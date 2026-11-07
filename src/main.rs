//! Forest Ranger: a desktop app for working across git worktrees with AI agents,
//! built on GPUI Kit. The window shell: sidebar, titlebar, tabs, panels, palettes.

mod acp;
mod assets;
mod chat;
mod codehost;
mod data;
mod files;
mod git;
mod log;
mod notify;
mod palette;
mod panes;
mod project_view;
mod review;
mod session_state;
mod settings;
mod sidebar;
mod term;
mod theme;
mod tree;

use std::collections::{HashMap, HashSet};

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::diff::{Diff, DiffFile, DiffMode, DiffState};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::notification::Notification;
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::component::menu::{DropdownMenu as _, PopupMenuItem};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::component::*;
use gpui_kit::*;

use chat::{Attention, ChatEvent, ChatView};
use data::{ChatMeta, Project};
use session_state::SessionState;

struct ForestRanger {
    projects: Vec<Project>,
    error: Option<String>,
    /// Selected worktree id.
    selected: Option<String>,
    /// The project page shown instead of a worktree (then `selected` is None).
    project_view: Option<project_view::ProjectPage>,
    /// Run commands per project id, loaded on first use.
    commands: HashMap<String, Vec<data::RunCommand>>,
    /// Expanded project ids in the sidebar tree.
    expanded: HashSet<String>,
    chats: Vec<ChatMeta>,
    /// Open chat tabs per worktree id — kept across navigation so agents keep running.
    tabs: std::collections::HashMap<String, Tabs>,
    /// The right-hand panel, one per visited worktree (keeps its view and inputs).
    reviews: std::collections::HashMap<String, Entity<review::ReviewPanel>>,
    /// The selected worktree's panel is open (each worktree remembers its own).
    show_diff: bool,
    /// Worktrees whose saved tabs were reopened this run.
    restored: HashSet<String>,
    /// Tracking branch per worktree path, for the breadcrumb (looked up on visit).
    upstreams: HashMap<String, Option<String>>,
    /// Latest window bounds, written to window-state.json shortly after a change and on quit.
    bounds: Option<Bounds<Pixels>>,
    save_bounds: Option<Task<()>>,
    /// Navigation history (⌘[ / ⌘]): worktree ids and `project:<id>`.
    back: Vec<String>,
    forward: Vec<String>,
    /// Keyboard focus root: actions only reach handlers on the focused element's
    /// path, so the window keeps focus inside this view.
    focus: FocusHandle,
    /// The open ⌘T / ⌘P palette, if any.
    palette: Option<(Entity<palette::Palette>, Subscription)>,
    /// The chat you're looking at (active tab, window focused): it doesn't go unread.
    looking: Option<WeakEntity<ChatView>>,
    /// Each chat's last attention, to spot transitions worth a notification.
    attention: HashMap<EntityId, Attention>,
    /// The tab whose title is being edited (double-click), by key.
    renaming: Option<(String, Entity<InputState>, Subscription)>,
    /// While a tab drags over a pane body: (group id, where it would land).
    drop_hint: Option<(String, panes::Drop)>,
    _subs: Vec<Subscription>,
}

actions!(
    forest_ranger,
    [TogglePanel, GoBack, GoForward, ShowReview, ShowFiles, ShowSearch, CloseTab, NewTerminal, Quit, JumpTo, OpenFile, SaveAll, About, Hide, HideOthers, ShowAll, Minimize, Zoom, CloseWindow]
);

/// A center tab: an agent chat, a file's diff, a file in the editor, or a terminal.
enum Tab {
    Chat(Entity<ChatView>),
    /// `fixed`: built from given texts (an agent's edit), not from git.
    Diff { key: String, title: String, state: Entity<DiffState>, root: String, file: String, base: Option<String>, full: bool, fixed: bool },
    File(Entity<files::FileView>),
    Term(Entity<term::TerminalView>),
}

impl Tab {
    fn key(&self, cx: &App) -> String {
        match self {
            Tab::Chat(c) => format!("chat:{}", c.read(cx).session_id()),
            Tab::Diff { key, .. } => key.clone(),
            Tab::File(f) => format!("file:{}", f.read(cx).rel),
            Tab::Term(t) => format!("term:{}", t.read(cx).id),
        }
    }
}

#[derive(Default)]
struct Tabs {
    open: Vec<Tab>,
    active: Option<usize>,
    /// Keys, most recently focused first (closing the active tab returns to the last one).
    mru: Vec<String>,
    /// The worktree's one temporary tab (italic title): the next file/diff open
    /// replaces it, until an edit or a double-click pins it.
    preview: Option<String>,
    /// Which group each tab sits in; `active` is the focused group's active tab.
    layout: panes::Node,
}

impl Tabs {
    fn keys(&self, cx: &App) -> Vec<String> {
        self.open.iter().map(|t| t.key(cx)).collect()
    }

    fn index(&self, key: &str, cx: &App) -> Option<usize> {
        self.open.iter().position(|t| t.key(cx) == key)
    }
}

/// A tab being dragged (by key), drawn under the pointer as a small chip.
#[derive(Clone)]
struct DraggedTab {
    key: String,
    title: String,
}

impl Render for DraggedTab {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().colors;
        div()
            .px(px(9.))
            .py(px(5.))
            .rounded(px(6.))
            .text_size(px(12.))
            .bg(theme.background)
            .border_1()
            .border_color(theme.border)
            .shadow_md()
            .opacity(0.9)
            .child(self.title.clone())
    }
}

/// A split's divider being dragged: the split's id and the child it follows.
#[derive(Clone)]
struct DraggedDivider {
    split: String,
    ix: usize,
}

impl Render for DraggedDivider {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
    }
}

/// `diff:<base|working|commit:hash>:<path>` → (base, path).
fn parse_diff_key(key: &str) -> Option<(Option<String>, String)> {
    let rest = key.strip_prefix("diff:")?;
    let (base, file) = match rest.strip_prefix("commit:") {
        Some(r) => r.split_once(':').map(|(h, f)| (format!("commit:{h}"), f))?,
        None => rest.split_once(':').map(|(b, f)| (b.to_string(), f))?,
    };
    Some(((base != "working").then_some(base), file.to_string()))
}

/// Rewrite `git diff --no-index a b` output as a patch of `file`.
fn rehead(file: &str, out: &str) -> String {
    match out.find("\n@@") {
        Some(i) => format!("diff --git a/{file} b/{file}\n--- a/{file}\n+++ b/{file}\n{}", &out[i + 1..]),
        None => String::new(),
    }
}

/// A unified patch between two texts of `file`.
fn text_patch(file: &str, old: &str, new: &str) -> String {
    let dir = std::env::temp_dir().join(format!("forest-ranger-diff-{}", uuid::Uuid::new_v4()));
    if std::fs::create_dir_all(&dir).is_err() || std::fs::write(dir.join("a"), old).is_err() || std::fs::write(dir.join("b"), new).is_err() {
        return String::new();
    }
    let out = std::process::Command::new("git")
        .args(["diff", "--no-index", "--no-color", "--no-ext-diff", "a", "b"])
        .current_dir(&dir)
        .output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default();
    let _ = std::fs::remove_dir_all(&dir);
    rehead(file, &out)
}

fn rank(a: Attention) -> u8 {
    match a {
        Attention::NeedsAnswer => 0,
        Attention::Working => 1,
        Attention::Unread => 2,
        Attention::Idle => 3,
    }
}

/// A chat's status dot: amber pulsing (needs your answer), accent pulsing
/// (working), accent bullseye (unread). None when idle.
pub(crate) fn status_dot(a: Attention, id: impl Into<ElementId>, cx: &App) -> Option<AnyElement> {
    let (accent, amber) = (cx.theme().colors.primary, theme::extra(cx).amber);
    let pulse = |d: Div, ms: u64| {
        d.with_animation(id.into(), Animation::new(std::time::Duration::from_millis(ms)).repeat().with_easing(pulsating_between(0.45, 1.)), |d, a| d.opacity(a))
            .into_any_element()
    };
    let dot = || div().size(px(8.)).flex_shrink_0().rounded_full();
    Some(match a {
        Attention::NeedsAnswer => pulse(dot().bg(amber), 1200),
        Attention::Working => pulse(dot().bg(accent), 1400),
        Attention::Unread => div()
            .size(px(10.))
            .flex_shrink_0()
            .flex()
            .items_center()
            .justify_center()
            .rounded_full()
            .border_1()
            .border_color(accent)
            .child(div().size(px(4.)).rounded_full().bg(accent))
            .into_any_element(),
        Attention::Idle => return None,
    })
}

/// A file's patch; `full` asks git for the whole file as context.
fn diff_patch(root: &str, file: &str, base: Option<&str>, full: bool) -> String {
    if !full {
        return match base {
            Some(b) if b.starts_with("commit:") => git::commit_file_diff(root, &b["commit:".len()..], file),
            b => git::file_diff(root, file, b),
        };
    }
    // ponytail: shells out here rather than in git.rs (owned elsewhere this wave); move it there.
    let git = |args: &[&str]| {
        std::process::Command::new("git").args(args).current_dir(root).output().map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default()
    };
    const U: &str = "-U1000000";
    let out = match base {
        Some(b) if b.starts_with("commit:") => git(&["show", "--format=", "--no-color", "--no-ext-diff", U, &b["commit:".len()..], "--", file]),
        Some(b) => {
            let mb = git(&["merge-base", b, "HEAD"]);
            if mb.trim().is_empty() { String::new() } else { git(&["diff", "-M", U, mb.trim(), "HEAD", "--", file]) }
        }
        None => git(&["diff", "-M", U, "HEAD", "--", file]),
    };
    // Untracked files are all-added already.
    if out.trim().is_empty() { diff_patch(root, file, base, false) } else { out }
}

fn read_window_state() -> Option<(f32, f32, Option<(f32, f32)>)> {
    let v: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(data::data_dir().join("window-state.json")).ok()?).ok()?;
    let (w, h) = (v["width"].as_f64()? as f32, v["height"].as_f64()? as f32);
    let pos = v["x"].as_f64().zip(v["y"].as_f64()).map(|(x, y)| (x as f32, y as f32));
    Some((w, h, pos))
}

/// The saved window bounds (Electron's window-state.json), if they still land
/// on a connected display; else centred.
fn initial_bounds(cx: &App) -> Bounds<Pixels> {
    let (w, h, pos) = read_window_state().unwrap_or((1440., 900., None));
    let sz = size(px(w.max(600.)), px(h.max(400.)));
    if let Some((x, y)) = pos {
        let b = Bounds::new(point(px(x), px(y)), sz);
        if cx.displays().iter().any(|d| d.bounds().intersects(&b)) {
            return b;
        }
    }
    Bounds::centered(None, sz, cx)
}

fn write_window_state(b: Bounds<Pixels>) {
    let (o, s) = (b.origin, b.size);
    let v = serde_json::json!({
        "width": f32::from(s.width).round() as i64,
        "height": f32::from(s.height).round() as i64,
        "x": f32::from(o.x).round() as i64,
        "y": f32::from(o.y).round() as i64,
    });
    let _ = std::fs::write(data::data_dir().join("window-state.json"), v.to_string());
}

fn view_name(v: review::View) -> &'static str {
    match v {
        review::View::Review => "review",
        review::View::Files => "files",
        review::View::Search => "search",
    }
}

fn view_of(name: &str) -> review::View {
    match name {
        "files" => review::View::Files,
        "search" => review::View::Search,
        _ => review::View::Review,
    }
}

impl ForestRanger {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let (projects, error) = match data::load_projects() {
            Ok(p) => (p, None),
            Err(e) => (vec![], Some(e)),
        };
        let appearance = cx.observe_window_appearance(window, |_, window, cx| {
            let dark = cx.global::<settings::Settings>().dark(window);
            theme::apply(dark, cx);
            window.refresh();
        });
        // Remember the window's size and position (debounced while dragging).
        let bounds = cx.observe_window_bounds(window, |this, window, cx| {
            this.bounds = Some(window.window_bounds().get_bounds());
            this.save_bounds = Some(cx.spawn(async move |this, cx| {
                cx.background_executor().timer(std::time::Duration::from_millis(400)).await;
                let _ = this.update(cx, |this, _| this.bounds.map(write_window_state));
            }));
        });
        let quit = cx.on_app_quit(|this, cx| {
            if let Some(b) = this.bounds {
                write_window_state(b);
            }
            SessionState::flush(cx);
            async {}
        });
        // Window focus decides whether a finished turn is unread (re-checked on render).
        let activation = cx.observe_window_activation(window, |_, _, cx| cx.notify());
        cx.spawn(async move |this, cx| {
            let clicks = notify::clicks();
            while let Ok((wt, key)) = clicks.recv().await {
                let ok = this.update(cx, |this, cx| {
                    cx.activate(true);
                    this.select(wt, cx);
                    this.focus_tab(&key, cx);
                });
                if ok.is_err() {
                    break;
                }
            }
        })
        .detach();
        let this = Self {
            projects,
            error,
            selected: None,
            project_view: None,
            commands: HashMap::new(),
            expanded: HashSet::new(),
            chats: vec![],
            tabs: Default::default(),
            reviews: Default::default(),
            show_diff: true,
            restored: HashSet::new(),
            upstreams: HashMap::new(),
            bounds: None,
            save_bounds: None,
            back: vec![],
            forward: vec![],
            focus: {
                let f = cx.focus_handle();
                window.focus(&f, cx);
                f
            },
            palette: None,
            looking: None,
            attention: HashMap::new(),
            renaming: None,
            drop_hint: None,
            _subs: vec![appearance, bounds, quit, activation],
        };
        this.load_activity(cx);
        this.sync_all(cx);
        this
    }

    /// Bring the DB in line with `git worktree list` for every project (new or
    /// removed worktrees), then reload the sidebar.
    fn sync_all(&self, cx: &mut Context<Self>) {
        let projects: Vec<(String, String)> = self.projects.iter().map(|p| (p.id.clone(), p.path.clone())).collect();
        let work = cx.background_executor().spawn(async move {
            for (id, path) in projects {
                let _ = data::sync_worktrees(&id, &path);
            }
        });
        cx.spawn(async move |this, cx| {
            work.await;
            let _ = this.update(cx, |this, cx| this.reload(cx));
        })
        .detach();
    }

    /// Re-read projects/worktrees from the DB, keeping known activity times.
    fn reload(&mut self, cx: &mut Context<Self>) {
        let Ok(mut projects) = data::load_projects() else { return };
        let times: std::collections::HashMap<String, i64> =
            self.projects.iter().flat_map(|p| &p.worktrees).map(|w| (w.id.clone(), w.activity)).collect();
        for p in &mut projects {
            for w in &mut p.worktrees {
                w.activity = times.get(&w.id).copied().unwrap_or(0);
            }
            p.worktrees.sort_by(|a, b| b.activity.cmp(&a.activity));
        }
        self.projects = projects;
        self.load_activity(cx);
        if self.project_view.is_some() {
            self.load_page(cx);
        }
        cx.notify();
    }

    fn add_project(&mut self, cx: &mut Context<Self>) {
        let picked = cx.prompt_for_paths(PathPromptOptions { files: false, directories: true, multiple: false, prompt: Some("Add project".into()) });
        cx.spawn(async move |this, cx| {
            let Ok(Ok(Some(paths))) = picked.await else { return };
            let Some(path) = paths.into_iter().next() else { return };
            let result = data::add_project(&path);
            let _ = this.update(cx, |this, cx| match result {
                Ok(id) => {
                    this.error = None;
                    this.expanded.insert(id);
                    this.reload(cx);
                }
                Err(e) => {
                    this.error = Some(e);
                    cx.notify();
                }
            });
        })
        .detach();
    }

    /// Last-activity times need two git calls per worktree — run them off the UI
    /// thread (a few at a time, like the Electron app) and re-sort when done.
    fn load_activity(&self, cx: &mut Context<Self>) {
        let jobs: Vec<(String, String)> =
            self.projects.iter().flat_map(|p| &p.worktrees).map(|w| (w.id.clone(), w.path.clone())).collect();
        let work = cx.background_executor().spawn(async move {
            let next = std::sync::atomic::AtomicUsize::new(0);
            let out = std::sync::Mutex::new(Vec::new());
            std::thread::scope(|s| {
                for _ in 0..6 {
                    s.spawn(|| loop {
                        let i = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        let Some((id, path)) = jobs.get(i) else { break };
                        let at = data::activity(path);
                        out.lock().unwrap().push((id.clone(), at));
                    });
                }
            });
            out.into_inner().unwrap()
        });
        cx.spawn(async move |this, cx| {
            let times: std::collections::HashMap<String, i64> = work.await.into_iter().collect();
            let _ = this.update(cx, |this, cx| {
                for p in &mut this.projects {
                    for w in &mut p.worktrees {
                        w.activity = times.get(&w.id).copied().unwrap_or(0);
                    }
                    p.worktrees.sort_by(|a, b| b.activity.cmp(&a.activity));
                }
                cx.notify();
            });
        })
        .detach();
    }

    fn worktree(&self) -> Option<&data::Worktree> {
        let id = self.selected.as_deref()?;
        self.projects.iter().flat_map(|p| &p.worktrees).find(|w| w.id == id)
    }

    /// Where you are, as a history entry.
    fn location(&self) -> Option<String> {
        self.selected.clone().or_else(|| self.project_view.as_ref().map(|v| format!("project:{}", v.id)))
    }

    fn goto(&mut self, loc: String, cx: &mut Context<Self>) {
        match loc.strip_prefix("project:") {
            Some(pid) => self.show_project(pid.to_string(), cx),
            None => self.show(loc, cx),
        }
    }

    /// Navigate to a worktree (recorded in back/forward history).
    fn select(&mut self, id: String, cx: &mut Context<Self>) {
        if self.selected.as_ref() == Some(&id) {
            return;
        }
        if let Some(prev) = self.location() {
            self.back.push(prev);
        }
        self.forward.clear();
        data::touch_worktree(&id);
        self.show(id, cx);
    }

    fn go_back(&mut self, cx: &mut Context<Self>) {
        if let Some(loc) = self.back.pop() {
            if let Some(cur) = self.location() {
                self.forward.push(cur);
            }
            self.goto(loc, cx);
        }
    }

    fn go_forward(&mut self, cx: &mut Context<Self>) {
        if let Some(loc) = self.forward.pop() {
            if let Some(cur) = self.location() {
                self.back.push(cur);
            }
            self.goto(loc, cx);
        }
    }

    fn show(&mut self, id: String, cx: &mut Context<Self>) {
        self.project_view = None;
        self.selected = Some(id);
        if let Some(p) = self.projects.iter().find(|p| p.worktrees.iter().any(|w| Some(&w.id) == self.selected.as_ref())) {
            self.expanded.insert(p.id.clone());
        }
        let Some(wt) = self.worktree() else { return };
        let (wt_id, path) = (wt.id.clone(), wt.path.clone());
        if let Some(pid) = self.projects.iter().find(|p| p.worktrees.iter().any(|w| w.id == wt_id)).map(|p| p.id.clone()) {
            self.ensure_commands(&pid);
        }
        self.chats = data::chats_for(&wt_id);
        let panel = SessionState::get(cx).panel(&wt_id);
        self.show_diff = panel.open;
        // Pin a first visit's (inherited) state to this worktree, so it stays as
        // you left it here rather than following later changes elsewhere.
        if SessionState::get(cx).worktrees.get(&wt_id).is_none_or(|w| w.panel.is_none()) {
            let p = panel.clone();
            SessionState::update(cx, |s| s.set_panel(&wt_id, p));
        }
        if let Some(r) = self.reviews.get(&wt_id) {
            r.update(cx, |r, cx| {
                r.view = view_of(&panel.view);
                cx.notify();
            });
        }
        if !self.upstreams.contains_key(&path) {
            let p = path.clone();
            let work = cx.background_executor().spawn(async move {
                let o = std::process::Command::new("git").args(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).current_dir(&p).output().ok()?;
                let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
                (o.status.success() && !s.is_empty()).then_some(s)
            });
            cx.spawn(async move |this, cx| {
                let up = work.await;
                let _ = this.update(cx, |this, cx| {
                    this.upstreams.insert(path, up);
                    cx.notify();
                });
            })
            .detach();
        }
        cx.notify();
    }

    /// Save the selected worktree's panel state (open + view); unvisited
    /// worktrees inherit it.
    fn save_panel(&mut self, cx: &mut Context<Self>) {
        let Some(id) = self.selected.clone() else { return };
        let review = self.reviews.get(&id).map(|r| r.read(cx)).map(|r| (view_name(r.view), r.show_commits));
        let open = self.show_diff;
        SessionState::update(cx, |s| {
            let mut p = s.panel(&id);
            p.open = open;
            if let Some((v, commits)) = review {
                p.view = v.into();
                p.commits = commits;
            }
            s.set_panel(&id, p);
        });
    }

    fn toggle_panel(&mut self, cx: &mut Context<Self>) {
        self.show_diff = !self.show_diff;
        self.save_panel(cx);
        cx.notify();
    }

    /// ⌘T (worktrees + projects) or ⌘P (files in this worktree); pressing it
    /// again closes it.
    fn toggle_palette(&mut self, files: bool, window: &mut Window, cx: &mut Context<Self>) {
        if self.palette.take().is_some() {
            window.focus(&self.focus, cx);
            cx.notify();
            return;
        }
        let items = if files {
            None
        } else {
            // Most recently active worktrees first, across every project; then projects.
            let mut wts: Vec<(&data::Project, &data::Worktree)> =
                self.projects.iter().flat_map(|p| p.worktrees.iter().map(move |w| (p, w))).collect();
            wts.sort_by(|a, b| b.1.activity.cmp(&a.1.activity));
            let mut items: Vec<palette::Item> = wts
                .into_iter()
                .map(|(p, w)| {
                    let (label, note) = w.label();
                    palette::Item::Worktree { id: w.id.clone(), label, note, project: p.name.clone() }
                })
                .collect();
            items.extend(self.projects.iter().map(|p| palette::Item::Project { id: p.id.clone(), name: p.name.clone() }));
            Some(items)
        };
        let Some(root) = (if files { self.worktree().map(|w| w.path.clone()) } else { Some(String::new()) }) else { return };
        let repo = self.projects.iter().find(|p| p.worktrees.iter().any(|w| Some(&w.id) == self.selected.as_ref())).map(|p| p.path.clone());
        let pal = cx.new(|cx| palette::Palette::new(files, items, window, cx));
        if files {
            let recent = self.selected.as_deref().and_then(|id| SessionState::worktree(cx, id)).map(|w| w.recent.clone()).unwrap_or_default();
            pal.update(cx, |p, _| p.set_recent(&recent));
            // Every file, plus a diff entry for each changed one (uncommitted wins
            // over committed-vs-base), like the Electron FilePalette.
            let (path, repo) = (root.clone(), repo.unwrap_or_default());
            let work = cx.background_executor().spawn(async move {
                let (files, ignored) = git::list_files(&path);
                let d = git::detail(&path, &repo, None);
                let mut diff_base: std::collections::HashMap<String, Option<String>> =
                    d.committed.iter().map(|f| (f.path.clone(), d.base.clone())).collect();
                diff_base.extend(d.uncommitted.iter().map(|f| (f.path.clone(), None)));
                let mut items = vec![];
                for f in &files {
                    items.push(palette::Item::File { path: f.clone(), ignored: false });
                    if let Some(base) = diff_base.get(f) {
                        items.push(palette::Item::Diff { path: f.clone(), base: base.clone() });
                    }
                }
                items.extend(ignored.into_iter().filter(|p| !p.ends_with('/')).map(|p| palette::Item::File { path: p, ignored: true }));
                let listed: std::collections::HashSet<&String> = files.iter().collect();
                items.extend(
                    diff_base.into_iter().filter(|(p, _)| !listed.contains(p)).map(|(path, base)| palette::Item::Diff { path, base }),
                );
                items
            });
            let p = pal.clone();
            cx.spawn(async move |_, cx| {
                let items = work.await;
                let _ = p.update(cx, |p, cx| p.set_items(items, cx));
            })
            .detach();
        }
        let sub = cx.subscribe_in(&pal, window, move |this, _, ev: &palette::PaletteEvent, window, cx| {
            this.palette = None;
            window.focus(&this.focus, cx);
            if let palette::PaletteEvent::Pick(item) = ev {
                match item.clone() {
                    palette::Item::Worktree { id, .. } => this.select(id, cx),
                    palette::Item::Project { id, .. } => this.open_project(id, cx),
                    palette::Item::File { path, .. } => this.open_file(&root, &path, None, window, cx),
                    palette::Item::Diff { path, base } => this.open_diff(&root, &path, base, cx),
                }
            }
            cx.notify();
        });
        self.palette = Some((pal, sub));
        cx.notify();
    }

    /// The selected worktree's Review panel, created on first visit.
    fn review(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Option<Entity<review::ReviewPanel>> {
        let id = self.selected.clone()?;
        if let Some(r) = self.reviews.get(&id) {
            return Some(r.clone());
        }
        let (pid, repo, path) = self.projects.iter().find_map(|p| {
            let w = p.worktrees.iter().find(|w| w.id == id)?;
            Some((p.id.clone(), p.path.clone(), w.path.clone()))
        })?;
        let saved = SessionState::get(cx).panel(&id);
        let view = view_of(&saved.view);
        let panel = cx.new(|cx| {
            let mut r = review::ReviewPanel::new(&pid, &path, &repo, window, cx);
            r.view = view;
            if saved.commits {
                r.show_commits = true;
                r.refresh(cx);
            }
            r
        });
        let sub = cx.subscribe_in(&panel, window, move |this, _, ev: &review::ReviewEvent, window, cx| match ev {
            review::ReviewEvent::OpenDiff { file, base } => this.open_diff(&path, file, base.clone(), cx),
            review::ReviewEvent::OpenFile { rel, line } => this.open_file(&path, rel, *line, window, cx),
            review::ReviewEvent::Changed => this.load_activity(cx),
            review::ReviewEvent::CommitsToggled => this.save_panel(cx),
            review::ReviewEvent::Pin => {
                if let Some(tabs) = this.tabs_mut() {
                    tabs.preview = None;
                    cx.notify();
                }
            }
            review::ReviewEvent::StartChat(prompt) => {
                let provider = cx.global::<settings::Settings>().provider.clone();
                this.new_chat(&provider, window, cx);
                if let Some(Tab::Chat(chat)) = this.tabs_mut().and_then(|t| t.open.last()) {
                    let chat = chat.clone();
                    chat.update(cx, |c, cx| c.send_text(prompt.clone(), cx));
                }
            }
        });
        self._subs.push(sub);
        self.reviews.insert(id, panel.clone());
        Some(panel)
    }

    /// Focus tab `i`: bumps it in the focus order and saves the tab state.
    fn activate(&mut self, i: usize, cx: &mut Context<Self>) {
        let Some(key) = self.tabs_mut().and_then(|t| t.open.get(i)).map(|t| t.key(cx)) else { return };
        let tabs = self.tabs_mut().unwrap();
        // A tab not placed yet opens in the focused group.
        let focus = tabs.active.and_then(|a| tabs.open.get(a)).map(|t| t.key(cx));
        tabs.layout = std::mem::take(&mut tabs.layout).insert(std::slice::from_ref(&key), focus.as_deref()).set_active(&key);
        tabs.active = Some(i);
        tabs.mru.retain(|k| *k != key);
        tabs.mru.insert(0, key);
        self.persist_tabs(cx);
        cx.notify();
    }

    /// Write the selected worktree's tabs to the session state. Skipped until its
    /// saved tabs have been reopened, so an early open can't wipe them.
    fn persist_tabs(&mut self, cx: &mut Context<Self>) {
        let Some(id) = self.selected.clone().filter(|id| self.restored.contains(id)) else { return };
        let Some(tabs) = self.tabs.get(&id) else { return };
        let keys = tabs.keys(cx);
        let active = tabs.active.and_then(|i| keys.get(i).cloned());
        let (mru, preview) = (tabs.mru.clone(), tabs.preview.clone());
        let layout = tabs.layout.clone().reconcile(&keys, active.as_deref());
        SessionState::update(cx, |s| {
            let w = s.worktree_mut(&id);
            w.tabs = keys;
            w.active = active;
            w.mru = mru;
            w.preview = preview;
            w.layout = Some(layout);
        });
    }

    /// Reopen a worktree's tabs from the last run (first visit only). Chats load
    /// their history but start no agent until you send.
    fn restore_tabs(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if self.restored.contains(id) {
            return;
        }
        self.restored.insert(id.to_string());
        let Some(saved) = SessionState::worktree(cx, id).cloned() else { return };
        let Some(path) = self.projects.iter().flat_map(|p| &p.worktrees).find(|w| w.id == id).map(|w| w.path.clone()) else { return };
        let chats = data::data_dir().join("chats");
        let already: Vec<String> = self.tabs.get(id).map(|t| t.open.iter().map(|t| t.key(cx)).collect()).unwrap_or_default();
        let mut restored = vec![];
        for key in saved.tabs.iter().filter(|k| !already.contains(k)) {
            let tab = if let Some(sid) = key.strip_prefix("chat:") {
                // A chat that never got a message has no log to reopen.
                if !chats.join(format!("{sid}.jsonl")).exists() {
                    continue;
                }
                let chat = cx.new(|cx| ChatView::open(sid, &path, window, cx));
                self.chat_tab(id, chat, window, cx)
            } else if let Some(rel) = key.strip_prefix("file:") {
                Tab::File(self.file_view(&path, rel, None, window, cx))
            } else if let Some((base, file)) = parse_diff_key(key) {
                self.diff_tab(&path, &file, base, false, cx)
            } else if let Some(tid) = key.strip_prefix("term:") {
                // Its shell ended with the app: a fresh one in the worktree.
                let Ok(session) = term::start(&path, None) else { continue };
                Tab::Term(self.term_view(session, Some(tid.into()), cx))
            } else {
                continue;
            };
            restored.push(tab);
        }
        let tabs = self.tabs.entry(id.to_string()).or_default();
        let n = restored.len();
        tabs.open.splice(0..0, restored);
        tabs.active = tabs.active.map(|i| i + n);
        let keys: Vec<String> = tabs.open.iter().map(|t| t.key(cx)).collect();
        if tabs.active.is_none() {
            tabs.active = saved.active.and_then(|a| keys.iter().position(|k| *k == a)).or(keys.len().checked_sub(1));
        }
        tabs.mru = saved.mru.into_iter().filter(|k| keys.contains(k)).collect();
        tabs.preview = tabs.preview.take().or(saved.preview).filter(|k| keys.contains(k));
        let focus = tabs.active.and_then(|i| keys.get(i).cloned());
        tabs.layout = saved.layout.unwrap_or_default().reconcile(&keys, focus.as_deref());
        // Restoring grabbed focus for each chat's composer; give it back.
        window.focus(&self.focus, cx);
        self.persist_tabs(cx);
    }

    /// Focus the tab with `key` if it's open; true if found.
    fn focus_tab(&mut self, key: &str, cx: &mut Context<Self>) -> bool {
        let keys: Vec<String> = self.tabs_mut().map(|t| t.open.iter().map(|t| t.key(cx)).collect()).unwrap_or_default();
        match keys.iter().position(|k| k == key) {
            Some(i) => {
                self.activate(i, cx);
                true
            }
            None => false,
        }
    }

    fn push_tab(&mut self, tab: Tab, cx: &mut Context<Self>) {
        let Some(tabs) = self.tabs_mut() else { return };
        tabs.open.push(tab);
        let i = tabs.open.len() - 1;
        self.activate(i, cx);
    }

    /// Open a file/diff tab as the worktree's preview: it takes the existing
    /// preview tab's place, or opens a new one.
    fn push_preview(&mut self, tab: Tab, cx: &mut Context<Self>) {
        let key = tab.key(cx);
        let Some(tabs) = self.tabs_mut() else { return };
        let slot = tabs.preview.take().and_then(|p| tabs.index(&p, cx).map(|i| (i, p)));
        tabs.preview = Some(key.clone());
        match slot {
            Some((i, old)) => {
                tabs.layout = std::mem::take(&mut tabs.layout).rename(&old, &key);
                tabs.open[i] = tab;
                self.activate(i, cx);
            }
            None => self.push_tab(tab, cx),
        }
    }

    fn pin_tab(&mut self, i: usize, cx: &mut Context<Self>) {
        let Some(tabs) = self.tabs_mut() else { return };
        let key = tabs.open.get(i).map(|t| t.key(cx));
        if key.is_some() && tabs.preview == key {
            tabs.preview = None;
            cx.notify();
        }
    }

    fn diff_tab(&self, root: &str, file: &str, base: Option<String>, full: bool, cx: &mut Context<Self>) -> Tab {
        let key = format!("diff:{}:{file}", base.as_deref().unwrap_or("working"));
        let files = DiffFile::parse(&diff_patch(root, file, base.as_deref(), full)).unwrap_or_default();
        let name = file.rsplit('/').next().unwrap_or(file);
        let title = match base.as_deref() {
            None => format!("{name} (changes)"),
            Some(b) if b.starts_with("commit:") => format!("{name} @ {}", &b[7..14.min(b.len())]),
            Some(b) => format!("{name} vs {b}"),
        };
        let state = cx.new(|cx| DiffState::new(files, cx).with_mode(DiffMode::Split));
        Tab::Diff { key, title, state, root: root.into(), file: file.into(), base, full, fixed: false }
    }

    fn open_diff(&mut self, root: &str, file: &str, base: Option<String>, cx: &mut Context<Self>) {
        if let Some(id) = self.selected.clone() {
            SessionState::update(cx, |s| s.worktree_mut(&id).record_recent(file));
        }
        let key = format!("diff:{}:{file}", base.as_deref().unwrap_or("working"));
        // Re-opening refreshes the diff in place.
        if let Some(Tab::Diff { state, full, .. }) =
            self.tabs_mut().and_then(|t| t.open.iter().find(|t| matches!(t, Tab::Diff { key: k, .. } if *k == key)))
        {
            let (state, full) = (state.clone(), *full);
            let files = DiffFile::parse(&diff_patch(root, file, base.as_deref(), full)).unwrap_or_default();
            state.update(cx, |s, cx| s.set_files(files, cx));
            self.focus_tab(&key, cx);
            return;
        }
        let tab = self.diff_tab(root, file, base, false, cx);
        self.push_preview(tab, cx);
    }

    /// Flip a diff tab between split/unified, or between hunks and the whole file.
    fn toggle_diff(&mut self, i: usize, full_file: bool, cx: &mut Context<Self>) {
        let Some(Tab::Diff { state, root, file, base, full, fixed, .. }) = self.tabs_mut().and_then(|t| t.open.get_mut(i)) else { return };
        let state = state.clone();
        if full_file {
            if *fixed {
                return;
            }
            *full = !*full;
            let files = DiffFile::parse(&diff_patch(root, file, base.as_deref(), *full)).unwrap_or_default();
            state.update(cx, |s, cx| s.set_files(files, cx));
        } else {
            state.update(cx, |s, cx| {
                let mode = if s.mode() == DiffMode::Split { DiffMode::Unified } else { DiffMode::Split };
                s.set_mode(mode, cx)
            });
        }
        cx.notify();
    }

    /// A FileView whose first edit pins its tab.
    fn file_view(&mut self, root: &str, rel: &str, line: Option<u32>, window: &mut Window, cx: &mut Context<Self>) -> Entity<files::FileView> {
        let view = cx.new(|cx| files::FileView::new(root, rel, line, window, cx));
        let key = format!("file:{rel}");
        // ponytail: kept for the app's life like the review subs; move onto the tab if it grows.
        let sub = cx.subscribe(&view, move |this, _, ev: &files::FileEvent, cx| {
            if matches!(ev, files::FileEvent::Edited) {
                for tabs in this.tabs.values_mut() {
                    if tabs.preview.as_deref() == Some(&key) {
                        tabs.preview = None;
                    }
                }
            }
            cx.notify();
        });
        self._subs.push(sub);
        view
    }

    fn open_file(&mut self, root: &str, rel: &str, line: Option<u32>, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(id) = self.selected.clone() {
            SessionState::update(cx, |s| s.worktree_mut(&id).record_recent(rel));
        }
        let key = format!("file:{rel}");
        let open = self.tabs_mut().and_then(|t| {
            t.open.iter().find_map(|t| match t {
                Tab::File(f) if format!("file:{}", f.read(cx).rel) == key => Some(f.clone()),
                _ => None,
            })
        });
        if let Some(f) = open {
            if let Some(line) = line {
                f.update(cx, |f, cx| f.goto_line(line, window, cx));
            }
            self.focus_tab(&key, cx);
            return;
        }
        let view = self.file_view(root, rel, line, window, cx);
        self.push_preview(Tab::File(view), cx);
    }

    /// ⌥⌘S: save every edited file, in every worktree.
    fn save_all(&mut self, cx: &mut Context<Self>) {
        let dirty: Vec<Entity<files::FileView>> = self
            .tabs
            .values()
            .flat_map(|t| &t.open)
            .filter_map(|t| match t {
                Tab::File(f) if f.read(cx).is_dirty() => Some(f.clone()),
                _ => None,
            })
            .collect();
        for f in dirty {
            f.update(cx, |f, cx| f.save(cx));
        }
    }

    fn set_review_view(&mut self, view: review::View, window: &mut Window, cx: &mut Context<Self>) {
        self.show_diff = true;
        if let Some(r) = self.review(window, cx) {
            r.update(cx, |r, cx| {
                r.view = view;
                cx.notify();
            });
        }
        self.save_panel(cx);
        cx.notify();
    }

    fn tabs_mut(&mut self) -> Option<&mut Tabs> {
        let id = self.selected.clone()?;
        Some(self.tabs.entry(id).or_default())
    }

    fn open_saved(&mut self, ix: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(path) = self.worktree().map(|w| w.path.clone()) else { return };
        let sid = self.chats[ix].session_id.clone();
        if self.focus_tab(&format!("chat:{sid}"), cx) {
            return;
        }
        let chat = cx.new(|cx| ChatView::open(&sid, &path, window, cx));
        let Some(wt) = self.selected.clone() else { return };
        let tab = self.chat_tab(&wt, chat, window, cx);
        self.push_tab(tab, cx);
    }

    /// Open a terminal tab in worktree `wt` (going there first), running
    /// `command` (label, command line) if given.
    pub(crate) fn open_terminal(&mut self, wt: &str, cwd: &str, command: Option<(String, String)>, window: &mut Window, cx: &mut Context<Self>) {
        let command_label = command.as_ref().map(|c| c.0.clone());
        let session = match term::start(cwd, command) {
            Ok(s) => s,
            Err(e) => return window.push_notification(Notification::error(format!("Couldn't start a terminal: {e}")), cx),
        };
        let label = command_label;
        let view = self.term_view(session, None, cx);
        // A run command's tab keeps its label when reopened after a restart.
        if let Some(label) = label {
            let key = format!("term:{}", view.read(cx).id);
            SessionState::update(cx, |s| {
                s.worktree_mut(wt).titles.insert(key, label);
            });
        }
        self.select(wt.to_string(), cx);
        self.push_tab(Tab::Term(view.clone()), cx);
        let focus = view.read(cx).focus_handle(cx);
        window.focus(&focus, cx);
    }

    fn term_view(&mut self, session: term::Session, id: Option<String>, cx: &mut Context<Self>) -> Entity<term::TerminalView> {
        let view = cx.new(|cx| term::TerminalView::new(session, id, cx));
        // ponytail: kept for the app's life like the file-view subs.
        self._subs.push(cx.subscribe(&view, |_, _, _: &term::TermChanged, cx| cx.notify()));
        view
    }

    fn new_chat(&mut self, provider: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some((pid, wid, path)) = self.projects.iter().find_map(|p| {
            let w = p.worktrees.iter().find(|w| Some(&w.id) == self.selected.as_ref())?;
            Some((p.id.clone(), w.id.clone(), w.path.clone()))
        }) else {
            return;
        };
        let chat_log = log::ChatLog::new(uuid::Uuid::new_v4().to_string(), wid.clone(), pid, provider.into());
        let chat = cx.new(|cx| ChatView::new(chat_log, &path, window, cx));
        let tab = self.chat_tab(&wid, chat, window, cx);
        self.push_tab(tab, cx);
    }

    fn close_tab(&mut self, i: usize, cx: &mut Context<Self>) {
        let Some(tabs) = self.tabs_mut() else { return };
        if i < tabs.open.len() {
            let was_active = tabs.active == Some(i);
            let key = tabs.open.remove(i).key(cx);
            tabs.mru.retain(|k| *k != key);
            if tabs.preview.as_ref() == Some(&key) {
                tabs.preview = None;
            }
            // Its group falls back to the group's most recently used tab; a group
            // left empty collapses.
            let siblings: Vec<String> = tabs.layout.group_of(&key).map(|g| g.tabs.iter().filter(|t| **t != key).cloned().collect()).unwrap_or_default();
            let sibling = session_state::next_focus(&siblings, &tabs.mru).cloned();
            let was_group_active = tabs.layout.group_of(&key).is_some_and(|g| g.active.as_ref() == Some(&key));
            tabs.layout = std::mem::take(&mut tabs.layout).remove(&key);
            if let Some(s) = sibling.as_ref().filter(|_| was_group_active) {
                tabs.layout = std::mem::take(&mut tabs.layout).set_active(s);
            }
            let keys = tabs.keys(cx);
            tabs.active = if was_active {
                sibling.or_else(|| session_state::next_focus(&keys, &tabs.mru).cloned()).and_then(|k| keys.iter().position(|x| *x == k))
            } else {
                tabs.active.map(|a| if a > i { a - 1 } else { a })
            };
            match tabs.active {
                Some(a) => self.activate(a, cx),
                None => self.persist_tabs(cx),
            }
        }
        // Closing saves the chat; refresh the list so it's offered again.
        if let Some(id) = self.selected.clone() {
            self.chats = data::chats_for(&id);
        }
        self.update_badge(cx);
        cx.notify();
    }

    /// A bordered icon button, like the Electron titlebar's `.iconBtn`.
    fn icon_btn(&self, id: &'static str, icon: &'static str, active: bool, cx: &mut Context<Self>) -> Stateful<Div> {
        let theme = cx.theme().colors;
        let x = theme::extra(cx);
        div()
            .id(id)
            .flex()
            .items_center()
            .justify_center()
            .p(px(6.))
            .rounded(px(6.))
            .border_1()
            .border_color(x.border_strong)
            .flex_shrink_0()
            .cursor_pointer()
            .hover(|s| s.bg(x.hover))
            .when(active, |d| d.bg(x.active))
            .child(sidebar::icon(icon, 15., if active { theme.foreground } else { theme.muted_foreground }))
    }

    /// The top strip over the main area (Titlebar.tsx): history, breadcrumb, actions.
    fn titlebar(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().colors;
        let x = theme::extra(cx);
        let nav = |id: &'static str, icon: &'static str, enabled: bool| {
            div()
                .id(id)
                .size(px(26.))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(6.))
                .when(enabled, |d| d.cursor_pointer().hover(|s| s.bg(x.hover)))
                .child(sidebar::icon(icon, 16., if enabled { theme.muted_foreground } else { x.faint.opacity(0.5) }))
        };
        let bar = div()
            .flex()
            .items_center()
            .gap_3()
            .h(px(40.))
            .flex_shrink_0()
            .px(px(14.))
            .bg(theme.background)
            .border_b_1()
            .border_color(theme.border)
            .child(
                div()
                    .flex()
                    .gap(px(2.))
                    .child(nav("back", "fr/arrow-left.svg", !self.back.is_empty()).tooltip(sidebar::tip("Back  ⌘[  ·  ⌃-")).on_click(cx.listener(|this, _, _, cx| this.go_back(cx))))
                    .child(nav("fwd", "fr/arrow-right.svg", !self.forward.is_empty()).tooltip(sidebar::tip("Forward  ⌘]  ·  ⌃+")).on_click(cx.listener(|this, _, _, cx| this.go_forward(cx)))),
            );
        if self.project_view.is_some() {
            return self.project_titlebar(bar, cx);
        }
        let Some((project, wt)) = self.projects.iter().find_map(|p| {
            let w = p.worktrees.iter().find(|w| Some(&w.id) == self.selected.as_ref())?;
            Some((p, w))
        }) else {
            return bar.child(div().flex_1()).into_any_element();
        };
        let run = self.run_buttons(&project.id, &wt.path, cx);
        let (add_fr, add_pid) = (cx.entity(), project.id.clone());
        // The real branch, not the label; a detached worktree is named for where it came from.
        let branch = wt.branch.clone();
        let label = branch.clone().or_else(|| wt.detached_from.clone()).unwrap_or_else(|| wt.label().0);
        let upstream = self.upstreams.get(&wt.path).cloned().flatten();
        let project_id = project.id.clone();
        let path = wt.path.clone();
        let open_ids: Vec<String> = self
            .tabs
            .get(&wt.id)
            .map(|t| t.open.iter().filter_map(|t| match t { Tab::Chat(c) => Some(c.read(cx).session_id().to_string()), _ => None }).collect())
            .unwrap_or_default();
        let reopenable: Vec<(usize, String, String)> = self
            .chats
            .iter()
            .enumerate()
            .filter(|(_, c)| !open_ids.contains(&c.session_id))
            .map(|(i, c)| (i, c.name.clone(), data::relative_time(c.updated_at)))
            .collect();
        let provider = cx.global::<settings::Settings>().provider.clone();
        let this = cx.entity();
        bar.child(
            div()
                .flex()
                .items_center()
                .gap_2()
                .flex_1()
                .min_w_0()
                .text_size(px(13.5))
                .font_weight(FontWeight::SEMIBOLD)
                .child(
                    div()
                        .id("crumb-project")
                        .px_1()
                        .rounded(px(4.))
                        .cursor_pointer()
                        .hover(|s| s.bg(x.hover))
                        .child(project.name.clone())
                        .on_click(cx.listener(move |this, _, _, cx| this.open_project(project_id.clone(), cx))),
                )
                .child(div().font_weight(FontWeight::NORMAL).text_color(x.faint).child("/"))
                .child(
                    div()
                        .id("crumb-branch")
                        .flex()
                        .items_center()
                        .gap_2()
                        .min_w_0()
                        .child(sidebar::icon("fr/git-branch.svg", 15., theme.foreground))
                        .child(div().truncate().child(label))
                        .tooltip({
                            let path = path.clone();
                            move |window, cx| Tooltip::new(path.clone()).build(window, cx)
                        }),
                )
                .when(branch.is_none(), |d| d.child(div().font_weight(FontWeight::NORMAL).text_color(x.faint).child("(detached)")))
                .when_some(upstream, |d, u| d.child(div().font_weight(FontWeight::NORMAL).text_color(x.faint).child(format!("→ {u}")))),
        )
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(6.))
                // ✦ Chat — split: the face starts a chat, the arrow offers the other
                // agent and this worktree's past chats.
                .child(
                    div()
                        .flex()
                        .items_stretch()
                        .overflow_hidden()
                        .rounded(px(6.))
                        .border_1()
                        .border_color(x.border_strong)
                        .text_size(px(12.5))
                        .text_color(theme.muted_foreground)
                        .child(
                            div()
                                .id("chat")
                                .tooltip(sidebar::tip("New chat"))
                                .flex()
                                .items_center()
                                .gap(px(6.))
                                .px(px(10.))
                                .py(px(5.))
                                .cursor_pointer()
                                .hover(|s| s.bg(x.hover).text_color(theme.foreground))
                                .child(sidebar::icon("fr/sparkle.svg", 13., theme.primary))
                                .child("Chat")
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    let p = cx.global::<settings::Settings>().provider.clone();
                                    this.new_chat(&p, window, cx)
                                })),
                        )
                        .child(div().w(px(1.)).bg(x.border_strong))
                        .child(
                            Button::new("chat-more")
                                .tooltip("Reopen a past chat")
                                .ghost()
                                .compact()
                                .px(px(6.))
                                .h_full()
                                .rounded_none()
                                .icon(Icon::empty().path("fr/chevron-down.svg"))
                                .dropdown_menu_with_anchor(Anchor::TopRight, move |menu, _, _| {
                                    let other = if provider == "codex" { "claude" } else { "codex" };
                                    let t = this.clone();
                                    let menu = menu.item(
                                        PopupMenuItem::new(format!("New {} chat", if other == "codex" { "Codex" } else { "Claude" }))
                                            .on_click(move |_, window, cx| t.update(cx, |v, cx| v.new_chat(other, window, cx))),
                                    );
                                    if reopenable.is_empty() {
                                        return menu;
                                    }
                                    reopenable.iter().fold(menu.separator().label("Reopen"), |menu, (i, name, when)| {
                                        let (t, i, name, when) = (this.clone(), *i, SharedString::from(name.clone()), SharedString::from(when.clone()));
                                        let item = PopupMenuItem::element(move |_, cx| {
                                            div()
                                                .flex()
                                                .items_center()
                                                .gap_4()
                                                .w_full()
                                                .child(div().flex_1().max_w(px(320.)).truncate().child(name.clone()))
                                                .child(div().flex_shrink_0().text_xs().text_color(theme::extra(cx).faint).child(when.clone()))
                                        });
                                        menu.item(item.on_click(move |_, window, cx| t.update(cx, |v, cx| v.open_saved(i, window, cx))))
                                    })
                                }),
                        ),
                )
                .child(self.icon_btn("editor", "fr/folder.svg", false, cx).tooltip(sidebar::tip("Open in editor")).on_click({
                    let path = path.clone();
                    move |_, window, cx| {
                        let editor = cx.global::<settings::Settings>().editor.clone();
                        if let Err(e) = settings::try_open_in(editor.as_deref(), &path, "editor") {
                            let msg = match &editor {
                                Some(app) => format!("Couldn't open in {}: {e}", settings::app_label(app)),
                                None => format!("{e} — install one (e.g. VS Code)."),
                            };
                            window.push_notification(Notification::error(msg), cx);
                        }
                    }
                }))
                .child(self.icon_btn("terminal", "fr/terminal.svg", false, cx).tooltip(sidebar::tip("New terminal (⌃`)")).on_click(cx.listener({
                    let (id, path) = (wt.id.clone(), path.clone());
                    move |this, _, window, cx| this.open_terminal(&id, &path, None, window, cx)
                })))
                .child(div().w(px(1.)).h(px(20.)).mx(px(2.)).bg(theme.border))
                .children(run)
                .child(
                    Button::new("more")
                        .tooltip("More")
                        .ghost()
                        .icon(Icon::empty().path("fr/ellipsis.svg"))
                        .dropdown_menu_with_anchor(Anchor::TopRight, move |menu, _, _| {
                            let p = path.clone();
                            let (fr, pid) = (add_fr.clone(), add_pid.clone());
                            menu.item(PopupMenuItem::new("Add run command…").on_click(move |_, window, cx| {
                                project_view::commands::command_dialog(fr.clone(), pid.clone(), None, window, cx)
                            }))
                            .item(PopupMenuItem::new("Reveal in Finder").on_click(move |_, _, _| settings::reveal(&p)))
                        }),
                )
                .child(
                    self.icon_btn("panel", "fr/panel-right.svg", self.show_diff, cx)
                        .tooltip(sidebar::tip(if self.show_diff { "Hide review panel (⌘B)" } else { "Show review panel (⌘B)" }))
                        .on_click(cx.listener(|this, _, _, cx| this.toggle_panel(cx))),
                ),
        )
        .into_any_element()
    }

    fn center(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().colors;
        let x = theme::extra(cx);
        if self.worktree().is_none() {
            return div()
                .size_full()
                .flex()
                .items_center()
                .justify_center()
                .text_color(theme.muted_foreground)
                .child("Pick a worktree")
                .into_any_element();
        }
        let tabs = self.selected.as_ref().and_then(|id| self.tabs.get(id));
        match tabs.filter(|t| !t.open.is_empty()) {
            Some(tabs) => self.pane(&tabs.layout, tabs, cx),
            None => div()
                .size_full()
                .flex()
                .flex_col()
                .gap_1()
                .items_center()
                .justify_center()
                .text_color(theme.muted_foreground)
                .child("Start a chat with ✦ Chat")
                .when(!self.chats.is_empty(), |d| {
                    d.child(div().text_sm().text_color(x.faint).child(format!(
                        "{} past chat{} here — reopen from the Chat ▾ menu",
                        self.chats.len(),
                        if self.chats.len() == 1 { "" } else { "s" }
                    )))
                })
                .into_any_element(),
        }
    }

    /// A layout node: a tab group, or a split of them with draggable dividers.
    fn pane(&self, node: &panes::Node, tabs: &Tabs, cx: &mut Context<Self>) -> AnyElement {
        let (id, dir, children, sizes) = match node {
            panes::Node::Group(g) => return self.pane_group(g, tabs, cx),
            panes::Node::Split { id, dir, children, sizes } => (id.clone(), *dir, children, sizes),
        };
        let row = dir == panes::Dir::Row;
        let border = cx.theme().colors.border;
        let mut cells: Vec<AnyElement> = vec![];
        for (i, child) in children.iter().enumerate() {
            if i > 0 {
                let divider = DraggedDivider { split: id.clone(), ix: i - 1 };
                cells.push(
                    div()
                        .id(SharedString::from(format!("divider-{id}-{i}")))
                        .flex_shrink_0()
                        .flex()
                        .justify_center()
                        .items_center()
                        .map(|d| if row { d.w(px(5.)).h_full().cursor_col_resize() } else { d.h(px(5.)).w_full().cursor_row_resize() })
                        .child(div().map(|d| if row { d.w(px(1.)).h_full() } else { d.h(px(1.)).w_full() }).bg(border))
                        .on_drag(divider, |d, _, _, cx| cx.new(|_| d.clone()))
                        .into_any_element(),
                );
            }
            let grow = sizes.get(i).copied().unwrap_or(1.);
            cells.push(
                div()
                    .flex_basis(px(0.))
                    .min_w_0()
                    .min_h_0()
                    .overflow_hidden()
                    .map(|mut d| {
                        d.style().flex_grow = Some(grow);
                        d
                    })
                    .child(self.pane(child, tabs, cx))
                    .into_any_element(),
            );
        }
        let split = id.clone();
        div()
            .id(SharedString::from(format!("split-{id}")))
            .flex()
            .size_full()
            .when(!row, |d| d.flex_col())
            .on_drag_move(cx.listener(move |this, ev: &DragMoveEvent<DraggedDivider>, _, cx| {
                let d = ev.drag(cx).clone();
                if d.split != split {
                    return;
                }
                let (pos, b) = (ev.event.position, ev.bounds);
                let at = if row { (pos.x - b.origin.x) / b.size.width } else { (pos.y - b.origin.y) / b.size.height };
                this.resize_split(&split, d.ix, at, cx);
            }))
            .children(cells)
            .into_any_element()
    }

    /// One tab group: its own strip (drop a tab to move or reorder it) and its
    /// active tab's body (drop on an edge to split).
    fn pane_group(&self, g: &panes::Group, tabs: &Tabs, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().colors;
        let x = theme::extra(cx);
        let gid = g.id.clone();
        let shown = g.active.as_deref().and_then(|k| tabs.index(k, cx));
        let focused = shown.is_some() && shown == tabs.active;
        let dragging = cx.has_active_drag();
        let hint = self.drop_hint.as_ref().filter(|h| dragging && h.0 == gid).map(|h| h.1);
        let strip_gid = gid.clone();
        let strip = div()
            .id(SharedString::from(format!("tabs-{gid}")))
            .flex()
            .items_center()
            .gap_1()
            .px_2()
            .py(px(5.))
            .flex_shrink_0()
            .overflow_x_scroll()
            .border_b_1()
            .border_color(theme.border)
            .drag_over::<DraggedTab>(move |s, _, _, _| s.bg(x.hover))
            .on_drop(cx.listener(move |this, d: &DraggedTab, _, cx| this.move_tab(&d.key, &strip_gid, None, cx)))
            .children(g.tabs.iter().enumerate().filter_map(|(slot, key)| {
                let i = tabs.index(key, cx)?;
                let tab = &tabs.open[i];
                let active = shown == Some(i);
                let preview = tabs.preview.as_ref() == Some(key);
                let lead: AnyElement = match tab {
                    Tab::Chat(c) => status_dot(c.read(cx).attention(), ("tab-dot", i), cx)
                        .unwrap_or_else(|| sidebar::icon("fr/sparkle.svg", 12., theme.primary).into_any_element()),
                    Tab::Diff { .. } => sidebar::icon("fr/git-branch.svg", 12., x.amber).into_any_element(),
                    Tab::File(_) => sidebar::icon("fr/folder.svg", 12., theme.muted_foreground).into_any_element(),
                    Tab::Term(_) => sidebar::icon("fr/terminal.svg", 12., theme.muted_foreground).into_any_element(),
                };
                let title = self.tab_title(tab, cx);
                let editing = self.renaming.as_ref().filter(|r| r.0 == *key).map(|r| r.1.clone());
                let dragged = DraggedTab { key: key.clone(), title: title.clone() };
                let drop_gid = gid.clone();
                Some(
                    div()
                        .id(("tab", i))
                        .tooltip(sidebar::tip(title.clone()))
                        .flex()
                        .items_center()
                        .gap(px(6.))
                        .flex_shrink_0()
                        .max_w(px(220.))
                        .pl(px(9.))
                        .pr_1()
                        .py(px(5.))
                        .rounded(px(6.))
                        .text_size(px(12.))
                        .cursor_pointer()
                        .text_color(if active && focused { theme.foreground } else { theme.muted_foreground })
                        .when(active, |d| d.bg(x.active))
                        .hover(|s| s.bg(x.hover))
                        .on_drag(dragged, |d, _, _, cx| cx.new(|_| d.clone()))
                        .drag_over::<DraggedTab>(move |s, _, _, _| s.border_l_2().border_color(theme.primary))
                        // Dropped on a tab: lands just before it.
                        .on_drop(cx.listener(move |this, d: &DraggedTab, _, cx| this.move_tab(&d.key, &drop_gid, Some(slot), cx)))
                        .child(lead)
                        .map(|d| match editing {
                            Some(input) => d.child(
                                div()
                                    .w(px(150.))
                                    .capture_key_down(cx.listener(|this, ev: &KeyDownEvent, window, cx| {
                                        if ev.keystroke.key == "escape" {
                                            this.renaming = None;
                                            window.focus(&this.focus, cx);
                                            cx.stop_propagation();
                                            cx.notify();
                                        }
                                    }))
                                    .child(Input::new(&input).small()),
                            ),
                            None => d.child(div().truncate().when(preview, |d| d.italic()).child(title)),
                        })
                        .child(
                            div()
                                .id(("close", i))
                                .px_1()
                                .rounded(px(4.))
                                .text_color(x.faint)
                                .hover(|s| s.bg(x.active).text_color(theme.foreground))
                                .child("×")
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    cx.stop_propagation();
                                    this.close_tab(i, cx);
                                })),
                        )
                        .on_click(cx.listener(move |this, ev: &ClickEvent, window, cx| {
                            this.activate(i, cx);
                            if ev.click_count() == 2 {
                                if preview {
                                    this.pin_tab(i, cx);
                                } else {
                                    this.start_rename(i, window, cx);
                                }
                            }
                        })),
                )
            }));
        let (move_gid, drop_gid) = (gid.clone(), gid.clone());
        let catch = div()
            .id(SharedString::from(format!("drop-{gid}")))
            .absolute()
            .inset_0()
            .on_drag_move(cx.listener(move |this, ev: &DragMoveEvent<DraggedTab>, _, cx| {
                let (pos, b) = (ev.event.position, ev.bounds);
                let next = b.contains(&pos).then(|| {
                    let side = panes::drop_at(f32::from(pos.x - b.origin.x), f32::from(pos.y - b.origin.y), f32::from(b.size.width), f32::from(b.size.height));
                    (move_gid.clone(), side)
                });
                let mine = this.drop_hint.as_ref().is_some_and(|h| h.0 == move_gid);
                if next.is_some() && this.drop_hint != next || next.is_none() && mine {
                    this.drop_hint = next;
                    cx.notify();
                }
            }))
            .on_drop(cx.listener(move |this, d: &DraggedTab, _, cx| {
                let side = this.drop_hint.take().filter(|h| h.0 == drop_gid).map_or(panes::Drop::Center, |h| h.1);
                this.split_tab(&d.key, &drop_gid, side, cx);
            }))
            .children(hint.map(|side| {
                let zone = div().absolute().bg(theme.primary.opacity(0.12)).border_2().border_color(theme.primary.opacity(0.5)).rounded(px(4.));
                match side {
                    panes::Drop::Center => zone.inset_0(),
                    panes::Drop::Left => zone.top_0().bottom_0().left_0().w(relative(0.5)),
                    panes::Drop::Right => zone.top_0().bottom_0().right_0().w(relative(0.5)),
                    panes::Drop::Top => zone.left_0().right_0().top_0().h(relative(0.5)),
                    panes::Drop::Bottom => zone.left_0().right_0().bottom_0().h(relative(0.5)),
                }
            }));
        div()
            .id(SharedString::from(format!("group-{gid}")))
            .flex()
            .flex_col()
            .size_full()
            .min_w_0()
            // Any click into a group focuses it, so the next new tab opens here.
            .when(!focused, |d| {
                d.capture_any_mouse_down(cx.listener(move |this, _, _, cx| {
                    if let Some(i) = shown {
                        this.activate(i, cx);
                    }
                }))
            })
            .child(strip)
            .child(
                div()
                    .flex_1()
                    .min_h_0()
                    .relative()
                    .child(self.tab_body(shown, tabs, cx))
                    .when(dragging, |d| d.child(catch)),
            )
            .into_any_element()
    }

    fn tab_body(&self, shown: Option<usize>, tabs: &Tabs, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().colors;
        let x = theme::extra(cx);
        match shown.and_then(|i| tabs.open.get(i)) {
            Some(Tab::Chat(chat)) => chat.clone().into_any_element(),
            Some(Tab::Diff { state, full, fixed, .. }) => {
                let i = shown.unwrap_or(0);
                let split = state.read(cx).mode() == DiffMode::Split;
                let toggle = |id: &'static str, label: &'static str, on: bool| {
                    div()
                        .id(id)
                        .px_2()
                        .py(px(2.))
                        .rounded(px(4.))
                        .cursor_pointer()
                        .text_color(if on { theme.foreground } else { theme.muted_foreground })
                        .when(on, |d| d.bg(x.active))
                        .hover(|s| s.bg(x.hover))
                        .child(label)
                };
                div()
                    .flex()
                    .flex_col()
                    .size_full()
                    .child(
                        div()
                            .flex()
                            .justify_end()
                            .gap_1()
                            .px_2()
                            .py_1()
                            .text_xs()
                            .border_b_1()
                            .border_color(theme.border)
                            .child(toggle("diff-split", "Split", split).on_click(cx.listener(move |this, _, _, cx| {
                                if !split {
                                    this.toggle_diff(i, false, cx)
                                }
                            })))
                            .child(toggle("diff-unified", "Unified", !split).on_click(cx.listener(move |this, _, _, cx| {
                                if split {
                                    this.toggle_diff(i, false, cx)
                                }
                            })))
                            .when(!*fixed, |d| {
                                d.child(div().w(px(1.)).mx_1().bg(theme.border))
                                    .child(toggle("diff-full", "Full file", *full).on_click(cx.listener(move |this, _, _, cx| this.toggle_diff(i, true, cx))))
                            }),
                    )
                    .child(div().flex_1().min_h_0().child(Diff::new(state).size_full()))
                    .into_any_element()
            }
            Some(Tab::File(f)) => f.clone().into_any_element(),
            Some(Tab::Term(t)) => t.clone().into_any_element(),
            None => div().size_full().into_any_element(),
        }
    }

    /// Drop a tab into a group's strip (at `index`, default the end).
    fn move_tab(&mut self, key: &str, group: &str, index: Option<usize>, cx: &mut Context<Self>) {
        let Some(tabs) = self.tabs_mut() else { return };
        tabs.layout = std::mem::take(&mut tabs.layout).move_tab(key, group, index);
        if let Some(i) = tabs.index(key, cx) {
            self.activate(i, cx);
        }
    }

    /// Drop a tab on a group's body: split it off that edge (centre: move it in).
    fn split_tab(&mut self, key: &str, group: &str, side: panes::Drop, cx: &mut Context<Self>) {
        let Some(tabs) = self.tabs_mut() else { return };
        tabs.layout = std::mem::take(&mut tabs.layout).split_off(key, group, side);
        if let Some(i) = tabs.index(key, cx) {
            self.activate(i, cx);
        }
    }

    fn resize_split(&mut self, split: &str, ix: usize, at: f32, cx: &mut Context<Self>) {
        let Some(tabs) = self.tabs_mut() else { return };
        let Some(sizes) = tabs.layout.sizes(split).and_then(|s| panes::resize(s, ix, at)) else { return };
        tabs.layout = std::mem::take(&mut tabs.layout).set_sizes(split, sizes);
        self.persist_tabs(cx);
        cx.notify();
    }

    /// Keep the selected worktree's layout holding exactly its open tabs (a tab
    /// opened while another worktree was selected lands in the focused group).
    fn reconcile_layout(&mut self, cx: &mut Context<Self>) {
        let Some(tabs) = self.selected.as_ref().and_then(|id| self.tabs.get_mut(id)) else { return };
        let keys = tabs.keys(cx);
        let have = tabs.layout.all_tabs();
        if have.len() != keys.len() || keys.iter().any(|k| !have.contains(k)) {
            let focus = tabs.active.and_then(|i| keys.get(i).cloned());
            tabs.layout = std::mem::take(&mut tabs.layout).reconcile(&keys, focus.as_deref());
        }
    }
}

/// Chats talking to the shell: their tabs, dots, notifications and renames.
impl ForestRanger {
    /// Wrap a chat in a tab of worktree `wt`, listening to what it asks of the shell.
    fn chat_tab(&mut self, wt: &str, chat: Entity<ChatView>, window: &mut Window, cx: &mut Context<Self>) -> Tab {
        // Not looked at until it's the visible tab (see sync_focus).
        chat.update(cx, |c, cx| c.set_focused_by_user(false, cx));
        let wt = wt.to_string();
        let sub = cx.subscribe_in(&chat, window, move |this, chat, ev: &ChatEvent, window, cx| match ev {
            ChatEvent::OpenDiff { path, old, new } => this.open_agent_diff(&wt, path, old, new, cx),
            ChatEvent::Branched { log_id } => this.open_branch(&wt, log_id, window, cx),
            ChatEvent::TitleChanged => {
                if this.selected.as_deref() == Some(&wt) {
                    this.chats = data::chats_for(&wt);
                }
                cx.notify();
            }
            ChatEvent::StatusChanged => this.chat_status(&wt, chat, window, cx),
        });
        self._subs.push(sub);
        Tab::Chat(chat)
    }

    /// A chat's attention changed: notify if it needs you in the background, then
    /// refresh the badge and dots.
    fn chat_status(&mut self, wt: &str, chat: &Entity<ChatView>, window: &mut Window, cx: &mut Context<Self>) {
        let c = chat.read(cx);
        let now = c.attention();
        let prev = self.attention.insert(chat.entity_id(), now);
        if !window.is_window_active() && prev != Some(now) {
            let target = (wt.to_string(), format!("chat:{}", c.session_id()));
            let label = c.title();
            match now {
                Attention::NeedsAnswer => notify::post("Permission needed", &format!("{label} is waiting for your answer."), target),
                Attention::Unread => notify::post("Chat finished", &format!("{label} finished its turn."), target),
                _ => {}
            }
        }
        self.update_badge(cx);
        cx.notify();
    }

    fn chats(&self) -> impl Iterator<Item = (&String, &Entity<ChatView>)> {
        self.tabs.iter().flat_map(|(wt, t)| t.open.iter().filter_map(move |t| match t {
            Tab::Chat(c) => Some((wt, c)),
            _ => None,
        }))
    }

    /// Dock badge: chats waiting on an answer.
    // ponytail: counts chats, not requests; a chat with two open prompts counts once.
    fn update_badge(&self, cx: &App) {
        notify::set_badge(self.chats().filter(|(_, c)| c.read(cx).attention() == Attention::NeedsAnswer).count());
    }

    /// The most urgent attention across a worktree's open chats.
    pub(crate) fn worktree_attention(&self, wt: &str, cx: &App) -> Attention {
        self.chats().filter(|(w, _)| *w == wt).map(|(_, c)| c.read(cx).attention()).min_by_key(|a| rank(*a)).unwrap_or(Attention::Idle)
    }

    pub(crate) fn project_attention(&self, p: &Project, cx: &App) -> Attention {
        p.worktrees.iter().map(|w| self.worktree_attention(&w.id, cx)).min_by_key(|a| rank(*a)).unwrap_or(Attention::Idle)
    }

    /// A chat is open here, or will be when its saved tabs reopen.
    pub(crate) fn chat_here(&self, wt: &str, cx: &App) -> bool {
        self.chats().any(|(w, _)| w == wt)
            || (!self.restored.contains(wt) && SessionState::worktree(cx, wt).is_some_and(|w| w.tabs.iter().any(|k| k.starts_with("chat:"))))
    }

    /// Tell chats whether you're looking at them: the visible tab of a focused window.
    fn sync_focus(&mut self, window: &Window, cx: &mut Context<Self>) {
        let visible = window
            .is_window_active()
            .then(|| self.selected.as_ref().and_then(|id| self.tabs.get(id)).and_then(|t| t.active.and_then(|i| t.open.get(i))))
            .flatten()
            .and_then(|t| match t {
                Tab::Chat(c) => Some(c.clone()),
                _ => None,
            });
        let id = visible.as_ref().map(|c| c.entity_id());
        if id == self.looking.as_ref().map(|w| w.entity_id()) {
            return;
        }
        if let Some(old) = self.looking.take().and_then(|w| w.upgrade()) {
            old.update(cx, |c, cx| c.set_focused_by_user(false, cx));
        }
        if let Some(c) = visible {
            c.update(cx, |c, cx| c.set_focused_by_user(true, cx));
            self.looking = Some(c.downgrade());
        }
    }

    /// "View diff" on an agent's edit: a preview diff tab of the two texts.
    fn open_agent_diff(&mut self, wt: &str, path: &str, old: &str, new: &str, cx: &mut Context<Self>) {
        if self.selected.as_deref() != Some(wt) {
            return;
        }
        let root = self.worktree().map(|w| w.path.clone()).unwrap_or_default();
        let file = path.strip_prefix(&format!("{root}/")).unwrap_or(path).to_string();
        let files = DiffFile::parse(&text_patch(&file, old, new)).unwrap_or_default();
        let key = format!("agent:{file}");
        let name = file.rsplit('/').next().unwrap_or(&file);
        let state = cx.new(|cx| DiffState::new(files, cx).with_mode(DiffMode::Split));
        let title = format!("{name} (agent edit)");
        let tab = Tab::Diff { key: key.clone(), title, state, root, file, base: None, full: false, fixed: true };
        if let Some(i) = self.tabs_mut().and_then(|t| t.open.iter().position(|t| matches!(t, Tab::Diff { key: k, .. } if *k == key))) {
            self.tabs_mut().unwrap().open[i] = tab;
            self.activate(i, cx);
        } else {
            self.push_preview(tab, cx);
        }
    }

    /// A chat branched (or started fresh): open the new one as a tab and focus it.
    fn open_branch(&mut self, wt: &str, log_id: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(path) = self.projects.iter().flat_map(|p| &p.worktrees).find(|w| w.id == wt).map(|w| w.path.clone()) else { return };
        let chat = cx.new(|cx| ChatView::open(log_id, &path, window, cx));
        let tab = self.chat_tab(wt, chat, window, cx);
        if self.selected.as_deref() == Some(wt) {
            self.push_tab(tab, cx);
        } else {
            self.tabs.entry(wt.to_string()).or_default().open.push(tab);
        }
    }

    /// A file / diff tab's title, or the name you gave it.
    fn tab_title(&self, tab: &Tab, cx: &App) -> String {
        let title = match tab {
            Tab::Chat(c) => return c.read(cx).title(),
            Tab::Diff { title, .. } => title.clone(),
            Tab::File(f) => f.read(cx).title(),
            Tab::Term(t) => t.read(cx).title(),
        };
        self.selected
            .as_deref()
            .and_then(|id| SessionState::worktree(cx, id))
            .and_then(|w| w.titles.get(&tab.key(cx)).cloned())
            .unwrap_or(title)
    }

    /// Double-click a (pinned) tab: edit its title in place. Enter or blur saves; Esc cancels.
    fn start_rename(&mut self, i: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(tab) = self.selected.as_ref().and_then(|id| self.tabs.get(id)).and_then(|t| t.open.get(i)) else { return };
        let (key, title) = (tab.key(cx), self.tab_title(tab, cx));
        let input = cx.new(|cx| InputState::new(window, cx).default_value(title));
        input.update(cx, |s, cx| {
            s.focus(window, cx);
            s.select_all(window, cx);
        });
        let sub = cx.subscribe_in(&input, window, |this, _, ev: &InputEvent, window, cx| match ev {
            InputEvent::PressEnter { .. } => {
                this.commit_rename(cx);
                window.focus(&this.focus, cx);
            }
            InputEvent::Blur => this.commit_rename(cx),
            _ => {}
        });
        self.renaming = Some((key, input, sub));
        cx.notify();
    }

    fn commit_rename(&mut self, cx: &mut Context<Self>) {
        let Some((key, input, _)) = self.renaming.take() else { return };
        cx.notify();
        let name = input.read(cx).value().trim().to_string();
        let Some(id) = self.selected.clone() else { return };
        if name.is_empty() {
            return;
        }
        let chat = self.tabs.get(&id).and_then(|t| t.open.iter().find(|t| t.key(cx) == key)).and_then(|t| match t {
            Tab::Chat(c) => Some(c.clone()),
            _ => None,
        });
        match chat {
            Some(c) => c.update(cx, |c, cx| c.set_custom_title(Some(name), cx)),
            None => SessionState::update(cx, |s| {
                s.worktree_mut(&id).titles.insert(key, name);
            }),
        }
    }
}

impl Render for ForestRanger {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // Nothing focused (e.g. the focused tab was closed): take focus back so the
        // window's shortcuts keep working.
        if let Some(id) = self.selected.clone() {
            self.restore_tabs(&id, window, cx);
        }
        self.reconcile_layout(cx);
        if window.focused(cx).is_none() {
            window.focus(&self.focus, cx);
        }
        self.sync_focus(window, cx);
        let review = if self.show_diff { self.review(window, cx) } else { None };
        let (sidebar_w, panel_w) = {
            let s = SessionState::get(cx);
            (s.sidebar_width, s.panel_width)
        };
        let sidebar = self.sidebar(cx);
        let titlebar = self.titlebar(cx);
        let center = if self.project_view.is_some() { self.project_page(window, cx) } else { self.center(cx) };
        let theme = cx.theme().colors;
        div()
            .flex()
            .size_full()
            .bg(theme.background)
            .text_color(theme.foreground)
            .on_action(cx.listener(|this, _: &TogglePanel, _, cx| this.toggle_panel(cx)))
            .on_action(cx.listener(|this, _: &SaveAll, _, cx| this.save_all(cx)))
            .on_action(|_: &About, window, cx| {
                let version = format!("Version {}", env!("CARGO_PKG_VERSION"));
                let _ = window.prompt(PromptLevel::Info, "Forest Ranger", Some(&version), &["OK"], cx);
            })
            .on_action(|_: &Minimize, window, _| window.minimize_window())
            .on_action(|_: &Zoom, window, _| window.zoom_window())
            .on_action(|_: &CloseWindow, window, _| window.remove_window())
            .relative()
            .track_focus(&self.focus)
            .on_action(cx.listener(|this, _: &JumpTo, window, cx| this.toggle_palette(false, window, cx)))
            .on_action(cx.listener(|this, _: &OpenFile, window, cx| this.toggle_palette(true, window, cx)))
            .on_action(cx.listener(|this, _: &CloseTab, _, cx| {
                if let Some(i) = this.tabs_mut().and_then(|t| t.active) {
                    this.close_tab(i, cx);
                }
            }))
            .on_action(cx.listener(|this, _: &NewTerminal, window, cx| {
                if let Some((id, path)) = this.worktree().map(|w| (w.id.clone(), w.path.clone())) {
                    this.open_terminal(&id, &path, None, window, cx)
                }
            }))
            .on_action(cx.listener(|this, _: &GoBack, _, cx| this.go_back(cx)))
            .on_action(cx.listener(|this, _: &GoForward, _, cx| this.go_forward(cx)))
            .on_action(cx.listener(|this, _: &ShowReview, window, cx| this.set_review_view(review::View::Review, window, cx)))
            .on_action(cx.listener(|this, _: &ShowFiles, window, cx| this.set_review_view(review::View::Files, window, cx)))
            .on_action(cx.listener(|this, _: &ShowSearch, window, cx| this.set_review_view(review::View::Search, window, cx)))
            .child(
                h_resizable("shell")
                    .on_resize(|state, _, cx| {
                        if let Some(&w) = state.read(cx).sizes().first() {
                            SessionState::update(cx, |s| s.sidebar_width = f32::from(w).clamp(session_state::SIDEBAR_WIDTH.0, session_state::SIDEBAR_WIDTH.2));
                        }
                    })
                    .child(
                        // flex_none: keep the saved width as the window resizes (the
                        // centre column takes up the slack).
                        resizable_panel()
                            .size(px(sidebar_w))
                            .size_range(px(session_state::SIDEBAR_WIDTH.0)..px(session_state::SIDEBAR_WIDTH.2))
                            .flex_none()
                            .child(sidebar),
                    )
                    .child(
                        resizable_panel().child(
                            div().flex().flex_col().size_full().min_w_0().child(titlebar).child(
                                // Below the 40px titlebar: take the rest, not the full height.
                                div().flex_1().min_h_0().child(
                                    h_resizable("main")
                                        .on_resize(|state, _, cx| {
                                            if let Some(&w) = state.read(cx).sizes().get(1) {
                                                let (lo, _, hi) = session_state::PANEL_WIDTH;
                                                SessionState::update(cx, |s| s.panel_width = f32::from(w).clamp(lo, hi));
                                            }
                                        })
                                        .child(resizable_panel().child(center))
                                        .child(
                                            resizable_panel()
                                                .size(px(panel_w))
                                                .size_range(px(session_state::PANEL_WIDTH.0)..px(session_state::PANEL_WIDTH.2))
                                                .flex_none()
                                                .visible(review.is_some())
                                                .children(review.map(|r| r.into_any_element())),
                                        ),
                                ),
                            ),
                        ),
                    ),
            )
            .when_some(self.palette.as_ref().map(|p| p.0.clone()), |d, pal| {
                d.child(
                    div()
                        .id("palette-backdrop")
                        .absolute()
                        .inset_0()
                        .flex()
                        .justify_center()
                        // Top-aligned, sized to its content (not stretched to the window).
                        .items_start()
                        .pt(px(90.))
                        .bg(gpui_kit::black().opacity(0.25))
                        .on_mouse_down(MouseButton::Left, cx.listener(|this, _, window, cx| {
                            this.palette = None;
                            window.focus(&this.focus, cx);
                            cx.notify();
                        }))
                        .child(pal),
                )
            })
    }
}

/// `cargo run -- --check`: load everything the UI reads, headless, and report.
fn check() {
    let projects = data::load_projects().expect("load projects");
    let wts: usize = projects.iter().map(|p| p.worktrees.len()).sum();
    println!("{} projects, {wts} worktrees", projects.len());
    let bad = projects
        .iter()
        .flat_map(|p| p.worktrees.iter().map(move |w| (p, w)))
        .filter(|(p, w)| data::worktree_id(&p.id, &w.path) != w.id)
        .count();
    println!("worktree ids matching the Electron scheme: {}/{wts}", wts - bad);
    let mut biggest = (0usize, String::new());
    for w in projects.iter().flat_map(|p| &p.worktrees) {
        for c in data::chats_for(&w.id) {
            let t = std::time::Instant::now();
            let rows = log::ChatLog::open(&c.session_id).events.len();
            if rows > biggest.0 {
                biggest = (rows, format!("{} ({rows} events, parsed in {:?})", c.name, t.elapsed()));
            }
        }
    }
    println!("biggest chat: {}", biggest.1);
    if let Some((p, w)) = projects.iter().max_by_key(|p| p.worktrees.len()).and_then(|p| p.worktrees.first().map(|w| (p, w))) {
        let t = std::time::Instant::now();
        let d = git::detail(&w.path, &p.path, None);
        println!(
            "review {}: branch {:?}, base {:?} ↑{} ↓{}, {} committed / {} uncommitted files, {} branches ({:?})",
            w.label().0, d.branch, d.base, d.ahead, d.behind, d.committed.len(), d.uncommitted.len(), d.branches.len(), t.elapsed()
        );
        let t = std::time::Instant::now();
        let (files, ignored) = git::list_files(&w.path);
        println!("files view: {} files, {} ignored ({:?})", files.len(), ignored.len(), t.elapsed());
        let t = std::time::Instant::now();
        let tree = tree::Dir::build(&files, &ignored, &Default::default(), "");
        let mut rows = vec![];
        tree.flatten("", 0, &Default::default(), false, &mut rows);
        let filtered = tree::Dir::build(&files, &ignored, &Default::default(), "skill");
        let mut frows = vec![];
        filtered.flatten("", 0, &Default::default(), true, &mut frows);
        println!("file tree: {} top-level rows, filter \"skill\" → {} rows ({:?} for both)", rows.len(), frows.len(), t.elapsed());
    }

}

/// `cargo run -- --agent` (use a temp FOREST_RANGER_DATA_DIR): a two-turn chat
/// that's persisted, reopened from disk, and resumed — the agent should still
/// remember the first turn.
fn check_agent() {
    let run = |chat: &mut log::ChatLog, text: &str| -> String {
        let (tx, rx) = async_channel::unbounded();
        let opts = acp::StartOpts {
            provider: "claude".into(),
            cwd: std::env::temp_dir().to_string_lossy().into(),
            model: None,
            resume_id: chat.resume_id(),
        };
        let agent = acp::Agent::spawn(opts, tx).expect("spawn agent");
        chat.push(serde_json::json!({ "type": "user_text", "text": text }));
        agent.prompt(acp::text_prompt(text));
        let mut reply = String::new();
        while let Ok(e) = rx.recv_blocking() {
            let kind = e["type"].as_str().unwrap_or_default().to_string();
            if kind == "assistant_text" {
                reply.push_str(e["text"].as_str().unwrap_or_default());
            }
            chat.push(e);
            if matches!(kind.as_str(), "result" | "error" | "exited") {
                break;
            }
        }
        chat.flush(true);
        chat.write_meta();
        reply
    };
    let id = uuid::Uuid::new_v4().to_string();
    let mut chat = log::ChatLog::new(id.clone(), "wt".into(), "proj".into(), "claude".into());
    println!("turn 1: {:?}", run(&mut chat, "Remember the word ORCHID. Reply with just: ok"));
    let mut reopened = log::ChatLog::open(&id);
    println!("reopened: {} events, name {:?}, resume id {:?}", reopened.events.len(), reopened.name(), reopened.resume_id());
    println!("turn 2: {:?}", run(&mut reopened, "What word did I ask you to remember? Reply with just the word."));
    println!("on disk: {} events", log::ChatLog::open(&id).events.len());
}

/// Use Forest Ranger's icon in the Dock (assets/icon.png) — an unbundled
/// `cargo run` binary otherwise shows a generic one.
#[cfg(target_os = "macos")]
fn set_dock_icon() {
    use objc2::{AllocAnyThread as _, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::NSData;
    static ICON: &[u8] = include_bytes!("../assets/icon.png");
    let Some(mtm) = MainThreadMarker::new() else { return };
    let data = NSData::with_bytes(ICON);
    if let Some(image) = NSImage::initWithData(NSImage::alloc(), &data) {
        unsafe { NSApplication::sharedApplication(mtm).setApplicationIconImage(Some(&image)) };
    }
}

fn main() {
    if std::env::args().any(|a| a == "--check") {
        return check();
    }
    if std::env::args().any(|a| a == "--agent") {
        return check_agent();
    }
    // The app owns its database now (it used to be created by the Electron app).
    if let Err(e) = data::ensure_schema() {
        eprintln!("forest-ranger: couldn't set up the database: {e}");
    }
    // Closing the last window quits (macOS apps otherwise linger windowless).
    gpui_kit::application().with_assets(assets::Assets).with_quit_mode(QuitMode::LastWindowClosed).run(|cx| {
        gpui_kit::init(cx);
        #[cfg(target_os = "macos")]
        set_dock_icon();
        cx.set_global(settings::Settings::load());
        cx.set_global(SessionState::load());
        cx.on_action(|_: &Quit, cx| cx.quit());
        cx.on_action(|_: &Hide, cx| cx.hide());
        cx.on_action(|_: &HideOthers, cx| cx.hide_other_apps());
        cx.on_action(|_: &ShowAll, cx| cx.unhide_other_apps());
        cx.set_menus(vec![
            Menu {
                name: "Forest Ranger".into(),
                items: vec![
                    MenuItem::action("About Forest Ranger", About),
                    MenuItem::separator(),
                    MenuItem::action("Hide Forest Ranger", Hide),
                    MenuItem::action("Hide Others", HideOthers),
                    MenuItem::action("Show All", ShowAll),
                    MenuItem::separator(),
                    MenuItem::action("Quit Forest Ranger", Quit),
                ],
                disabled: false,
            },
            Menu {
                name: "Edit".into(),
                items: vec![
                    MenuItem::os_action("Undo", gpui_kit::component::input::Undo, OsAction::Undo),
                    MenuItem::os_action("Redo", gpui_kit::component::input::Redo, OsAction::Redo),
                    MenuItem::separator(),
                    MenuItem::os_action("Cut", gpui_kit::component::input::Cut, OsAction::Cut),
                    MenuItem::os_action("Copy", gpui_kit::component::input::Copy, OsAction::Copy),
                    MenuItem::os_action("Paste", gpui_kit::component::input::Paste, OsAction::Paste),
                    MenuItem::os_action("Select All", gpui_kit::component::input::SelectAll, OsAction::SelectAll),
                ],
                disabled: false,
            },
            Menu {
                name: "Window".into(),
                items: vec![
                    MenuItem::action("Minimize", Minimize),
                    MenuItem::action("Zoom", Zoom),
                    MenuItem::separator(),
                    MenuItem::action("Close Window", CloseWindow),
                ],
                disabled: false,
            },
        ]);
        cx.bind_keys([
            KeyBinding::new("cmd-q", Quit, None),
            KeyBinding::new("cmd-t", JumpTo, None),
            KeyBinding::new("cmd-k", JumpTo, None),
            KeyBinding::new("cmd-p", OpenFile, None),
            KeyBinding::new("cmd-w", CloseTab, None),
            KeyBinding::new("ctrl-`", NewTerminal, None),
            // In a terminal these go to the shell, not back/forward.
            KeyBinding::new("ctrl--", NoAction, Some("Terminal")),
            KeyBinding::new("ctrl-=", NoAction, Some("Terminal")),
            KeyBinding::new("ctrl-shift--", NoAction, Some("Terminal")),
            KeyBinding::new("cmd-b", TogglePanel, None),
            KeyBinding::new("cmd-[", GoBack, None),
            KeyBinding::new("cmd-]", GoForward, None),
            // ⌘[ / ⌘] are indent/outdent inside text fields; ⌃- / ⌃= work everywhere (as in Electron).
            KeyBinding::new("ctrl--", GoBack, None),
            KeyBinding::new("ctrl-=", GoForward, None),
            KeyBinding::new("ctrl-shift--", GoForward, None),
            KeyBinding::new("cmd-1", ShowReview, None),
            KeyBinding::new("cmd-2", ShowFiles, None),
            KeyBinding::new("cmd-shift-f", ShowSearch, None),
            KeyBinding::new("cmd-s", files::Save, Some("FileView")),
            KeyBinding::new("cmd-alt-s", SaveAll, None),
            KeyBinding::new("cmd-h", Hide, None),
            KeyBinding::new("cmd-alt-h", HideOthers, None),
            KeyBinding::new("cmd-m", Minimize, None),
            KeyBinding::new("cmd-shift-w", CloseWindow, None),
        ]);
        let bounds = initial_bounds(cx);
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(bounds)),
                titlebar: Some(TitlebarOptions {
                    title: Some("Forest Ranger".into()),
                    appears_transparent: true,
                    traffic_light_position: Some(point(px(12.), px(12.))),
                }),
                ..Default::default()
            },
            cx,
            |window, cx| {
                let dark = cx.global::<settings::Settings>().dark(window);
                theme::apply(dark, cx);
                cx.new(|cx| ForestRanger::new(window, cx))
            },
        )
        .expect("failed to open window");
        cx.activate(true);
        // Smoke test for quit-on-close: FR_SMOKE_CLOSE=1 closes the window after 4s;
        // the process should then exit by itself.
        if std::env::var_os("FR_SMOKE_CLOSE").is_some() {
            // FR_SMOKE_AGENT=1 also starts an agent (no prompt sent), as a live chat would.
            let agent = std::env::var_os("FR_SMOKE_AGENT").map(|_| {
                let (tx, rx) = async_channel::unbounded();
                let opts = acp::StartOpts { provider: "claude".into(), cwd: std::env::temp_dir().to_string_lossy().into(), model: None, resume_id: None };
                (acp::Agent::spawn(opts, tx).ok(), rx)
            });
            cx.spawn(async move |cx| {
                let _agent = agent;
                cx.background_executor().timer(std::time::Duration::from_secs(4)).await;
                let _ = cx.update(|cx| {
                    for w in cx.windows() {
                        let _ = w.update(cx, |_, window, _| window.remove_window());
                    }
                });
            })
            .detach();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{parse_diff_key, rehead, text_patch};

    #[test]
    fn agent_patch() {
        let p = text_patch("src/x.rs", "a\nb\n", "a\nc\n");
        assert!(p.starts_with("diff --git a/src/x.rs b/src/x.rs\n--- a/src/x.rs\n+++ b/src/x.rs\n@@"), "{p}");
        assert!(p.contains("\n-b\n+c\n"));
        assert_eq!(text_patch("x", "same", "same"), "");
        assert_eq!(rehead("x", "diff --git a/a b/b\nnew file mode 100644\n--- /dev/null\n"), "");
    }

    #[test]
    fn diff_keys() {
        assert_eq!(parse_diff_key("diff:working:src/a:b.rs"), Some((None, "src/a:b.rs".into())));
        assert_eq!(parse_diff_key("diff:origin/main:x.rs"), Some((Some("origin/main".into()), "x.rs".into())));
        assert_eq!(parse_diff_key("diff:commit:abc123:x.rs"), Some((Some("commit:abc123".into()), "x.rs".into())));
        assert_eq!(parse_diff_key("file:x.rs"), None);
    }
}
