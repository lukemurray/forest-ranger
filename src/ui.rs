//! Shared controls the kit doesn't have in the shape we need.

use std::rc::Rc;

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::menu::{DropdownMenu as _, PopupMenu};
use gpui_kit::component::*;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::{sidebar, theme};

type OnClick = Rc<dyn Fn(&ClickEvent, &mut Window, &mut App)>;
type Menu = Rc<dyn Fn(PopupMenu, &mut Window, &mut Context<PopupMenu>) -> PopupMenu>;

/// A main action joined to a ▾ menu (✦ Chat, ▶ Run, Queue): one control, two halves.
///
/// Outlined: one rounded border around both, a hairline between (the titlebar's
/// look). Filled: two primary halves rounded on their outer edges only — GPUI
/// doesn't clip filled children to a rounded parent — with a dark hairline between.
#[derive(IntoElement)]
pub struct SplitButton {
    id: ElementId,
    label: SharedString,
    icon: Option<(&'static str, Hsla)>,
    tip: Option<SharedString>,
    filled: bool,
    on_click: Option<OnClick>,
    menu_tip: SharedString,
    anchor: Anchor,
    menu: Option<Menu>,
}

impl SplitButton {
    pub fn new(id: impl Into<ElementId>, label: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            icon: None,
            tip: None,
            filled: false,
            on_click: None,
            menu_tip: "More".into(),
            anchor: Anchor::TopRight,
            menu: None,
        }
    }

    /// A leading icon (asset path) and its colour (outlined only).
    pub fn icon(mut self, path: &'static str, color: Hsla) -> Self {
        self.icon = Some((path, color));
        self
    }

    pub fn tooltip(mut self, tip: impl Into<SharedString>) -> Self {
        self.tip = Some(tip.into());
        self
    }

    /// The primary (green) look, as for the composer's Queue.
    pub fn filled(mut self) -> Self {
        self.filled = true;
        self
    }

    pub fn on_click(mut self, f: impl Fn(&ClickEvent, &mut Window, &mut App) + 'static) -> Self {
        self.on_click = Some(Rc::new(f));
        self
    }

    /// The ▾ half: its tooltip, where the menu opens, and its items.
    pub fn menu(
        mut self,
        tip: impl Into<SharedString>,
        anchor: Anchor,
        f: impl Fn(PopupMenu, &mut Window, &mut Context<PopupMenu>) -> PopupMenu + 'static,
    ) -> Self {
        self.menu_tip = tip.into();
        self.anchor = anchor;
        self.menu = Some(Rc::new(f));
        self
    }
}

impl RenderOnce for SplitButton {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = cx.theme().colors;
        let x = theme::extra(cx);
        // The ▾ half: same build for both looks, then its variant and rounding.
        let arrow = Button::new(SharedString::from(format!("{}-menu", self.id)))
            .compact()
            .px(px(6.))
            .icon(Icon::empty().path("fr/chevron-down.svg"))
            .tooltip(self.menu_tip.clone());
        let arrow = if self.filled { arrow.primary().rounded_l_none() } else { arrow.ghost().h_full().rounded_none() };
        let menu = self.menu.clone();
        let arrow = arrow.dropdown_menu_with_anchor(self.anchor, move |m, window, cx| match &menu {
            Some(f) => f(m, window, cx),
            None => m,
        });
        let click = self.on_click.clone();
        if self.filled {
            let main = Button::new(self.id.clone())
                .primary()
                .rounded_r_none()
                .px(px(14.))
                .label(self.label.clone())
                .when_some(self.tip.clone(), |b, t| b.tooltip(t))
                .when_some(click, |b, f| b.on_click(move |e, w, cx| f(e, w, cx)));
            return div()
                .flex()
                .items_stretch()
                .child(main)
                // A dark hairline reads as one button; a light one looks like a gap.
                .child(div().w(px(1.)).bg(gpui_kit::black().opacity(0.18)))
                .child(arrow)
                .into_any_element();
        }
        let face = div()
            .id(self.id.clone())
            .flex()
            .items_center()
            .gap(px(6.))
            .px(px(10.))
            .py(px(5.))
            .cursor_pointer()
            .hover(|s| s.bg(x.hover).text_color(theme.foreground))
            .when_some(self.icon, |d, (path, color)| d.child(sidebar::icon(path, 13., color)))
            .child(self.label.clone())
            .when_some(self.tip.clone(), |d, t| d.tooltip(sidebar::tip(t)))
            .when_some(click, |d, f| d.on_click(move |e, w, cx| f(e, w, cx)));
        div()
            .flex()
            .items_stretch()
            .overflow_hidden()
            .rounded(px(6.))
            .border_1()
            .border_color(x.border_strong)
            .text_size(px(12.5))
            .text_color(theme.muted_foreground)
            .child(face)
            .child(div().w(px(1.)).bg(x.border_strong))
            .child(arrow)
            .into_any_element()
    }
}
