//! A worktree popped out into its own window: the same shell, locked to that
//! worktree, without the sidebar. Its running chats and terminals move across
//! live (no agent restarts); files, diffs and the side panel reopen there.
//! Closing the window docks it back into the main one, which shows it again.
//! The main window lists it greyed out; clicking brings its window forward.

use std::collections::HashMap;

use super::*;

/// Every window's shell: the main one, and popped-out worktrees by id.
#[derive(Default)]
pub(crate) struct Windows {
    main: Option<(AnyWindowHandle, WeakEntity<ForestRanger>)>,
    popped: HashMap<String, (AnyWindowHandle, WeakEntity<ForestRanger>)>,
}

impl Global for Windows {}

impl Windows {
    pub(crate) fn set_main(handle: AnyWindowHandle, fr: &Entity<ForestRanger>, cx: &mut App) {
        cx.default_global::<Windows>().main = Some((handle, fr.downgrade()));
    }

    fn get(cx: &App) -> Option<&Windows> {
        cx.try_global::<Windows>()
    }

    /// The window a popped-out worktree lives in.
    pub(crate) fn popped(cx: &App, wt: &str) -> Option<(AnyWindowHandle, Entity<ForestRanger>)> {
        let (h, fr) = Self::get(cx)?.popped.get(wt)?;
        Some((*h, fr.upgrade()?))
    }

    fn main(cx: &App) -> Option<(AnyWindowHandle, Entity<ForestRanger>)> {
        let (h, fr) = Self::get(cx)?.main.as_ref()?;
        Some((*h, fr.upgrade()?))
    }

    /// The other windows' shells (not `me`, which may be mid-update).
    pub(crate) fn others(cx: &App, me: EntityId) -> Vec<Entity<ForestRanger>> {
        let Some(w) = Self::get(cx) else { return vec![] };
        w.main.iter().chain(w.popped.values()).filter_map(|(_, fr)| fr.upgrade()).filter(|fr| fr.entity_id() != me).collect()
    }
}

/// Bring a window to the front.
fn activate(handle: AnyWindowHandle, cx: &mut App) {
    let _ = handle.update(cx, |_, window, _| window.activate_window());
}

impl ForestRanger {
    /// A popped-out window's shell for worktree `wt`, adopting its live tabs.
    fn popped_out(wt: String, adopted: HashMap<String, Tab>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut this = Self::build(Some(wt.clone()), window, cx);
        this.adopted = adopted;
        this.show(wt, cx);
        this
    }

    /// Pop worktree `wt` out into its own window (or bring that window forward).
    pub(crate) fn pop_out(&mut self, wt: &str, cx: &mut Context<Self>) {
        if let Some((h, _)) = Windows::popped(cx, wt) {
            return activate(h, cx);
        }
        let Some(label) = self.projects.iter().flat_map(|p| &p.worktrees).find(|w| w.id == wt).map(|w| w.branch.clone().unwrap_or_else(|| w.label().0)) else { return };
        // Hand over what's running; the rest reopens there from the saved tab state.
        let adopted = self.take_live_tabs(wt, cx);
        if self.selected.as_deref() == Some(wt) {
            let pid = self.projects.iter().find(|p| p.worktrees.iter().any(|w| w.id == wt)).map(|p| p.id.clone());
            self.selected = None;
            if let Some(pid) = pid {
                self.show_project(pid, cx);
            }
        }
        SessionState::update(cx, |s| {
            if !s.popped.iter().any(|w| w == wt) {
                s.popped.push(wt.to_string());
            }
        });
        let (wt, me) = (wt.to_string(), cx.entity());
        // Deferred: opening the window builds a shell, which mustn't happen inside ours.
        cx.defer(move |cx| open_popped(wt, label, adopted, me, cx));
        cx.notify();
    }

    /// Remove a worktree's tabs from this shell: its chats and terminals (kept
    /// alive, by tab key) after saving its files. Its panel goes too.
    pub(crate) fn take_live_tabs(&mut self, wt: &str, cx: &mut Context<Self>) -> HashMap<String, Tab> {
        let shown = self.selected.replace(wt.to_string());
        self.persist_tabs(cx);
        self.selected = shown;
        let tabs = self.tabs.remove(wt).unwrap_or_default();
        for t in &tabs.open {
            if let Tab::File(f) = t {
                f.update(cx, |f, cx| f.save(cx));
            }
        }
        self.reviews.remove(wt);
        self.restored.remove(wt);
        let live: HashMap<String, Tab> = tabs.open.into_iter().filter(|t| matches!(t, Tab::Chat(_) | Tab::Term(_))).map(|t| (t.key(cx), t)).collect();
        self.prune();
        live
    }

    /// Wire an adopted chat or terminal into this window (its events, its composer).
    pub(crate) fn adopt(&mut self, wt: &str, tab: Tab, window: &mut Window, cx: &mut Context<Self>) -> Tab {
        match tab {
            Tab::Chat(chat) => {
                chat.update(cx, |c, cx| c.move_to_window(window, cx));
                self.chat_tab(wt, chat, window, cx)
            }
            Tab::Term(t) => {
                self.watch_term(&t, cx);
                Tab::Term(t)
            }
            other => other,
        }
    }

    /// This popped-out window is closing: give its worktree back to the main window.
    pub(crate) fn dock_back(&mut self, cx: &mut Context<Self>) {
        let Some(wt) = self.locked.clone() else { return };
        // Already let go of: docked once, or its worktree was removed (nothing to return).
        if Windows::popped(cx, &wt).is_none() {
            return;
        }
        let live = self.take_live_tabs(&wt, cx);
        if cx.has_global::<Windows>() {
            cx.global_mut::<Windows>().popped.remove(&wt);
        }
        SessionState::update(cx, |s| s.popped.retain(|w| *w != wt));
        let Some((h, main)) = Windows::main(cx) else { return };
        cx.defer(move |cx| {
            main.update(cx, |m, cx| {
                m.adopted.extend(live);
                m.window_subs.remove(&wt);
                m.select(wt, cx);
            });
            activate(h, cx);
        });
    }

    /// Main window: a popped-out worktree's row was clicked — bring its window forward.
    pub(crate) fn focus_popped(&self, wt: &str, cx: &mut App) -> bool {
        match Windows::popped(cx, wt) {
            Some((h, _)) => {
                activate(h, cx);
                true
            }
            None => false,
        }
    }

    /// A popped-out window asked to go somewhere else: the main window does that.
    pub(crate) fn forward_to_main(&self, loc: String, cx: &mut App) {
        let Some((h, main)) = Windows::main(cx) else { return };
        cx.defer(move |cx| {
            main.update(cx, |m, cx| m.goto_from_elsewhere(loc, cx));
            activate(h, cx);
        });
    }

    /// Navigate (from another window or a notification), recorded in history.
    pub(crate) fn goto_from_elsewhere(&mut self, loc: String, cx: &mut Context<Self>) {
        match loc.strip_prefix("project:") {
            Some(pid) => self.open_project(pid.to_string(), cx),
            None => self.select(loc, cx),
        }
    }

    /// Main window: close the own windows of worktrees that were removed (here or
    /// outside the app) — their chats and terminals stop, as a removed worktree's do.
    pub(crate) fn close_removed_popped(&mut self, cx: &mut Context<Self>) {
        if self.locked.is_some() || !cx.has_global::<Windows>() {
            return;
        }
        let live: std::collections::HashSet<&str> = self.projects.iter().flat_map(|p| &p.worktrees).map(|w| w.id.as_str()).collect();
        let gone: Vec<(String, AnyWindowHandle)> =
            cx.global::<Windows>().popped.iter().filter(|(wt, _)| !live.contains(wt.as_str())).map(|(wt, (h, _))| (wt.clone(), *h)).collect();
        for (wt, h) in gone {
            cx.global_mut::<Windows>().popped.remove(&wt);
            self.window_subs.remove(&wt);
            SessionState::update(cx, |s| {
                s.popped.retain(|w| *w != wt);
                s.popped_bounds.remove(&wt);
            });
            cx.defer(move |cx| {
                let _ = h.update(cx, |_, window, _| window.remove_window());
            });
        }
    }

    /// Reopen the worktrees that were in their own windows last run.
    pub(crate) fn reopen_popped(&mut self, cx: &mut Context<Self>) {
        let ids: Vec<String> = SessionState::get(cx).popped.clone();
        let live: Vec<String> = ids.into_iter().filter(|id| self.projects.iter().flat_map(|p| &p.worktrees).any(|w| w.id == *id)).collect();
        SessionState::update(cx, |s| s.popped.clear());
        for id in live {
            self.pop_out(&id, cx);
        }
    }
}

fn open_popped(wt: String, label: String, adopted: HashMap<String, Tab>, main: Entity<ForestRanger>, cx: &mut App) {
    let bounds = session_state::popped_bounds(cx, &wt);
    let id = wt.clone();
    let opened = gpui_kit::open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            titlebar: Some(TitlebarOptions {
                title: Some(format!("{label} — Forest Ranger").into()),
                appears_transparent: true,
                traffic_light_position: Some(point(px(12.), px(12.))),
            }),
            ..Default::default()
        },
        cx,
        move |window, cx| cx.new(|cx| ForestRanger::popped_out(id, adopted, window, cx)),
    );
    let Ok((handle, fr)) = opened else { return };
    cx.default_global::<Windows>().popped.insert(wt.clone(), (handle, fr.downgrade()));
    // The main window's sidebar shows this worktree's dots: redraw it as they change.
    main.update(cx, |m, cx| {
        let sub = cx.observe(&fr, |_, _, cx| cx.notify());
        m.window_subs.insert(wt, sub);
        cx.notify();
    });
}
