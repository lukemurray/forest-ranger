//! The base-branch sync bar (BranchSyncBar.tsx): how the project's base compares
//! with origin, Fetch / Update, and its latest commits.

use gpui_kit::component::notification::Notification;
use gpui_kit::component::*;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::page_button;
use crate::sidebar::icon;
use crate::{ForestRanger, git, theme};

#[derive(Default)]
pub(crate) struct SyncState {
    pub base: Option<String>,
    /// (ahead, behind) vs origin; None hides the bar (no origin branch).
    pub status: Option<(u32, u32)>,
    pub recent: Vec<git::Commit>,
    pub busy: bool,
    pub expanded: bool,
}

impl SyncState {
    pub fn load(repo: &str) -> Self {
        let base = git::resolve_base(repo, None);
        let status = base.as_deref().and_then(|b| git::base_status(repo, b));
        let recent = base.as_deref().filter(|_| status.is_some()).map(|b| git::base_log(repo, b, 20)).unwrap_or_default();
        Self { base, status, recent, busy: false, expanded: false }
    }
}

impl ForestRanger {
    fn fetch_project(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(page) = self.project_view.as_mut() else { return };
        if page.sync.busy {
            return;
        }
        page.sync.busy = true;
        let id = page.id.clone();
        let base = page.sync.base.clone();
        let Some(repo) = self.projects.iter().find(|p| p.id == id).map(|p| p.path.clone()) else { return };
        let b = base.clone();
        let work = cx.background_executor().spawn(async move { git::fetch_base(&repo, b.as_deref()) });
        cx.spawn_in(window, async move |this, cx| {
            let res = work.await;
            let _ = this.update_in(cx, |this, window, cx| {
                if let Some(page) = this.project_view.as_mut().filter(|v| v.id == id) {
                    page.sync.busy = false;
                }
                match res {
                    Ok(()) => {
                        window.push_notification(Notification::success(format!("Fetched {}", base.unwrap_or_default())), cx);
                        this.load_page(cx);
                        this.load_activity(cx);
                    }
                    Err(e) => window.push_notification(Notification::error(format!("Fetch failed: {e}")), cx),
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    pub(super) fn sync_bar(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let sync = &self.project_view.as_ref()?.sync;
        let (ahead, behind) = sync.status?;
        let base = sync.base.clone()?;
        let theme = cx.theme().colors;
        let x = theme::extra(cx);
        let mono = cx.theme().mono_font_family.clone();
        let state = format!(
            "{}{}",
            if behind > 0 { format!("{behind} behind origin") } else { "up to date with origin".into() },
            if ahead > 0 { format!(" · {ahead} ahead") } else { String::new() }
        );
        let label = if sync.busy { "Fetching…" } else if behind > 0 { "Update" } else { "Fetch" };
        let shown = if sync.expanded { sync.recent.len() } else { 3.min(sync.recent.len()) };
        let more = sync.recent.len().saturating_sub(3);
        // BranchSyncBar.module.css; `[data-behind]` tints the border and background amber.
        let (border, bg) = if behind > 0 { (x.amber.mix_oklab(x.border_strong, 0.45), x.amber.mix_oklab(x.elevated, 0.08)) } else { (theme.border, x.elevated) };
        Some(
            div()
                .flex()
                .flex_col()
                .px(px(12.))
                .py(px(8.))
                .rounded(px(8.))
                .border_1()
                .border_color(border)
                .bg(bg)
                .text_size(px(13.))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap(px(9.))
                        .child(icon("fr/git-branch.svg", 14., x.faint))
                        .child(div().flex_shrink_0().font_family(mono.clone()).font_weight(FontWeight::SEMIBOLD).child(base))
                        .child(div().flex_1().min_w_0().text_color(if behind > 0 { x.amber } else { theme.muted_foreground }).child(state))
                        .child(
                            page_button("fetch-base", "fr/download.svg", label, behind > 0, cx)
                                .disabled(sync.busy)
                                .on_click(cx.listener(|this, _, window, cx| this.fetch_project(window, cx))),
                        ),
                )
                .when(!sync.recent.is_empty(), |d| {
                    d.child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(5.))
                            .mt(px(9.))
                            .pt(px(9.))
                            .border_t_1()
                            .border_color(theme.border)
                            .text_size(px(12.))
                            .children(sync.recent[..shown].iter().map(|c| {
                                div()
                                    .flex()
                                    .items_baseline()
                                    .gap(px(9.))
                                    .child(div().flex_shrink_0().font_family(mono.clone()).text_color(x.faint).child(c.hash.clone()))
                                    .child(div().flex_1().min_w_0().truncate().text_color(theme.muted_foreground).child(c.subject.clone()))
                                    .child(div().flex_shrink_0().max_w(px(140.)).truncate().text_color(x.faint).child(c.author.clone()))
                                    .child(div().flex_shrink_0().text_color(x.faint).child(c.relative.clone()))
                            }))
                            .when(more > 0, |d| {
                                d.child(
                                    div()
                                        .id("sync-more")
                                        .self_start()
                                        .mt(px(3.))
                                        .py(px(2.))
                                        .text_color(theme.primary)
                                        .cursor_pointer()
                                        .hover(|s| s.underline())
                                        .child(if sync.expanded { "Show less".to_string() } else { format!("Show {more} more") })
                                        .on_click(cx.listener(|this, _, _, cx| {
                                            if let Some(v) = this.project_view.as_mut() {
                                                v.sync.expanded = !v.sync.expanded;
                                                cx.notify();
                                            }
                                        })),
                                )
                            }),
                    )
                })
                .into_any_element(),
        )
    }
}
