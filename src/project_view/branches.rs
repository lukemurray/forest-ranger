//! The project's Branches tab (ProjectBranches.tsx): every local and origin branch,
//! grouped, with worktree chips or "+ Worktree" / delete, and merged-branch cleanup.

use std::collections::HashSet;

use gpui_kit::component::button::ButtonVariant;
use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::notification::Notification;
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::component::*;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::sidebar::icon;
use crate::{ForestRanger, data, git, theme};

/// Collapsed groups show this many rows until "Show all" (ignored while filtering).
const CAP: usize = 12;

const GROUPS: [(&str, fn(&git::BranchInfo) -> bool); 3] = [
    ("Local only", |b| b.local && !b.remote),
    ("Local & origin", |b| b.local && b.remote),
    ("Origin only", |b| !b.local && b.remote),
];

#[derive(Default)]
pub(crate) struct BranchesState {
    pub list: Vec<git::BranchInfo>,
    pub base: Option<String>,
    filter: Option<(Entity<InputState>, Subscription)>,
    show_all: HashSet<usize>,
    /// The branch an action is running on; its buttons are inert meanwhile.
    busy: Option<String>,
}

impl BranchesState {
    /// Runs off the UI thread.
    pub fn load(repo: &str) -> (Vec<git::BranchInfo>, Option<String>) {
        let base = git::resolve_base(repo, None);
        (git::branch_graph(repo, base.as_deref()), base)
    }
}

/// Local branches fully merged into the base with no worktree — safe to prune.
fn merged(list: &[git::BranchInfo], base: Option<&str>) -> Vec<String> {
    list.iter().filter(|b| b.local && b.worktrees.is_empty() && b.ahead == Some(0) && Some(b.name.as_str()) != base).map(|b| b.name.clone()).collect()
}

/// The rows for each group: filtered, newest first.
fn grouped<'a>(list: &'a [git::BranchInfo], q: &str) -> Vec<Vec<&'a git::BranchInfo>> {
    GROUPS
        .iter()
        .map(|(_, m)| {
            let mut v: Vec<_> = list.iter().filter(|b| m(b) && b.name.to_lowercase().contains(q)).collect();
            v.sort_by(|a, b| b.last_commit.cmp(&a.last_commit));
            v
        })
        .collect()
}

fn plural(n: usize) -> &'static str {
    if n == 1 { "" } else { "es" }
}

impl ForestRanger {
    fn branches_state(&mut self) -> Option<&mut BranchesState> {
        self.project_view.as_mut().map(|v| &mut v.branches)
    }

    fn page_repo(&self) -> Option<(String, String)> {
        let id = &self.project_view.as_ref()?.id;
        self.projects.iter().find(|p| &p.id == id).map(|p| (p.id.clone(), p.path.clone()))
    }

    fn set_busy(&mut self, b: Option<String>, cx: &mut Context<Self>) {
        if let Some(s) = self.branches_state() {
            s.busy = b;
        }
        cx.notify();
    }

    /// Check the branch out in a new worktree (an origin-only one becomes a local
    /// branch of the same name), then open it.
    fn branch_worktree(&mut self, b: &git::BranchInfo, window: &mut Window, cx: &mut Context<Self>) {
        let Some(p) = self.project_view.as_ref().and_then(|v| self.projects.iter().find(|p| p.id == v.id)) else { return };
        let (pid, repo, parent) = (p.id.clone(), p.path.clone(), data::worktree_parent(p));
        let (name, local) = (b.name.clone(), b.local);
        self.set_busy(Some(name.clone()), cx);
        let work = cx.background_executor().spawn(async move {
            data::set_worktree_dir(&pid, &parent);
            std::fs::create_dir_all(&parent).map_err(|e| e.to_string())?;
            let path = data::worktree_folder(&parent, &name).to_string_lossy().into_owned();
            let remote = format!("origin/{name}");
            git::worktree_add(&repo, &path, &name, (!local).then_some(remote.as_str()))?;
            data::sync_worktrees(&pid, &repo)?;
            Ok::<_, String>(data::worktree_id(&pid, &path))
        });
        cx.spawn_in(window, async move |this, cx| {
            let res = work.await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.set_busy(None, cx);
                match res {
                    Ok(id) => {
                        this.reload(cx);
                        this.select(id, cx);
                    }
                    Err(e) => window.push_notification(Notification::error(format!("Couldn't create worktree: {e}")), cx),
                }
            });
        })
        .detach();
    }

    /// Safe-delete first; if git refuses an unmerged branch, confirm a force delete.
    fn delete_branch(&mut self, name: String, force: bool, window: &mut Window, cx: &mut Context<Self>) {
        let Some((_, repo)) = self.page_repo() else { return };
        self.set_busy(Some(name.clone()), cx);
        let work = cx.background_executor().spawn({
            let name = name.clone();
            async move { git::delete_branch(&repo, &name, force) }
        });
        cx.spawn_in(window, async move |this, cx| {
            let res = work.await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.set_busy(None, cx);
                match res {
                    Ok(()) => this.load_page(cx),
                    Err(e) if !force && is_unmerged(&e) => this.confirm_force_delete(name, window, cx),
                    Err(e) => window.push_notification(Notification::error(format!("Couldn't delete branch: {e}")), cx),
                }
            });
        })
        .detach();
    }

    fn confirm_force_delete(&mut self, name: String, window: &mut Window, cx: &mut Context<Self>) {
        let base = self.branches_state().and_then(|s| s.base.clone()).unwrap_or_else(|| "the base branch".into());
        let fr = cx.entity();
        window.open_alert_dialog(cx, move |alert, _, _| {
            let (fr, name2) = (fr.clone(), name.clone());
            alert
                .title("Force-delete branch?")
                .description(format!("\"{name}\" has commits not merged into {base}. Deleting it discards that work permanently."))
                .ok_text("Force delete")
                .ok_variant(ButtonVariant::Danger)
                .show_cancel(true)
                .on_ok(move |_, window, cx| {
                    fr.update(cx, |fr, cx| fr.delete_branch(name2.clone(), true, window, cx));
                    true
                })
        });
    }

    fn confirm_cleanup(&mut self, names: Vec<String>, window: &mut Window, cx: &mut Context<Self>) {
        let base = self.branches_state().and_then(|s| s.base.clone()).unwrap_or_else(|| "the base branch".into());
        let Some((_, repo)) = self.page_repo() else { return };
        let fr = cx.entity();
        let n = names.len();
        // The list of what goes, behind a disclosure (there can be hundreds).
        let shown = std::rc::Rc::new(std::cell::Cell::new(false));
        window.open_alert_dialog(cx, move |alert, _, cx| {
            let (fr, names, repo) = (fr.clone(), names.clone(), repo.clone());
            let (muted, mono, open) = (cx.theme().colors.muted_foreground, cx.theme().mono_font_family.clone(), shown.get());
            let toggle = shown.clone();
            let list = div()
                .flex()
                .flex_col()
                .gap(px(6.))
                .child(format!("Deletes local branches fully merged into {base} with no worktree. Unmerged branches are left untouched, so no work is lost."))
                .child(
                    div()
                        .id("cleanup-show")
                        .text_color(muted)
                        .cursor_pointer()
                        .child(format!("{} {n} branch{}", if open { "▾ Hide" } else { "▸ Show" }, plural(n)))
                        .on_click(move |_, window, _| {
                            toggle.set(!toggle.get());
                            window.refresh();
                        }),
                )
                .when(open, |d| {
                    d.child(
                        div()
                            .id("cleanup-list")
                            .max_h(px(220.))
                            .overflow_y_scroll()
                            .font_family(mono)
                            .text_size(px(12.))
                            .children(names.iter().map(|b| div().child(b.clone()))),
                    )
                });
            alert
                .title(format!("Clean up {n} merged branch{}?", plural(n)))
                .description(list)
                .ok_text("Delete merged")
                .ok_variant(ButtonVariant::Danger)
                .show_cancel(true)
                .on_ok(move |_, window, cx| {
                    let (names, repo) = (names.clone(), repo.clone());
                    // Sequential: `git branch -d` is fast and avoids index-lock contention.
                    let work = cx.background_executor().spawn(async move { names.iter().filter(|b| git::delete_branch(&repo, b, false).is_ok()).count() });
                    fr.update(cx, |_, cx| {
                        cx.spawn_in(window, async move |this, cx| {
                            let deleted = work.await;
                            let _ = this.update_in(cx, |this, window, cx| {
                                this.load_page(cx);
                                let skipped = if deleted < n { format!(", {} skipped", n - deleted) } else { String::new() };
                                window.push_notification(Notification::success(format!("Deleted {deleted} merged branch{}{skipped}", plural(deleted))), cx);
                            });
                        })
                        .detach();
                    });
                    true
                })
        });
    }

    fn branch_filter(&mut self, window: &mut Window, cx: &mut Context<Self>) -> Option<Entity<InputState>> {
        let s = self.branches_state()?;
        if let Some((f, _)) = &s.filter {
            return Some(f.clone());
        }
        let state = cx.new(|cx| InputState::new(window, cx).placeholder("Filter branches…"));
        let sub = cx.subscribe(&state, |_, _, ev: &InputEvent, cx| {
            if matches!(ev, InputEvent::Change) {
                cx.notify();
            }
        });
        self.branches_state()?.filter = Some((state.clone(), sub));
        Some(state)
    }

    pub(super) fn branches_tab(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().colors;
        let x = theme::extra(cx);
        let Some(filter) = self.branch_filter(window, cx) else { return div().into_any_element() };
        let Some((pid, _)) = self.page_repo() else { return div().into_any_element() };
        let q = filter.read(cx).value().trim().to_lowercase();
        let Some(s) = self.project_view.as_ref().map(|v| &v.branches) else { return div().into_any_element() };
        let merged = merged(&s.list, s.base.as_deref());
        let groups = grouped(&s.list, &q);
        let total = s.list.len();

        // `.cleanup`: muted bordered button that turns red on hover.
        let cleanup = (!merged.is_empty()).then(|| {
            let n = merged.len();
            div()
                .id("branches-cleanup")
                .flex()
                .flex_shrink_0()
                .items_center()
                .gap(px(5.))
                .ml(px(8.))
                .px(px(11.))
                .py(px(5.))
                .rounded(px(6.))
                .border_1()
                .border_color(x.border_strong)
                .text_size(px(12.))
                .text_color(theme.muted_foreground)
                .cursor_pointer()
                .hover(|s| s.text_color(red()).border_color(red().mix_oklab(x.border_strong, 0.45)).bg(red().opacity(0.1)))
                .child(icon("fr/trash.svg", 13., theme.muted_foreground))
                .child(format!("Clean up {n}"))
                .tooltip(|window, cx| Tooltip::new("Delete local branches fully merged into the base").build(window, cx))
                .on_click(cx.listener(move |this, _, window, cx| this.confirm_cleanup(merged.clone(), window, cx)))
        });
        // ponytail: GPUI has no letter-spacing; the uppercase labels drop their tracking.
        let head = div()
            .flex()
            .items_center()
            .gap(px(8.))
            .mb(px(14.))
            .child(div().text_size(px(12.)).font_weight(FontWeight::SEMIBOLD).text_color(theme.muted_foreground).child("BRANCHES"))
            .child(div().px(px(7.)).py(px(1.)).rounded(px(10.)).bg(x.active).text_size(px(11.5)).text_color(x.faint).child(total.to_string()))
            .child(div().flex_1())
            .child(div().w(px(220.)).child(Input::new(&filter)))
            .children(cleanup);

        let shown: usize = groups.iter().map(Vec::len).sum();
        let body = if shown == 0 {
            div().text_size(px(13.)).text_color(x.faint).child(if total == 0 { "No branches found." } else { "No matches." })
        } else {
            div().flex().flex_col().gap(px(16.)).children(groups.into_iter().enumerate().filter(|(_, v)| !v.is_empty()).map(|(gi, items)| {
                let n = items.len();
                let capped = q.is_empty() && !s.show_all.contains(&gi) && n > CAP;
                let take = if capped { CAP } else { n };
                let rows: Vec<AnyElement> = items.into_iter().take(take).enumerate().map(|(i, b)| self.branch_row(&pid, b, i == 0, i + 1 == take, cx)).collect();
                div()
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .flex()
                            .gap(px(4.))
                            .mb(px(6.))
                            .text_size(px(11.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(x.faint)
                            .child(GROUPS[gi].0.to_uppercase())
                            .child(div().opacity(0.7).child(n.to_string())),
                    )
                    .child(div().flex().flex_col().rounded(px(8.)).border_1().border_color(theme.border).children(rows))
                    .when(capped, |d| {
                        d.child(
                            div()
                                .id(("branches-show-all", gi))
                                .self_start()
                                .mt(px(8.))
                                .py(px(2.))
                                .text_size(px(12.))
                                .text_color(theme.primary)
                                .cursor_pointer()
                                .hover(|s| s.underline())
                                .child(format!("Show all {n}"))
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    if let Some(s) = this.branches_state() {
                                        s.show_all.insert(gi);
                                    }
                                    cx.notify();
                                })),
                        )
                    })
            }))
        };
        div().flex().flex_col().mt(px(28.)).child(head).child(body).into_any_element()
    }

    fn branch_row(&self, pid: &str, b: &git::BranchInfo, first: bool, last: bool, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().colors;
        let x = theme::extra(cx);
        let mono = cx.theme().mono_font_family.clone();
        let busy = self.project_view.as_ref().is_some_and(|v| v.branches.busy.as_ref() == Some(&b.name));
        let (ahead, behind) = (b.ahead.unwrap_or(0), b.behind.unwrap_or(0));
        let actions = if b.worktrees.is_empty() {
            let (create, del) = (b.clone(), b.name.clone());
            // `.create`: accent-outlined "+ Worktree"; `.trash`: 28px bordered square.
            div()
                .flex()
                .flex_shrink_0()
                .items_center()
                .gap(px(6.))
                .child(
                    div()
                        .id(SharedString::from(format!("br-wt-{}", b.name)))
                        .flex()
                        .items_center()
                        .gap(px(5.))
                        .px(px(10.))
                        .py(px(4.))
                        .rounded(px(6.))
                        .border_1()
                        .border_color(theme.primary.mix_oklab(x.border_strong, 0.35))
                        .text_size(px(12.))
                        .text_color(theme.primary)
                        .child(icon("fr/plus.svg", 13., theme.primary))
                        .child("Worktree")
                        .tooltip({
                            let t = format!("Create a worktree for {}", b.name);
                            move |window, cx| Tooltip::new(t.clone()).build(window, cx)
                        })
                        .when(busy, |d| d.opacity(0.5))
                        .when(!busy, |d| {
                            d.cursor_pointer()
                                .hover(|s| s.bg(theme.primary.opacity(0.12)))
                                .on_click(cx.listener(move |this, _, window, cx| this.branch_worktree(&create, window, cx)))
                        }),
                )
                .when(b.local, |d| {
                    d.child(
                        div()
                            .id(SharedString::from(format!("br-del-{}", b.name)))
                            .size(px(28.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(6.))
                            .border_1()
                            .border_color(x.border_strong)
                            .child(icon("fr/trash.svg", 14., x.faint))
                            .tooltip(|window, cx| Tooltip::new("Delete branch").build(window, cx))
                            .when(busy, |d| d.opacity(0.5))
                            .when(!busy, |d| {
                                d.cursor_pointer()
                                    .hover(|s| s.border_color(red().mix_oklab(x.border_strong, 0.45)).bg(red().opacity(0.1)))
                                    .on_click(cx.listener(move |this, _, window, cx| this.delete_branch(del.clone(), false, window, cx)))
                            }),
                    )
                })
        } else {
            // `.wtChip`s: the worktrees this branch is checked out in.
            div().flex().flex_wrap().justify_end().gap(px(5.)).children(b.worktrees.iter().map(|path| {
                let id = data::worktree_id(pid, path);
                let name = path.rsplit('/').find(|s| !s.is_empty()).unwrap_or(path).to_string();
                let tip = path.clone();
                div()
                    .id(SharedString::from(format!("br-go-{}", id)))
                    .flex()
                    .items_center()
                    .gap(px(4.))
                    .px(px(8.))
                    .py(px(3.))
                    .rounded(px(6.))
                    .bg(x.active)
                    .text_size(px(11.5))
                    .text_color(theme.muted_foreground)
                    .cursor_pointer()
                    .hover(|s| s.bg(x.elevated).text_color(theme.foreground))
                    .child(icon("fr/folder.svg", 12., x.faint))
                    .child(name)
                    .tooltip(move |window, cx| Tooltip::new(tip.clone()).build(window, cx))
                    .on_click(cx.listener(move |this, _, _, cx| this.select(id.clone(), cx)))
            }))
        };
        let base = self.project_view.as_ref().and_then(|v| v.branches.base.clone()).unwrap_or_else(|| "base".into());
        div()
            .id(SharedString::from(format!("br-{}", b.name)))
            .flex()
            .items_center()
            .gap(px(8.))
            .px(px(12.))
            .py(px(8.))
            .text_size(px(13.))
            .hover(|s| s.bg(x.hover))
            .when(first, |d| d.rounded_t(px(7.)))
            .when(last, |d| d.rounded_b(px(7.)))
            .when(!last, |d| d.border_b_1().border_color(theme.border))
            .child(icon("fr/git-branch.svg", 14., x.faint))
            .child(div().min_w_0().truncate().font_family(mono.clone()).child(b.name.clone()))
            .when(b.remote, |d| {
                d.child(
                    div()
                        .flex_shrink_0()
                        .px(px(6.))
                        .py(px(1.))
                        .rounded(px(4.))
                        .bg(x.active)
                        .text_size(px(10.))
                        .font_weight(FontWeight::SEMIBOLD)
                        .text_color(theme.muted_foreground)
                        .child("ORIGIN"),
                )
            })
            .when(ahead > 0 || behind > 0, |d| {
                d.child(
                    div()
                        .id(SharedString::from(format!("br-ab-{}", b.name)))
                        .flex()
                        .flex_shrink_0()
                        .gap(px(6.))
                        .font_family(mono)
                        .text_size(px(11.5))
                        .when(ahead > 0, |d| d.child(div().text_color(x.green).child(format!("↑{ahead}"))))
                        .when(behind > 0, |d| d.child(div().text_color(x.amber).child(format!("↓{behind}"))))
                        .tooltip(move |window, cx| Tooltip::new(format!("{ahead} ahead / {behind} behind {base}")).build(window, cx)),
                )
            })
            .when(b.last_commit > 0, |d| d.child(div().flex_shrink_0().text_size(px(11.5)).text_color(x.faint).child(data::relative_time(b.last_commit))))
            .child(div().flex_1())
            .child(actions)
            .into_any_element()
    }
}

/// The Electron app's destructive red (#e5746f).
fn red() -> Hsla {
    rgb(0xe5746f).into()
}

fn is_unmerged(e: &str) -> bool {
    let e = e.to_lowercase();
    e.contains("not merged") || e.contains("not fully merged")
}

#[cfg(test)]
mod tests {
    use super::{grouped, is_unmerged, merged};
    use crate::git;

    fn br(name: &str, local: bool, remote: bool, t: i64, ahead: Option<u32>, wt: bool) -> git::BranchInfo {
        git::BranchInfo { name: name.into(), local, remote, last_commit: t, ahead, behind: Some(0), worktrees: if wt { vec!["/w".into()] } else { vec![] } }
    }

    #[test]
    fn groups_and_merged() {
        let list = [
            br("main", true, true, 5, Some(0), true),
            br("old", true, false, 1, Some(0), false),
            br("new", true, false, 9, Some(2), false),
            br("Feat", false, true, 3, None, false),
            br("done", true, true, 2, Some(0), false),
        ];
        let g = grouped(&list, "");
        let names = |v: &Vec<&git::BranchInfo>| v.iter().map(|b| b.name.clone()).collect::<Vec<_>>();
        assert_eq!(names(&g[0]), ["new", "old"]);
        assert_eq!(names(&g[1]), ["main", "done"]);
        assert_eq!(names(&g[2]), ["Feat"]);
        assert_eq!(grouped(&list, "feat")[2].len(), 1);
        assert_eq!(merged(&list, Some("main")), ["old", "done"]);
        assert!(is_unmerged("error: The branch 'x' is not fully merged."));
    }
}
