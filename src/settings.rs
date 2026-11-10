//! App settings (theme, editor, external terminal, default agent) and the Settings
//! dialog. Saved in `~/.forest-ranger/gpui-settings.json`.

use std::{collections::HashMap, fs, path::Path, process::Command};

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::menu::{DropdownMenu as _, PopupMenuItem};
use gpui_kit::component::*;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use serde_json::{Value, json};

use crate::codehost::Provider;
use crate::data::data_dir;
use crate::theme;

#[derive(Clone, PartialEq)]
pub struct Settings {
    /// "system" | "light" | "dark"
    pub theme: String,
    pub editor: Option<String>,
    pub terminal: Option<String>,
    /// "claude" | "codex"
    pub provider: String,
    /// Starting mode per provider (the agent's mode id); absent = the agent's default.
    pub default_mode_by_provider: HashMap<String, String>,
    /// Review prompt template per project id; absent = DEFAULT_REVIEW_PROMPT.
    pub review_prompt_by_project: HashMap<String, String>,
    /// Desktop notifications when something's ready (a chat or a long terminal run
    /// finished) while the app isn't in front. Off by default; "needs you" always notifies.
    pub notify_ready: bool,
}

impl Global for Settings {}

fn file() -> std::path::PathBuf {
    data_dir().join("gpui-settings.json")
}

impl Settings {
    pub fn load() -> Self {
        let v: Value = fs::read_to_string(file()).ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or_default();
        let s = |k: &str| v[k].as_str().map(str::to_string);
        let apps = detect_apps();
        let first = |kind: &str| apps.iter().find(|a| a.kind == kind).map(|a| a.id.to_string());
        Self {
            theme: s("theme").unwrap_or_else(|| "system".into()),
            editor: s("editor").or_else(|| first("editor")),
            terminal: s("terminal").or_else(|| first("terminal")),
            provider: s("provider").unwrap_or_else(|| "claude".into()),
            default_mode_by_provider: str_map(&v["defaultModeByProvider"]),
            review_prompt_by_project: str_map(&v["reviewPromptByProject"]),
            notify_ready: v["notifyReady"].as_bool().unwrap_or(false),
        }
    }

    fn save(&self) {
        let v = json!({
            "theme": self.theme,
            "editor": self.editor,
            "terminal": self.terminal,
            "provider": self.provider,
            "defaultModeByProvider": self.default_mode_by_provider,
            "reviewPromptByProject": self.review_prompt_by_project,
            "notifyReady": self.notify_ready,
        });
        if let Err(e) = crate::data::write_atomic(&file(), v.to_string()) {
            eprintln!("couldn't save settings: {e}");
        }
    }

    pub fn dark(&self, window: &Window) -> bool {
        match self.theme.as_str() {
            "dark" => true,
            "light" => false,
            _ => matches!(window.appearance(), WindowAppearance::Dark | WindowAppearance::VibrantDark),
        }
    }

    pub fn update(cx: &mut App, f: impl FnOnce(&mut Settings)) {
        let mut s = cx.global::<Settings>().clone();
        f(&mut s);
        s.save();
        cx.set_global(s);
    }
}

fn str_map(v: &Value) -> HashMap<String, String> {
    v.as_object().map(|m| m.iter().filter_map(|(k, v)| Some((k.clone(), v.as_str()?.to_string()))).collect()).unwrap_or_default()
}

/// Built-in review prompt (chatConfig.ts). `{branch}` and `{base}` are substituted at review time.
pub const DEFAULT_REVIEW_PROMPT: &str = r#"Review the branch `{branch}` against `{base}`. This worktree is checked out at `{branch}` for review.

Start by seeing what changed:
- `git log {base}..HEAD --oneline` for the commits
- `git diff {base}...HEAD` for the full diff

Then give me a review:
- Summarize what the branch does and why.
- Flag bugs, edge cases, security issues, and consistency/style problems — cite specific files and lines.
- Call out anything risky, unclear, or worth discussing.

If the branch has new commits on origin, update it with `git pull --ff-only` on the branch — don't check out `origin/…` or detach HEAD.

Don't change any code — this is a read-only review."#;

/// The project's review template, or the default when unset / blank.
pub fn review_prompt(cx: &App, project_id: &str) -> String {
    template_or_default(cx.global::<Settings>().review_prompt_by_project.get(project_id)).to_string()
}

fn template_or_default(t: Option<&String>) -> &str {
    t.map(|t| t.as_str()).filter(|t| !t.trim().is_empty()).unwrap_or(DEFAULT_REVIEW_PROMPT)
}

/// The review instruction for a branch + base (ReviewDialog.tsx reviewPrompt).
pub fn render_review_prompt(cx: &App, project_id: &str, branch: &str, base: Option<&str>) -> String {
    fill_review_prompt(&review_prompt(cx, project_id), branch, base)
}

fn fill_review_prompt(template: &str, branch: &str, base: Option<&str>) -> String {
    template.trim().replace("{branch}", branch).replace("{base}", base.unwrap_or("the main branch"))
}

/// Save a project's template; None (or the default text) resets it.
pub fn set_review_prompt(cx: &mut App, project_id: &str, value: Option<String>) {
    let id = project_id.to_string();
    Settings::update(cx, move |s| match value.filter(|v| v != DEFAULT_REVIEW_PROMPT) {
        Some(v) => _ = s.review_prompt_by_project.insert(id, v),
        None => _ = s.review_prompt_by_project.remove(&id),
    });
}

pub struct AppInfo {
    pub id: &'static str,
    pub label: &'static str,
    bundle: &'static str,
    pub kind: &'static str,
}

// Order = default priority (first installed wins), as in the Electron app's apps.ts.
const CATALOG: [AppInfo; 7] = [
    AppInfo { id: "cursor", label: "Cursor", bundle: "Cursor", kind: "editor" },
    AppInfo { id: "vscode", label: "VS Code", bundle: "Visual Studio Code", kind: "editor" },
    AppInfo { id: "zed", label: "Zed", bundle: "Zed", kind: "editor" },
    AppInfo { id: "ghostty", label: "Ghostty", bundle: "Ghostty", kind: "terminal" },
    AppInfo { id: "iterm", label: "iTerm", bundle: "iTerm", kind: "terminal" },
    AppInfo { id: "warp", label: "Warp", bundle: "Warp", kind: "terminal" },
    AppInfo { id: "terminal", label: "Terminal", bundle: "Terminal", kind: "terminal" },
];

pub fn detect_apps() -> Vec<&'static AppInfo> {
    let home = std::env::var("HOME").unwrap_or_default();
    let dirs = ["/Applications".to_string(), format!("{home}/Applications"), "/System/Applications".into(), "/System/Applications/Utilities".into()];
    CATALOG.iter().filter(|a| dirs.iter().any(|d| Path::new(d).join(format!("{}.app", a.bundle)).exists())).collect()
}

/// Open a folder in an app (`open -a`), or Finder when `app` is None.
pub fn open_in(app: Option<&str>, path: &str) {
    let bundle = app.and_then(|id| CATALOG.iter().find(|a| a.id == id)).map(|a| a.bundle);
    let mut cmd = Command::new("open");
    if let Some(b) = bundle {
        cmd.args(["-a", b]);
    }
    let _ = cmd.arg(path).spawn();
}

/// Like `open_in`, but reports failure: no app chosen, or `open` failing.
pub fn try_open_in(app: Option<&str>, path: &str, kind: &str) -> Result<(), String> {
    let Some(app) = app else {
        return Err(if kind == "terminal" { "No terminal found" } else { "No editor found" }.into());
    };
    let bundle = CATALOG.iter().find(|a| a.id == app).map(|a| a.bundle).unwrap_or(app);
    let out = Command::new("open").args(["-a", bundle, path]).output().map_err(|e| e.to_string())?;
    if out.status.success() { Ok(()) } else { Err(String::from_utf8_lossy(&out.stderr).trim().to_string()) }
}

pub fn app_label(id: &str) -> &str {
    CATALOG.iter().find(|a| a.id == id).map(|a| a.label).unwrap_or(id)
}

/// Known mode ids per provider, for the Default mode picker (label, id).
fn known_modes(provider: &str) -> &'static [(&'static str, &'static str)] {
    if provider == "codex" {
        &[("Read only", "read-only"), ("Agent", "agent"), ("Full access", "full-access")]
    } else {
        &[("Default", "default"), ("Accept edits", "acceptEdits"), ("Plan", "plan"), ("Bypass permissions", "bypassPermissions"), ("Auto", "auto")]
    }
}

pub fn reveal(path: &str) {
    let _ = Command::new("open").args(["-R", path]).spawn();
}

// ---- per-project code host (ProjectView CodeHostField) ----

struct CodeHostView {
    project_id: String,
    repo: String,
    /// None while loading.
    info: Option<crate::codehost::ProjectCodeHost>,
}

/// One view per project, so the picker keeps its loaded state across renders.
#[derive(Default)]
struct CodeHostViews(HashMap<String, Entity<CodeHostView>>);
impl Global for CodeHostViews {}

impl CodeHostView {
    /// Reads `git remote` + the DB off the main thread.
    fn load(&mut self, cx: &mut Context<Self>) {
        let (id, repo) = (self.project_id.clone(), self.repo.clone());
        let work = cx.background_executor().spawn(async move { crate::codehost::project_code_host(&id, &repo) });
        cx.spawn(async move |this, cx| {
            let info = work.await;
            let _ = this.update(cx, |this, cx| {
                this.info = Some(info);
                cx.notify();
            });
        })
        .detach();
    }
}

fn choice_label(choice: &str, detected: Option<Provider>) -> String {
    match choice {
        "github" => "GitHub".into(),
        "gitlab" => "GitLab".into(),
        "none" => "None".into(),
        _ => format!("Auto ({})", detected.map(|p| p.label()).unwrap_or("no match")),
    }
}

impl Render for CodeHostView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().colors;
        let hint = |t: String| div().text_size(px(12.)).text_color(theme.muted_foreground).child(t);
        let Some(info) = self.info.clone() else { return div().child(hint("Checking…".into())) };
        let this = cx.entity();
        let current = info.choice.clone();
        let detected = info.detected;
        let picker = Button::new("code-host-pick").outline().label(format!("{}  ▾", choice_label(&current, detected))).dropdown_menu(move |mut m, _, _| {
            for choice in ["auto", "github", "gitlab", "none"] {
                let this = this.clone();
                m = m.item(PopupMenuItem::new(choice_label(choice, detected)).checked(current == choice).on_click(move |_, _, cx| {
                    this.update(cx, |v, cx| {
                        if let Err(e) = crate::codehost::set_project_code_host(&v.project_id, choice) {
                            eprintln!("set code host: {e}");
                        }
                        v.load(cx);
                    })
                }));
            }
            m
        });
        div()
            .flex()
            .flex_col()
            .gap_2()
            .child(
                div()
                    .flex()
                    .gap_1()
                    .text_size(px(12.))
                    .text_color(theme.muted_foreground)
                    .child("Origin:")
                    .child(div().font_family(cx.theme().mono_font_family.clone()).text_color(theme.foreground).child(info.remote.clone().unwrap_or_else(|| "none".into()))),
            )
            .child(div().flex().child(picker))
            .child(hint(crate::codehost::project_status_line(&info)))
    }
}

/// The project Settings "Code host" field: origin, the Auto / GitHub / GitLab / None
/// picker (writes `projects.integration`), and what's in effect.
pub fn project_code_host_section(project_id: &str, repo: &str, _window: &mut Window, cx: &mut App) -> AnyElement {
    if let Some(v) = cx.try_global::<CodeHostViews>().and_then(|g| g.0.get(project_id)).cloned() {
        return v.into_any_element();
    }
    let v = cx.new(|cx| {
        let mut v = CodeHostView { project_id: project_id.into(), repo: repo.into(), info: None };
        v.load(cx);
        v
    });
    cx.default_global::<CodeHostViews>().0.insert(project_id.into(), v.clone());
    v.into_any_element()
}

/// Integrations changed: re-check every mounted project's code host line.
fn reload_code_hosts(cx: &mut App) {
    let views: Vec<_> = cx.try_global::<CodeHostViews>().map(|g| g.0.values().cloned().collect()).unwrap_or_default();
    for v in views {
        v.update(cx, |v, cx| v.load(cx));
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Section {
    General,
    Apps,
    Agents,
    Integrations,
}

pub struct SettingsView {
    section: Section,
    integrations: Vec<crate::codehost::IntegrationInfo>,
    /// Editable host per provider.
    hosts: Vec<(Provider, Entity<InputState>)>,
    /// Provider whose CLI sign-in / test is running, and the last result per provider.
    connecting: Option<Provider>,
    results: Vec<(Provider, Result<String, String>)>,
    _subs: Vec<Subscription>,
}

pub fn open(window: &mut Window, cx: &mut App) {
    let view = cx.new(|cx| {
        let integrations = crate::codehost::integrations();
        let hosts: Vec<_> = integrations
            .iter()
            .map(|i| {
                let ph = if i.provider == Provider::GitHub { "github.com" } else { "https://gitlab.com" };
                (i.provider, cx.new(|cx| InputState::new(window, cx).default_value(i.host.clone()).placeholder(ph)))
            })
            .collect();
        let _subs = hosts.iter().map(|(_, h)| cx.subscribe(h, |_, _, _: &InputEvent, cx| cx.notify())).collect();
        SettingsView { section: Section::General, integrations, hosts, connecting: None, results: vec![], _subs }
    });
    // No corner ×: it overlapped the content. The footer's Done closes it (and Esc).
    window.open_dialog(cx, move |d, _, _| d.width(px(680.)).p_0().close_button(false).child(view.clone()));
}

impl SettingsView {
    fn typed_host(&self, p: Provider, cx: &App) -> String {
        self.hosts.iter().find(|h| h.0 == p).map(|h| h.1.read(cx).value().trim().to_string()).unwrap_or_default()
    }

    /// Run a CLI check off the main thread (it hits the network); Ok(Some(msg)) is shown in green.
    fn run(&mut self, p: Provider, work: impl FnOnce() -> Result<Option<String>, String> + Send + 'static, cx: &mut Context<Self>) {
        self.connecting = Some(p);
        self.results.retain(|r| r.0 != p);
        let work = cx.background_executor().spawn(async move { work() });
        cx.spawn(async move |this, cx| {
            let res = work.await;
            let _ = this.update(cx, |this, cx| {
                this.connecting = None;
                match res {
                    Ok(Some(msg)) => this.results.push((p, Ok(msg))),
                    Ok(None) => {}
                    Err(e) => this.results.push((p, Err(e))),
                }
                this.integrations = crate::codehost::integrations();
                reload_code_hosts(cx);
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    /// Switch a provider to its CLI sign-in on the typed host, or off it.
    fn set_cli(&mut self, p: Provider, on: bool, cx: &mut Context<Self>) {
        let host = self.typed_host(p, cx);
        self.run(
            p,
            move || {
                if on {
                    crate::codehost::use_cli_host(p, &host).map(|u| Some(format!("Connected via {} as @{u}", p.cli())))
                } else {
                    crate::codehost::stop_cli(p).map(|_| None)
                }
            },
            cx,
        );
    }

    fn test(&mut self, p: Provider, cx: &mut Context<Self>) {
        let host = self.typed_host(p, cx);
        self.run(
            p,
            move || {
                let shown = if host.is_empty() { "the saved host".to_string() } else { host.clone() };
                crate::codehost::test_connection(p, &host).map(|u| Some(format!("@{u} on {shown}")))
            },
            cx,
        );
    }

    fn integration_card(&self, info: &crate::codehost::IntegrationInfo, cx: &mut Context<Self>) -> AnyElement {
        use crate::codehost::Connection;
        let theme = cx.theme().colors;
        let x = theme::extra(cx);
        let p = info.provider;
        let cli = p.cli();
        let status = match &info.connection {
            Connection::Cli { user } => format!("Using {cli} sign-in{}", user.as_ref().map(|u| format!(" as @{u}")).unwrap_or_default()),
            Connection::OAuth { user } => format!(
                "Signed in{} with a browser sign-in from an older version — that can't be used anymore; use {cli} instead.",
                user.as_ref().map(|u| format!(" as @{u}")).unwrap_or_default()
            ),
            Connection::Token => format!("Access token from an older version — it can't be read anymore; use {cli} instead."),
            Connection::None => "Not connected".into(),
        };
        let typed = self.typed_host(p, cx);
        let host_changed = !typed.is_empty() && !crate::codehost::same_host(&typed, &info.host);
        // Connected via the CLI on the host shown; a changed host offers to reconnect instead.
        let is_cli = matches!(info.connection, Connection::Cli { .. }) && !host_changed;
        let busy = self.connecting == Some(p);
        let result = self.results.iter().find(|r| r.0 == p).map(|r| r.1.clone());
        let host_input = self.hosts.iter().find(|h| h.0 == p).map(|h| h.1.clone());
        let enabled = info.enabled;
        let this = cx.entity();
        div()
            .flex()
            .flex_col()
            .gap_2()
            .p_4()
            .rounded(px(8.))
            .border_1()
            .border_color(theme.border)
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .child(div().text_size(px(14.)).font_weight(FontWeight::SEMIBOLD).child(p.label()))
                    .child(
                        gpui_kit::component::switch::Switch::new(SharedString::from(format!("en-{cli}")))
                            .checked(enabled)
                            .on_click(move |on, window, cx| {
                                let _ = crate::codehost::set_enabled(p, *on);
                                reload_code_hosts(cx);
                                this.update(cx, |v, cx| {
                                    v.integrations = crate::codehost::integrations();
                                    cx.notify();
                                });
                                window.refresh();
                            }),
                    ),
            )
            .child(div().text_size(px(13.)).text_color(if is_cli { theme.foreground } else { theme.muted_foreground }).child(status))
            .when_some(host_input, |d, h| {
                d.child(
                    div()
                        .flex()
                        .items_center()
                        .gap_2()
                        .child(div().w(px(40.)).text_size(px(12.)).text_color(theme.muted_foreground).child("Host"))
                        .child(div().flex_1().child(Input::new(&h).font_family(cx.theme().mono_font_family.clone()))),
                )
            })
            .when_some(result, |d, r| {
                let (text, color) = match r {
                    Ok(t) => (t, theme.success),
                    Err(e) => (e, theme.danger),
                };
                d.child(div().text_size(px(12.)).text_color(color).child(text))
            })
            .child(
                div().flex().gap_2().child(
                    Button::new(SharedString::from(format!("test-{cli}")))
                        .outline()
                        .label("Test connection")
                        .disabled(busy)
                        .on_click(cx.listener(move |this, _, _, cx| this.test(p, cx))),
                )
                .child(
                    Button::new(SharedString::from(format!("cli-{cli}")))
                        .when(!is_cli, |b| b.primary())
                        .when(is_cli, |b| b.outline())
                        .label(if busy {
                            "Checking…".to_string()
                        } else if is_cli {
                            format!("Stop using {cli}")
                        } else {
                            format!("Use {cli} sign-in")
                        })
                        .disabled(busy)
                        .on_click(cx.listener(move |this, _, _, cx| this.set_cli(p, !is_cli, cx))),
                ),
            )
            .child(
                div()
                    .text_size(px(11.5))
                    .text_color(x.faint)
                    .child(format!("Uses your existing `{cli}` login (no token stored). Sign in with `{cli} auth login` if needed.")),
            )
            .into_any_element()
    }

    fn option(&self, id: impl Into<SharedString>, label: impl Into<SharedString>, selected: bool, cx: &mut Context<Self>, on: impl Fn(&mut Window, &mut App) + 'static) -> AnyElement {
        let theme = cx.theme().colors;
        let x = theme::extra(cx);
        div()
            .id(ElementId::Name(id.into()))
            .flex()
            .items_center()
            .justify_between()
            .px_3()
            .py_2()
            .rounded(px(6.))
            .text_size(px(13.))
            .cursor_pointer()
            .hover(|s| s.bg(x.hover))
            .when(selected, |d| d.bg(x.active))
            .child(label.into())
            .when(selected, |d| d.child(div().text_color(theme.primary).child("✓")))
            .on_click(move |_, window, cx| {
                on(window, cx);
                window.refresh();
            })
            .into_any_element()
    }

    fn group(&self, label: &str, items: Vec<AnyElement>, cx: &App) -> AnyElement {
        div()
            .flex()
            .flex_col()
            .gap_1()
            .child(
                div()
                    .px_1()
                    .pb_1()
                    .text_size(px(11.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(theme::extra(cx).faint)
                    .child(label.to_uppercase()),
            )
            .children(items)
            .into_any_element()
    }
}

impl Render for SettingsView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().colors;
        let x = theme::extra(cx);
        let s = cx.global::<Settings>().clone();
        let nav = [
            (Section::General, "General"),
            (Section::Apps, "Applications"),
            (Section::Agents, "Agents"),
            (Section::Integrations, "Integrations"),
        ];
        let content: Vec<AnyElement> = match self.section {
            Section::General => {
                let opts = [("system", "Follow system"), ("light", "Light"), ("dark", "Dark")]
                    .into_iter()
                    .map(|(v, label)| {
                        self.option(v, label, s.theme == v, cx, move |window, cx| {
                            Settings::update(cx, |s| s.theme = v.into());
                            let dark = cx.global::<Settings>().dark(window);
                            theme::apply(dark, cx);
                        })
                    })
                    .collect();
                let notify = [(false, "Off"), (true, "On — a chat or a long terminal run finished while you were elsewhere")]
                    .into_iter()
                    .map(|(on, label)| {
                        let id = if on { "notify-on" } else { "notify-off" };
                        self.option(id, label, s.notify_ready == on, cx, move |_, cx| Settings::update(cx, |s| s.notify_ready = on))
                    })
                    .collect();
                vec![self.group("Theme", opts, cx), self.group("Desktop notifications when something's ready", notify, cx)]
            }
            Section::Apps => {
                let apps = detect_apps();
                let mut groups = vec![];
                for (kind, title) in [("editor", "Editor"), ("terminal", "External terminal")] {
                    let items: Vec<AnyElement> = apps
                        .iter()
                        .filter(|a| a.kind == kind)
                        .map(|a| {
                            let id = a.id;
                            let selected = if kind == "editor" { s.editor.as_deref() } else { s.terminal.as_deref() } == Some(id);
                            self.option(id, a.label, selected, cx, move |_, cx| {
                                Settings::update(cx, |s| {
                                    if kind == "editor" { s.editor = Some(id.into()) } else { s.terminal = Some(id.into()) }
                                })
                            })
                        })
                        .collect();
                    groups.push(if items.is_empty() {
                        self.group(title, vec![div().px_3().text_sm().text_color(x.faint).child("None found").into_any_element()], cx)
                    } else {
                        self.group(title, items, cx)
                    });
                }
                groups
            }
            Section::Agents => {
                let opts = [("claude", "Claude"), ("codex", "Codex")]
                    .into_iter()
                    .map(|(v, label)| {
                        self.option(v, label, s.provider == v, cx, move |_, cx| Settings::update(cx, |s| s.provider = v.into()))
                    })
                    .collect();
                let mut groups = vec![self.group("Default agent for new chats", opts, cx)];
                for (provider, label) in [("claude", "Claude"), ("codex", "Codex")] {
                    let current = s.default_mode_by_provider.get(provider).cloned();
                    let mut items = vec![self.option(
                        SharedString::from(format!("mode-{provider}-")),
                        "Agent default",
                        current.is_none(),
                        cx,
                        move |_, cx| Settings::update(cx, |s| _ = s.default_mode_by_provider.remove(provider)),
                    )];
                    items.extend(known_modes(provider).iter().map(|&(name, id)| {
                        self.option(SharedString::from(format!("mode-{provider}-{id}")), name, current.as_deref() == Some(id), cx, move |_, cx| {
                            Settings::update(cx, |s| _ = s.default_mode_by_provider.insert(provider.into(), id.into()))
                        })
                    }));
                    groups.push(self.group(&format!("{label} default mode"), items, cx));
                }
                groups
            }
            Section::Integrations => {
                let infos = std::mem::take(&mut self.integrations);
                let cards = infos.iter().map(|i| self.integration_card(i, cx)).collect();
                self.integrations = infos;
                cards
            }
        };
        div()
            .flex()
            .h(px(420.))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_0p5()
                    .w(px(180.))
                    .p_3()
                    .bg(theme.sidebar)
                    .border_r_1()
                    .border_color(theme.border)
                    .rounded_l(px(8.))
                    .child(div().px_2().pb_3().text_size(px(15.)).font_weight(FontWeight::SEMIBOLD).child("Settings"))
                    .children(nav.into_iter().map(|(sec, label)| {
                        div()
                            .id(label)
                            .px_2()
                            .py(px(6.))
                            .rounded(px(6.))
                            .text_size(px(13.))
                            .cursor_pointer()
                            .text_color(theme.muted_foreground)
                            .hover(|s| s.bg(x.hover).text_color(theme.foreground))
                            .when(self.section == sec, |d| d.bg(x.active).text_color(theme.foreground))
                            .child(label)
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.section = sec;
                                cx.notify();
                            }))
                    })),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .flex()
                    .flex_col()
                    .child(div().id("settings-content").flex_1().min_h_0().flex().flex_col().gap_5().p_5().overflow_y_scroll().children(content))
                    .child(
                        div().flex().justify_end().px_5().py_3().border_t_1().border_color(theme.border).child(
                            Button::new("settings-done")
                                .primary()
                                .px(px(18.))
                                .label("Done")
                                .on_click(|_, window, cx| window.close_dialog(cx)),
                        ),
                    ),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::{DEFAULT_REVIEW_PROMPT, fill_review_prompt, template_or_default};

    #[test]
    fn review_prompt_fill() {
        let custom = "  Review {branch} vs {base}. ".to_string();
        assert_eq!(fill_review_prompt(template_or_default(Some(&custom)), "feat/x", None), "Review feat/x vs the main branch.");
        assert_eq!(template_or_default(Some(&"  ".to_string())), DEFAULT_REVIEW_PROMPT);
        let d = fill_review_prompt(template_or_default(None), "b", Some("origin/main"));
        assert!(d.starts_with("Review the branch `b` against `origin/main`."));
        assert!(!d.contains("{branch}") && !d.contains("{base}"));
    }
}
