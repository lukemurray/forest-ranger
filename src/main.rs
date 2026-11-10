//! Forest Ranger: a desktop app for working across git worktrees with AI agents,
//! built on GPUI Kit. The window shell: sidebar, titlebar, tabs, panels, palettes.

mod acp;
mod anim;
mod assets;
mod chat;
mod codehost;
mod data;
mod files;
mod ghostty;
mod git;
mod log;
mod notify;
mod palette;
mod panes;
mod project_view;
mod review;
mod reviews;
mod session_state;
mod settings;
mod sidebar;
mod term;
mod theme;
mod tree;
mod tabs;
mod titlebar;
mod windows;
mod dev;

use std::collections::{HashMap, HashSet};

use gpui_kit::component::button::{Button, ButtonVariant, ButtonVariants as _};
use gpui_kit::component::diff::{Diff, DiffFile, DiffMode, DiffState};
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::component::menu::{DropdownMenu as _, PopupMenuItem};
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::component::*;
use gpui_kit::*;

use chat::{Attention, ChatEvent, ChatView};
use data::{ChatMeta, Project};
use session_state::{SessionState, initial_bounds, write_window_state};
use tabs::{Tab, Tabs};
use windows::Windows;

struct ForestRanger {
    /// A popped-out window's one worktree (None: the main window, with the sidebar).
    locked: Option<String>,
    /// Live chats / terminals handed over from another window, by tab key; they
    /// take their saved places when the worktree's tabs are restored here.
    adopted: HashMap<String, Tab>,
    /// Main window: watching each popped-out window, to redraw its worktree's dots.
    window_subs: HashMap<String, Subscription>,
    projects: Vec<Project>,
    error: Option<String>,
    /// Selected worktree id.
    selected: Option<String>,
    /// The project page shown instead of a worktree (then `selected` is None).
    project_view: Option<project_view::ProjectPage>,
    /// Open MRs/PRs needing you, per project id (the sidebar's and the page tab's badge).
    needs_you: HashMap<String, usize>,
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
    /// Redraws for the pulsing status dots, while a chat is working or waiting.
    ticker: anim::Ticker,
    /// Subscriptions to tabs' and panels' entities, pruned when those go.
    tab_subs: Vec<(EntityId, Subscription)>,
    /// The running load per diff tab (keyed by its DiffState).
    diff_loads: HashMap<EntityId, Task<()>>,
    _load_chats: Task<()>,
    _subs: Vec<Subscription>,
}

actions!(
    forest_ranger,
    [TogglePanel, GoBack, GoForward, NextTab, PrevTab, ShowReview, ShowFiles, ShowSearch, CloseTab, NewTerminal, Quit, JumpTo, OpenFile, SaveAll, About, Hide, HideOthers, ShowAll, Minimize, Zoom, CloseWindow]
);

/// A chat's status dot: amber pulsing (needs your answer), accent pulsing
/// (working), accent bullseye (unread). None when idle.
/// The pulses run on the root view's `anim::Ticker` (see `render`).
pub(crate) fn status_dot(a: Attention, cx: &App) -> Option<AnyElement> {
    let (accent, amber) = (cx.theme().colors.primary, theme::extra(cx).amber);
    let pulse = |d: Div, ms: u64| d.opacity(anim::pulse(ms, 0.45, 1.)).into_any_element();
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
    /// The main window's shell.
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut this = Self::build(None, window, cx);
        this.load_activity(cx);
        this.sync_all(cx);
        this.restore_place(cx);
        this.poll_needs_you(cx);
        dev::bench(window, cx);
        dev::smoke_popout(window, cx);
        this
    }

    /// A shell for the main window (`locked` None) or a popped-out worktree.
    fn build(locked: Option<String>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let main = locked.is_none();
        let (projects, error) = match data::load_projects() {
            Ok(p) => (p, None),
            Err(e) => (vec![], Some(e)),
        };
        let appearance = cx.observe_window_appearance(window, |_, window, cx| {
            let dark = cx.global::<settings::Settings>().dark(window);
            theme::apply(dark, cx);
            window.refresh();
        });
        // Remember the window's size and position: the main window's in
        // window-state.json (debounced while dragging), a popped-out one's per worktree.
        let bounds = cx.observe_window_bounds(window, |this, window, cx| {
            let b = window.window_bounds().get_bounds();
            if let Some(wt) = this.locked.clone() {
                let r = [f32::from(b.origin.x), f32::from(b.origin.y), f32::from(b.size.width), f32::from(b.size.height)].map(f32::round);
                return SessionState::update(cx, |s| _ = s.popped_bounds.insert(wt, r));
            }
            this.bounds = Some(b);
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
        // The window's close button: the main window quits (asking first if anything's
        // busy); a popped-out one docks its worktree back into the main window.
        let fr = cx.entity().downgrade();
        window.on_window_should_close(cx, move |window, cx| {
            let Some(fr) = fr.upgrade() else { return true };
            if !main {
                fr.update(cx, |fr, cx| fr.dock_back(cx));
                return true;
            }
            if fr.read(cx).busy_summary(None, fr.entity_id(), cx).is_none() {
                cx.quit();
                return true;
            }
            fr.update(cx, |fr, cx| fr.confirm_leave(false, window, cx));
            false
        });
        // Window focus decides whether a finished turn is unread (re-checked on render).
        let activation = cx.observe_window_activation(window, |_, _, cx| cx.notify());
        // Notification clicks (the main window takes them; a popped-out worktree's go there).
        if main {
            cx.spawn(async move |this, cx| {
                let clicks = notify::clicks();
                while let Ok((wt, key)) = clicks.recv().await {
                    let ok = this.update(cx, |this, cx| {
                        cx.activate(true);
                        if let Some((h, fr)) = Windows::popped(cx, &wt) {
                            let _ = h.update(cx, |_, window, _| window.activate_window());
                            fr.update(cx, |fr, cx| _ = fr.focus_tab(&key, cx));
                            return;
                        }
                        this.select(wt, cx);
                        this.focus_tab(&key, cx);
                    });
                    if ok.is_err() {
                        break;
                    }
                }
            })
            .detach();
        }
        Self {
            locked,
            adopted: HashMap::new(),
            window_subs: HashMap::new(),
            projects,
            error,
            selected: None,
            project_view: None,
            commands: HashMap::new(),
            needs_you: HashMap::new(),
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
            ticker: Default::default(),
            tab_subs: vec![],
            diff_loads: HashMap::new(),
            _load_chats: Task::ready(()),
            // Window size and app-quit saving are the main window's.
            _subs: if main { vec![appearance, bounds, quit, activation] } else { vec![appearance, bounds, activation] },
        }
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

    /// Re-read the selected worktree's saved chats (one file per chat) off the UI thread.
    fn load_chats(&mut self, cx: &mut Context<Self>) {
        let Some(wt) = self.selected.clone() else { return };
        let id = wt.clone();
        let work = cx.background_executor().spawn(async move { data::chats_for(&id) });
        self._load_chats = cx.spawn(async move |this, cx| {
            let chats = work.await;
            let _ = this.update(cx, |this, cx| {
                if this.selected.as_deref() == Some(&wt) {
                    this.chats = chats;
                    cx.notify();
                }
            });
        });
    }

    /// Drop subscriptions and attention for tabs and panels that are gone.
    fn prune(&mut self) {
        let live: HashSet<EntityId> = self
            .tabs
            .values()
            .flat_map(|t| &t.open)
            .map(Tab::entity_id)
            .chain(self.reviews.values().map(|r| r.entity_id()))
            .collect();
        self.tab_subs.retain(|(id, _)| live.contains(id));
        self.attention.retain(|id, _| live.contains(id));
        self.diff_loads.retain(|id, _| live.contains(id));
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
        // Worktrees removed (here or outside the app) and removed projects: drop their
        // tabs (stopping their agents and terminals), panels and history.
        let wts: HashSet<String> = self.projects.iter().flat_map(|p| &p.worktrees).map(|w| w.id.clone()).collect();
        let pids: HashSet<String> = self.projects.iter().map(|p| format!("project:{}", p.id)).collect();
        let live = |id: &String| wts.contains(id) || pids.contains(id);
        self.close_removed_popped(cx);
        self.tabs.retain(|id, _| live(id));
        self.reviews.retain(|id, _| live(id));
        self.restored.retain(|id| live(id));
        self.back.retain(|id| live(id));
        self.forward.retain(|id| live(id));
        if self.selected.as_ref().is_some_and(|id| !live(id)) {
            self.selected = None;
        }
        self.prune();
        self.update_badge(cx.entity_id(), cx);
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
            // A chat counts as using its worktree, even before any file changes.
            let chats = data::chat_activity();
            out.into_inner().unwrap().into_iter().map(|(id, at)| {
                let chat = chats.get(&id).copied().unwrap_or(0);
                (id, at.max(chat))
            }).collect::<Vec<_>>()
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

    /// Mark a worktree used just now and move it to the top of its project.
    fn touch_worktree(&mut self, wt: &str) {
        for p in &mut self.projects {
            if let Some(w) = p.worktrees.iter_mut().find(|w| w.id == wt) {
                w.activity = log::now_ms();
                p.worktrees.sort_by(|a, b| b.activity.cmp(&a.activity));
            }
        }
    }

    fn worktree(&self) -> Option<&data::Worktree> {
        let id = self.selected.as_deref()?;
        self.projects.iter().flat_map(|p| &p.worktrees).find(|w| w.id == id)
    }

    /// Where you are, as a history entry.
    /// Reopen the sidebar as it was last run: expanded projects, and the worktree or
    /// project page you were on — skipping any that have gone since.
    fn restore_place(&mut self, cx: &mut Context<Self>) {
        let s = SessionState::get(cx);
        let (expanded, location) = (s.expanded.clone(), s.location.clone());
        let project = |id: &str| self.projects.iter().any(|p| p.id == id);
        self.expanded = expanded.into_iter().filter(|id| project(id)).collect();
        let live = location.filter(|loc| match loc.strip_prefix("project:") {
            Some(pid) => project(pid),
            None => self.projects.iter().flat_map(|p| &p.worktrees).any(|w| w.id == *loc),
        });
        if let Some(loc) = live {
            self.goto(loc, cx);
        }
    }

    /// Save the sidebar's expanded projects and location when they change. Called from
    /// render, which every change goes through; a no-op when nothing moved.
    fn save_place(&self, cx: &mut Context<Self>) {
        let mut expanded: Vec<String> = self.expanded.iter().cloned().collect();
        expanded.sort();
        let location = self.location();
        let s = SessionState::get(cx);
        if s.expanded != expanded || s.location != location {
            SessionState::update(cx, |s| (s.expanded, s.location) = (expanded, location));
        }
    }

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
        // A popped-out window stays on its worktree; elsewhere is the main window's job.
        if self.locked.is_some() {
            return self.forward_to_main(id, cx);
        }
        // In its own window: bring that forward instead.
        if self.focus_popped(&id, cx) {
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
        self.load_chats(cx);
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
            let work = cx.background_executor().spawn(async move { git::git_line(&p, &["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]) });
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

    pub(crate) fn toggle_panel(&mut self, cx: &mut Context<Self>) {
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
            review::ReviewEvent::ContinueChat(prompt) => {
                // The chat in view, else the one used last here; none: a new one.
                let chat = this.tabs_mut().and_then(|t| {
                    let active = t.active.and_then(|i| t.open.get(i)).and_then(|t| match t {
                        Tab::Chat(c) => Some(c.clone()),
                        _ => None,
                    });
                    active.or_else(|| {
                        t.mru.iter().find_map(|k| t.open.iter().find_map(|t| match t {
                            Tab::Chat(c) if format!("chat:{}", c.read(cx).session_id()) == *k => Some(c.clone()),
                            _ => None,
                        }))
                    })
                });
                match chat {
                    Some(chat) => {
                        let key = format!("chat:{}", chat.read(cx).session_id());
                        this.focus_tab(&key, cx);
                        chat.update(cx, |c, cx| c.send_or_queue(prompt.clone(), cx));
                    }
                    None => {
                        let provider = cx.global::<settings::Settings>().provider.clone();
                        this.new_chat(&provider, window, cx);
                        if let Some(Tab::Chat(chat)) = this.tabs_mut().and_then(|t| t.open.last()) {
                            let chat = chat.clone();
                            chat.update(cx, |c, cx| c.send_text(prompt.clone(), cx));
                        }
                    }
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
        self.tab_subs.push((panel.entity_id(), sub));
        self.reviews.insert(id, panel.clone());
        Some(panel)
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
                    this.load_chats(cx);
                }
                cx.notify();
            }
            ChatEvent::StatusChanged => this.chat_status(&wt, chat, window, cx),
            ChatEvent::OpenNote { key, title, text } => {
                let beside = format!("chat:{}", chat.read(cx).session_id());
                this.open_note(&wt, key, title, text, &beside, cx)
            }
        });
        self.tab_subs.push((chat.entity_id(), sub));
        Tab::Chat(chat)
    }

    /// A chat's attention changed: notify if it needs you in the background, then
    /// refresh the badge and dots.
    fn chat_status(&mut self, wt: &str, chat: &Entity<ChatView>, window: &mut Window, cx: &mut Context<Self>) {
        let c = chat.read(cx);
        let now = c.attention();
        let prev = self.attention.insert(chat.entity_id(), now);
        // An agent starting work makes its worktree the most recent one, now.
        if now == Attention::Working && prev != Some(now) {
            self.touch_worktree(wt);
            // The sidebar's order is the main window's.
            if self.locked.is_some() {
                for other in Windows::others(cx, cx.entity_id()) {
                    let wt = wt.to_string();
                    cx.defer(move |cx| other.update(cx, |m, cx| {
                        m.touch_worktree(&wt);
                        cx.notify();
                    }));
                }
            }
        }
        let c = chat.read(cx);
        if !window.is_window_active() && prev != Some(now) {
            let target = (wt.to_string(), format!("chat:{}", c.session_id()));
            let label = c.title();
            match now {
                Attention::NeedsAnswer => {
                    let title = if c.open_asks().0 > 0 { "Permission needed" } else { "Input needed" };
                    notify::post(title, &format!("{label} is waiting for your answer."), target)
                }
                Attention::Unread => notify::post("Chat finished", &format!("{label} finished its turn."), target),
                _ => {}
            }
        }
        self.update_badge(cx.entity_id(), cx);
        cx.notify();
    }

    fn chats(&self) -> impl Iterator<Item = (&String, &Entity<ChatView>)> {
        self.tabs.iter().flat_map(|(wt, t)| t.open.iter().filter_map(move |t| match t {
            Tab::Chat(c) => Some((wt, c)),
            _ => None,
        }))
    }

    /// Dock badge: open permission prompts and elicitation forms across chats.
    fn update_badge(&self, me: EntityId, cx: &App) {
        let asks = |fr: &ForestRanger| -> usize { fr.chats().map(|(_, c)| { let (p, e) = c.read(cx).open_asks(); p + e }).sum() };
        notify::set_badge(asks(self) + Windows::others(cx, me).iter().map(|fr| asks(fr.read(cx))).sum::<usize>());
    }

    /// A worktree's dot: its chats' state first (a finished chat stays "ready" even
    /// with a terminal running); a running terminal shows as Working only when the
    /// chats have nothing to say.
    pub(crate) fn worktree_attention(&self, wt: &str, cx: &App) -> Attention {
        let (chats, term) = self.worktree_state(wt, cx);
        if chats == Attention::Idle && term { Attention::Working } else { chats }
    }

    /// (the most pressing of its chats, a terminal running something) — from the
    /// window the worktree is in (its own, if popped out).
    pub(crate) fn worktree_state(&self, wt: &str, cx: &App) -> (Attention, bool) {
        if self.locked.as_deref() != Some(wt)
            && let Some((_, fr)) = Windows::popped(cx, wt)
        {
            return fr.read(cx).own_state(wt, cx);
        }
        self.own_state(wt, cx)
    }

    fn own_state(&self, wt: &str, cx: &App) -> (Attention, bool) {
        let chats = self.chats().filter(|(w, _)| *w == wt).map(|(_, c)| c.read(cx).attention()).min().unwrap_or(Attention::Idle);
        (chats, self.busy_terms(cx).any(|w| w == wt))
    }

    /// Agents working (or waiting on you) and terminals running, in this window's
    /// shell, in worktree `wt` (or anywhere).
    fn own_busy(&self, wt: Option<&str>, cx: &App) -> (usize, usize) {
        let here = |w: &String| wt.is_none_or(|wt| w == wt);
        let agents = self.chats().filter(|(w, c)| here(w) && matches!(c.read(cx).attention(), Attention::Working | Attention::NeedsAnswer)).count();
        (agents, self.busy_terms(cx).filter(|w| here(w)).count())
    }

    /// "2 agents working and a terminal running" in worktree `wt` (or anywhere);
    /// None when nothing would be cut short.
    pub(crate) fn busy_summary(&self, wt: Option<&str>, me: EntityId, cx: &App) -> Option<String> {
        // Every window's shell: quitting stops them all, and a worktree may be popped out.
        let (agents, terms) = Windows::others(cx, me).iter().map(|fr| fr.read(cx).own_busy(wt, cx)).fold(self.own_busy(wt, cx), |a, b| (a.0 + b.0, a.1 + b.1));
        let part = |n: usize, one: &str, many: &str, verb: &str| match n {
            0 => None,
            1 => Some(format!("{one} {verb}")),
            n => Some(format!("{n} {many} {verb}")),
        };
        let parts: Vec<String> = [part(agents, "an agent", "agents", "working"), part(terms, "a terminal", "terminals", "running")].into_iter().flatten().collect();
        (!parts.is_empty()).then(|| parts.join(" and "))
    }

    /// Quit (or close the window, which quits): ask first if that would stop an
    /// agent or a running terminal.
    fn confirm_leave(&mut self, quit: bool, window: &mut Window, cx: &mut Context<Self>) {
        // A popped-out window just closes: its worktree goes back to the main window, running.
        if !quit && self.locked.is_some() {
            self.dock_back(cx);
            return window.remove_window();
        }
        // The main window closing quits, popped-out windows and all.
        let leave = move |_: &mut Window, cx: &mut App| cx.quit();
        let Some(busy) = self.busy_summary(None, cx.entity_id(), cx) else { return leave(window, cx) };
        window.open_alert_dialog(cx, move |alert, _, _| {
            alert
                .title(if quit { "Quit Forest Ranger?" } else { "Close the window?" })
                .description(format!("You have {busy}. {} stops them; chats so far are saved.", if quit { "Quitting" } else { "Closing it quits Forest Ranger and" }))
                .ok_text(if quit { "Quit" } else { "Close" })
                .ok_variant(ButtonVariant::Danger)
                .show_cancel(true)
                .on_ok(move |_, window, cx| {
                    // Deferred: not from inside the dialog's own callback.
                    window.defer(cx, move |window, cx| leave(window, cx));
                    true
                })
        });
    }

    /// The worktree ids of terminals running something (one per busy terminal).
    fn busy_terms<'a>(&'a self, cx: &'a App) -> impl Iterator<Item = &'a String> + 'a {
        self.tabs.iter().flat_map(move |(wt, t)| t.open.iter().filter(move |t| matches!(t, Tab::Term(v) if v.read(cx).busy())).map(move |_| wt))
    }

    pub(crate) fn project_attention(&self, p: &Project, cx: &App) -> Attention {
        p.worktrees.iter().map(|w| self.worktree_attention(&w.id, cx)).min().unwrap_or(Attention::Idle)
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
        let key = format!("agent:{file}");
        let name = file.rsplit('/').next().unwrap_or(&file);
        let state = Self::new_diff_state(cx);
        let (f, old, new) = (file.clone(), old.to_string(), new.to_string());
        self.fill_diff(&state, move || git::text_patch(&f, &old, &new), cx);
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

    /// Edit a tab title, or a worktree label (key `label:<worktree id>`), in place.
    /// Enter or blur saves; Esc (handled where it's drawn) cancels.
    fn start_inline_edit(&mut self, key: String, initial: String, placeholder: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        let input = cx.new(|cx| {
            let s = InputState::new(window, cx).default_value(initial);
            if let Some(p) = placeholder { s.placeholder(p) } else { s }
        });
        input.update(cx, |s, cx| {
            s.focus(window, cx);
            s.select_all(window, cx);
        });
        let sub = cx.subscribe_in(&input, window, |this, _, ev: &InputEvent, window, cx| match ev {
            InputEvent::PressEnter { .. } => {
                this.commit_inline_edit(cx);
                window.focus(&this.focus, cx);
            }
            InputEvent::Blur => this.commit_inline_edit(cx),
            _ => {}
        });
        self.renaming = Some((key, input, sub));
        cx.notify();
    }

    fn commit_inline_edit(&mut self, cx: &mut Context<Self>) {
        // Dropping the subscription from inside its own callback is fine: GPUI defers removal.
        let Some((key, input, _)) = self.renaming.take() else { return };
        cx.notify();
        let name = input.read(cx).value().trim().to_string();
        if let Some(wt) = key.strip_prefix("label:") {
            return self.save_label(wt, name, cx);
        }
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
        // Where you are is the main window's; a popped-out one is always on its worktree.
        if self.locked.is_none() {
            self.save_place(cx);
        }
        let pulsing = self.chats().any(|(_, c)| matches!(c.read(cx).attention(), Attention::Working | Attention::NeedsAnswer))
            || self.busy_terms(cx).next().is_some();
        self.ticker.keep(pulsing, cx);
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
            .on_action(cx.listener(|this, _: &CloseWindow, window, cx| this.confirm_leave(false, window, cx)))
            .on_action(cx.listener(|this, _: &Quit, window, cx| this.confirm_leave(true, window, cx)))
            .relative()
            .track_focus(&self.focus)
            .on_action(cx.listener(|this, _: &JumpTo, window, cx| this.toggle_palette(false, window, cx)))
            .on_action(cx.listener(|this, _: &OpenFile, window, cx| this.toggle_palette(true, window, cx)))
            .on_action(cx.listener(|this, _: &NextTab, _, cx| this.cycle_tab(1, cx)))
            .on_action(cx.listener(|this, _: &PrevTab, _, cx| this.cycle_tab(-1, cx)))
            .on_action(cx.listener(|this, _: &CloseTab, window, cx| {
                if let Some(i) = this.tabs_mut().and_then(|t| t.active) {
                    this.request_close_tab(i, window, cx);
                }
            }))
            .on_action(cx.listener(|this, _: &NewTerminal, window, cx| {
                if let Some((id, path)) = this.worktree().map(|w| (w.id.clone(), w.path.clone())) {
                    this.open_terminal(&id, &path, None, window, cx)
                }
            }))
            .on_action(cx.listener(|this, _: &GoBack, _, cx| this.go_back(cx)))
            .on_action(cx.listener(|this, _: &GoForward, _, cx| this.go_forward(cx)))
            .on_action(cx.listener(|this, _: &ShowReview, window, cx| this.toggle_review_view(review::View::Review, window, cx)))
            .on_action(cx.listener(|this, _: &ShowFiles, window, cx| this.toggle_review_view(review::View::Files, window, cx)))
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
                        // centre column takes up the slack). None in a popped-out window.
                        resizable_panel()
                            .size(px(sidebar_w))
                            .size_range(px(session_state::SIDEBAR_WIDTH.0)..px(session_state::SIDEBAR_WIDTH.2))
                            .flex_none()
                            .visible(self.locked.is_none())
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
                                                .children(review.map(|r| r.cached(tabs::fill()).into_any_element())),
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


/// Use Forest Ranger's icon in the Dock (assets/icon.png) — an unbundled
/// `cargo run` binary otherwise shows a generic one. Not in the .app: it has
/// icon.icns, and AppKit keeps a 32 MB rendering of an icon set this way.
#[cfg(target_os = "macos")]
fn set_dock_icon() {
    use objc2::{AllocAnyThread as _, MainThreadMarker};
    use objc2_app_kit::{NSApplication, NSImage};
    use objc2_foundation::NSData;
    static ICON: &[u8] = include_bytes!("../assets/icon.png");
    let bundled = std::env::current_exe().is_ok_and(|p| p.to_string_lossy().contains(".app/Contents/MacOS/"));
    if bundled {
        return;
    }
    let Some(mtm) = MainThreadMarker::new() else { return };
    let data = NSData::with_bytes(ICON);
    if let Some(image) = NSImage::initWithData(NSImage::alloc(), &data) {
        unsafe { NSApplication::sharedApplication(mtm).setApplicationIconImage(Some(&image)) };
    }
}

fn main() {
    if std::env::args().any(|a| a == "--check") {
        return dev::check();
    }
    if std::env::args().any(|a| a == "--agent") {
        return dev::check_agent();
    }
    // The app owns its database now (it used to be created by the Electron app).
    if let Err(e) = data::ensure_schema() {
        eprintln!("forest-ranger: couldn't set up the database: {e}");
    }
    // Closing the last window quits (macOS apps otherwise linger windowless).
    gpui_kit::application().with_assets(assets::Assets).with_quit_mode(QuitMode::LastWindowClosed).run(|cx| {
        gpui_kit::init(cx);
        files::register_grammars();
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
            // Next / previous tab (Safari, Terminal, VS Code; ⌃Tab as in browsers).
            // ⌘⇧] arrives as cmd-shift-] or cmd-} depending on the keyboard.
            KeyBinding::new("cmd-shift-]", NextTab, None),
            KeyBinding::new("cmd-}", NextTab, None),
            KeyBinding::new("ctrl-tab", NextTab, None),
            KeyBinding::new("cmd-shift-[", PrevTab, None),
            KeyBinding::new("cmd-{", PrevTab, None),
            KeyBinding::new("ctrl-shift-tab", PrevTab, None),
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
        let opened = gpui_kit::open_window(
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
        let (handle, fr) = opened;
        Windows::set_main(handle, &fr, cx);
        // Worktrees that were in their own windows when you quit.
        fr.update(cx, |fr, cx| fr.reopen_popped(cx));
        cx.activate(true);
        dev::smoke_close(cx);
    });
}
