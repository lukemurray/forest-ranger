//! The left sidebar: brand, then a collapsible tree of projects → worktrees,
//! styled after the Electron app's Sidebar.module.css.

use gpui_kit::component::input::Input;
use gpui_kit::component::menu::{ContextMenuExt as _, PopupMenu, PopupMenuItem};
use gpui_kit::component::*;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::ForestRanger;
use crate::data::{self, Project};
use crate::settings::{self, Settings};
use crate::theme;

pub(crate) mod dialogs;

/// A hover tooltip (the Electron app's `data-tip` / `title`).
pub fn tip(text: impl Into<SharedString>) -> impl Fn(&mut Window, &mut App) -> AnyView + 'static {
    let text = text.into();
    move |window, cx| gpui_kit::component::tooltip::Tooltip::new(text.clone()).build(window, cx)
}

pub fn icon(path: &'static str, size: f32, color: Hsla) -> Svg {
    svg().path(path).size(px(size)).flex_shrink_0().text_color(color)
}

/// A "chat here, at rest" marker: a calm hollow dot in the shared 8px status slot.
fn resume_dot(color: Hsla) -> Div {
    div().size(px(8.)).flex_shrink_0().rounded_full().border_1().border_color(color)
}

/// The row's status: the most urgent chat's dot, else a hollow one if a chat is here.
fn row_dot(attention: crate::chat::Attention, here: bool, id: SharedString, cx: &App) -> Option<AnyElement> {
    crate::status_dot(attention, id, cx).or_else(|| here.then(|| resume_dot(cx.theme().colors.muted_foreground).into_any_element()))
}

impl ForestRanger {
    pub(crate) fn sidebar(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().colors;
        let x = theme::extra(cx);
        div()
            .flex()
            .flex_col()
            .w_full()
            .h_full()
            .bg(theme.sidebar)
            .border_r_1()
            .border_color(theme.sidebar_border)
            .px_2()
            // Clear the traffic lights.
            .child(div().h(px(36.)).flex_shrink_0())
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(7.))
                    .px(px(6.))
                    .pb(px(10.))
                    .text_size(px(13.))
                    .font_weight(FontWeight::SEMIBOLD)
                    .text_color(x.green)
                    .child(icon("fr/tree.svg", 16., x.green))
                    .child("Forest Ranger"),
            )
            // PROJECTS, with + (add a project) at its right.
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .pl_2()
                    .pr(px(4.))
                    .pt(px(8.))
                    .child(div().text_size(px(11.)).font_weight(FontWeight::SEMIBOLD).text_color(x.faint).child("PROJECTS"))
                    .child(
                        div()
                            .id("add-project")
                            .p_1()
                            .rounded(px(6.))
                            .cursor_pointer()
                            .hover(|s| s.bg(x.hover))
                            .child(icon("fr/plus.svg", 14., theme.muted_foreground))
                            .tooltip(tip("Add a git project"))
                            .on_click(cx.listener(|this, _, _, cx| this.add_project(cx))),
                    ),
            )
            .when_some(self.error.clone(), |d, e| {
                d.child(div().px_2().text_sm().text_color(theme.danger).child(e))
            })
            .child(
                div()
                    .id("projects")
                    .flex()
                    .flex_col()
                    .flex_1()
                    .min_h_0()
                    .overflow_y_scroll()
                    .pb_4()
                    .children(self.projects.iter().map(|p| self.project_node(p, cx))),
            )
            // Footer: Settings (SettingsMenu.tsx), full-bleed past the side padding.
            .child(
                div()
                    .id("settings")
                    .flex()
                    .items_center()
                    .gap(px(9.))
                    .mx(px(-8.))
                    .px(px(12.))
                    .py(px(10.))
                    .border_t_1()
                    .border_color(theme.border)
                    .cursor_pointer()
                    .text_color(theme.muted_foreground)
                    .hover(|s| s.bg(x.hover))
                    .child(
                        div()
                            .size(px(26.))
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(6.))
                            .bg(x.active)
                            .child(icon("fr/tree.svg", 15., x.green)),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .flex_1()
                            .child(div().text_size(px(13.)).font_weight(FontWeight::MEDIUM).text_color(theme.foreground).child("Settings"))
                            .child(div().text_size(px(11.)).text_color(x.faint).child("Forest Ranger")),
                    )
                    .child(icon("fr/chevron-up-down.svg", 15., theme.muted_foreground))
                    .on_click(|_, window, cx| crate::settings::open(window, cx)),
            )
            .into_any_element()
    }

    fn project_node(&self, p: &Project, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().colors;
        let x = theme::extra(cx);
        let open = self.expanded.contains(&p.id);
        let within = p.worktrees.iter().any(|w| self.selected.as_deref() == Some(&w.id));
        let viewing = self.project_view.as_ref().is_some_and(|v| v.id == p.id);
        let dot = row_dot(
            self.project_attention(p, cx),
            p.worktrees.iter().any(|w| self.chat_here(&w.id, cx)),
            SharedString::from(format!("pdot-{}", p.id)),
            cx,
        );
        let pid = p.id.clone();
        let fr = cx.entity();
        let hover_btn = |id: &str, path: &'static str, size: f32| {
            div()
                .id(SharedString::from(format!("{id}-{}", p.id)))
                .p(px(3.))
                .rounded(px(5.))
                .invisible()
                .group_hover("prow", |s| s.visible())
                .hover(|s| s.bg(x.active))
                .child(icon(path, size, theme.muted_foreground))
        };
        let (new_pid, scan_pid, scan_path, review_pid, toggle_pid) = (p.id.clone(), p.id.clone(), p.path.clone(), p.id.clone(), p.id.clone());
        let (menu_pid, menu_path, menu_name) = (p.id.clone(), p.path.clone(), p.name.clone());
        div()
            .flex()
            .flex_col()
            .child(
                div()
                    .id(SharedString::from(format!("p-{}", p.id)))
                    .tooltip(tip(p.path.clone()))
                    .group("prow")
                    .flex()
                    .items_center()
                    .gap(px(2.))
                    .h(px(28.))
                    .pr(px(8.))
                    .rounded(px(6.))
                    .cursor_pointer()
                    .hover(|s| s.bg(x.hover))
                    .when(viewing, |d| d.bg(x.active))
                    // A worktree under this project is open: a green lineage hint.
                    .when(within, |d| d.border_l_2().border_color(x.green.opacity(0.55)))
                    .child(
                        div()
                            .id(SharedString::from(format!("chev-{}", p.id)))
                            .w(px(22.))
                            .h_full()
                            .flex()
                            .items_center()
                            .justify_center()
                            .child(icon(
                                if open { "fr/chevron-down.svg" } else { "fr/chevron.svg" },
                                14.,
                                if open { theme.muted_foreground } else { x.faint },
                            ))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                cx.stop_propagation();
                                if !this.expanded.remove(&toggle_pid) {
                                    this.expanded.insert(toggle_pid.clone());
                                }
                                cx.notify();
                            })),
                    )
                    .child(
                        div()
                            .flex_1()
                            .text_size(px(13.))
                            .font_weight(FontWeight::MEDIUM)
                            .truncate()
                            .child(p.name.clone()),
                    )
                    .child(hover_btn("review", "fr/sparkle.svg", 13.).tooltip(tip("Review a branch")).on_click(cx.listener(move |_, _, window, cx| {
                        cx.stop_propagation();
                        dialogs::review_branch(cx.entity(), review_pid.clone(), window, cx);
                    })))
                    .child(hover_btn("new-wt", "fr/plus.svg", 14.).tooltip(tip("New worktree")).on_click(cx.listener(move |_, _, window, cx| {
                        cx.stop_propagation();
                        dialogs::new_worktree(cx.entity(), new_pid.clone(), window, cx);
                    })))
                    .child(hover_btn("rescan", "fr/refresh.svg", 13.).tooltip(tip("Rescan worktrees")).mr(px(4.)).on_click(cx.listener(move |this, _, _, cx| {
                        cx.stop_propagation();
                        this.rescan(scan_pid.clone(), scan_path.clone(), cx);
                    })))
                    // Hover actions take the row's right edge; the dot steps aside.
                    .children(dot.map(|d| div().group_hover("prow", |s| s.invisible()).child(d)))
                    .on_click(cx.listener(move |this, _, _, cx| this.open_project(pid.clone(), cx)))
                    .context_menu(move |menu, _, _| {
                        let (path, fr, pid, name) = (menu_path.clone(), fr.clone(), menu_pid.clone(), menu_name.clone());
                        menu.item(PopupMenuItem::new("Reveal in Finder").on_click(move |_, _, _| settings::reveal(&path)))
                            .separator()
                            .item(PopupMenuItem::new("Remove project").on_click(move |_, window, cx| {
                                dialogs::remove_project(fr.clone(), pid.clone(), name.clone(), window, cx)
                            }))
                    }),
            )
            .when(open, |d| {
                d.child(
                    div()
                        .flex()
                        .flex_col()
                        .ml(px(11.))
                        .pl(px(8.))
                        .border_l_1()
                        .border_color(theme.border)
                        .when(p.worktrees.is_empty(), |d| {
                            d.child(div().px_2().py_1().text_sm().text_color(x.faint).child("No worktrees"))
                        })
                        .children(p.worktrees.iter().map(|w| self.worktree_row(p, w, cx))),
                )
            })
            .into_any_element()
    }

    fn worktree_row(&self, p: &Project, w: &data::Worktree, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().colors;
        let x = theme::extra(cx);
        let active = self.selected.as_deref() == Some(&w.id);
        let (label, note) = w.label();
        let id = w.id.clone();
        if let Some((_, input, _)) = self.renaming.as_ref().filter(|e| e.0.strip_prefix("label:") == Some(&w.id)) {
            return div()
                .flex()
                .items_center()
                .px(px(2.))
                .h(px(26.))
                .rounded(px(6.))
                .when(active, |d| d.bg(x.active))
                .capture_key_down(cx.listener(|this, ev: &KeyDownEvent, window, cx| {
                    if ev.keystroke.key == "escape" {
                        this.renaming = None;
                        window.focus(&this.focus, cx);
                        cx.stop_propagation();
                        cx.notify();
                    }
                }))
                .child(Input::new(input).font_family(cx.theme().mono_font_family.clone()))
                .into_any_element();
        }
        let menu = self.worktree_menu(p, w, cx);
        let edit = (w.name.clone().or_else(|| w.branch.clone()).unwrap_or_default(), w.branch.clone());
        div()
            .id(SharedString::from(format!("w-{}", w.id)))
            .flex()
            .items_center()
            .justify_between()
            .gap_2()
            .px(px(8.))
            .h(px(26.))
            .rounded(px(6.))
            .text_size(px(12.5))
            .cursor_pointer()
            .text_color(theme.muted_foreground)
            .hover(|s| s.bg(x.hover).text_color(theme.foreground))
            .when(active, |d| d.bg(x.active).text_color(theme.foreground))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(6.))
                    .min_w_0()
                    .when(w.is_primary, |d| d.child(icon("fr/sprout.svg", 14., theme.primary)))
                    .child(div().min_w_0().truncate().font_family(cx.theme().mono_font_family.clone()).child(label.clone()))
                    // The label wins the space: the bracketed branch gives way first.
                    .when_some(note.clone(), |d, n| {
                        d.child(
                            div()
                                .min_w_0()
                                .truncate()
                                .text_color(x.faint)
                                .map(|mut d| {
                                    d.style().flex_shrink = Some(50.);
                                    d
                                })
                                .child(format!("({n})")),
                        )
                    }),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .flex_shrink_0()
                    .child(div().text_size(px(11.)).text_color(x.faint).child(data::relative_time(w.activity)))
                    .children(row_dot(self.worktree_attention(&w.id, cx), self.chat_here(&w.id, cx), SharedString::from(format!("wdot-{}", w.id)), cx)),
            )
            .tooltip(tip(match &note {
                Some(n) => format!("{label} ({n})\n{}\nDouble-click to set a label", w.path),
                None => format!("{label}\n{}\nDouble-click to set a label", w.path),
            }))
            .on_click(cx.listener(move |this, ev: &ClickEvent, window, cx| {
                this.select(id.clone(), cx);
                if ev.click_count() == 2 {
                    this.edit_label(id.clone(), edit.0.clone(), edit.1.clone(), window, cx);
                }
            }))
            .context_menu(menu)
            .into_any_element()
    }

    /// A worktree's right-click menu (sidebar rows and project-view cards).
    pub(crate) fn worktree_menu(&self, p: &Project, w: &data::Worktree, cx: &mut Context<Self>) -> impl Fn(PopupMenu, &mut Window, &mut Context<PopupMenu>) -> PopupMenu + 'static {
        let fr = cx.entity();
        let (menu_pid, menu_wid, repo, path, name, branch) = (p.id.clone(), w.id.clone(), p.path.clone(), w.path.clone(), w.name.clone(), w.branch.clone());
        let primary = w.is_primary;
        move |menu, _, _| {
            let open = |label: &'static str, app: fn(&Settings) -> Option<String>| {
                let path = path.clone();
                PopupMenuItem::new(label).on_click(move |_, _, cx| settings::open_in(app(cx.global::<Settings>()).as_deref(), &path))
            };
            let reveal = path.clone();
            let (f1, f2, f3) = (fr.clone(), fr.clone(), fr.clone());
            let (wid, wid2, current) = (menu_wid.clone(), menu_wid.clone(), name.clone().or_else(|| branch.clone()).unwrap_or_default());
            let (repo, pid, branch) = (repo.clone(), menu_pid.clone(), branch.clone());
            menu.item(open("Open in editor", |s| s.editor.clone()))
                .item(open("Open in terminal", |s| s.terminal.clone()))
                .item(PopupMenuItem::new("Reveal in Finder").on_click(move |_, _, _| settings::reveal(&reveal)))
                .separator()
                .item(PopupMenuItem::new("Rename…").on_click(move |_, window, cx| dialogs::rename_worktree(f1.clone(), wid.clone(), current.clone(), window, cx)))
                .when_some(branch, |m, b| {
                    m.item(PopupMenuItem::new("Rename branch…").on_click(move |_, window, cx| dialogs::rename_branch(f2.clone(), repo.clone(), b.clone(), window, cx)))
                })
                .when(!primary, |m| {
                    m.separator().item(PopupMenuItem::new("Remove worktree…").on_click(move |_, window, cx| {
                        dialogs::remove_worktree(f3.clone(), pid.clone(), wid2.clone(), window, cx)
                    }))
                })
        }
    }

    /// Re-sync one project's worktrees from git (the ↻ hover action).
    fn rescan(&self, project_id: String, path: String, cx: &mut Context<Self>) {
        let work = cx.background_executor().spawn(async move { data::sync_worktrees(&project_id, &path) });
        cx.spawn(async move |this, cx| {
            let res = work.await;
            let _ = this.update(cx, |this, cx| {
                this.error = res.err();
                this.reload(cx);
            });
        })
        .detach();
    }

    /// Swap a worktree row's label for an input.
    fn edit_label(&mut self, id: String, initial: String, branch: Option<String>, window: &mut Window, cx: &mut Context<Self>) {
        self.start_inline_edit(format!("label:{id}"), initial, Some(branch.unwrap_or_else(|| "label".into())), window, cx);
    }

    /// Save an inline label edit. Blank, or the branch name itself, clears it.
    pub(crate) fn save_label(&mut self, id: &str, value: String, cx: &mut Context<Self>) {
        if let Some(w) = self.projects.iter().flat_map(|p| &p.worktrees).find(|w| w.id == id) {
            let name = (!value.is_empty() && Some(&value) != w.branch.as_ref()).then_some(value);
            if name != w.name {
                data::set_label(id, name.as_deref());
                self.reload(cx);
            }
        }
        cx.notify();
    }
}
