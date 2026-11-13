//! Run commands: launching one in a terminal tab or the external terminal (apps.ts runInTerminal),
//! the titlebar ▶ buttons (RunCommands.tsx), and the add/edit CommandDialog.

use std::path::Path;

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::checkbox::Checkbox;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::menu::{ContextMenuExt as _, PopupMenuItem};
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::component::*;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::data::{self, RunCommand as Command};
use crate::settings::Settings;
use crate::sidebar::{dialogs, icon};
use crate::{ForestRanger, theme};

/// Past this many, the titlebar folds commands into one "Run ▾" menu.
const COLLAPSE_AT: usize = 2;

fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', r"'\''"))
}

fn apple_script_str(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', r"\\").replace('"', "\\\""))
}

/// The argv that runs `script` in terminal `app`: AppleScript for Terminal/iTerm,
/// Ghostty's `-e`, else the default `.command` handler.
fn terminal_argv(app: Option<&str>, script: &str) -> Vec<String> {
    let osa = |lines: &[&str]| vec!["osascript".into(), "-e".into(), lines.join("\n")];
    match app {
        Some("ghostty") => ["open", "-na", "Ghostty", "--args", "-e", script].map(String::from).to_vec(),
        Some("iterm") => osa(&[
            "tell application \"iTerm\"",
            "activate",
            "set w to (create window with default profile)",
            &format!("tell current session of w to write text {}", apple_script_str(&sh_quote(script))),
            "end tell",
        ]),
        Some("terminal") => osa(&["tell application \"Terminal\"", "activate", &format!("do script {}", apple_script_str(&sh_quote(script))), "end tell"]),
        _ => vec!["open".into(), script.into()],
    }
}

/// Run `command` in `cwd` in a new terminal window, through a login shell that
/// then stays open so output and dev servers remain visible.
fn run_in_terminal(app: Option<&str>, cwd: &str, command: &str) -> Result<(), String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let dir = std::env::temp_dir().join(format!("forest-ranger-run-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let file = dir.join("run.command");
    let launch = format!("{command}; exec {shell} -i");
    let script = format!("#!/bin/sh\ncd {} || exit 1\nexec {shell} -l -c {}\n", sh_quote(cwd), sh_quote(&launch));
    std::fs::write(&file, script).map_err(|e| e.to_string())?;
    use std::os::unix::fs::PermissionsExt as _;
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    let argv = terminal_argv(app, &file.to_string_lossy());
    let out = std::process::Command::new(&argv[0]).args(&argv[1..]).output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        let e = String::from_utf8_lossy(&out.stderr).trim().to_string();
        Err(if e.is_empty() { "Failed to launch terminal".into() } else { e })
    }
}

/// The dialog's directory, normalised: trimmed, no leading `./` or `/`.
fn clean_dir(dir: &str) -> String {
    let d = dir.trim();
    d.strip_prefix('.').filter(|r| r.starts_with('/')).unwrap_or(d).trim_start_matches('/').to_string()
}

impl ForestRanger {
    /// Run a project command in the worktree at `root` (`dir` joined on): in a
    /// terminal tab there, or the external terminal when the command asks for it.
    pub(crate) fn run_command(&mut self, cmd: &Command, root: &str, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(pid) = self.projects.iter().find(|p| p.worktrees.iter().any(|w| w.path == root)).map(|p| p.id.clone()) {
            let id = cmd.id.clone();
            crate::session_state::SessionState::update(cx, |s| _ = s.last_run.insert(pid, id));
            cx.notify();
        }
        let cwd = if cmd.dir.is_empty() { root.to_string() } else { Path::new(root).join(&cmd.dir).to_string_lossy().into_owned() };
        let command = cmd.command.clone();
        let wt = self.projects.iter().flat_map(|p| &p.worktrees).find(|w| w.path == root).map(|w| w.id.clone());
        if let Some(wt) = wt.filter(|_| cmd.run_target != "external") {
            let run = crate::term::Run { label: cmd.label.clone(), command, close_on_success: cmd.close_on_success };
            return self.open_terminal(&wt, &cwd, Some(run), window, cx);
        }
        let app = cx.global::<Settings>().terminal.clone();
        let work = cx.background_executor().spawn(async move { run_in_terminal(app.as_deref(), &cwd, &command) });
        cx.spawn_in(window, async move |_, cx| {
            if let Err(e) = work.await {
                let _ = cx.update(|window, cx| window.push_notification(crate::notify::error(format!("Couldn't run the command: {e}")), cx));
            }
        })
        .detach();
    }

    pub(crate) fn delete_command(&mut self, project_id: &str, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if let Err(e) = data::delete_command(id) {
            window.push_notification(crate::notify::error(format!("Couldn't delete the command: {e}")), cx);
        }
        self.reload_commands(project_id);
        cx.notify();
    }

    /// The worktree titlebar's ▶ buttons (right-click: Edit / Delete), or "Run ▾" past two.
    pub(crate) fn run_buttons(&self, project_id: &str, root: &str, cx: &mut Context<Self>) -> Option<AnyElement> {
        let commands = self.commands.get(project_id).filter(|c| !c.is_empty())?.clone();
        let theme = cx.theme().colors;
        let x = theme::extra(cx);
        let btn = |id: SharedString| {
            div()
                .id(id)
                .flex()
                .items_center()
                .gap(px(5.))
                .px(px(9.))
                .py(px(4.))
                .rounded(px(6.))
                .border_1()
                .border_color(x.border_strong)
                .text_size(px(12.5))
                .text_color(theme.muted_foreground)
                .cursor_pointer()
                .hover(|s| s.bg(x.hover).text_color(theme.foreground))
                .child(icon("fr/play.svg", 12., x.green))
        };
        let fr = cx.entity();
        // Past two: a split button — the face reruns the last-used command, the arrow lists them all.
        if commands.len() > COLLAPSE_AT {
            let last = crate::session_state::SessionState::get(cx).last_run.get(project_id).cloned();
            let face = commands.iter().find(|c| Some(&c.id) == last.as_ref()).unwrap_or(&commands[0]).clone();
            let root = root.to_string();
            let (run, run_root, me) = (face.clone(), root.clone(), fr.clone());
            return Some(
                crate::ui::SplitButton::new("run-last", face.label.clone())
                    .icon("fr/play.svg", x.green)
                    .tooltip(face.command.clone())
                    .on_click(move |_, window, cx| me.update(cx, |fr, cx| fr.run_command(&run, &run_root, window, cx)))
                    .menu("Run commands", Anchor::TopRight, move |menu, _, _| {
                        commands.iter().fold(menu, |menu, c| {
                            let (fr, c, root) = (fr.clone(), c.clone(), root.clone());
                            menu.item(PopupMenuItem::new(c.label.clone()).on_click(move |_, window, cx| fr.update(cx, |fr, cx| fr.run_command(&c, &root, window, cx))))
                        })
                    })
                    .into_any_element(),
            );
        }
        Some(
            div()
                .flex()
                .gap(px(6.))
                .children(commands.into_iter().map(|c| {
                    let (run, root, tip) = (c.clone(), root.to_string(), c.command.clone());
                    let (fr, pid) = (fr.clone(), project_id.to_string());
                    btn(format!("run-{}", c.id).into())
                        .child(c.label.clone())
                        .tooltip(move |window, cx| Tooltip::new(tip.clone()).build(window, cx))
                        .on_click(cx.listener(move |this, _, window, cx| this.run_command(&run, &root, window, cx)))
                        .context_menu(move |menu, _, _| {
                            let (f1, f2, p1, p2, edit, id) = (fr.clone(), fr.clone(), pid.clone(), pid.clone(), c.clone(), c.id.clone());
                            menu.item(PopupMenuItem::new("Edit command").on_click(move |_, window, cx| command_dialog(f1.clone(), p1.clone(), Some(edit.clone()), window, cx)))
                                .separator()
                                .item(PopupMenuItem::new("Delete command").on_click(move |_, window, cx| f2.update(cx, |fr, cx| fr.delete_command(&p2, &id, window, cx))))
                        })
                }))
                .into_any_element(),
        )
    }
}

// --- Command dialog -----------------------------------------------------------

struct CommandDialog {
    fr: WeakEntity<ForestRanger>,
    project_id: String,
    editing: Option<String>,
    label: Entity<InputState>,
    command: Entity<InputState>,
    dir: Entity<InputState>,
    /// "external", else a terminal tab ("in-app", or Electron's "default").
    run_target: String,
    close_on_success: bool,
    error: Option<String>,
    _subs: Vec<Subscription>,
}

/// Add (`editing` None) or edit a project's run command.
pub(crate) fn command_dialog(fr: Entity<ForestRanger>, project_id: String, editing: Option<Command>, window: &mut Window, cx: &mut App) {
    let title = if editing.is_some() { "Edit command" } else { "Add command" };
    let view = cx.new(|cx| {
        let c = editing.clone().unwrap_or(Command { id: String::new(), label: String::new(), command: String::new(), dir: String::new(), run_target: "in-app".into(), close_on_success: false });
        let label = cx.new(|cx| InputState::new(window, cx).placeholder("Run").default_value(c.label));
        let command = cx.new(|cx| InputState::new(window, cx).placeholder("npm run dev").default_value(c.command));
        let dir = cx.new(|cx| InputState::new(window, cx).placeholder("repo root — e.g. apps/web").default_value(c.dir));
        let mut subs = vec![];
        for (input, submits) in [(&label, false), (&command, true), (&dir, true)] {
            subs.push(cx.subscribe_in(input, window, move |this: &mut CommandDialog, _, ev: &InputEvent, window, cx| match ev {
                InputEvent::PressEnter { .. } if submits => this.save(window, cx),
                InputEvent::Change => cx.notify(),
                _ => {}
            }));
        }
        CommandDialog { fr: fr.downgrade(), project_id, editing: editing.map(|c| c.id), label, command, dir, run_target: c.run_target, close_on_success: c.close_on_success, error: None, _subs: subs }
    });
    let focus = view.read(cx).label.clone();
    dialogs::show(title, view, Some(focus), window, cx);
}

impl CommandDialog {
    fn values(&self, cx: &App) -> (String, String) {
        (self.label.read(cx).value().trim().to_string(), self.command.read(cx).value().trim().to_string())
    }

    fn save(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let (label, command) = self.values(cx);
        if label.is_empty() || command.is_empty() {
            return;
        }
        let dir = clean_dir(&self.dir.read(cx).value());
        let c = Command {
            id: self.editing.clone().unwrap_or_default(),
            label,
            command,
            dir,
            run_target: self.run_target.clone(),
            close_on_success: self.close_on_success,
        };
        let res = if self.editing.is_some() { data::update_command(&c) } else { data::add_command(&self.project_id, &c) };
        if let Err(e) = res {
            self.error = Some(e);
            cx.notify();
            return;
        }
        window.close_dialog(cx);
        let pid = self.project_id.clone();
        if let Some(fr) = self.fr.upgrade() {
            fr.update(cx, |fr, cx| {
                fr.reload_commands(&pid);
                cx.notify();
            });
        }
    }
}

impl Render for CommandDialog {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let mono = cx.theme().mono_font_family.clone();
        let (label, command) = self.values(cx);
        let external = self.run_target == "external";
        let target = |id: &'static str, text: &'static str, on: bool, value: &'static str| {
            Button::new(id).label(text).map(|b| if on { b.primary() } else { b.ghost() }).on_click(cx.listener(move |this, _, _, cx| {
                this.run_target = value.into();
                cx.notify();
            }))
        };
        div()
            .flex()
            .flex_col()
            .gap_3()
            .child(dialogs::field("Label", Input::new(&self.label), cx))
            .child(dialogs::field("Command", Input::new(&self.command).font_family(mono.clone()), cx))
            .child(dialogs::field("Working directory (optional)", Input::new(&self.dir).font_family(mono), cx))
            .child(dialogs::field(
                "Run in",
                div().flex().gap_1().child(target("rt-in-app", "Terminal tab", !external, "in-app")).child(target("rt-external", "External terminal", external, "external")),
                cx,
            ))
            // Only a tab can close itself; an external terminal is the terminal app's.
            .when(!external, |d| {
                d.child(
                    Checkbox::new("close-on-success")
                        .label("Close the tab when the command succeeds (stays open on failure)")
                        .checked(self.close_on_success)
                        .on_click(cx.listener(|this, v: &bool, _, cx| {
                            this.close_on_success = *v;
                            cx.notify();
                        })),
                )
            })
            .child(dialogs::error_line(self.error.clone(), cx))
            .child(dialogs::actions(
                Button::new("save-command")
                    .primary()
                    .label("Save")
                    .disabled(label.is_empty() || command.is_empty())
                    .on_click(cx.listener(|this, _, window, cx| this.save(window, cx))),
            ))
    }
}

#[cfg(test)]
mod tests {
    use super::{clean_dir, sh_quote, terminal_argv};

    #[test]
    fn dirs_and_argv() {
        assert_eq!(clean_dir("  ./apps/web "), "apps/web");
        assert_eq!(clean_dir("/apps"), "apps");
        assert_eq!(clean_dir(".//x"), "x");
        assert_eq!(clean_dir(".hidden"), ".hidden");
        assert_eq!(sh_quote("it's"), r"'it'\''s'");
        assert_eq!(terminal_argv(Some("ghostty"), "/t/run.command"), ["open", "-na", "Ghostty", "--args", "-e", "/t/run.command"]);
        let t = terminal_argv(Some("terminal"), "/t/a b");
        assert_eq!(t[2], "tell application \"Terminal\"\nactivate\ndo script \"'/t/a b'\"\nend tell");
        assert_eq!(terminal_argv(Some("warp"), "/t/x"), ["open", "/t/x"]);
    }
}
