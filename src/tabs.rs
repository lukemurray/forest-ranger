//! Center tabs: chats, diffs, files and terminals in split panes — opening,
//! focusing, closing, dragging, and drawing them.

use super::*;

/// A center tab: an agent chat, a file's diff, a file in the editor, or a terminal.
pub(crate) enum Tab {
    Chat(Entity<ChatView>),
    /// `fixed`: built from given texts (an agent's edit), not from git.
    Diff { key: String, title: String, state: Entity<DiffState>, root: String, file: String, base: Option<String>, full: bool, fixed: bool },
    File(Entity<files::FileView>),
    Term(Entity<term::TerminalView>),
    /// A pinned chat message opened beside its chat (read-only).
    Note(Entity<chat::NoteView>),
}

impl Tab {
    pub(crate) fn entity_id(&self) -> EntityId {
        match self {
            Tab::Chat(c) => c.entity_id(),
            Tab::Diff { state, .. } => state.entity_id(),
            Tab::File(f) => f.entity_id(),
            Tab::Term(t) => t.entity_id(),
            Tab::Note(n) => n.entity_id(),
        }
    }

    pub(crate) fn key(&self, cx: &App) -> String {
        match self {
            Tab::Chat(c) => format!("chat:{}", c.read(cx).session_id()),
            Tab::Diff { key, .. } => key.clone(),
            Tab::File(f) => format!("file:{}", f.read(cx).rel),
            Tab::Term(t) => format!("term:{}", t.read(cx).id),
            Tab::Note(n) => n.read(cx).key.clone(),
        }
    }
}

#[derive(Default)]
pub(crate) struct Tabs {
    pub(crate) open: Vec<Tab>,
    pub(crate) active: Option<usize>,
    /// Keys, most recently focused first (closing the active tab returns to the last one).
    pub(crate) mru: Vec<String>,
    /// The worktree's one temporary tab (italic title): the next file/diff open
    /// replaces it, until an edit or a double-click pins it.
    pub(crate) preview: Option<String>,
    /// Which group each tab sits in; `active` is the focused group's active tab.
    pub(crate) layout: panes::Node,
}

impl Tabs {
    pub(crate) fn keys(&self, cx: &App) -> Vec<String> {
        self.open.iter().map(|t| t.key(cx)).collect()
    }

    pub(crate) fn index(&self, key: &str, cx: &App) -> Option<usize> {
        self.open.iter().position(|t| t.key(cx) == key)
    }
}

/// A tab being dragged (by key), drawn under the pointer as a small chip.
#[derive(Clone)]
pub(crate) struct DraggedTab {
    pub(crate) key: String,
    pub(crate) title: String,
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
pub(crate) struct DraggedDivider {
    pub(crate) split: String,
    pub(crate) ix: usize,
}

impl Render for DraggedDivider {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
    }
}

/// `pos` moved by `step`, wrapping within `len`.
fn next_index(pos: usize, step: isize, len: usize) -> usize {
    (pos as isize + step).rem_euclid(len as isize) as usize
}

/// A git diff tab's key: `diff:<base|working|commit:hash>:<path>`.
pub(crate) fn diff_key(base: Option<&str>, file: &str) -> String {
    format!("diff:{}:{file}", base.unwrap_or("working"))
}

/// `diff:<base|working|commit:hash>:<path>` → (base, path).
pub(crate) fn parse_diff_key(key: &str) -> Option<(Option<String>, String)> {
    let rest = key.strip_prefix("diff:")?;
    let (base, file) = match rest.strip_prefix("commit:") {
        Some(r) => r.split_once(':').map(|(h, f)| (format!("commit:{h}"), f))?,
        None => rest.split_once(':').map(|(b, f)| (b.to_string(), f))?,
    };
    Some(((base != "working").then_some(base), file.to_string()))
}

/// A cached view's box (it's sized from this, not its contents): fill the pane.
pub(crate) fn fill() -> StyleRefinement {
    StyleRefinement::default().size_full()
}

impl ForestRanger {
    /// An empty diff view in the last-used layout (split / unified).
    pub(crate) fn new_diff_state(cx: &mut Context<Self>) -> Entity<DiffState> {
        let mode = if SessionState::get(cx).diff_unified { DiffMode::Unified } else { DiffMode::Split };
        cx.new(|cx| DiffState::new(vec![], cx).with_mode(mode))
    }

    /// Fill a diff tab off the UI thread (a big file's diff can take a while). One
    /// load per tab: a newer one replaces (cancels) an older, so quick toggles can't
    /// land out of order.
    pub(crate) fn fill_diff(&mut self, state: &Entity<DiffState>, patch: impl FnOnce() -> String + Send + 'static, cx: &mut Context<Self>) {
        let work = cx.background_executor().spawn(async move {
            // Highlight as the editor would (e.g. .csproj as XML, .h as C++), not by raw extension.
            let parsed = DiffFile::parse(&patch()).unwrap_or_default();
            parsed.into_iter().map(|f| {
                let lang = files::language_for(f.path());
                f.with_language(lang)
            }).collect::<Vec<_>>()
        });
        let weak = state.downgrade();
        let task = cx.spawn(async move |_, cx| {
            let files = work.await;
            let _ = weak.update(cx, |s, cx| s.set_files(files, cx));
        });
        self.diff_loads.insert(state.entity_id(), task);
    }

    /// Focus tab `i`: bumps it in the focus order and saves the tab state.
    pub(crate) fn activate(&mut self, i: usize, cx: &mut Context<Self>) {
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
    pub(crate) fn persist_tabs(&mut self, cx: &mut Context<Self>) {
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
    pub(crate) fn restore_tabs(&mut self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
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
                self.diff_tab(&path, &file, base, cx)
            } else if let Some(tid) = key.strip_prefix("term:") {
                // Its shell ended with the app: a fresh one in the worktree.
                let Ok(session) = term::start(&path, None) else { continue };
                Tab::Term(self.term_view(session, Some(tid.into()), cx))
            } else if let Some((sid, mid)) = key.strip_prefix("note:").and_then(|k| k.split_once(':')) {
                // Re-read from its chat's log; gone if the message is.
                let Some(text) = chat::pinned_text(sid, mid) else { continue };
                Tab::Note(cx.new(|_| chat::NoteView::new(key.clone(), chat::pin_title(&text), text)))
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

    /// The next (`step` 1) or previous (-1) tab in the focused pane, in the order
    /// shown, wrapping around.
    pub(crate) fn cycle_tab(&mut self, step: isize, cx: &mut Context<Self>) {
        let Some(tabs) = self.tabs_mut() else { return };
        let Some(active) = tabs.active.and_then(|i| tabs.open.get(i)).map(|t| t.key(cx)) else { return };
        let order = tabs.layout.group_of(&active).map(|g| g.tabs.clone()).unwrap_or_else(|| tabs.keys(cx));
        let Some(pos) = order.iter().position(|k| *k == active) else { return };
        let next = &order[next_index(pos, step, order.len())];
        if let Some(i) = tabs.index(next, cx) {
            self.activate(i, cx);
        }
    }

    /// Focus the tab with `key` if it's open; true if found.
    pub(crate) fn focus_tab(&mut self, key: &str, cx: &mut Context<Self>) -> bool {
        let keys: Vec<String> = self.tabs_mut().map(|t| t.open.iter().map(|t| t.key(cx)).collect()).unwrap_or_default();
        match keys.iter().position(|k| k == key) {
            Some(i) => {
                self.activate(i, cx);
                true
            }
            None => false,
        }
    }

    pub(crate) fn push_tab(&mut self, tab: Tab, cx: &mut Context<Self>) {
        let Some(tabs) = self.tabs_mut() else { return };
        tabs.open.push(tab);
        let i = tabs.open.len() - 1;
        self.activate(i, cx);
    }

    /// Open a file/diff tab as the worktree's preview: it takes the existing
    /// preview tab's place, or opens a new one.
    pub(crate) fn push_preview(&mut self, tab: Tab, cx: &mut Context<Self>) {
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

    pub(crate) fn pin_tab(&mut self, i: usize, cx: &mut Context<Self>) {
        let Some(tabs) = self.tabs_mut() else { return };
        let key = tabs.open.get(i).map(|t| t.key(cx));
        if key.is_some() && tabs.preview == key {
            tabs.preview = None;
            cx.notify();
        }
    }

    /// A git diff tab, opened with the last-used toggles.
    pub(crate) fn diff_tab(&mut self, root: &str, file: &str, base: Option<String>, cx: &mut Context<Self>) -> Tab {
        let full = SessionState::get(cx).diff_full;
        let key = diff_key(base.as_deref(), file);
        let name = file.rsplit('/').next().unwrap_or(file);
        let title = match base.as_deref() {
            None => format!("{name} (changes)"),
            Some(b) if b.starts_with("commit:") => format!("{name} @ {}", &b[7..14.min(b.len())]),
            Some(b) => format!("{name} vs {b}"),
        };
        let state = Self::new_diff_state(cx);
        let (r, f, b) = (root.to_string(), file.to_string(), base.clone());
        self.fill_diff(&state, move || git::diff_patch(&r, &f, b.as_deref(), full), cx);
        Tab::Diff { key, title, state, root: root.into(), file: file.into(), base, full, fixed: false }
    }

    pub(crate) fn open_diff(&mut self, root: &str, file: &str, base: Option<String>, cx: &mut Context<Self>) {
        if let Some(id) = self.selected.clone() {
            SessionState::update(cx, |s| s.worktree_mut(&id).record_recent(file));
        }
        let key = diff_key(base.as_deref(), file);
        // Re-opening refreshes the diff in place.
        if let Some(Tab::Diff { state, full, .. }) =
            self.tabs_mut().and_then(|t| t.open.iter().find(|t| matches!(t, Tab::Diff { key: k, .. } if *k == key)))
        {
            let (state, full) = (state.clone(), *full);
            let (r, f) = (root.to_string(), file.to_string());
            self.fill_diff(&state, move || git::diff_patch(&r, &f, base.as_deref(), full), cx);
            self.focus_tab(&key, cx);
            return;
        }
        let tab = self.diff_tab(root, file, base, cx);
        self.push_preview(tab, cx);
    }

    /// Flip a diff tab between split/unified, or between hunks and the whole file.
    /// The choice is remembered for the next diff tab.
    pub(crate) fn toggle_diff(&mut self, i: usize, full_file: bool, cx: &mut Context<Self>) {
        let Some(Tab::Diff { state, root, file, base, full, fixed, .. }) = self.tabs_mut().and_then(|t| t.open.get_mut(i)) else { return };
        let state = state.clone();
        if full_file {
            if *fixed {
                return;
            }
            *full = !*full;
            let (r, f, b, full) = (root.clone(), file.clone(), base.clone(), *full);
            SessionState::update(cx, |s| s.diff_full = full);
            self.fill_diff(&state, move || git::diff_patch(&r, &f, b.as_deref(), full), cx);
        } else {
            let unified = state.read(cx).mode() == DiffMode::Split;
            state.update(cx, |s, cx| s.set_mode(if unified { DiffMode::Unified } else { DiffMode::Split }, cx));
            SessionState::update(cx, |s| s.diff_unified = unified);
        }
        cx.notify();
    }

    /// A FileView whose first edit pins its tab.
    pub(crate) fn file_view(&mut self, root: &str, rel: &str, line: Option<u32>, window: &mut Window, cx: &mut Context<Self>) -> Entity<files::FileView> {
        let view = cx.new(|cx| files::FileView::new(root, rel, line, window, cx));
        let key = format!("file:{rel}");
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
        self.tab_subs.push((view.entity_id(), sub));
        view
    }

    pub(crate) fn open_file(&mut self, root: &str, rel: &str, line: Option<u32>, window: &mut Window, cx: &mut Context<Self>) {
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
    pub(crate) fn save_all(&mut self, cx: &mut Context<Self>) {
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

    /// The panel's current view (or the saved one before the panel's been built).
    pub(crate) fn review_view_now(&self, cx: &App) -> review::View {
        let Some(id) = &self.selected else { return review::View::Review };
        match self.reviews.get(id) {
            Some(r) => r.read(cx).view,
            None => crate::view_of(&SessionState::get(cx).panel(id).view),
        }
    }

    /// Titlebar / ⌘1 / ⌘2: open the panel on `view`, or close it if that's what's showing.
    pub(crate) fn toggle_review_view(&mut self, view: review::View, window: &mut Window, cx: &mut Context<Self>) {
        if self.show_diff && self.review_view_now(cx) == view {
            return self.toggle_panel(cx);
        }
        self.set_review_view(view, window, cx);
    }

    pub(crate) fn set_review_view(&mut self, view: review::View, window: &mut Window, cx: &mut Context<Self>) {
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

    pub(crate) fn tabs_mut(&mut self) -> Option<&mut Tabs> {
        let id = self.selected.clone()?;
        Some(self.tabs.entry(id).or_default())
    }

    pub(crate) fn open_saved(&mut self, sid: &str, window: &mut Window, cx: &mut Context<Self>) {
        let Some(path) = self.worktree().map(|w| w.path.clone()) else { return };
        if self.focus_tab(&format!("chat:{sid}"), cx) {
            return;
        }
        let chat = cx.new(|cx| ChatView::open(sid, &path, window, cx));
        let Some(wt) = self.selected.clone() else { return };
        let tab = self.chat_tab(&wt, chat, window, cx);
        self.push_tab(tab, cx);
    }

    /// Open a terminal tab in worktree `wt` (going there first), running
    /// `command` (label, command line) if given.
    pub(crate) fn open_terminal(&mut self, wt: &str, cwd: &str, run: Option<term::Run>, window: &mut Window, cx: &mut Context<Self>) {
        let command_label = run.as_ref().map(|r| r.label.clone());
        let session = match term::start(cwd, run) {
            Ok(s) => s,
            Err(e) => return window.push_notification(crate::notify::error(format!("Couldn't start a terminal: {e}")), cx),
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

    pub(crate) fn term_view(&mut self, session: term::Session, id: Option<String>, cx: &mut Context<Self>) -> Entity<term::TerminalView> {
        let view = cx.new(|cx| term::TerminalView::new(session, id, cx));
        // ponytail: kept for the app's life like the file-view subs.
        let sub = cx.subscribe(&view, |_, _, _: &term::TermChanged, cx| cx.notify());
        self.tab_subs.push((view.entity_id(), sub));
        let done = cx.subscribe(&view, |this, view, _: &term::TermFinished, cx| this.close_term(&view, cx));
        self.tab_subs.push((view.entity_id(), done));
        view
    }

    /// Close a terminal's tab, in whichever worktree it's in.
    fn close_term(&mut self, view: &Entity<term::TerminalView>, cx: &mut Context<Self>) {
        let found = self.tabs.iter().find_map(|(wt, t)| {
            let i = t.open.iter().position(|t| matches!(t, Tab::Term(v) if v == view))?;
            Some((wt.clone(), i))
        });
        let Some((wt, i)) = found else { return };
        // close_tab works on the selected worktree's tabs (and saves them): point it
        // at this one for the call. The selection itself doesn't change.
        let shown = self.selected.replace(wt);
        self.close_tab(i, cx);
        self.selected = shown;
        cx.notify();
    }

    pub(crate) fn new_chat(&mut self, provider: &str, window: &mut Window, cx: &mut Context<Self>) {
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

    /// Close tab `i` of the selected worktree — after asking, if an agent is working
    /// (or waiting on you) there, or its terminal is running something.
    pub(crate) fn request_close_tab(&mut self, i: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some((wt, tab)) = self.selected.clone().and_then(|wt| Some((wt.clone(), self.tabs.get(&wt)?.open.get(i)?))) else { return };
        let warning = match tab {
            Tab::Chat(c) if matches!(c.read(cx).attention(), Attention::Working | Attention::NeedsAnswer) => {
                Some(("Stop the agent?", "The agent in this chat is still working. Closing the tab stops it; the chat so far is saved."))
            }
            Tab::Term(t) if t.read(cx).busy() => Some(("Stop the running process?", "Something is still running in this terminal. Closing the tab ends it.")),
            _ => None,
        };
        let Some((title, description)) = warning else { return self.close_tab(i, cx) };
        let key = tab.key(cx);
        let fr = cx.entity();
        window.open_alert_dialog(cx, move |alert, _, _| {
            let (fr, wt, key) = (fr.clone(), wt.clone(), key.clone());
            alert.title(title).description(description).ok_text("Close").ok_variant(ButtonVariant::Danger).show_cancel(true).on_ok(move |_, _, cx| {
                // By key and worktree: tabs may have moved while the dialog was up.
                fr.update(cx, |fr, cx| {
                    let Some(i) = fr.tabs.get(&wt).and_then(|t| t.index(&key, cx)) else { return };
                    let shown = fr.selected.replace(wt.clone());
                    fr.close_tab(i, cx);
                    fr.selected = shown;
                    cx.notify();
                });
                true
            })
        });
    }

    pub(crate) fn close_tab(&mut self, i: usize, cx: &mut Context<Self>) {
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
        self.load_chats(cx);
        self.prune();
        self.update_badge(cx);
        cx.notify();
    }

    pub(crate) fn center(&self, cx: &mut Context<Self>) -> AnyElement {
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
    pub(crate) fn pane(&self, node: &panes::Node, tabs: &Tabs, cx: &mut Context<Self>) -> AnyElement {
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
    pub(crate) fn pane_group(&self, g: &panes::Group, tabs: &Tabs, cx: &mut Context<Self>) -> AnyElement {
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
                    Tab::Chat(c) => status_dot(c.read(cx).attention(), cx)
                        .unwrap_or_else(|| sidebar::icon("fr/sparkle.svg", 12., theme.primary).into_any_element()),
                    Tab::Diff { .. } => sidebar::icon("fr/git-branch.svg", 12., x.amber).into_any_element(),
                    Tab::File(_) => sidebar::icon("fr/folder.svg", 12., theme.muted_foreground).into_any_element(),
                    Tab::Term(_) => sidebar::icon("fr/terminal.svg", 12., theme.muted_foreground).into_any_element(),
                    Tab::Note(_) => sidebar::icon("fr/pin.svg", 12., theme.primary).into_any_element(),
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
                                .on_click(cx.listener(move |this, _, window, cx| {
                                    cx.stop_propagation();
                                    this.request_close_tab(i, window, cx);
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

    pub(crate) fn tab_body(&self, shown: Option<usize>, tabs: &Tabs, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().colors;
        let x = theme::extra(cx);
        match shown.and_then(|i| tabs.open.get(i)) {
            // Cached: the view reuses its last frame unless it notified itself, so a
            // pulsing dot or the sidebar re-rendering doesn't re-render the chat.
            Some(Tab::Chat(chat)) => chat.clone().cached(fill()).into_any_element(),
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
            Some(Tab::File(f)) => f.clone().cached(fill()).into_any_element(),
            Some(Tab::Term(t)) => t.clone().cached(fill()).into_any_element(),
            Some(Tab::Note(n)) => n.clone().cached(fill()).into_any_element(),
            None => div().size_full().into_any_element(),
        }
    }

    /// Drop a tab into a group's strip (at `index`, default the end).
    pub(crate) fn move_tab(&mut self, key: &str, group: &str, index: Option<usize>, cx: &mut Context<Self>) {
        let Some(tabs) = self.tabs_mut() else { return };
        tabs.layout = std::mem::take(&mut tabs.layout).move_tab(key, group, index);
        if let Some(i) = tabs.index(key, cx) {
            self.activate(i, cx);
        }
    }

    /// Drop a tab on a group's body: split it off that edge (centre: move it in).
    /// A pinned message as a read-only tab, split off to the right of its chat
    /// (or focused, if it's already open).
    pub(crate) fn open_note(&mut self, wt: &str, key: &str, title: &str, text: &str, beside: &str, cx: &mut Context<Self>) {
        if self.selected.as_deref() != Some(wt) || self.focus_tab(key, cx) {
            return;
        }
        let view = cx.new(|_| chat::NoteView::new(key.to_string(), title.to_string(), text.to_string()));
        self.push_tab(Tab::Note(view), cx);
        let group = self.tabs_mut().and_then(|t| t.layout.group_of(beside).map(|g| g.id.clone()));
        if let Some(g) = group {
            self.split_tab(key, &g, panes::Drop::Right, cx);
        }
    }

    pub(crate) fn split_tab(&mut self, key: &str, group: &str, side: panes::Drop, cx: &mut Context<Self>) {
        let Some(tabs) = self.tabs_mut() else { return };
        tabs.layout = std::mem::take(&mut tabs.layout).split_off(key, group, side);
        if let Some(i) = tabs.index(key, cx) {
            self.activate(i, cx);
        }
    }

    pub(crate) fn resize_split(&mut self, split: &str, ix: usize, at: f32, cx: &mut Context<Self>) {
        let Some(tabs) = self.tabs_mut() else { return };
        let Some(sizes) = tabs.layout.sizes(split).and_then(|s| panes::resize(s, ix, at)) else { return };
        tabs.layout = std::mem::take(&mut tabs.layout).set_sizes(split, sizes);
        self.persist_tabs(cx);
        cx.notify();
    }

    /// Keep the selected worktree's layout holding exactly its open tabs (a tab
    /// opened while another worktree was selected lands in the focused group).
    pub(crate) fn reconcile_layout(&mut self, cx: &mut Context<Self>) {
        let Some(tabs) = self.selected.as_ref().and_then(|id| self.tabs.get_mut(id)) else { return };
        let keys = tabs.keys(cx);
        let have = tabs.layout.all_tabs();
        if have.len() != keys.len() || keys.iter().any(|k| !have.contains(k)) {
            let focus = tabs.active.and_then(|i| keys.get(i).cloned());
            tabs.layout = std::mem::take(&mut tabs.layout).reconcile(&keys, focus.as_deref());
        }
    }

    /// A file / diff tab's title, or the name you gave it.
    pub(crate) fn tab_title(&self, tab: &Tab, cx: &App) -> String {
        let title = match tab {
            Tab::Chat(c) => return c.read(cx).title(),
            Tab::Diff { title, .. } => title.clone(),
            Tab::File(f) => f.read(cx).title(),
            Tab::Term(t) => t.read(cx).title(),
            Tab::Note(n) => n.read(cx).title.clone(),
        };
        self.selected
            .as_deref()
            .and_then(|id| SessionState::worktree(cx, id))
            .and_then(|w| w.titles.get(&tab.key(cx)).cloned())
            .unwrap_or(title)
    }

    /// Double-click a (pinned) tab: edit its title in place.
    pub(crate) fn start_rename(&mut self, i: usize, window: &mut Window, cx: &mut Context<Self>) {
        let Some(tab) = self.selected.as_ref().and_then(|id| self.tabs.get(id)).and_then(|t| t.open.get(i)) else { return };
        let (key, title) = (tab.key(cx), self.tab_title(tab, cx));
        self.start_inline_edit(key, title, None, window, cx);
    }

}

#[cfg(test)]
mod tests {
    use super::{diff_key, next_index, parse_diff_key};

    #[test]
    fn tab_cycling_wraps() {
        assert_eq!(next_index(0, 1, 3), 1);
        assert_eq!(next_index(2, 1, 3), 0);
        assert_eq!(next_index(0, -1, 3), 2);
        assert_eq!(next_index(0, 1, 1), 0);
    }

    #[test]
    fn diff_keys() {
        assert_eq!(parse_diff_key("diff:working:src/a:b.rs"), Some((None, "src/a:b.rs".into())));
        assert_eq!(parse_diff_key("diff:origin/main:x.rs"), Some((Some("origin/main".into()), "x.rs".into())));
        assert_eq!(parse_diff_key("diff:commit:abc123:x.rs"), Some((Some("commit:abc123".into()), "x.rs".into())));
        assert_eq!(parse_diff_key("file:x.rs"), None);
        assert_eq!(parse_diff_key(&diff_key(Some("commit:abc"), "a:b")), Some((Some("commit:abc".into()), "a:b".into())));
    }
}
