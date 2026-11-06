//! ⌘F: find in the chat's questions and answers (tool output isn't searched).

use std::ops::Range;

use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::*;
use gpui_kit::*;

use super::transcript::{Item, Node};
use super::{ChatView, Row};
use crate::{sidebar, theme};

actions!(chat, [FindInChat]);

pub(super) fn bind(cx: &mut App) {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| cx.bind_keys([KeyBinding::new("cmd-f", FindInChat, Some("ChatView"))]));
}

pub(super) struct Find {
    input: Entity<InputState>,
    /// The query, lowercased (ASCII, so byte offsets match the text).
    pub query: String,
    /// Items with a match, oldest first, and the one shown.
    pub hits: Vec<usize>,
    pub pos: usize,
    _sub: Subscription,
}

fn row_text(r: &Row) -> Option<&str> {
    match r {
        Row::User { text, .. } | Row::Assistant { text, .. } => Some(text),
        _ => None,
    }
}

/// Items whose question/answer text contains `q` (already lowercased).
pub(super) fn hits(rows: &[Row], items: &[Item], q: &str) -> Vec<usize> {
    if q.is_empty() {
        return vec![];
    }
    let has = |r: usize| rows.get(r).and_then(row_text).is_some_and(|t| t.to_ascii_lowercase().contains(q));
    items
        .iter()
        .enumerate()
        .filter(|(_, it)| match &it.node {
            Node::Row(r) => has(*r),
            Node::Strip(rs) => rs.iter().any(|&r| has(r)),
        })
        .map(|(i, _)| i)
        .collect()
}

/// Byte ranges of `q` (lowercased) in `text`, case-insensitively.
pub(super) fn ranges(text: &str, q: &str) -> Vec<Range<usize>> {
    if q.is_empty() {
        return vec![];
    }
    let lower = text.to_ascii_lowercase();
    lower.match_indices(q).map(|(i, _)| i..i + q.len()).collect()
}

impl ChatView {
    pub(super) fn open_find(&mut self, _: &FindInChat, window: &mut Window, cx: &mut Context<Self>) {
        if self.find.is_none() {
            let input = cx.new(|cx| InputState::new(window, cx).placeholder("Find in chat"));
            let sub = cx.subscribe_in(&input, window, |this, input, ev: &InputEvent, _, cx| match ev {
                InputEvent::Change => {
                    let q = input.read(cx).value().trim().to_ascii_lowercase();
                    if let Some(f) = &mut this.find {
                        f.query = q;
                    }
                    this.refresh_find(true, cx);
                }
                InputEvent::PressEnter { shift, .. } => this.step_find(if *shift { 1 } else { -1 }, cx),
                _ => {}
            });
            self.find = Some(Find { input, query: String::new(), hits: vec![], pos: 0, _sub: sub });
        }
        if let Some(f) = &self.find {
            f.input.update(cx, |s, cx| {
                s.focus(window, cx);
                s.select_all(window, cx);
            });
        }
        cx.notify();
    }

    /// Recompute the hits (the rows changed or the query did). A new query jumps
    /// to the newest match.
    pub(super) fn refresh_find(&mut self, new_query: bool, cx: &mut Context<Self>) {
        let Some(f) = &mut self.find else { return };
        f.hits = hits(&self.rows.rows, &self.items, &f.query);
        if new_query {
            f.pos = f.hits.len().saturating_sub(1);
            self.jump_to_hit(cx);
        } else {
            f.pos = f.pos.min(f.hits.len().saturating_sub(1));
        }
        cx.notify();
    }

    fn step_find(&mut self, dir: isize, cx: &mut Context<Self>) {
        let Some(f) = &mut self.find else { return };
        let n = f.hits.len() as isize;
        if n == 0 {
            return;
        }
        f.pos = ((f.pos as isize + dir + n) % n) as usize;
        self.jump_to_hit(cx);
        cx.notify();
    }

    // ponytail: scrolls the hit to the top; centre it if MessageScroller grows a reveal API.
    fn jump_to_hit(&mut self, cx: &mut Context<Self>) {
        let Some(&ix) = self.find.as_ref().and_then(|f| f.hits.get(f.pos)) else { return };
        self.scroller.update(cx, |s, cx| {
            s.scroll_to_item(ix, cx);
        });
    }

    fn close_find(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.find = None;
        self.input.update(cx, |s, cx| s.focus(window, cx));
        cx.notify();
    }

    /// For an item: Some(true) the current hit, Some(false) another hit.
    pub(super) fn find_mark(&self, item: usize) -> Option<bool> {
        let f = self.find.as_ref()?;
        f.hits.binary_search(&item).ok().map(|i| i == f.pos)
    }

    pub(super) fn find_query(&self) -> Option<&str> {
        self.find.as_ref().map(|f| f.query.as_str()).filter(|q| !q.is_empty())
    }

    pub(super) fn render_find_bar(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let f = self.find.as_ref()?;
        let theme = cx.theme().colors;
        let x = theme::extra(cx);
        let count = match (f.query.is_empty(), f.hits.len()) {
            (true, _) => String::new(),
            (false, 0) => "No matches".into(),
            (false, n) => format!("{} / {n}", f.pos + 1),
        };
        let btn = |id: &'static str, glyph: &'static str| {
            div()
                .id(id)
                .size(px(24.))
                .flex()
                .items_center()
                .justify_center()
                .rounded(px(5.))
                .cursor_pointer()
                .text_size(px(12.))
                .text_color(theme.muted_foreground)
                .hover(|s| s.bg(x.hover))
                .child(glyph)
        };
        Some(
            div()
                .flex()
                .items_center()
                .gap_1()
                .px(px(12.))
                .py_1()
                .border_b_1()
                .border_color(theme.border)
                .capture_key_down(cx.listener(|this, e: &KeyDownEvent, window, cx| {
                    if e.keystroke.key == "escape" {
                        cx.stop_propagation();
                        this.close_find(window, cx);
                    }
                }))
                .child(div().flex_1().child(Input::new(&f.input).cleanable(false)))
                .child(div().px_2().text_size(px(12.)).text_color(x.faint).child(count))
                .child(btn("find-older", "↑").on_click(cx.listener(|this, _, _, cx| this.step_find(-1, cx))))
                .child(btn("find-newer", "↓").on_click(cx.listener(|this, _, _, cx| this.step_find(1, cx))))
                .child(
                    btn("find-close", "")
                        .child(sidebar::icon("icons/close.svg", 11., theme.muted_foreground))
                        .on_click(cx.listener(|this, _, window, cx| this.close_find(window, cx))),
                )
                .into_any_element(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::super::Row;
    use super::{hits, ranges};

    #[test]
    fn finds_question_and_answer_rows() {
        let rows = vec![
            Row::User { text: "Fix the Parser".into(), steered: false, attachments: vec![], ts: None },
            Row::Tool { title: "parser.rs".into(), status: "done", output: "parser".into(), diffs: vec![] },
            Row::Assistant { text: "The parser is fixed".into(), message_id: None, ts: None },
        ];
        let items = super::super::transcript::build_items(&rows);
        assert_eq!(hits(&rows, &items, "parser"), [0, 2]);
        assert!(hits(&rows, &items, "").is_empty());
        assert_eq!(ranges("aXa xa", "xa"), [1..3, 4..6]);
    }
}
