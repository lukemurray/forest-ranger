//! Worktree lifecycle dialogs: new, remove, rename (label), rename branch, and
//! the remove-project confirm, and review-a-branch — the Electron app's *Dialog.tsx components.

use std::cell::Cell;

use gpui_kit::component::button::{Button, ButtonVariant, ButtonVariants as _};
use gpui_kit::component::checkbox::Checkbox;
use gpui_kit::component::input::{Input, InputEvent, InputState, Textarea, TextareaState};
use gpui_kit::component::searchable_list::SearchableVec;
use gpui_kit::component::select::{Select, SelectEvent, SelectState};
use gpui_kit::component::*;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::settings::{self, Settings};
use crate::chat::Attention;
use crate::{ForestRanger, data, git, theme};

/// Open `view` as a dialog, focusing `focus` once on open.
pub(crate) fn show<V: Render>(title: &'static str, view: Entity<V>, focus: Option<Entity<InputState>>, window: &mut Window, cx: &mut App) {
    let first = Cell::new(true);
    window.open_dialog(cx, move |d, window, cx| {
        if first.replace(false) {
            if let Some(f) = &focus {
                f.update(cx, |s, cx| {
                    s.focus(window, cx);
                    s.select_all(window, cx);
                });
            }
        }
        d.width(px(420.)).title(title).child(view.clone())
    });
}

pub(crate) fn field(label: &'static str, body: impl IntoElement, cx: &App) -> Div {
    div()
        .flex()
        .flex_col()
        .gap_1()
        .child(div().text_size(px(12.)).text_color(cx.theme().colors.muted_foreground).child(label))
        .child(body)
}

pub(crate) fn error_line(e: Option<String>, cx: &App) -> impl IntoElement {
    let danger = cx.theme().colors.danger;
    div().when_some(e, |d, e| d.text_size(px(12.5)).text_color(danger).child(e))
}

/// Cancel + the primary action, right-aligned.
pub(crate) fn actions(primary: Button) -> Div {
    div()
        .flex()
        .justify_end()
        .gap_2()
        .pt_2()
        .child(Button::new("cancel").ghost().label("Cancel").on_click(|_, window, cx| window.close_dialog(cx)))
        .child(primary)
}

fn project_of<'a>(fr: &'a ForestRanger, project_id: &str) -> Option<&'a data::Project> {
    fr.projects.iter().find(|p| p.id == project_id)
}

// --- New worktree -----------------------------------------------------------

struct NewWorktree {
    fr: WeakEntity<ForestRanger>,
    project_id: String,
    repo: String,
    default_parent: String,
    name: Entity<InputState>,
    base: Entity<SelectState<SearchableVec<String>>>,
    location: Entity<InputState>,
    start_chat: bool,
    open_editor: bool,
    busy: bool,
    error: Option<String>,
    _sub: Subscription,
}

pub fn new_worktree(fr: Entity<ForestRanger>, project_id: String, window: &mut Window, cx: &mut App) {
    // Deferred: callers are often ForestRanger's own click handlers, and this reads
    // ForestRanger — reading it mid-update panics.
    window.defer(cx, move |window, cx| new_worktree_now(fr, project_id, window, cx));
}

fn new_worktree_now(fr: Entity<ForestRanger>, project_id: String, window: &mut Window, cx: &mut App) {
    let Some((repo, default_parent)) = project_of(fr.read(cx), &project_id).map(|p| (p.path.clone(), data::worktree_parent(p))) else { return };
    // ponytail: three quick git calls on the UI thread; move to the background if large repos stall.
    let branches = git::list_branches(&repo);
    let base = git::resolve_base(&repo, None);
    let sel = base.as_ref().and_then(|b| branches.iter().position(|x| x == b)).map(IndexPath::new);
    let view = cx.new(|cx| {
        let name = cx.new(|cx| InputState::new(window, cx).placeholder("auto-generated if blank"));
        let location = cx.new(|cx| InputState::new(window, cx).placeholder("~/path/to/worktrees").default_value(data::tilde_path(&default_parent)));
        let base = cx.new(|cx| SelectState::new(SearchableVec::new(branches), sel, window, cx).searchable(true));
        let sub = cx.subscribe_in(&name, window, |this: &mut NewWorktree, _, ev: &InputEvent, window, cx| {
            if matches!(ev, InputEvent::PressEnter { .. }) {
                this.create(window, cx);
            }
        });
        NewWorktree {
            fr: fr.downgrade(),
            project_id,
            repo,
            default_parent,
            name,
            base,
            location,
            start_chat: false,
            open_editor: false,
            busy: false,
            error: None,
            _sub: sub,
        }
    });
    let focus = view.read(cx).name.clone();
    show("New worktree", view, Some(focus), window, cx);
}

impl NewWorktree {
    fn create(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        self.busy = true;
        self.error = None;
        let name = self.name.read(cx).value().to_string();
        let base = self.base.read(cx).selected_value().cloned();
        let location = self.location.read(cx).value().trim().to_string();
        let (pid, repo, fallback) = (self.project_id.clone(), self.repo.clone(), self.default_parent.clone());
        let work = cx.background_executor().spawn(async move {
            let branch = data::new_branch_name(&name, base.as_deref());
            // An explicit location becomes the project's remembered default.
            let parent = if location.is_empty() { fallback } else { data::expand_tilde(&location) };
            data::set_worktree_dir(&pid, &parent);
            std::fs::create_dir_all(&parent).map_err(|e| e.to_string())?;
            let path = data::worktree_folder(&parent, &branch).to_string_lossy().into_owned();
            let base = git::resolve_base(&repo, base.as_deref());
            git::worktree_add(&repo, &path, &branch, base.as_deref())?;
            data::sync_worktrees(&pid, &repo)?;
            Ok::<_, String>((data::worktree_id(&pid, &path), path))
        });
        cx.spawn_in(window, async move |this, cx| {
            let res = work.await;
            let _ = this.update_in(cx, |this, window, cx| match res {
                Err(e) => {
                    this.busy = false;
                    this.error = Some(e);
                    cx.notify();
                }
                Ok((id, path)) => {
                    if this.open_editor {
                        settings::open_in(cx.global::<Settings>().editor.as_deref(), &path);
                    }
                    let start = this.start_chat;
                    window.close_dialog(cx);
                    let Some(fr) = this.fr.upgrade() else { return };
                    fr.update(cx, |fr, cx| {
                        fr.reload(cx);
                        fr.select(id, cx);
                        if start {
                            let p = cx.global::<Settings>().provider.clone();
                            fr.new_chat(&p, window, cx);
                        }
                    });
                }
            });
        })
        .detach();
        cx.notify();
    }
}

impl Render for NewWorktree {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let mono = cx.theme().mono_font_family.clone();
        let agent = if cx.global::<Settings>().provider == "codex" { "Codex" } else { "Claude" };
        div()
            .flex()
            .flex_col()
            .gap_3()
            .child(field("Branch name (optional)", Input::new(&self.name).font_family(mono.clone()), cx))
            .child(field("Base branch", Select::new(&self.base).placeholder("current HEAD").search_placeholder("Filter branches…"), cx))
            .child(field("Location", Input::new(&self.location).font_family(mono), cx))
            .child(
                Checkbox::new("start-chat")
                    .label(format!("Start a {agent} chat in the new worktree"))
                    .checked(self.start_chat)
                    .on_click(cx.listener(|this, v: &bool, _, cx| {
                        this.start_chat = *v;
                        cx.notify();
                    })),
            )
            .child(
                Checkbox::new("open-editor").label("Open in editor").checked(self.open_editor).on_click(cx.listener(|this, v: &bool, _, cx| {
                    this.open_editor = *v;
                    cx.notify();
                })),
            )
            .child(error_line(self.error.clone(), cx))
            .child(actions(
                Button::new("create")
                    .primary()
                    .label(if self.busy { "Creating…" } else { "Create worktree" })
                    .disabled(self.busy)
                    .on_click(cx.listener(|this, _, window, cx| this.create(window, cx))),
            ))
    }
}

// --- Remove worktree --------------------------------------------------------

struct RemoveWorktree {
    fr: WeakEntity<ForestRanger>,
    project_id: String,
    repo: String,
    wt_id: String,
    path: String,
    primary_id: Option<String>,
    info: Option<git::WorktreeStatus>,
    force: bool,
    delete_branch: bool,
    busy: bool,
    error: Option<String>,
    /// git refused a plain remove (e.g. a locked worktree): offer force even when clean.
    refused: bool,
    /// "an agent working and a terminal running" there: removing cuts them short.
    running: Option<String>,
}

pub fn remove_worktree(fr: Entity<ForestRanger>, project_id: String, wt_id: String, window: &mut Window, cx: &mut App) {
    // Deferred: callers are often ForestRanger's own click handlers, and this reads
    // ForestRanger — reading it mid-update panics.
    window.defer(cx, move |window, cx| remove_worktree_now(fr, project_id, wt_id, window, cx));
}

fn remove_worktree_now(fr: Entity<ForestRanger>, project_id: String, wt_id: String, window: &mut Window, cx: &mut App) {
    let running = fr.read(cx).busy_summary(Some(&wt_id), cx);
    let Some((repo, path, primary_id)) = project_of(fr.read(cx), &project_id).and_then(|p| {
        let w = p.worktrees.iter().find(|w| w.id == wt_id)?;
        Some((p.path.clone(), w.path.clone(), p.worktrees.iter().find(|w| w.is_primary).map(|w| w.id.clone())))
    }) else {
        return;
    };
    let view = cx.new(|cx: &mut Context<RemoveWorktree>| {
        let (r, p) = (repo.clone(), path.clone());
        let work = cx.background_executor().spawn(async move { git::worktree_status(&r, &p) });
        cx.spawn(async move |this, cx| {
            let info = work.await;
            let _ = this.update(cx, |this, cx| {
                this.info = Some(info);
                cx.notify();
            });
        })
        .detach();
        RemoveWorktree { fr: fr.downgrade(), project_id, repo, wt_id, path, primary_id, info: None, force: false, delete_branch: false, busy: false, error: None, refused: false, running }
    });
    show("Remove worktree", view, None, window, cx);
}

impl RemoveWorktree {
    fn dirty(&self) -> bool {
        self.info.as_ref().is_some_and(|i| i.uncommitted > 0)
    }

    /// The force checkbox shows: there are changes to lose, or git said no.
    fn can_force(&self) -> bool {
        self.dirty() || self.refused
    }

    fn remove(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(info) = &self.info else { return };
        if self.busy || (self.dirty() && !self.force) || self.path == self.repo {
            return;
        }
        self.busy = true;
        self.error = None;
        let force = self.can_force() && self.force;
        let branch = info.branch.clone().filter(|_| self.delete_branch);
        let (pid, repo, path) = (self.project_id.clone(), self.repo.clone(), self.path.clone());
        let work = cx.background_executor().spawn(async move {
            git::worktree_remove(&repo, &path, force)?;
            if let Some(b) = branch {
                let _ = git::delete_branch(&repo, &b, true);
            }
            data::sync_worktrees(&pid, &repo)
        });
        cx.spawn_in(window, async move |this, cx| {
            let res = work.await;
            let _ = this.update_in(cx, |this, window, cx| match res {
                Err(e) => {
                    this.busy = false;
                    this.refused |= !force;
                    this.error = Some(e);
                    cx.notify();
                }
                Ok(()) => {
                    window.close_dialog(cx);
                    let (id, primary) = (this.wt_id.clone(), this.primary_id.clone());
                    let Some(fr) = this.fr.upgrade() else { return };
                    fr.update(cx, |fr, cx| {
                        // reload drops the worktree's tabs, panel and history.
                        let was_open = fr.selected.as_deref() == Some(&id);
                        fr.reload(cx);
                        if let Some(p) = primary.filter(|_| was_open) {
                            fr.select(p, cx);
                        }
                    });
                }
            });
        })
        .detach();
        cx.notify();
    }
}

impl Render for RemoveWorktree {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().colors;
        let x = theme::extra(cx);
        let mono = cx.theme().mono_font_family.clone();
        let line = |ok: bool, text: String| {
            div().text_size(px(12.5)).text_color(if ok { x.green } else { theme.danger }).child(format!("{} {text}", if ok { "✓" } else { "•" }))
        };
        let plural = |n: u32, one: &str| format!("{n} {one}{}", if n == 1 { "" } else { "s" });
        let primary = self.path == self.repo;
        let dirty = self.dirty();
        let blocked = self.info.is_none() || primary || (dirty && !self.force);
        let branch = self.info.as_ref().and_then(|i| i.branch.clone());
        div()
            .flex()
            .flex_col()
            .gap_3()
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .child(div().font_family(mono.clone()).text_size(px(13.)).child(branch.clone().unwrap_or_else(|| "detached".into())))
                    .child(div().text_size(px(12.)).text_color(x.faint).child(data::tilde_path(&self.path))),
            )
            .when(primary, |d| d.child(div().text_size(px(12.5)).text_color(theme.danger).child("This is the primary worktree and can't be removed.")))
            .when_some(self.running.clone().filter(|_| !primary), |d, r| {
                d.child(div().text_size(px(12.5)).text_color(x.amber).child(format!("⚠ This worktree has {r}. Removing it stops them.")))
            })
            .when(self.info.is_none() && !primary, |d| d.child(div().text_size(px(12.5)).text_color(x.faint).child("Checking…")))
            .when_some(self.info.as_ref().filter(|_| !primary), |d, i| {
                d.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap_1()
                        .child(if i.uncommitted > 0 { line(false, plural(i.uncommitted, "uncommitted change")) } else { line(true, "No uncommitted changes".into()) })
                        .child(match (i.has_upstream, i.unpushed) {
                            (true, 0) => line(true, "Pushed to origin".into()),
                            (true, n) => line(false, format!("{} not pushed to origin", plural(n, "commit"))),
                            (false, _) => line(false, "Not pushed to any remote".into()),
                        }),
                )
                .when(self.can_force(), |d| {
                    let label = if dirty { "Force remove — discards uncommitted changes" } else { "Force remove — overrides git's refusal (e.g. a locked worktree)" };
                    d.child(Checkbox::new("force").label(label).checked(self.force).on_click(cx.listener(|this, v: &bool, _, cx| {
                        this.force = *v;
                        cx.notify();
                    })))
                })
                .when_some(branch.clone(), |d, b| {
                    d.child(Checkbox::new("delete-branch").label(format!("Also delete branch {b}")).checked(self.delete_branch).on_click(cx.listener(|this, v: &bool, _, cx| {
                        this.delete_branch = *v;
                        cx.notify();
                    })))
                })
                .when(self.delete_branch && branch.is_some() && (i.unpushed > 0 || !i.has_upstream), |d| {
                    d.child(div().text_size(px(12.5)).text_color(theme.warning).child(if i.has_upstream {
                        format!("Discards {} not on origin.", plural(i.unpushed, "commit"))
                    } else {
                        "This branch isn't on any remote — deleting it discards its commits.".into()
                    }))
                })
            })
            .child(error_line(self.error.clone(), cx))
            .child(actions(
                Button::new("remove")
                    .danger()
                    .label(if self.busy { "Removing…" } else { "Remove worktree" })
                    .disabled(blocked || self.busy)
                    .on_click(cx.listener(|this, _, window, cx| this.remove(window, cx))),
            ))
    }
}

// --- Clean up worktrees -------------------------------------------------------

/// A worktree the cleanup can remove without losing anything.
struct Removable {
    path: String,
    label: String,
    branch: Option<String>,
    /// Why it's safe ("!123 merged", "pushed to origin", …) and when last used.
    note: String,
    /// Finished: its MR/PR merged (HEAD in what was merged) or it's in the base.
    /// Ticked by default; the rest are merely pushed — likely still in progress.
    done: bool,
    /// Merged via the code host (maybe squashed): its branch can go with `-D`.
    squashed: bool,
    checked: bool,
}

struct CleanupWorktrees {
    fr: WeakEntity<ForestRanger>,
    project_id: String,
    repo: String,
    /// None while checking.
    rows: Option<Vec<Removable>>,
    /// Worktrees looked at but kept (changes, unshared commits, locked, a running chat).
    kept: usize,
    delete_branches: bool,
    busy: bool,
    error: Option<String>,
}

/// Remove the project's worktrees that have nothing to lose (see `git::safe_to_remove`):
/// listed with checkboxes, all ticked.
pub fn cleanup_worktrees(fr: Entity<ForestRanger>, project_id: String, window: &mut Window, cx: &mut App) {
    // Deferred: reads ForestRanger, and the caller may be its own click handler.
    window.defer(cx, move |window, cx| cleanup_worktrees_now(fr, project_id, window, cx));
}

fn cleanup_worktrees_now(fr: Entity<ForestRanger>, project_id: String, window: &mut Window, cx: &mut App) {
    let f = fr.read(cx);
    let Some(p) = project_of(f, &project_id) else { return };
    let repo = p.path.clone();
    // A chat working or waiting for you there: leave it alone.
    let busy = |id: &str| matches!(f.worktree_attention(id, cx), Attention::Working | Attention::NeedsAnswer);
    let linked: Vec<_> = p.worktrees.iter().filter(|w| !w.is_primary).collect();
    let candidates: Vec<_> =
        linked.iter().filter(|w| !busy(&w.id)).map(|w| (w.path.clone(), w.label().0, w.branch.clone(), w.activity)).collect();
    let total = linked.len();
    let view = cx.new(|cx: &mut Context<CleanupWorktrees>| {
        let r = repo.clone();
        let pid = project_id.clone();
        let work = cx.background_executor().spawn(async move {
            // Learn which origin branches were deleted, and bring the base up to date.
            let base = git::resolve_base(&r, None);
            let _ = git::fetch_base(&r, base.as_deref());
            let branches: Vec<String> = candidates.iter().filter_map(|c| c.2.clone()).collect();
            // No code host (or it fails): fall back to what git alone can tell.
            let merged = crate::reviews::merged(&pid, &r, &branches).unwrap_or_default();
            let sigil = match crate::codehost::matched(&pid, &r) {
                Some((crate::codehost::Provider::GitLab, ..)) => "!",
                _ => "#",
            };
            let locked: Vec<String> = git::list_worktrees(&r).into_iter().filter(|e| e.locked).map(|e| e.path).collect();
            let mut rows: Vec<Removable> = candidates
                .into_iter()
                .filter(|c| !locked.contains(&c.0))
                .filter_map(|(path, label, branch, activity)| {
                    // HEAD is in a merged MR/PR (squash merges included) and nothing's uncommitted.
                    let mr = branch.as_ref().and_then(|b| merged.get(b)).and_then(|ms| {
                        let found = ms.iter().find(|(_, sha)| git::is_ancestor(&path, "HEAD", sha));
                        found.filter(|_| git::is_clean(&path)).map(|(n, _)| *n)
                    });
                    let (why, done, squashed) = match mr {
                        Some(n) => (format!("{sigil}{n} merged"), true, true),
                        None => {
                            let why = git::safe_to_remove(&r, &path)?;
                            // Merged (or its folder's gone); not "pushed" or "no commits yet".
                            let done = why.starts_with("merged") || why.starts_with("folder");
                            (why, done, false)
                        }
                    };
                    let note = if activity > 0 { format!("{why} · {}", data::relative_time(activity)) } else { why };
                    Some(Removable { path, label, branch, note, done, squashed, checked: done })
                })
                .collect();
            rows.sort_by_key(|r| !r.done);
            rows
        });
        cx.spawn(async move |this, cx| {
            let rows = work.await;
            let _ = this.update(cx, |this, cx| {
                this.kept = total.saturating_sub(rows.len());
                this.rows = Some(rows);
                cx.notify();
            });
        })
        .detach();
        CleanupWorktrees { fr: fr.downgrade(), project_id, repo, rows: None, kept: 0, delete_branches: false, busy: false, error: None }
    });
    show("Clean up worktrees", view, None, window, cx);
}

impl CleanupWorktrees {
    fn chosen(&self) -> Vec<&Removable> {
        self.rows.iter().flatten().filter(|r| r.checked).collect()
    }

    fn remove(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let chosen: Vec<(String, Option<String>, bool)> = self.chosen().into_iter().map(|r| (r.path.clone(), r.branch.clone(), r.squashed)).collect();
        if self.busy || chosen.is_empty() {
            return;
        }
        self.busy = true;
        self.error = None;
        let (pid, repo, delete_branches) = (self.project_id.clone(), self.repo.clone(), self.delete_branches);
        let work = cx.background_executor().spawn(async move {
            let base = git::resolve_base(&repo, None);
            let mut removed = 0;
            for (path, branch, squashed) in &chosen {
                // Never forced: if anything changed since the check, git refuses and it stays.
                if git::worktree_remove(&repo, path, false).is_err() {
                    continue;
                }
                removed += 1;
                // Only if merged into the base or fully pushed, and never the base itself.
                if let Some(b) = branch.as_ref().filter(|b| delete_branches && Some(*b) != base.as_ref()) {
                    // Squash-merged: not in the base's history, but the host says it landed.
                    let _ = if *squashed { git::delete_branch(&repo, b, true) } else { git::delete_merged_branch(&repo, b, base.as_deref()) };
                }
            }
            data::sync_worktrees(&pid, &repo).map(|()| (removed, chosen.len() - removed))
        });
        cx.spawn_in(window, async move |this, cx| {
            let res = work.await;
            let _ = this.update_in(cx, |this, window, cx| match res {
                Err(e) => {
                    this.busy = false;
                    this.error = Some(e);
                    cx.notify();
                }
                Ok((removed, failed)) => {
                    window.close_dialog(cx);
                    if let Some(fr) = this.fr.upgrade() {
                        fr.update(cx, |fr, cx| fr.reload(cx));
                    }
                    let failed = if failed > 0 { format!(", {failed} kept (changed since the check)") } else { String::new() };
                    window.push_notification(crate::notify::success(format!("Removed {removed} worktree{}{failed}", if removed == 1 { "" } else { "s" })), cx);
                }
            });
        })
        .detach();
        cx.notify();
    }
}

impl Render for CleanupWorktrees {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let x = theme::extra(cx);
        let mono = cx.theme().mono_font_family.clone();
        let n = self.chosen().len();
        let plural = |n: usize| if n == 1 { "" } else { "s" };
        let body = match &self.rows {
            None => div().text_size(px(12.5)).text_color(x.faint).child("Checking worktrees…").into_any_element(),
            Some(rows) if rows.is_empty() => {
                div().text_size(px(12.5)).text_color(x.faint).child("Nothing to clean up — every worktree has changes or commits that aren't anywhere else.").into_any_element()
            }
            Some(rows) => div()
                .id("cleanup-rows")
                .flex()
                .flex_col()
                .gap(px(8.))
                .max_h(px(320.))
                .overflow_y_scroll()
                .children(rows.iter().enumerate().flat_map(|(i, r)| {
                    // A heading where each group starts (done first, then merely pushed).
                    let heading = (i == 0 || rows[i - 1].done != r.done).then(|| {
                        let text = if r.done { "Merged — done with" } else { "Not merged — probably still in progress" };
                        div().pt(px(if i == 0 { 0. } else { 8. })).text_size(px(11.)).font_weight(FontWeight::SEMIBOLD).text_color(x.faint).child(text.to_uppercase()).into_any_element()
                    });
                    let title = match &r.branch {
                        Some(b) if *b != r.label => format!("{}  ({b})", r.label),
                        _ => r.label.clone(),
                    };
                    // The whole row toggles; the checkbox is just its indicator (no handler
                    // of its own, so a click on it isn't counted twice).
                    let row = div()
                        .id(("cleanup-row", i))
                        .flex()
                        .flex_col()
                        .min_w_0()
                        .cursor_pointer()
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if let Some(r) = this.rows.as_mut().and_then(|rs| rs.get_mut(i)) {
                                r.checked = !r.checked;
                            }
                            cx.notify();
                        }))
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .gap_2()
                                .child(Checkbox::new(("cleanup", i)).checked(r.checked))
                                .child(div().min_w_0().font_family(mono.clone()).text_size(px(13.)).truncate().child(title)),
                        )
                        // Indented under the name: checkbox (16px) + gap (8px).
                        .child(div().pl(px(24.)).text_size(px(12.)).text_color(x.faint).truncate().child(format!("{} · {}", r.note, data::tilde_path(&r.path))));
                    heading.into_iter().chain([row.into_any_element()])
                }))
                .into_any_element(),
        };
        div()
            .flex()
            .flex_col()
            .gap_3()
            .child(div().text_size(px(12.5)).text_color(cx.theme().colors.muted_foreground).child(
                "Worktrees with nothing uncommitted whose work is safe elsewhere: merged (its MR/PR merged, even squashed, or in the base branch) — ticked — or just pushed / not started yet. Removing one deletes its folder (ignored files like .env or node_modules included).",
            ))
            .child(body)
            .when(self.kept > 0, |d| {
                d.child(div().text_size(px(12.)).text_color(x.faint).child(format!(
                    "{} other worktree{} kept: uncommitted or unshared work, locked, or a chat running.",
                    self.kept,
                    plural(self.kept)
                )))
            })
            .when(self.rows.as_ref().is_some_and(|r| !r.is_empty()), |d| {
                d.child(Checkbox::new("cleanup-branches").label("Also delete their local branches (safe delete; the base branch is kept)").checked(self.delete_branches).on_click(cx.listener(|this, v: &bool, _, cx| {
                    this.delete_branches = *v;
                    cx.notify();
                })))
            })
            .child(error_line(self.error.clone(), cx))
            .child(actions(
                Button::new("cleanup-remove")
                    .danger()
                    .label(if self.busy { "Removing…".to_string() } else { format!("Remove {n} worktree{}", plural(n)) })
                    .disabled(n == 0 || self.busy)
                    .on_click(cx.listener(|this, _, window, cx| this.remove(window, cx))),
            ))
    }
}

// --- Rename worktree (label) / rename branch ---------------------------------

/// A one-field dialog; `save` runs (possibly off the UI thread) and either
/// closes it or returns an error to show.
struct OneField {
    input: Entity<InputState>,
    label: &'static str,
    button: &'static str,
    error: Option<String>,
    save: Box<dyn Fn(&str, &mut App) -> Task<Result<(), String>>>,
    /// The save is running (it may shell out): ignore another submit meanwhile.
    busy: bool,
    _sub: Subscription,
}

fn one_field(
    title: &'static str,
    label: &'static str,
    button: &'static str,
    value: String,
    placeholder: &'static str,
    save: impl Fn(&str, &mut App) -> Task<Result<(), String>> + 'static,
    window: &mut Window,
    cx: &mut App,
) {
    let view = cx.new(|cx| {
        let input = cx.new(|cx| InputState::new(window, cx).placeholder(placeholder).default_value(value));
        let sub = cx.subscribe_in(&input, window, |this: &mut OneField, _, ev: &InputEvent, window, cx| {
            if matches!(ev, InputEvent::PressEnter { .. }) {
                this.submit(window, cx);
            }
        });
        OneField { input, label, button, error: None, save: Box::new(save), busy: false, _sub: sub }
    });
    let focus = view.read(cx).input.clone();
    show(title, view, Some(focus), window, cx);
}

impl OneField {
    fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        self.busy = true;
        let value = self.input.read(cx).value().trim().to_string();
        let saved = (self.save)(&value, cx);
        cx.spawn_in(window, async move |this, cx| {
            let res = saved.await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.busy = false;
                match res {
                    Ok(()) => window.close_dialog(cx),
                    Err(e) => this.error = Some(e),
                }
                cx.notify();
            });
        })
        .detach();
    }
}

impl Render for OneField {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .flex()
            .flex_col()
            .gap_3()
            .child(field(self.label, Input::new(&self.input), cx))
            .child(error_line(self.error.clone(), cx))
            .child(actions(Button::new("save").primary().label(self.button).on_click(cx.listener(|this, _, window, cx| this.submit(window, cx)))))
    }
}

/// Set the app-side display name; blank reverts to the branch label.
pub fn rename_worktree(fr: Entity<ForestRanger>, wt_id: String, current: String, window: &mut Window, cx: &mut App) {
    let save = move |v: &str, cx: &mut App| {
        data::set_label(&wt_id, (!v.is_empty()).then_some(v));
        fr.update(cx, |fr, cx| fr.reload(cx));
        Task::ready(Ok(()))
    };
    one_field("Rename worktree", "Display name", "Save", current, "leave blank to use the branch name", save, window, cx);
}

/// `git branch -m` in the project repo; the folder is untouched.
pub fn rename_branch(fr: Entity<ForestRanger>, repo: String, branch: String, window: &mut Window, cx: &mut App) {
    let from = branch.clone();
    let save = move |to: &str, cx: &mut App| {
        if to.is_empty() || to == from {
            return Task::ready(Err("Enter a new branch name.".into()));
        }
        let (repo, from, to, fr) = (repo.clone(), from.clone(), to.to_string(), fr.clone());
        let work = cx.background_executor().spawn(async move { git::rename_branch(&repo, &from, &to) });
        cx.spawn(async move |cx| {
            work.await?;
            let _ = fr.update(cx, |fr, cx| fr.reload(cx));
            Ok(())
        })
    };
    one_field("Rename branch", "Branch name", "Rename", branch, "branch name", save, window, cx);
}

// --- Remove project ---------------------------------------------------------

pub fn remove_project(fr: Entity<ForestRanger>, project_id: String, name: String, window: &mut Window, cx: &mut App) {
    window.open_alert_dialog(cx, move |alert, _, _| {
        let (fr, pid) = (fr.clone(), project_id.clone());
        alert
            .title("Remove project?")
            .description(format!("\"{name}\" will be removed from Forest Ranger. Your git repository and its worktrees on disk are not touched."))
            .ok_text("Remove")
            .ok_variant(ButtonVariant::Danger)
            .show_cancel(true)
            .on_ok(move |_, _, cx| {
                if data::remove_project(&pid).is_ok() {
                    fr.update(cx, |fr, cx| {
                        if fr.project_view.as_ref().is_some_and(|v| v.id == pid) {
                            fr.project_view = None;
                        }
                        fr.expanded.remove(&pid);
                        fr.reload(cx);
                    });
                }
                true
            })
    });
}

// --- Review a branch ----------------------------------------------------------

struct ReviewBranch {
    fr: WeakEntity<ForestRanger>,
    project_id: String,
    repo: String,
    parent: String,
    base: Option<String>,
    branch: Entity<SelectState<SearchableVec<String>>>,
    custom: bool,
    prompt: Entity<TextareaState>,
    /// The prompt last filled in for the picked branch; once the text differs, it's yours.
    auto: String,
    busy: bool,
    error: Option<String>,
    _sub: Subscription,
}

/// Pick a branch to review, then check it out (reusing a worktree already on it)
/// and start a chat seeded with the review prompt — ReviewDialog + startReview.
/// `preselect`: a branch (as `list_branches` names it) to start with, e.g. an MR's.
pub fn review_branch(fr: Entity<ForestRanger>, project_id: String, preselect: Option<String>, window: &mut Window, cx: &mut App) {
    // Deferred: callers are often ForestRanger's own click handlers, and this reads
    // ForestRanger — reading it mid-update panics.
    window.defer(cx, move |window, cx| review_branch_now(fr, project_id, preselect, window, cx));
}

fn review_branch_now(fr: Entity<ForestRanger>, project_id: String, preselect: Option<String>, window: &mut Window, cx: &mut App) {
    let Some((repo, parent)) = project_of(fr.read(cx), &project_id).map(|p| (p.path.clone(), data::worktree_parent(p))) else { return };
    // ponytail: quick git calls on the UI thread, as in new_worktree.
    let base = git::resolve_base(&repo, None);
    let branches: Vec<String> = git::list_branches(&repo).into_iter().filter(|b| Some(b) != base.as_ref()).collect();
    let picked = preselect.and_then(|b| branches.iter().position(|x| *x == b));
    let auto = picked.map(|i| settings::render_review_prompt(cx, &project_id, &branches[i], base.as_deref())).unwrap_or_default();
    let view = cx.new(|cx| {
        let branch = cx.new(|cx| SelectState::new(SearchableVec::new(branches), picked.map(IndexPath::new), window, cx).searchable(true));
        let first = auto.clone();
        let prompt = cx.new(|cx| TextareaState::new(window, cx).rows(9).placeholder("Pick a branch to fill the default prompt, or write your own.").default_value(first));
        let sub = cx.subscribe_in(&branch, window, |this: &mut ReviewBranch, _, ev: &SelectEvent<SearchableVec<String>>, window, cx| {
            let SelectEvent::Confirm(Some(b)) = ev else { return };
            if this.prompt.read(cx).value().as_ref() == this.auto {
                this.auto = settings::render_review_prompt(cx, &this.project_id, b, this.base.as_deref());
                let auto = this.auto.clone();
                this.prompt.update(cx, |s, cx| s.set_value(auto, window, cx));
            }
            cx.notify();
        });
        ReviewBranch { fr: fr.downgrade(), project_id, repo, parent, base, branch, custom: false, prompt, auto, busy: false, error: None, _sub: sub }
    });
    window.open_dialog(cx, move |d, _, _| {
        d.width(px(520.)).title("Review a branch").child(view.clone())
    });
}

impl ReviewBranch {
    fn start(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(branch) = self.branch.read(cx).selected_value().cloned() else { return };
        if self.busy {
            return;
        }
        let typed = self.prompt.read(cx).value().trim().to_string();
        let prompt = if self.custom && !typed.is_empty() { typed } else { settings::render_review_prompt(cx, &self.project_id, &branch, self.base.as_deref()) };
        self.busy = true;
        self.error = None;
        let (pid, repo, parent, b) = (self.project_id.clone(), self.repo.clone(), self.parent.clone(), branch.clone());
        let work = cx.background_executor().spawn(async move {
            // Review checks out the real branch (its local name when remote), so edits land on it.
            let local = b.strip_prefix("origin/").unwrap_or(&b).to_string();
            let path = match git::list_worktrees(&repo).into_iter().find(|w| w.branch.as_deref() == Some(&local)) {
                Some(w) => w.path,
                None => {
                    data::set_worktree_dir(&pid, &parent);
                    std::fs::create_dir_all(&parent).map_err(|e| e.to_string())?;
                    let path = data::worktree_folder(&parent, &local).to_string_lossy().into_owned();
                    git::worktree_add(&repo, &path, &local, Some(&b))?;
                    path
                }
            };
            data::sync_worktrees(&pid, &repo)?;
            Ok::<_, String>(data::worktree_id(&pid, &path))
        });
        cx.spawn_in(window, async move |this, cx| {
            let res = work.await;
            let _ = this.update_in(cx, |this, window, cx| match res {
                Err(e) => {
                    this.busy = false;
                    this.error = Some(e);
                    cx.notify();
                }
                Ok(id) => {
                    window.close_dialog(cx);
                    let Some(fr) = this.fr.upgrade() else { return };
                    fr.update(cx, |fr, cx| {
                        fr.reload(cx);
                        fr.select(id, cx);
                        let provider = cx.global::<Settings>().provider.clone();
                        fr.new_chat(&provider, window, cx);
                        if let Some(crate::Tab::Chat(chat)) = fr.tabs_mut().and_then(|t| t.open.last()) {
                            chat.clone().update(cx, |c, cx| {
                                c.set_custom_title(Some(format!("Review {branch}")), cx);
                                c.send_text(prompt, cx);
                            });
                        }
                    });
                }
            });
        })
        .detach();
        cx.notify();
    }
}

impl Render for ReviewBranch {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let x = theme::extra(cx);
        let picked = self.branch.read(cx).selected_value().is_some();
        let hint = format!(
            "Checks the branch out in a worktree (reusing one already on it) and starts a chat to review it{}.",
            self.base.as_ref().map(|b| format!(" against {b}")).unwrap_or_default()
        );
        div()
            .flex()
            .flex_col()
            .gap_3()
            .child(field("Branch to review", Select::new(&self.branch).placeholder("pick a branch").search_placeholder("Filter branches…"), cx))
            .child(Checkbox::new("custom-prompt").label("Customize the review prompt").checked(self.custom).on_click(cx.listener(|this, v: &bool, _, cx| {
                this.custom = *v;
                cx.notify();
            })))
            .when(self.custom, |d| d.child(Textarea::new(&self.prompt).font_family(cx.theme().mono_font_family.clone())))
            .child(div().text_size(px(12.)).text_color(x.faint).child(hint))
            .child(error_line(self.error.clone(), cx))
            .child(actions(
                Button::new("start-review")
                    .primary()
                    .label(if self.busy { "Starting…" } else { "Start review" })
                    .disabled(self.busy || !picked)
                    .on_click(cx.listener(|this, _, window, cx| this.start(window, cx))),
            ))
    }
}
