//! The title bar: back/forward, where you are, ✦ Chat, editor and panel buttons.

use super::*;

impl ForestRanger {
    /// A bordered icon button, like the Electron titlebar's `.iconBtn`.
    pub(crate) fn icon_btn(&self, id: &'static str, icon: &'static str, active: bool, cx: &mut Context<Self>) -> Stateful<Div> {
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
    pub(crate) fn titlebar(&self, cx: &mut Context<Self>) -> AnyElement {
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
        // By session id: `chats` is re-sorted while the menu is open.
        let reopenable: Vec<(String, String, String)> = self
            .chats
            .iter()
            .filter(|c| !open_ids.contains(&c.session_id))
            .map(|c| (c.session_id.clone(), c.name.clone(), data::relative_time(c.updated_at)))
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
                                    reopenable.iter().fold(menu.separator().label("Reopen"), |menu, (sid, name, when)| {
                                        let (t, sid, name, when) = (this.clone(), sid.clone(), SharedString::from(name.clone()), SharedString::from(when.clone()));
                                        let item = PopupMenuItem::element(move |_, cx| {
                                            div()
                                                .flex()
                                                .items_center()
                                                .gap_4()
                                                .w_full()
                                                .child(div().flex_1().max_w(px(320.)).truncate().child(name.clone()))
                                                .child(div().flex_shrink_0().text_xs().text_color(theme::extra(cx).faint).child(when.clone()))
                                        });
                                        menu.item(item.on_click(move |_, window, cx| t.update(cx, |v, cx| v.open_saved(&sid, window, cx))))
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
                            window.push_notification(crate::notify::error(msg), cx);
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

}
