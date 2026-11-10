//! Pinned agent messages: kept in a strip over the transcript while the chat
//! goes on, each one jumpable-to, openable beside the chat as a read-only tab,
//! and unpinnable. Pins are `pin` events in the chat's log, so they come back
//! with it.

use std::time::Duration;

use super::transcript::Node;
use super::*;

/// How long a jumped-to message stays highlighted.
const FLASH: Duration = Duration::from_millis(1500);

impl Rows {
    /// The agent message with this id: its row and text.
    pub(super) fn message(&self, mid: &str) -> Option<(usize, &str)> {
        self.rows.iter().enumerate().rev().find_map(|(ix, r)| match r {
            Row::Assistant { text, message_id: Some(m), .. } if m == mid => Some((ix, text.as_str())),
            _ => None,
        })
    }

    /// A `pin` event: newest pin first; unpinning drops it.
    pub(super) fn apply_pin(&mut self, mid: &str, on: bool) {
        self.pins.retain(|p| p != mid);
        if on {
            self.pins.insert(0, mid.to_string());
        }
    }
}

/// A pin's one-line name: its first line of text, without Markdown marks.
pub(crate) fn pin_title(text: &str) -> String {
    let line = text.lines().map(|l| l.trim().trim_start_matches(['#', '-', '*', '>', ' '])).find(|l| !l.is_empty()).unwrap_or("Pinned message");
    let line = line.replace("**", "").replace('`', "");
    match line.char_indices().nth(60) {
        Some((i, _)) => format!("{}…", &line[..i]),
        None => line,
    }
}

/// A pinned message's text, read from its chat's log (reopening a note tab).
pub(crate) fn pinned_text(session_id: &str, mid: &str) -> Option<String> {
    let mut rows = Rows::default();
    for e in &ChatLog::open(session_id).events {
        rows.apply(e);
    }
    rows.message(mid).map(|(_, t)| t.to_string())
}

impl ChatView {
    pub(super) fn is_pinned(&self, mid: &str) -> bool {
        self.rows.pins.iter().any(|p| p == mid)
    }

    /// Pin or unpin an agent message. The strip stays as it was: the message you
    /// just pinned is already in view, so opening it would only show it twice.
    pub(super) fn toggle_pin(&mut self, mid: String, cx: &mut Context<Self>) {
        let on = !self.is_pinned(&mid);
        self.apply(json!({ "type": "pin", "messageId": mid, "on": on }), cx);
        cx.notify();
    }

    /// Scroll to the pinned message and highlight it for a moment.
    fn jump_to(&mut self, mid: &str, cx: &mut Context<Self>) {
        let Some((row, _)) = self.rows.message(mid) else { return };
        let item = self.items.iter().position(|it| match &it.node {
            Node::Row(r) => *r == row,
            Node::Strip(rs) => rs.contains(&row),
        });
        if let Some(i) = item {
            self.scroller.update(cx, |s, cx| s.scroll_to_item(i, cx));
        }
        self.flash = Some(row);
        self.flash_task = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(FLASH).await;
            let _ = this.update(cx, |this, cx| {
                this.flash = None;
                cx.notify();
            });
        }));
        cx.notify();
    }

    fn open_beside(&mut self, mid: &str, cx: &mut Context<Self>) {
        let Some((_, text)) = self.rows.message(mid) else { return };
        let (title, text) = (pin_title(text), text.to_string());
        cx.emit(ChatEvent::OpenNote { key: format!("note:{}:{mid}", self.session_id()), title, text });
    }

    /// The pins strip over the transcript: one line collapsed; open, each pin in
    /// full (scrolling on its own) with Jump to / Open beside / Unpin.
    pub(super) fn render_pins(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let pins: Vec<(String, String)> =
            self.rows.pins.iter().filter_map(|mid| self.rows.message(mid).map(|(_, t)| (mid.clone(), t.to_string()))).collect();
        if pins.is_empty() {
            return None;
        }
        let theme = cx.theme().colors;
        let x = theme::extra(cx);
        let open = self.pins_open;
        // Collapsed, one pin names itself; open, its text is right below, so just count.
        let summary = match pins.len() {
            1 if !open => pin_title(&pins[0].1),
            n => format!("{n} pinned"),
        };
        let action = |id: (&'static str, usize), label: &'static str| {
            div()
                .id(id)
                .text_size(px(12.))
                .text_color(theme.muted_foreground)
                .cursor_pointer()
                .hover(|s| s.text_color(theme.foreground))
                .child(label)
        };
        Some(
            div()
                .flex()
                .flex_col()
                .flex_shrink_0()
                .max_h(relative(0.4))
                .border_b_1()
                .border_color(theme.border)
                .bg(theme.sidebar)
                .child(
                    div()
                        .id("pins-head")
                        .flex()
                        .items_center()
                        .gap_2()
                        .px(px(20.))
                        .py(px(7.))
                        .cursor_pointer()
                        .text_size(px(12.5))
                        .child(sidebar::icon("fr/pin.svg", 13., theme.primary))
                        .child(div().flex_1().min_w_0().truncate().text_color(theme.foreground).child(summary))
                        .child(sidebar::icon(if open { "fr/chevron-down.svg" } else { "fr/chevron.svg" }, 12., x.faint))
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.pins_open = !this.pins_open;
                            cx.notify();
                        })),
                )
                .when(open, |d| {
                    d.child(
                        div().id("pins-body").flex().flex_col().min_h_0().overflow_y_scroll().px(px(20.)).pb_2().children(pins.into_iter().enumerate().map(
                            |(k, (mid, text))| {
                                let (m1, m2, m3) = (mid.clone(), mid.clone(), mid);
                                div()
                                    .flex()
                                    .flex_col()
                                    .gap_1()
                                    .py_2()
                                    .when(k > 0, |d| d.border_t_1().border_color(theme.border))
                                    .child(
                                        div()
                                            .flex()
                                            .gap_3()
                                            .justify_end()
                                            .child(action(("pin-jump", k), "Jump to").on_click(cx.listener(move |this, _, _, cx| this.jump_to(&m1, cx))))
                                            .child(action(("pin-beside", k), "Open beside").on_click(cx.listener(move |this, _, _, cx| this.open_beside(&m2, cx))))
                                            .child(action(("pin-unpin", k), "Unpin").on_click(cx.listener(move |this, _, _, cx| this.toggle_pin(m3.clone(), cx)))),
                                    )
                                    .child(super::transcript::markdown(("pin-md", k), &text))
                            },
                        )),
                    )
                })
                .into_any_element(),
        )
    }
}

/// A pinned message opened beside its chat: read-only, scrolling Markdown.
pub struct NoteView {
    pub key: String,
    pub title: String,
    text: String,
    scroll: ScrollHandle,
}

impl NoteView {
    pub fn new(key: String, title: String, text: String) -> Self {
        Self { key, title, text, scroll: ScrollHandle::new() }
    }
}

impl Render for NoteView {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
            .id("note")
            .size_full()
            .overflow_y_scroll()
            .track_scroll(&self.scroll)
            .px(px(28.))
            .py(px(18.))
            .child(super::transcript::markdown("note-md", &self.text))
    }
}

#[cfg(test)]
mod tests {
    use super::{Rows, pin_title};
    use serde_json::json;

    #[test]
    fn pins_follow_their_events() {
        let mut rows = Rows::default();
        for e in [
            json!({ "type": "assistant_text", "text": "## Plan\n1. a", "messageId": "m1" }),
            json!({ "type": "user_text", "text": "ok" }),
            json!({ "type": "assistant_text", "text": "Done.", "messageId": "m2" }),
            json!({ "type": "pin", "messageId": "m1", "on": true }),
            json!({ "type": "pin", "messageId": "m2", "on": true }),
            json!({ "type": "pin", "messageId": "m1", "on": false }),
            json!({ "type": "pin", "messageId": "m1", "on": true }),
        ] {
            rows.apply(&e);
        }
        assert_eq!(rows.pins, ["m1", "m2"], "newest first; re-pinning moves it up");
        assert_eq!(rows.message("m1").map(|(_, t)| pin_title(t)).as_deref(), Some("Plan"));
    }
}
