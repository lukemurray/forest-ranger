//! A type-to-search branch box: type (or ↓) for matching branches in a list that
//! floats under it, ↑ / ↓ and Enter or a click to pick, or paste an exact name.
//! The picked branch is the one the box names exactly. Used by the New worktree
//! and Review a branch dialogs.

use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::*;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::theme;

pub enum BranchPickerEvent {
    /// The picked branch changed (None: the box no longer names one).
    Picked(Option<String>),
    /// Enter with a branch picked: the dialog's main action.
    Submit,
}

pub struct BranchPicker {
    branches: Vec<String>,
    input: Entity<InputState>,
    /// The highlighted match (↑ / ↓, Enter picks it).
    cursor: usize,
    /// The list is showing: opened by typing or ↓, closed by picking, Escape or
    /// leaving the box — focus alone doesn't open it.
    listing: bool,
    /// Last picked, to report changes once.
    last: Option<String>,
    _sub: Subscription,
}

impl EventEmitter<BranchPickerEvent> for BranchPicker {}

impl BranchPicker {
    pub fn new(branches: Vec<String>, initial: Option<String>, placeholder: &str, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let initial = initial.filter(|b| branches.contains(b));
        let text = initial.clone().unwrap_or_default();
        let placeholder = placeholder.to_string();
        let input = cx.new(|cx| InputState::new(window, cx).placeholder(placeholder).default_value(text));
        let sub = cx.subscribe_in(&input, window, |this: &mut Self, _, ev: &InputEvent, window, cx| match ev {
            InputEvent::Change => {
                this.cursor = 0;
                this.listing = !this.text(cx).is_empty();
                this.report(cx);
                cx.notify();
            }
            InputEvent::PressEnter { .. } => match this.picked(cx) {
                Some(_) => cx.emit(BranchPickerEvent::Submit),
                None => this.pick_cursor(window, cx),
            },
            InputEvent::Blur => {
                this.listing = false;
                cx.notify();
            }
            _ => {}
        });
        Self { branches, input, cursor: 0, listing: false, last: initial, _sub: sub }
    }

    pub fn focus(&self, window: &mut Window, cx: &mut App) {
        self.input.update(cx, |s, cx| s.focus(window, cx));
    }

    /// What's typed, trimmed.
    pub fn text(&self, cx: &App) -> String {
        self.input.read(cx).value().trim().to_string()
    }

    /// The branch the box names exactly.
    pub fn picked(&self, cx: &App) -> Option<String> {
        let typed = self.text(cx);
        self.branches.iter().find(|b| **b == typed).cloned()
    }

    /// Branches containing the text (any case); all of them while empty or picked.
    fn matches(&self, cx: &App) -> Vec<String> {
        let q = self.text(cx).to_lowercase();
        if q.is_empty() || self.picked(cx).is_some() {
            return self.branches.clone();
        }
        self.branches.iter().filter(|b| b.to_lowercase().contains(&q)).cloned().collect()
    }

    fn pick(&mut self, branch: String, window: &mut Window, cx: &mut Context<Self>) {
        self.input.update(cx, |s, cx| s.set_value(branch, window, cx));
        self.listing = false;
        self.report(cx);
        cx.notify();
    }

    fn pick_cursor(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(b) = self.matches(cx).get(self.cursor).cloned() {
            self.pick(b, window, cx);
        }
    }

    fn report(&mut self, cx: &mut Context<Self>) {
        let now = self.picked(cx);
        if now != self.last {
            self.last = now.clone();
            cx.emit(BranchPickerEvent::Picked(now));
        }
    }
}

impl Render for BranchPicker {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let x = theme::extra(cx);
        let theme = cx.theme().colors;
        let picked = self.picked(cx).is_some();
        let matches = self.matches(cx);
        self.cursor = self.cursor.min(matches.len().saturating_sub(1));
        let open = self.listing && !picked;
        let list = div()
            .id("branch-list")
            .absolute()
            .top_full()
            .left_0()
            .right_0()
            .mt_1()
            .flex()
            .flex_col()
            .max_h(px(240.))
            .overflow_y_scroll()
            .py_1()
            .rounded(px(6.))
            .border_1()
            .border_color(theme.border)
            .bg(theme.popover)
            .shadow_md()
            .when(matches.is_empty(), |d| d.child(div().px_2().py_1p5().text_size(px(12.5)).text_color(x.faint).child("No matching branch")))
            .children(matches.iter().enumerate().map(|(i, b)| {
                let b2 = b.clone();
                div()
                    .id(("branch", i))
                    // Rows keep their height: a capped flex column would squash them.
                    .flex_shrink_0()
                    .px_2()
                    .py(px(4.))
                    .text_size(px(13.))
                    .truncate()
                    .cursor_pointer()
                    .when(i == self.cursor, |d| d.bg(x.hover))
                    .hover(|s| s.bg(x.hover))
                    .child(b.clone())
                    // On press: the box loses focus (closing the list) before a click would land.
                    .on_mouse_down(MouseButton::Left, cx.listener(move |this, _, window, cx| {
                        cx.stop_propagation();
                        this.pick(b2.clone(), window, cx)
                    }))
            }));
        div()
            .relative()
            // ↑ / ↓ / Escape for the list, caught before the text box sees them.
            .capture_key_down(cx.listener(|this, ev: &KeyDownEvent, _, cx| {
                let n = this.matches(cx).len();
                match ev.keystroke.key.as_str() {
                    // ↓ opens the list first, then moves through it.
                    "down" if !this.listing => this.listing = true,
                    "down" if n > 0 => this.cursor = (this.cursor + 1).min(n - 1),
                    "up" if this.listing => this.cursor = this.cursor.saturating_sub(1),
                    "escape" if this.listing => this.listing = false,
                    _ => return,
                }
                cx.stop_propagation();
                cx.notify();
            }))
            .child(Input::new(&self.input).cleanable(true))
            // Above the dialog's own layer (dialogs paint at 10+), like the kit's popups.
            .when(open, |d| d.child(deferred(list).with_priority(100)))
    }
}
