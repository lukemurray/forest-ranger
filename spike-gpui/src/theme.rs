//! Forest Ranger's palette (src/mainview/index.css) mapped onto GPUI Kit's theme.

use gpui_kit::component::{Theme, ThemeMode};
use gpui_kit::*;

struct Palette {
    bg: u32,
    elevated: u32,
    sidebar: u32,
    hover: u32,
    active: u32,
    border: u32,
    border_strong: u32,
    text: u32,
    muted: u32,
    faint: u32,
    accent: u32,
    /// accent at ~16% alpha, as RGBA
    accent_soft: u32,
    green: u32,
    amber: u32,
}

const DARK: Palette = Palette {
    bg: 0x16181d,
    elevated: 0x1c1f26,
    sidebar: 0x121419,
    hover: 0x23272f,
    active: 0x2c333d,
    border: 0x2a2e37,
    border_strong: 0x3a3f4b,
    text: 0xe6e8ec,
    muted: 0x9aa1ac,
    faint: 0x6b7280,
    accent: 0x46b96e,
    accent_soft: 0x46b96e2e,
    green: 0x4ec9a5,
    amber: 0xe2b341,
};

const LIGHT: Palette = Palette {
    bg: 0xffffff,
    elevated: 0xffffff,
    sidebar: 0xf7f8fa,
    hover: 0xf0f1f4,
    active: 0xe6e8ec,
    border: 0xe6e8ec,
    border_strong: 0xd2d6dd,
    text: 0x1c1f26,
    muted: 0x5c636e,
    faint: 0x8b929d,
    accent: 0x1f9d5b,
    accent_soft: 0x1f9d5b24,
    green: 0x1f9d76,
    amber: 0xb9852a,
};

/// Colors the kit has no slot for, read by our own views.
#[derive(Clone, Copy)]
pub struct Extra {
    pub faint: Hsla,
    pub green: Hsla,
    pub amber: Hsla,
    pub hover: Hsla,
    pub active: Hsla,
    pub elevated: Hsla,
    pub border_strong: Hsla,
}

impl Global for Extra {}

pub fn extra(cx: &App) -> Extra {
    *cx.global::<Extra>()
}

pub fn apply(dark: bool, cx: &mut App) {
    let p = if dark { &DARK } else { &LIGHT };
    let c = |hex: u32| -> Hsla { rgb(hex).into() };
    Theme::change(if dark { ThemeMode::Dark } else { ThemeMode::Light }, None, cx);
    Theme::update(cx, |t| {
        t.font_size = px(14.);
        t.background = c(p.bg);
        t.foreground = c(p.text);
        t.border = c(p.border);
        t.input = c(p.border_strong);
        t.ring = c(p.accent);
        t.caret = c(p.accent);
        t.selection = rgba(p.accent_soft).into();
        t.muted = c(p.hover);
        t.muted_foreground = c(p.muted);
        t.accent = c(p.hover);
        t.accent_foreground = c(p.text);
        t.secondary = c(p.hover);
        t.secondary_hover = c(p.active);
        t.secondary_active = c(p.active);
        t.secondary_foreground = c(p.text);
        t.primary = c(p.accent);
        t.primary_hover = c(p.accent);
        t.primary_active = c(p.accent);
        t.primary_foreground = c(0xffffff);
        t.button_primary = c(p.accent);
        t.button_primary_hover = c(p.accent);
        t.button_primary_active = c(p.accent);
        t.button_primary_foreground = c(0xffffff);
        t.popover = c(p.elevated);
        t.popover_foreground = c(p.text);
        t.colors.list = c(p.bg);
        t.list_hover = c(p.hover);
        t.list_active = rgba(p.accent_soft).into();
        t.list_active_border = c(p.accent);
        t.sidebar = c(p.sidebar);
        t.sidebar_foreground = c(p.text);
        t.sidebar_border = c(p.border);
        t.sidebar_accent = c(p.active);
        t.sidebar_accent_foreground = c(p.text);
        t.sidebar_primary = c(p.accent);
        t.link = c(p.accent);
        t.success = c(p.accent);
        t.warning = c(p.amber);
        t.tab_bar = c(p.bg);
        t.tab = c(p.bg);
        t.tab_active = c(p.bg);
        t.tab_foreground = c(p.muted);
        t.tab_active_foreground = c(p.text);
        t.title_bar = c(p.bg);
        t.title_bar_border = c(p.border);
        t.window_border = c(p.border);
        t.drag_border = c(p.accent);
    });
    cx.set_global(Extra {
        faint: c(p.faint),
        green: c(p.green),
        amber: c(p.amber),
        hover: c(p.hover),
        active: c(p.active),
        elevated: c(p.elevated),
        border_strong: c(p.border_strong),
    });
}
