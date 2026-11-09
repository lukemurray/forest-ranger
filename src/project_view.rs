//! The project screen (ProjectView.tsx): titlebar, base-branch sync bar,
//! worktree cards, and the Settings tab (run commands, code host, review prompt).

use std::collections::HashMap;

use gpui_kit::component::button::{Button, ButtonCustomVariant, ButtonVariants as _};
use gpui_kit::component::input::{InputEvent, Textarea, TextareaState};
use gpui_kit::component::menu::ContextMenuExt as _;
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::component::*;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::sidebar::{dialogs, icon};
use crate::session_state::SessionState;
use crate::{ForestRanger, data, git, settings, theme};

mod branches;
pub(crate) mod commands;
mod requests;
mod sync_bar;

/// Page.module.css `.page`: max-width 1000px, 32px side padding.
const PAGE_W: f32 = 1000.;
const PAGE_PX: f32 = 32.;

#[derive(Clone, Copy, PartialEq)]
pub(crate) enum PageTab {
    Requests,
    Worktrees,
    Branches,
    Settings,
}

pub(crate) struct ProjectPage {
    pub id: String,
    tab: PageTab,
    /// `git worktree list` by path: HEAD and lock state for the cards.
    entries: HashMap<String, git::WorktreeEntry>,
    sync: sync_bar::SyncState,
    branches: branches::BranchesState,
    requests: requests::RequestsState,
    prompt: Option<(Entity<TextareaState>, Subscription)>,
}

impl ForestRanger {
    /// Show a project's page (recorded in back/forward history).
    pub(crate) fn open_project(&mut self, id: String, cx: &mut Context<Self>) {
        if self.project_view.as_ref().is_some_and(|v| v.id == id) {
            return;
        }
        if let Some(prev) = self.location() {
            self.back.push(prev);
        }
        self.forward.clear();
        self.show_project(id, cx);
    }

    pub(crate) fn show_project(&mut self, id: String, cx: &mut Context<Self>) {
        self.selected = None;
        self.expanded.insert(id.clone());
        self.ensure_commands(&id);
        self.project_view = Some(ProjectPage {
            id,
            tab: PageTab::Requests,
            entries: HashMap::new(),
            sync: Default::default(),
            branches: Default::default(),
            requests: Default::default(),
            prompt: None,
        });
        self.load_page(cx);
        self.load_requests(cx);
        cx.notify();
    }

    pub(crate) fn ensure_commands(&mut self, project_id: &str) {
        if !self.commands.contains_key(project_id) {
            self.reload_commands(project_id);
        }
    }

    pub(crate) fn reload_commands(&mut self, project_id: &str) {
        self.commands.insert(project_id.to_string(), data::list_commands(project_id));
    }

    fn page_project(&self) -> Option<&data::Project> {
        let id = &self.project_view.as_ref()?.id;
        self.projects.iter().find(|p| &p.id == id)
    }

    /// Worktree entries and the sync bar, read off the UI thread.
    pub(crate) fn load_page(&mut self, cx: &mut Context<Self>) {
        let Some(p) = self.page_project() else { return };
        let (id, repo) = (p.id.clone(), p.path.clone());
        let want_branches = self.project_view.as_ref().is_some_and(|v| v.tab == PageTab::Branches);
        let work = cx.background_executor().spawn(async move {
            let branches = want_branches.then(|| branches::BranchesState::load(&repo));
            (git::list_worktrees(&repo), sync_bar::SyncState::load(&repo), branches)
        });
        cx.spawn(async move |this, cx| {
            let (entries, sync, branches) = work.await;
            let _ = this.update(cx, |this, cx| {
                if let Some(page) = this.project_view.as_mut().filter(|v| v.id == id) {
                    page.entries = entries.into_iter().map(|e| (e.path.clone(), e)).collect();
                    page.sync = sync_bar::SyncState { expanded: page.sync.expanded, ..sync };
                    if let Some((list, base)) = branches {
                        (page.branches.list, page.branches.base) = (list, base);
                    }
                    cx.notify();
                }
            });
        })
        .detach();
    }

    /// Refresh: re-sync worktrees from git, then the cards and sync bar.
    fn refresh_project(&mut self, cx: &mut Context<Self>) {
        let Some(p) = self.page_project() else { return };
        let (id, repo) = (p.id.clone(), p.path.clone());
        let work = cx.background_executor().spawn(async move { data::sync_worktrees(&id, &repo) });
        cx.spawn(async move |this, cx| {
            let res = work.await;
            let _ = this.update(cx, |this, cx| {
                this.error = res.err();
                this.reload(cx);
            });
        })
        .detach();
    }

    /// A bordered "icon + label" button, like the Electron titlebar's `.actionButton`.
    fn action_btn(&self, id: &'static str, path: &'static str, label: &'static str, cx: &App) -> Stateful<Div> {
        let theme = cx.theme().colors;
        let x = theme::extra(cx);
        div()
            .id(id)
            .flex()
            .items_center()
            .gap(px(6.))
            .flex_shrink_0()
            .px(px(10.))
            .py(px(5.))
            .rounded(px(6.))
            .border_1()
            .border_color(x.border_strong)
            .text_size(px(12.5))
            .text_color(theme.muted_foreground)
            .cursor_pointer()
            .hover(|s| s.bg(x.hover).text_color(theme.foreground))
            .child(icon(path, 15., theme.muted_foreground))
            .child(label)
    }

    pub(crate) fn project_titlebar(&self, bar: Div, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().colors;
        let x = theme::extra(cx);
        let Some(p) = self.page_project() else {
            return bar.child(div().flex_1().text_size(px(13.5)).child("Project unavailable")).into_any_element();
        };
        let n = p.worktrees.len();
        let path = p.path.clone();
        bar.child(
            div()
                .id("project-title")
                .flex()
                .items_center()
                .gap_2()
                .flex_1()
                .min_w_0()
                .text_size(px(13.5))
                .font_weight(FontWeight::SEMIBOLD)
                .child(icon("fr/folder.svg", 16., theme.muted_foreground))
                .child(div().truncate().child(p.name.clone()))
                .child(div().flex_shrink_0().font_weight(FontWeight::NORMAL).text_color(x.faint).child(format!("· {n} worktree{}", if n == 1 { "" } else { "s" })))
                .tooltip({
                    let path = path.clone();
                    move |window, cx| Tooltip::new(path.clone()).build(window, cx)
                }),
        )
        .child(
            div()
                .flex()
                .items_center()
                .gap(px(6.))
                .child(self.action_btn("project-refresh", "fr/refresh.svg", "Refresh", cx).on_click(cx.listener(|this, _, _, cx| this.refresh_project(cx))))
                .child(self.action_btn("project-reveal", "fr/reveal.svg", "Reveal", cx).on_click(move |_, _, _| settings::reveal(&path))),
        )
        .into_any_element()
    }

    pub(crate) fn project_page(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().colors;
        let Some(page) = self.project_view.as_ref() else { return div().into_any_element() };
        let tab = page.tab;
        let Some(p) = self.page_project() else {
            return div().p_6().text_color(theme.muted_foreground).child("This project is no longer available.").into_any_element();
        };
        let (pid, repo) = (p.id.clone(), p.path.clone());
        let requests_label = self.project_view.as_ref().map(|v| v.requests.label()).unwrap_or("Merge requests");
        let needs_you = self.needs_you.get(&pid).copied().unwrap_or(0);
        let tab_btn = |id: &'static str, label: &'static str, t: PageTab| {
            let on = tab == t;
            let badge = (t == PageTab::Requests && needs_you > 0).then(|| {
                div().px(px(6.)).rounded(px(8.)).bg(theme::extra(cx).amber.opacity(0.18)).text_size(px(11.)).text_color(theme::extra(cx).amber).child(needs_you.to_string())
            });
            div()
                .flex()
                .items_center()
                .gap(px(6.))
                .id(id)
                .px(px(12.))
                .py(px(9.))
                .mb(px(-1.))
                .text_size(px(13.))
                .font_weight(FontWeight::MEDIUM)
                .cursor_pointer()
                .border_b_2()
                .border_color(if on { theme.primary } else { transparent_black() })
                .text_color(if on { theme.foreground } else { theme.muted_foreground })
                .hover(|s| s.text_color(theme.foreground))
                .child(label)
                .children(badge)
                .on_click(cx.listener(move |this, _, _, cx| {
                    if let Some(v) = this.project_view.as_mut() {
                        v.tab = t;
                        if t == PageTab::Branches {
                            this.load_page(cx);
                        }
                        if t == PageTab::Requests {
                            this.load_requests(cx);
                        }
                        cx.notify();
                    }
                }))
        };
        let tabs = div()
            .flex()
            .gap(px(4.))
            .px(px(32.))
            .flex_shrink_0()
            .border_b_1()
            .border_color(theme.border)
            .child(tab_btn("tab-requests", requests_label, PageTab::Requests))
            .child(tab_btn("tab-worktrees", "Worktrees", PageTab::Worktrees))
            .child(tab_btn("tab-branches", "Branches", PageTab::Branches))
            .child(tab_btn("tab-settings", "Settings", PageTab::Settings));
        let body = match tab {
            PageTab::Requests => self.requests_tab(cx),
            PageTab::Worktrees => self.worktrees_tab(window, cx),
            PageTab::Branches => self.branches_tab(window, cx),
            PageTab::Settings => self.settings_tab(&pid, &repo, window, cx),
        };
        div()
            .flex()
            .flex_col()
            .size_full()
            .child(tabs)
            .child(
                div()
                    .id("project-scroll")
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .child(div().flex().flex_col().w_full().max_w(px(PAGE_W)).mx_auto().px(px(PAGE_PX)).pt(px(20.)).pb(px(48.)).text_color(theme.foreground).child(body)),
            )
            .into_any_element()
    }

    /// Page.module.css `.sectionHead`: an uppercase faint `.sectionTitle` + actions.
    fn section_head(title: &'static str, actions: impl IntoElement, cx: &App) -> Div {
        div()
            .flex()
            .items_center()
            .justify_between()
            .mb(px(10.))
            .child(section_title(title, cx))
            .child(actions)
    }

    fn worktrees_tab(&self, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let x = theme::extra(cx);
        let Some(p) = self.page_project() else { return div().into_any_element() };
        let fr = cx.entity();
        let (review_pid, new_pid, clean_pid) = (p.id.clone(), p.id.clone(), p.id.clone());
        let (fr1, fr2, fr3) = (fr.clone(), fr.clone(), fr.clone());
        let has_linked = p.worktrees.iter().any(|w| !w.is_primary);
        let head_actions = div()
            .flex()
            .items_center()
            .gap(px(6.))
            .when(has_linked, |d| {
                d.child(page_button("cleanup-worktrees", "fr/trash.svg", "Clean up", false, cx).on_click(move |_, window, cx| {
                    dialogs::cleanup_worktrees(fr3.clone(), clean_pid.clone(), window, cx)
                }))
            })
            .child(page_button("review-branch", "fr/sparkle.svg", "Review", false, cx).on_click(move |_, window, cx| {
                dialogs::review_branch(fr1.clone(), review_pid.clone(), None, window, cx)
            }))
            .child(page_button("new-worktree", "fr/plus.svg", "New worktree", false, cx).on_click(move |_, window, cx| {
                dialogs::new_worktree(fr2.clone(), new_pid.clone(), window, cx)
            }));
        let cards: Vec<AnyElement> = p.worktrees.iter().map(|w| self.worktree_card(p, w, cx)).collect();
        // `repeat(auto-fill, minmax(280px, 1fr))` with a 12px gap: GPUI's grid has no
        // auto-fill, so count the columns that fit the page column.
        // ponytail: assumes the page spans window minus sidebar (the review panel is hidden here).
        let avail = f32::from(window.viewport_size().width) - SessionState::get(cx).sidebar_width;
        let content = avail.min(PAGE_W) - 2. * PAGE_PX;
        let cols = ((content + 12.) / (280. + 12.)).floor().max(1.) as u16;
        div()
            .flex()
            .flex_col()
            .children(self.sync_bar(cx).map(|b| div().mb(px(18.)).child(b)))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .child(Self::section_head("Worktrees", head_actions, cx))
                    .map(|d| {
                        if cards.is_empty() {
                            d.child(div().py(px(8.)).text_size(px(13.)).text_color(x.faint).child("No worktrees found for this project."))
                        } else {
                            d.child(div().grid().grid_cols(cols).gap(px(12.)).children(cards))
                        }
                    }),
            )
            .into_any_element()
    }

    /// A worktree card (WorktreeCard.tsx): click to open, right-click for the row menu.
    fn worktree_card(&self, p: &data::Project, w: &data::Worktree, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().colors;
        let x = theme::extra(cx);
        let mono = cx.theme().mono_font_family.clone();
        let entry = self.project_view.as_ref().and_then(|v| v.entries.get(&w.path));
        let hash = entry.and_then(|e| e.head.as_deref()).map(|h| h[..7.min(h.len())].to_string()).unwrap_or_else(|| "—".into());
        let locked = entry.is_some_and(|e| e.locked);
        let badge = |label: &'static str, color: Hsla, bg: Hsla| {
            div().px(px(6.)).py(px(2.)).rounded(px(4.)).text_size(px(10.5)).font_weight(FontWeight::SEMIBOLD).text_color(color).bg(bg).child(label)
        };
        // `.actionBtn` / `.cmdBtn`: 12px, 4px 9px, strong border; run commands in accent.
        let small_btn = |id: SharedString, path: &'static str, size: f32, label: SharedString, cmd: bool| {
            let (fg, border) = if cmd { (theme.primary, theme.primary.mix_oklab(x.border_strong, 0.35)) } else { (theme.muted_foreground, x.border_strong) };
            div()
                .id(id)
                .flex()
                .items_center()
                .gap(px(5.))
                .px(px(9.))
                .py(px(4.))
                .rounded(px(6.))
                .border_1()
                .border_color(border)
                .text_size(px(12.))
                .text_color(fg)
                .cursor_pointer()
                .hover(|s| s.bg(x.active).text_color(theme.foreground))
                .child(icon(path, size, fg))
                .child(label)
        };
        let (id, path) = (w.id.clone(), w.path.clone());
        let (editor_path, term_path, reveal_path) = (path.clone(), path.clone(), path.clone());
        let commands = self.commands.get(&p.id).cloned().unwrap_or_default();
        let menu = self.worktree_menu(p, w, cx);
        div()
            .id(SharedString::from(format!("card-{}", w.id)))
            .flex()
            .flex_col()
            .min_w_0()
            .rounded(px(8.))
            .border_1()
            .border_color(theme.border)
            .bg(x.elevated)
            .overflow_hidden()
            .hover(|s| s.border_color(x.border_strong))
            .child(
                div()
                    .id(SharedString::from(format!("card-body-{}", w.id)))
                    .flex()
                    .flex_col()
                    .gap(px(8.))
                    .p(px(14.))
                    .rounded_t(px(7.))
                    .cursor_pointer()
                    .hover(|s| s.bg(x.hover))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .gap(px(8.))
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(7.))
                                    .min_w_0()
                                    .font_family(mono.clone())
                                    .text_size(px(13.))
                                    .font_weight(FontWeight::MEDIUM)
                                    .child(icon("fr/git-branch.svg", 15., x.faint))
                                    .child(div().truncate().child(w.label().0)),
                            )
                            .child(
                                div()
                                    .flex()
                                    .gap(px(5.))
                                    .flex_shrink_0()
                                    .when(w.is_primary, |d| d.child(badge("PRIMARY", x.green, x.green.opacity(0.14))))
                                    .when(w.branch.is_none(), |d| d.child(badge("DETACHED", x.amber, x.amber.opacity(0.14))))
                                    .when(locked, |d| d.child(badge("LOCKED", theme.muted_foreground, x.active))),
                            ),
                    )
                    .child(div().truncate().text_size(px(12.)).text_color(theme.muted_foreground).child(data::tilde_path(&w.path)))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(7.))
                            .text_size(px(12.))
                            .text_color(x.faint)
                            .child(div().font_family(mono).child(hash))
                            .child(div().opacity(0.5).child("·"))
                            .child(data::relative_time(w.activity))
                            .child(div().flex_1())
                            .child(
                                div()
                                    .id(SharedString::from(format!("card-reveal-{}", w.id)))
                                    .size(px(26.))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .rounded(px(6.))
                                    .hover(|s| s.bg(x.active))
                                    .child(icon("fr/reveal.svg", 15., x.faint))
                                    .tooltip(|window, cx| Tooltip::new("Reveal in Finder").build(window, cx))
                                    .on_click(move |_, _, cx| {
                                        cx.stop_propagation();
                                        settings::reveal(&reveal_path)
                                    }),
                            ),
                    )
                    .on_click(cx.listener(move |this, _, _, cx| this.select(id.clone(), cx))),
            )
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap(px(6.))
                    .px(px(12.))
                    .py(px(9.))
                    .border_t_1()
                    .border_color(theme.border)
                    .child(small_btn(format!("card-ed-{}", w.id).into(), "fr/folder.svg", 14., "Editor".into(), false).on_click(move |_, window, cx| {
                        open_or_toast(cx.global::<settings::Settings>().editor.clone(), &editor_path, "editor", window, cx);
                    }))
                    .child(small_btn(format!("card-term-{}", w.id).into(), "fr/terminal.svg", 14., "Terminal".into(), false).on_click(move |_, window, cx| {
                        open_or_toast(cx.global::<settings::Settings>().terminal.clone(), &term_path, "terminal", window, cx);
                    }))
                    .children(commands.into_iter().map(|c| {
                        let path = path.clone();
                        small_btn(format!("card-cmd-{}-{}", w.id, c.id).into(), "fr/play.svg", 12., c.label.clone().into(), true)
                            .tooltip({
                                let cmd = c.command.clone();
                                move |window, cx| Tooltip::new(cmd.clone()).build(window, cx)
                            })
                            .on_click(cx.listener(move |this, _, window, cx| this.run_command(&c, &path, window, cx)))
                    })),
            )
            .context_menu(menu)
            .into_any_element()
    }

    fn settings_tab(&mut self, pid: &str, repo: &str, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().colors;
        let x = theme::extra(cx);
        let mono = cx.theme().mono_font_family.clone();
        let fr = cx.entity();
        let commands = self.commands.get(pid).cloned().unwrap_or_default();
        let add = {
            let (fr, pid) = (fr.clone(), pid.to_string());
            page_button("add-command", "fr/plus.svg", "Add command", false, cx).on_click(move |_, window, cx| {
                commands::command_dialog(fr.clone(), pid.clone(), None, window, cx)
            })
        };
        // `.commandAction`: 28px square, faint; red tint on the delete one.
        let row_btn = |id: SharedString, path: &'static str, danger: bool| {
            div()
                .id(id)
                .size(px(28.))
                .flex()
                .flex_shrink_0()
                .items_center()
                .justify_center()
                .rounded(px(6.))
                .cursor_pointer()
                .hover(move |s| s.bg(if danger { rgba(0xe5746f24).into() } else { x.hover }))
                .child(icon(path, 14., x.faint))
        };
        let list = if commands.is_empty() {
            div().py(px(8.)).text_size(px(13.)).text_color(x.faint).child("No commands yet. Add one (e.g. “Run” → “npm run dev”) to launch it on any worktree.")
        } else {
            div().flex().flex_col().rounded(px(8.)).border_1().border_color(theme.border).children(commands.into_iter().enumerate().map(|(i, c)| {
                let (fr_e, pid_e, edit) = (fr.clone(), pid.to_string(), c.clone());
                let (pid_d, cid) = (pid.to_string(), c.id.clone());
                div()
                    .flex()
                    .items_center()
                    .gap(px(12.))
                    .pl(px(14.))
                    .pr(px(10.))
                    .py(px(8.))
                    .when(i > 0, |d| d.border_t_1().border_color(theme.border))
                    .child(div().min_w(px(96.)).flex_shrink_0().text_size(px(13.)).font_weight(FontWeight::SEMIBOLD).child(c.label.clone()))
                    .child(
                        div()
                            .flex()
                            .flex_1()
                            .min_w_0()
                            .truncate()
                            .font_family(mono.clone())
                            .text_size(px(12.5))
                            .text_color(theme.muted_foreground)
                            .when(!c.dir.is_empty(), |d| d.child(div().text_color(x.faint).child(format!("{}/", c.dir))))
                            .child(c.command.clone()),
                    )
                    .child(row_btn(format!("cmd-edit-{}", c.id).into(), "fr/pencil.svg", false).on_click(move |_, window, cx| {
                        commands::command_dialog(fr_e.clone(), pid_e.clone(), Some(edit.clone()), window, cx)
                    }))
                    .child(row_btn(format!("cmd-del-{}", c.id).into(), "fr/trash.svg", true).on_click(cx.listener(move |this, _, window, cx| {
                        this.delete_command(&pid_d, &cid, window, cx)
                    })))
            }))
        };
        let prompt = self.prompt_editor(pid, window, cx);
        let customized = cx.global::<settings::Settings>().review_prompt_by_project.contains_key(pid);
        let reset = {
            let (pid, prompt) = (pid.to_string(), prompt.clone());
            Button::new("reset-prompt")
                .custom(ButtonCustomVariant::new(cx).color(transparent_black()).foreground(theme.muted_foreground).hover(x.hover).active(x.active))
                .border_1()
                .border_color(x.border_strong)
                .rounded(px(6.))
                .px(px(14.))
                .text_size(px(13.))
                .font_weight(FontWeight::MEDIUM)
                .label("Reset to default").on_click(move |_, window, cx| {
                settings::set_review_prompt(cx, &pid, None);
                prompt.update(cx, |s, cx| s.set_value(settings::DEFAULT_REVIEW_PROMPT, window, cx));
            })
        };
        let code_host = settings::project_code_host_section(pid, repo, window, cx);
        div()
            .flex()
            .flex_col()
            .gap(px(28.))
            .child(div().flex().flex_col().child(Self::section_head("Commands", add, cx)).child(list))
            .child(div().flex().flex_col().child(Self::section_head("Code host", div(), cx)).child(code_host))
            .child(
                div()
                    .flex()
                    .flex_col()
                    .child(Self::section_head("Review prompt", div(), cx))
                    .child(Textarea::new(&prompt).font_family(mono))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .justify_between()
                            .mt_2()
                            .child(div().text_size(px(12.)).text_color(x.faint).child("{branch} and {base} are filled in when a review starts."))
                            .when(customized, |d| d.child(reset)),
                    ),
            )
            .into_any_element()
    }

    /// The Settings tab's review-prompt textarea; every edit saves.
    fn prompt_editor(&mut self, pid: &str, window: &mut Window, cx: &mut Context<Self>) -> Entity<TextareaState> {
        if let Some((p, _)) = self.project_view.as_ref().and_then(|v| v.prompt.as_ref()) {
            return p.clone();
        }
        let initial = settings::review_prompt(cx, pid);
        let state = cx.new(|cx| TextareaState::new(window, cx).rows(14).default_value(initial));
        let id = pid.to_string();
        // ponytail: rewrites gpui-settings.json per keystroke; debounce if it ever shows.
        let sub = cx.subscribe(&state, move |_, state, ev: &InputEvent, cx| {
            if matches!(ev, InputEvent::Change) {
                let v = state.read(cx).value().to_string();
                settings::set_review_prompt(cx, &id, Some(v));
                cx.notify();
            }
        });
        if let Some(v) = self.project_view.as_mut() {
            v.prompt = Some((state.clone(), sub));
        }
        state
    }
}

/// Page.module.css `.sectionTitle`: 13px semibold, uppercase, faint.
// ponytail: GPUI has no letter-spacing, so the 0.5px tracking is dropped.
pub(super) fn section_title(title: &str, cx: &App) -> Div {
    div().text_size(px(13.)).font_weight(FontWeight::SEMIBOLD).text_color(theme::extra(cx).faint).child(title.to_uppercase())
}

/// ui/Button.tsx at its default size: `primary` (accent fill) or `ghost`
/// (strong border, muted text) — 7px 14px, 13px medium, 6px radius, 14px icon.
pub(super) fn page_button(id: impl Into<ElementId>, path: &'static str, label: impl Into<SharedString>, primary: bool, cx: &App) -> Button {
    let theme = cx.theme().colors;
    let x = theme::extra(cx);
    let b = Button::new(id)
        .icon(Icon::empty().path(path).size_3p5())
        .label(label)
        .rounded(px(6.))
        .px(px(14.))
        .gap(px(6.))
        .text_size(px(13.))
        .font_weight(FontWeight::MEDIUM);
    if primary {
        b.primary()
    } else {
        b.custom(ButtonCustomVariant::new(cx).color(transparent_black()).foreground(theme.muted_foreground).hover(x.hover).active(x.active))
            .border_1()
            .border_color(x.border_strong)
    }
}

/// Open `path` in the chosen app, or toast why not.
pub(crate) fn open_or_toast(app: Option<String>, path: &str, kind: &str, window: &mut Window, cx: &mut App) {
    if let Err(e) = settings::try_open_in(app.as_deref(), path, kind) {
        window.push_notification(crate::notify::error(format!("Couldn't open the {kind}: {e}")), cx);
    }
}
