//! The project's Merge requests / Pull requests tab: open MRs sorted by what they
//! need from you (see reviews.rs), refreshed while the tab shows.

use std::time::Duration;

use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::component::*;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::PageTab;
use crate::codehost::{CheckState, Provider};
use crate::reviews::{Merge, Mr, Section};
use crate::sidebar::{dialogs, icon};
use std::collections::HashMap;

use crate::{ForestRanger, data, git, theme};

/// How often an open tab re-asks the code host.
const POLL: Duration = Duration::from_secs(180);

#[derive(Default)]
pub(crate) struct RequestsState {
    /// None until the first load comes back.
    pub result: Option<Result<(Provider, Vec<Mr>), String>>,
    pub loading: bool,
    /// Everyone else's MRs are folded by default.
    pub others_open: bool,
    /// The MR whose branch is being fetched for review.
    pub fetching: Option<u64>,
    _poll: Option<Task<()>>,
}

impl RequestsState {
    /// "Merge requests" (GitLab) or "Pull requests" (GitHub), once known.
    pub fn label(&self) -> &'static str {
        match &self.result {
            Some(Ok((Provider::GitHub, _))) => "Pull requests",
            _ => "Merge requests",
        }
    }

}

/// How many MRs need you (the tab's and the sidebar's badge).
fn needs_you(res: &Result<(Provider, Vec<Mr>), String>) -> usize {
    res.as_ref().map(|(_, mrs)| mrs.iter().filter(|m| m.section() == Section::NeedsYou).count()).unwrap_or(0)
}

/// An ISO 8601 time as "3h ago".
fn ago(iso: &str) -> String {
    chrono::DateTime::parse_from_rfc3339(iso).map(|t| data::relative_time(t.timestamp_millis())).unwrap_or_default()
}

impl ForestRanger {
    /// Keep every project's "needs you" count fresh for the sidebar, every few
    /// minutes for as long as the window lives.
    pub(crate) fn poll_needs_you(&self, cx: &mut Context<Self>) {
        cx.spawn(async move |this, cx| {
            loop {
                let Ok(projects) = this.update(cx, |this, _| this.projects.iter().map(|p| (p.id.clone(), p.path.clone())).collect::<Vec<_>>()) else { break };
                let work = cx.background_executor().spawn(async move {
                    projects.into_iter().map(|(id, repo)| {
                        let n = needs_you(&crate::reviews::list(&id, &repo));
                        (id, n)
                    }).collect::<HashMap<_, _>>()
                });
                let counts = work.await;
                let alive = this.update(cx, |this, cx| {
                    this.needs_you = counts;
                    cx.notify();
                });
                if alive.is_err() {
                    break;
                }
                cx.background_executor().timer(POLL).await;
            }
        })
        .detach();
    }

    fn requests_state(&mut self) -> Option<&mut RequestsState> {
        self.project_view.as_mut().map(|v| &mut v.requests)
    }

    /// Re-read the project's MRs off the UI thread; and keep doing so every few
    /// minutes while this page shows the tab (the timer goes with the page).
    pub(crate) fn load_requests(&mut self, cx: &mut Context<Self>) {
        let Some(p) = self.page_project() else { return };
        let (id, repo) = (p.id.clone(), p.path.clone());
        let Some(s) = self.requests_state() else { return };
        if s.loading {
            return;
        }
        s.loading = true;
        if s._poll.is_none() {
            s._poll = Some(cx.spawn(async move |this, cx| {
                loop {
                    cx.background_executor().timer(POLL).await;
                    let alive = this.update(cx, |this, cx| {
                        if this.project_view.as_ref().is_some_and(|v| v.tab == PageTab::Requests) {
                            this.load_requests(cx);
                        }
                    });
                    if alive.is_err() {
                        break;
                    }
                }
            }));
        }
        let pid = id.clone();
        let work = cx.background_executor().spawn(async move { crate::reviews::list(&pid, &repo) });
        cx.spawn(async move |this, cx| {
            let res = work.await;
            let _ = this.update(cx, |this, cx| {
                this.needs_you.insert(id.clone(), needs_you(&res));
                if let Some(page) = this.project_view.as_mut().filter(|v| v.id == id) {
                    page.requests.loading = false;
                    page.requests.result = Some(res);
                    cx.notify();
                }
            });
        })
        .detach();
        cx.notify();
    }

    /// Review: fetch the MR's branch (it may be new to this clone), then open
    /// "Review a branch" with it picked.
    fn review_request(&mut self, mr: &Mr, window: &mut Window, cx: &mut Context<Self>) {
        let Some(p) = self.page_project() else { return };
        let (pid, repo, branch, number) = (p.id.clone(), p.path.clone(), mr.branch.clone(), mr.number);
        if let Some(s) = self.requests_state() {
            s.fetching = Some(number);
        }
        let work = cx.background_executor().spawn(async move {
            let fetched = git::fetch_branch(&repo, &branch);
            // As list_branches names it: the local branch, else origin's.
            let local = git::list_branches(&repo).contains(&branch);
            (fetched, if local { branch } else { format!("origin/{branch}") })
        });
        cx.spawn_in(window, async move |this, cx| {
            let (fetched, name) = work.await;
            let _ = this.update_in(cx, |this, window, cx| {
                if let Some(s) = this.requests_state() {
                    s.fetching = None;
                }
                if let Err(e) = fetched {
                    window.push_notification(crate::notify::error(format!("Couldn't fetch {name}: {e}")), cx);
                }
                dialogs::review_branch(cx.entity(), pid, Some(name), window, cx);
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    pub(super) fn requests_tab(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().colors;
        let x = theme::extra(cx);
        let Some(p) = self.page_project() else { return div().into_any_element() };
        // Branch → worktree id, for "Open worktree".
        let worktrees: Vec<(String, String)> = p.worktrees.iter().filter_map(|w| Some((w.branch.clone()?, w.id.clone()))).collect();
        let Some(s) = self.project_view.as_ref().map(|v| &v.requests) else { return div().into_any_element() };
        let label = s.label();
        let refresh = div()
            .id("requests-refresh")
            .flex()
            .items_center()
            .gap(px(5.))
            .px(px(10.))
            .py(px(4.))
            .rounded(px(6.))
            .border_1()
            .border_color(x.border_strong)
            .text_size(px(12.))
            .text_color(theme.muted_foreground)
            .child(icon("fr/refresh.svg", 12., x.faint))
            .child(if s.loading { "Checking…" } else { "Refresh" })
            .when(!s.loading, |d| d.cursor_pointer().hover(|s| s.bg(x.hover)).on_click(cx.listener(|this, _, _, cx| this.load_requests(cx))));
        let head = div()
            .flex()
            .items_center()
            .justify_between()
            .mb(px(14.))
            .child(div().text_size(px(12.)).font_weight(FontWeight::SEMIBOLD).text_color(theme.muted_foreground).child(label.to_uppercase()))
            .child(refresh);
        let note = |t: String| div().py(px(8.)).text_size(px(13.)).text_color(x.faint).child(t);
        let body = match &s.result {
            None => note("Checking the code host…".into()).into_any_element(),
            Some(Err(e)) => note(e.clone()).into_any_element(),
            Some(Ok((_, mrs))) if mrs.is_empty() => note(format!("No open {}.", label.to_lowercase())).into_any_element(),
            Some(Ok((_, mrs))) => {
                let mrs = mrs.clone();
                let (fetching, others_open) = (s.fetching, s.others_open);
                div()
                    .flex()
                    .flex_col()
                    .gap(px(18.))
                    .children(Section::ALL.into_iter().filter_map(|sec| {
                        let rows: Vec<&Mr> = mrs.iter().filter(|m| m.section() == sec).collect();
                        if rows.is_empty() {
                            return None;
                        }
                        let folded = sec == Section::Others && !others_open;
                        let n = rows.len();
                        let title = div()
                            .id(("requests-section", sec as usize))
                            .flex()
                            .items_center()
                            .gap(px(5.))
                            .mb(px(6.))
                            .text_size(px(11.))
                            .font_weight(FontWeight::SEMIBOLD)
                            .text_color(if sec == Section::NeedsYou { x.amber } else { x.faint })
                            .when(sec == Section::Others, |d| {
                                d.cursor_pointer()
                                    .child(icon(if folded { "fr/chevron.svg" } else { "fr/chevron-down.svg" }, 11., x.faint))
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        if let Some(s) = this.requests_state() {
                                            s.others_open = !s.others_open;
                                        }
                                        cx.notify();
                                    }))
                            })
                            .child(sec.title(&label.to_lowercase()).to_uppercase())
                            .child(div().opacity(0.7).child(n.to_string()));
                        let list = (!folded).then(|| {
                            div().flex().flex_col().rounded(px(8.)).border_1().border_color(theme.border).children(
                                rows.iter().enumerate().map(|(i, m)| {
                                    let wt = worktrees.iter().find(|(b, _)| *b == m.branch).map(|(_, id)| id.clone());
                                    self.request_row(m, wt, fetching == Some(m.number), i + 1 == n, cx)
                                }),
                            )
                        });
                        Some(div().flex().flex_col().child(title).children(list))
                    }))
                    .into_any_element()
            }
        };
        div().flex().flex_col().mt(px(28.)).child(head).child(body).into_any_element()
    }

    fn request_row(&self, m: &Mr, worktree: Option<String>, fetching: bool, last: bool, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().colors;
        let x = theme::extra(cx);
        let mono = cx.theme().mono_font_family.clone();
        let chip = |text: String, color: Hsla| {
            div().px(px(6.)).py(px(1.)).rounded(px(4.)).bg(color.opacity(0.12)).text_size(px(11.)).text_color(color).child(text)
        };
        let mut chips: Vec<Div> = vec![];
        if m.draft {
            chips.push(chip("Draft".into(), x.faint));
        }
        match &m.pipeline {
            Some(CheckState::Success) => chips.push(chip("✓ Pipeline".into(), x.green)),
            Some(CheckState::Failed) => chips.push(chip("✗ Pipeline".into(), theme.danger)),
            Some(CheckState::Running | CheckState::Pending) => chips.push(chip("… Pipeline".into(), x.amber)),
            _ => {}
        }
        if m.approved && !m.draft {
            chips.push(chip("Approved".into(), x.green));
        }
        if m.unresolved > 0 {
            chips.push(chip(format!("{} thread{}", m.unresolved, if m.unresolved == 1 { "" } else { "s" }), x.amber));
        }
        match m.merge {
            Merge::Conflicts => chips.push(chip("Conflicts".into(), theme.danger)),
            Merge::Behind => chips.push(chip("Needs rebase".into(), x.amber)),
            _ => {}
        }
        let why = m.needs_you();
        let url = m.url.clone();
        let button = |id: SharedString, ic: &'static str, text: &'static str| {
            div()
                .id(id)
                .flex()
                .flex_shrink_0()
                .items_center()
                .gap(px(5.))
                .px(px(10.))
                .py(px(4.))
                .rounded(px(6.))
                .border_1()
                .border_color(theme.primary.mix_oklab(x.border_strong, 0.35))
                .text_size(px(12.))
                .text_color(theme.primary)
                .child(icon(ic, 13., theme.primary))
                .child(text)
        };
        let action = match worktree {
            Some(id) => button(format!("mr-open-{}", m.number).into(), "fr/folder.svg", "Open worktree")
                .cursor_pointer()
                .hover(|s| s.bg(theme.primary.opacity(0.12)))
                .tooltip(|window, cx| Tooltip::new("Go to the worktree with this branch").build(window, cx))
                .on_click(cx.listener(move |this, _, _, cx| {
                    cx.stop_propagation();
                    this.select(id.clone(), cx);
                })),
            None => {
                let mr = m.clone();
                button(format!("mr-review-{}", m.number).into(), "fr/sparkle.svg", if fetching { "Fetching…" } else { "Review" })
                    .tooltip(|window, cx| Tooltip::new("Fetch the branch and review it in a new worktree").build(window, cx))
                    .when(fetching, |d| d.opacity(0.5))
                    .when(!fetching, |d| {
                        d.cursor_pointer().hover(|s| s.bg(theme.primary.opacity(0.12))).on_click(cx.listener(move |this, _, window, cx| {
                            cx.stop_propagation();
                            this.review_request(&mr, window, cx);
                        }))
                    })
            }
        };
        div()
            .id(SharedString::from(format!("mr-{}", m.number)))
            .flex()
            .items_center()
            .gap(px(12.))
            .px(px(14.))
            .py(px(10.))
            .when(!last, |d| d.border_b_1().border_color(theme.border))
            .cursor_pointer()
            .hover(|s| s.bg(x.hover))
            .tooltip(|window, cx| Tooltip::new("Open in the browser").build(window, cx))
            .on_click(move |_, _, cx| cx.open_url(&url))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_w_0()
                    .gap(px(3.))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .min_w_0()
                            .child(div().flex_shrink_0().text_size(px(12.)).text_color(x.faint).child(format!("#{}", m.number)))
                            .child(div().min_w_0().truncate().text_size(px(13.5)).child(m.title.clone())),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .min_w_0()
                            .text_size(px(12.))
                            .text_color(x.faint)
                            .child(div().flex_shrink_0().child(m.author.clone()))
                            .child("·")
                            .child(div().min_w_0().truncate().font_family(mono).child(m.branch.clone()))
                            .child("·")
                            .child(div().flex_shrink_0().child(ago(&m.updated_at))),
                    )
                    .when(!why.is_empty(), |d| d.child(div().text_size(px(12.)).text_color(x.amber).child(why.join(" · "))))
                    .when(!chips.is_empty(), |d| d.child(div().flex().flex_wrap().gap(px(4.)).children(chips))),
            )
            .child(action)
            .into_any_element()
    }
}
