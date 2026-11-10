//! The transcript (ChatPane.tsx's ChatRow / ProcessStrip / UserBubble): rows
//! folded into list items, turns with time dividers and a pinned question, and
//! the activity / plan strips around it.

use std::ops::Range;

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::clipboard::Clipboard;
use gpui_kit::component::menu::{DropdownMenu as _, PopupMenuItem};
use gpui_kit::component::text::TextView;
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::component::*;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use serde_json::Value;

use super::{ChatView, Row, Status};
use crate::{sidebar, theme};

/// One list item: a row, or a run of 2+ consecutive tools folded into a strip.
#[derive(PartialEq, Clone, Debug)]
pub(super) enum Node {
    Row(usize),
    Strip(Vec<usize>),
}

#[derive(PartialEq, Clone, Debug)]
pub(super) struct Item {
    pub node: Node,
    pub user: bool,
    /// The first item of a turn (a question not right after another one).
    pub turn_start: bool,
    /// Set on a turn that starts >1h after the previous one: its start time.
    pub divider: Option<i64>,
}

const GAP_MS: i64 = 60 * 60 * 1000;

fn row_ts(r: &Row) -> Option<i64> {
    match r {
        Row::User { ts, .. } | Row::Assistant { ts, .. } => *ts,
        _ => None,
    }
}

pub(super) fn hidden(r: &Row) -> bool {
    matches!(r, Row::Assistant { text, .. } | Row::Thinking(text) if is_blank(text))
}

pub(super) fn build_items(rows: &[Row]) -> Vec<Item> {
    let mut items: Vec<Item> = vec![];
    let mut tools: Vec<usize> = vec![];
    let push = |items: &mut Vec<Item>, node: Node, user: bool| {
        let turn_start = items.is_empty() || (user && !items.last().is_some_and(|i| i.user));
        items.push(Item { node, user, turn_start, divider: None });
    };
    let flush = |items: &mut Vec<Item>, tools: &mut Vec<usize>| match tools.len() {
        0 => {}
        1 => push(items, Node::Row(tools.pop().unwrap()), false),
        _ => push(items, Node::Strip(std::mem::take(tools)), false),
    };
    for (i, r) in rows.iter().enumerate() {
        if hidden(r) {
            continue;
        }
        if matches!(r, Row::Tool { .. }) {
            tools.push(i);
            continue;
        }
        flush(&mut items, &mut tools);
        push(&mut items, Node::Row(i), matches!(r, Row::User { .. }));
    }
    flush(&mut items, &mut tools);

    // A turn's time is its first question/answer chunk with a timestamp.
    let mut prev: Option<i64> = None;
    let mut i = 0;
    while i < items.len() {
        let end = (i + 1..items.len()).find(|&j| items[j].turn_start).unwrap_or(items.len());
        let ts = items[i..end].iter().find_map(|it| match it.node {
            Node::Row(r) => row_ts(&rows[r]),
            Node::Strip(_) => None,
        });
        if let Some(ts) = ts {
            items[i].divider = prev.filter(|p| ts - p > GAP_MS).map(|_| ts);
            prev = Some(ts);
        }
        i = end;
    }
    items
}

/// The question pinned while item `k` is at the top: the last of its turn's
/// leading questions, once it has scrolled off — `k` itself, when it is the
/// question, only once less of it shows than the pinned copy covers.
pub(super) fn header_at(items: &[Item], k: usize, offset: Pixels, question_h: Pixels, pinned_h: Pixels) -> Option<usize> {
    let k = k.min(items.len().checked_sub(1)?);
    let start = (0..=k).rev().find(|&j| items[j].turn_start)?;
    if !items[start].user {
        return None;
    }
    let mut h = start;
    while h + 1 < items.len() && items[h + 1].user {
        h += 1;
    }
    (h < k || (h == k && offset > px(0.) && question_h - offset < pinned_h)).then_some(h)
}

/// How far the pinned copy slides up: the next turn's question pushes it off as it
/// reaches the top (like sticky headers), rather than sliding under it. The
/// question's distance from the top is the heights of the items above it, from
/// `k` (scrolled `offset` into it); an unmeasured one means "far", so no push.
pub(super) fn push_up(items: &[Item], k: usize, offset: Pixels, pinned_h: Pixels, height: impl Fn(usize) -> Option<Pixels>) -> Pixels {
    let Some(next) = (k + 1..items.len()).find(|&j| items[j].user && items[j].turn_start) else { return px(0.) };
    let mut top = px(0.) - offset;
    for j in k..next {
        top += match height(j) {
            Some(h) => h,
            None => return px(0.),
        };
        if top >= pinned_h {
            return px(0.);
        }
    }
    pinned_h - top.max(px(0.))
}

/// Only blank lines and `---` / `***` / `___` rules.
pub(super) fn is_blank(text: &str) -> bool {
    text.lines().all(|l| l.trim().is_empty() || is_rule(l))
}

fn is_rule(l: &str) -> bool {
    let indent = l.len() - l.trim_start_matches([' ', '\t']).len();
    let t = l.trim();
    indent <= 3 && t.len() >= 3 && ['-', '*', '_'].iter().any(|&c| t.chars().all(|x| x == c))
}

/// Drop thematic breaks (models sprinkle `---` between steps). Fenced code is
/// left alone, and so is a rule under text (a setext heading).
pub(super) fn strip_rules(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let (mut fence, mut prev_blank) = (false, true);
    for line in text.split_inclusive('\n') {
        let t = line.trim_start();
        if t.starts_with("```") || t.starts_with("~~~") {
            fence = !fence;
        }
        if !fence && prev_blank && is_rule(line.trim_end_matches(['\n', '\r'])) {
            continue;
        }
        prev_blank = line.trim().is_empty();
        out.push_str(line);
    }
    out
}

/// http(s) URLs in plain text: byte range and URL, without trailing punctuation.
pub(super) fn find_urls(text: &str) -> Vec<(Range<usize>, String)> {
    let mut out = vec![];
    let mut from = 0;
    while let Some(start) = ["https://", "http://"].iter().filter_map(|p| text[from..].find(p)).min().map(|i| from + i) {
        let len = text[start..].find(|c: char| c.is_whitespace() || "<>\"'`".contains(c)).unwrap_or(text.len() - start);
        let url = text[start..start + len].trim_end_matches(|c| ".,;:!?)]}'\"".contains(c));
        if url.split_once("://").is_some_and(|(_, rest)| !rest.is_empty()) {
            out.push((start..start + url.len(), url.to_string()));
        }
        from = start + len.max(1);
    }
    out
}

/// A one-line description of a tool's input, for the permission card.
pub(super) fn describe_input(input: &Value) -> String {
    if let Some(s) = ["command", "file_path", "path", "url", "pattern"].iter().find_map(|k| input[*k].as_str()) {
        return s.to_string();
    }
    let s = input.as_str().map(str::to_string).unwrap_or_else(|| if input.is_null() { "{}".into() } else { input.to_string() });
    truncate(&s, 300)
}

/// The first meaningful line of tool output, for the collapsed header.
fn tool_preview(s: &str) -> String {
    truncate(s.lines().map(str::trim).find(|l| !l.is_empty() && !l.starts_with("```")).unwrap_or_default(), 100)
}

fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() > n { format!("{}…", s.chars().take(n).collect::<String>()) } else { s.to_string() }
}

fn local(ms: i64) -> chrono::DateTime<chrono::Local> {
    chrono::DateTime::from_timestamp_millis(ms).unwrap_or_default().with_timezone(&chrono::Local)
}

/// "Nov 6, 2026, 2:41:07 PM" — a message's hover time.
fn clock_time(ms: i64) -> String {
    local(ms).format("%b %-d, %Y, %-I:%M:%S %p").to_string()
}

/// "2:41 PM" today, else "Thu, Nov 6 · 2:41 PM".
fn time_divider(ms: i64) -> String {
    let t = local(ms);
    let today = t.date_naive() == chrono::Local::now().date_naive();
    t.format(if today { "%-I:%M %p" } else { "%a, %b %-d · %-I:%M %p" }).to_string()
}

pub(super) const FOREST_WORDS: &[&str] = &[
    "Sprouting", "Photosynthesizing", "Rooting", "Branching", "Budding", "Germinating", "Composting", "Mulching",
    "Foraging", "Pollinating", "Rustling", "Ranging", "Whittling", "Grafting", "Leafing out", "Bushwhacking",
    "Tree-hugging", "Counting rings", "Trailblazing", "Meandering", "Rewilding", "Pruning", "Bird-watching",
    "Tending the grove", "Acorn-gathering", "Canopy-climbing", "Fern-unfurling", "Moss-reading", "Sap-rising",
    "Wind-reading", "Owl-spotting", "Clearing deadwood", "Seed-scattering", "Trail-marking", "Wandering the woods",
    "Chopping kindling", "Stoking the fire", "Pitching camp", "Following tracks", "Watching the birds",
    "Gathering pinecones", "Counting saplings", "Coppicing", "Thinning the understory", "Splitting logs",
    "Sharpening the axe", "Reading the map", "Fording the creek", "Crossing the brook", "Skipping stones",
    "Climbing the ridge", "Summiting", "Blazing the trail", "Tracking deer", "Spotting elk", "Listening for owls",
    "Reading the bark", "Tapping maples", "Collecting sap", "Foraging mushrooms", "Identifying lichen",
    "Watering saplings", "Planting seedlings", "Transplanting", "Weeding the beds", "Raking leaves",
    "Stacking firewood", "Roasting chestnuts", "Brewing pine tea", "Birdcalling", "Charting the canopy",
    "Dating the rings", "Mapping the stand", "Cruising timber", "Scouting the ridge", "Cloud-watching",
    "Star-mapping", "Banking the coals", "Breaking camp", "Filling the canteen", "Sketching the vista",
    "Pressing leaves", "Cataloguing moss", "Chasing fireflies", "Counting frogs", "Wading the shallows",
    "Watching the treeline", "Circling the meadow", "Whistling to jays", "Untangling brambles", "Trimming the hedge",
    "Sowing wildflowers", "Marking the trailhead", "Truffle hunting", "Tracking squirrels", "Observing the clouds",
    "Sketching the landscape", "Observing the stars", "Walking the forest",
];

/// A random word that isn't one of `recent`.
pub(super) fn next_forest_word(recent: &[&'static str], mut rand: impl FnMut() -> usize) -> &'static str {
    let mut w = FOREST_WORDS[rand() % FOREST_WORDS.len()];
    for _ in 0..50 {
        if !recent.contains(&w) {
            break;
        }
        w = FOREST_WORDS[rand() % FOREST_WORDS.len()];
    }
    w
}

// ponytail: estimates a bubble's height from its text; measure the laid-out
// height instead if clamping misfires on very wide panes.
fn overflows_clamp(text: &str) -> bool {
    text.lines().count() > 4 || text.chars().count() > 360
}

/// Your own message as Markdown that shows exactly what you typed — so it can use
/// the selectable TextView. Markdown characters are escaped (links stay bare so they
/// autolink), line breaks are kept, and leading spaces don't turn into code blocks.
fn plain_markdown(text: &str) -> String {
    let urls = find_urls(text);
    let mut out = String::with_capacity(text.len() + 16);
    let mut at = 0;
    let mut line_start = true;
    while at < text.len() {
        if let Some((r, url)) = urls.iter().find(|(r, _)| r.start == at) {
            out.push('<');
            out.push_str(url);
            out.push('>');
            at = r.end;
            line_start = false;
            continue;
        }
        let c = text[at..].chars().next().unwrap();
        at += c.len_utf8();
        match c {
            '\n' => {
                out.push_str("\\\n");
                line_start = true;
                continue;
            }
            ' ' | '\t' if line_start => out.push('\u{00A0}'),
            c if c.is_ascii_punctuation() => {
                out.push('\\');
                out.push(c);
            }
            c => out.push(c),
        }
        line_start = line_start && c.is_whitespace();
    }
    out
}

pub(super) fn markdown(id: impl Into<ElementId>, text: &str) -> TextView {
    TextView::markdown(id, strip_rules(text)).code_block_actions(|cb, _, _| {
        Clipboard::new(("copy-code", cb.span.as_ref().map_or(0, |s| s.start))).tooltip("Copy").value(cb.code())
    })
}

fn chevron(open: bool, color: Hsla) -> Svg {
    sidebar::icon(if open { "fr/chevron-down.svg" } else { "fr/chevron.svg" }, 12., color)
}

impl ChatView {
    pub(super) fn item_of_row(&self, row: usize) -> Option<usize> {
        // From the end: updates are almost always to the latest rows.
        self.items.iter().rposition(|it| match &it.node {
            Node::Row(r) => *r == row,
            Node::Strip(rs) => rs.contains(&row),
        })
    }

    /// Flip a row's (or a strip's, keyed by its first row) disclosure.
    pub(super) fn toggle(&mut self, row: usize, strip: bool, cx: &mut Context<Self>) {
        let set = if strip { &mut self.open_strips } else { &mut self.open };
        if !set.remove(&row) {
            set.insert(row);
        }
        if let Some(ix) = self.item_of_row(row) {
            self.scroller.update(cx, |s, cx| {
                s.remeasure_items(ix..ix + 1, cx);
            });
        }
        cx.notify();
    }

    pub(super) fn render_item(&self, ix: usize, view: Entity<ChatView>, cx: &App) -> AnyElement {
        let x = theme::extra(cx);
        let Some(item) = self.items.get(ix) else { return div().into_any_element() };
        let body = match &item.node {
            Node::Row(r) => self.render_row(*r, &view, cx),
            Node::Strip(rows) => self.render_strip(rows, self.status == Status::Working && ix + 1 == self.items.len(), &view, cx).into_any_element(),
        };
        let body = match self.find_mark(ix) {
            Some(current) => div().rounded_md().bg(x.amber.opacity(if current { 0.16 } else { 0.06 })).child(body).into_any_element(),
            None => body,
        };
        let heights = self.item_h.clone();
        div()
            .relative()
            .flex()
            .flex_col()
            // Each item records its height, for pinning (see `render_pinned`).
            .child(canvas(move |b, _, _| { heights.borrow_mut().insert(ix, b.size.height); }, |_, _, _, _| {}).absolute().size_full())
            .when_some(item.divider, |d, ts| {
                d.child(
                    div()
                        .flex()
                        .items_center()
                        .gap_3()
                        .pb_3()
                        .text_size(px(11.5))
                        .text_color(x.faint)
                        .child(div().flex_1().h(px(1.)).bg(x.border_strong))
                        .child(time_divider(ts))
                        .child(div().flex_1().h(px(1.)).bg(x.border_strong)),
                )
            })
            .child(body)
            .into_any_element()
    }

    fn render_strip(&self, rows: &[usize], active: bool, view: &Entity<ChatView>, cx: &App) -> Div {
        let theme = cx.theme().colors;
        let x = theme::extra(cx);
        let first = rows[0];
        let open = self.open_strips.contains(&first);
        let last = match self.rows.rows.get(*rows.last().unwrap()) {
            Some(Row::Tool { title, .. }) => title.clone(),
            _ => String::new(),
        };
        let dot = div().size(px(7.)).rounded_full().bg(if active { theme.primary } else { x.faint });
        let v = view.clone();
        div()
            .flex()
            .flex_col()
            .gap_1()
            .child(
                div()
                    .id(("strip", first))
                    .flex()
                    .items_center()
                    .gap_2()
                    .text_sm()
                    .text_color(theme.muted_foreground)
                    .cursor_pointer()
                    .child(chevron(open, x.faint))
                    .child(if active {
                        dot.opacity(crate::anim::pulse(1400, 0.3, 1.)).into_any_element()
                    } else {
                        dot.into_any_element()
                    })
                    .child(div().flex_shrink_0().child(format!("{} steps", rows.len())))
                    .child(div().min_w_0().truncate().text_color(x.faint).child(format!("· {last}")))
                    .on_click(move |_, _, cx| v.update(cx, |c, cx| c.toggle(first, true, cx))),
            )
            .when(open, |d| {
                d.child(
                    div()
                        .flex()
                        .flex_col()
                        .gap_2()
                        .ml(px(5.))
                        .pl_3()
                        .border_l_1()
                        .border_color(x.border_strong)
                        .children(rows.iter().map(|&r| self.render_row(r, view, cx))),
                )
            })
    }

    fn render_row(&self, ix: usize, view: &Entity<ChatView>, cx: &App) -> AnyElement {
        let theme = cx.theme().colors;
        let x = theme::extra(cx);
        let Some(row) = self.rows.rows.get(ix) else { return div().into_any_element() };
        let el = match row {
            Row::User { text, steered, attachments, ts } => div()
                .flex()
                .flex_col()
                .items_end()
                .gap_1()
                .when(*steered, |d| d.child(div().pr_1().text_xs().text_color(x.faint).child("steered in")))
                .child(self.user_bubble(ix, text, attachments, *ts, false, view, cx))
                .into_any_element(),
            Row::Assistant { text, message_id, ts } => {
                let (v, raw) = (view.clone(), text.clone());
                let pinned = message_id.as_deref().is_some_and(|m| self.is_pinned(m));
                div()
                    .id(("assistant", ix))
                    .group("assistant")
                    .relative()
                    .rounded(px(6.))
                    // Just jumped to from the pins strip.
                    .when(self.flash == Some(ix), |d| d.bg(theme.primary.opacity(0.1)))
                    .child(markdown(("md", ix), text))
                    .when_some(*ts, |d, ts| d.tooltip(move |w, cx| Tooltip::new(clock_time(ts)).build(w, cx)))
                    .when_some(message_id.clone(), |d, mid| {
                        let (pv, pmid) = (v.clone(), mid.clone());
                        d.child(
                            div()
                                .absolute()
                                .top(px(-6.))
                                .right_0()
                                .flex()
                                // A pinned message keeps its pin showing; the rest appear on hover.
                                .child(
                                    div().when(!pinned, |d| d.opacity(0.).group_hover("assistant", |s| s.opacity(1.))).child(
                                        Button::new(("msg-pin", ix))
                                            .small()
                                            .ghost()
                                            .icon(Icon::empty().path("fr/pin.svg").when(pinned, |i| i.text_color(theme.primary)))
                                            .tooltip(if pinned { "Unpin" } else { "Pin — keep it at the top while the chat goes on" })
                                            .on_click(move |_, _, cx| pv.update(cx, |c, cx| c.toggle_pin(pmid.clone(), cx))),
                                    ),
                                )
                                .child(div().opacity(0.).group_hover("assistant", |s| s.opacity(1.)).child(
                                Button::new(("msg-menu", ix))
                                    .small()
                                    .ghost()
                                    .icon(Icon::empty().path("fr/ellipsis.svg"))
                                    .tooltip("Message actions")
                                    .dropdown_menu_with_anchor(Anchor::TopRight, move |menu, _, _| {
                                        let (v1, v2, raw, mid, pin_mid) = (v.clone(), v.clone(), raw.clone(), mid.clone(), mid.clone());
                                        menu.item(PopupMenuItem::new(if pinned { "Unpin" } else { "Pin" }).on_click(move |_, _, cx| {
                                            v2.update(cx, |c, cx| c.toggle_pin(pin_mid.clone(), cx))
                                        }))
                                        .item(PopupMenuItem::new("Branch from here").on_click(move |_, _, cx| {
                                            v1.update(cx, |c, cx| c.branch_from(mid.clone(), cx))
                                        }))
                                        .item(PopupMenuItem::new("Copy text").on_click(move |_, _, cx| {
                                            cx.write_to_clipboard(ClipboardItem::new_string(raw.clone()))
                                        }))
                                    }),
                            )),
                        )
                    })
                    .into_any_element()
            }
            Row::Thinking(text) => {
                let open = self.open.contains(&ix);
                let v = view.clone();
                div()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .text_sm()
                    .text_color(x.faint)
                    .child(
                        div()
                            .id(("thinking", ix))
                            .flex()
                            .items_center()
                            .gap_1p5()
                            .cursor_pointer()
                            .child(chevron(open, x.faint))
                            .child(div().italic().child("Thinking"))
                            .on_click(move |_, _, cx| v.update(cx, |c, cx| c.toggle(ix, false, cx))),
                    )
                    .when(open, |d| d.child(div().pl_5().italic().whitespace_normal().child(text.clone())))
                    .into_any_element()
            }
            Row::Tool { title, status, output, diffs } => {
                let (glyph, color) = match *status {
                    "done" => ("✓", theme.success),
                    "failed" => ("✗", theme.danger),
                    _ => ("…", theme.muted_foreground),
                };
                let expandable = !diffs.is_empty() || !output.is_empty();
                // Edits start open; anything else starts closed.
                let open = expandable && (self.open.contains(&ix) != !diffs.is_empty());
                let preview = (diffs.is_empty() && !output.is_empty()).then(|| tool_preview(output)).filter(|p| !p.is_empty());
                let v = view.clone();
                div()
                    .flex()
                    .flex_col()
                    .gap_1()
                    .text_sm()
                    .text_color(theme.muted_foreground)
                    .child(
                        div()
                            .id(("tool", ix))
                            .flex()
                            .items_center()
                            .gap_2()
                            .when(expandable, |d| {
                                d.cursor_pointer().on_click(move |_, _, cx| v.update(cx, |c, cx| c.toggle(ix, false, cx)))
                            })
                            .child(div().w(px(12.)).flex_shrink_0().text_color(color).child(glyph))
                            .child(div().flex_shrink_0().max_w(rems(24.)).truncate().child(title.clone()))
                            .when_some(preview, |d, p| {
                                d.child(
                                    div()
                                        .min_w_0()
                                        .truncate()
                                        .text_size(px(12.5))
                                        .text_color(if *status == "failed" { theme.danger } else { x.faint })
                                        .child(p),
                                )
                            })
                            .when(expandable, |d| d.child(chevron(open, x.faint))),
                    )
                    .when(open, |d| {
                        let body = if diffs.is_empty() {
                            markdown(("tool-out", ix), output).into_any_element()
                        } else {
                            self.render_diffs(ix, diffs, view, cx).into_any_element()
                        };
                        d.child(
                            div()
                                .ml(px(20.))
                                .p_2()
                                .rounded_md()
                                .border_1()
                                .border_color(theme.border)
                                .bg(theme.sidebar)
                                .text_color(theme.foreground)
                                .child(body),
                        )
                    })
                    .into_any_element()
            }
            Row::Permission { id, title, input, options, answer } => div()
                .flex()
                .flex_col()
                .gap_2()
                .p_3()
                .rounded_md()
                .border_1()
                .border_color(x.amber)
                .map(|d| match input["plan"].as_str() {
                    // Plan mode's "approve this plan": the plan itself, as Markdown, in
                    // a box that scrolls rather than as a truncated line of JSON.
                    Some(plan) => d.child(div().text_sm().font_weight(FontWeight::SEMIBOLD).child("Approve this plan?")).child(
                        div()
                            .id(("plan-md", ix))
                            .max_h(px(480.))
                            .overflow_y_scroll()
                            .px_3()
                            .py_2()
                            .rounded(px(6.))
                            .border_1()
                            .border_color(theme.border)
                            .bg(theme.background)
                            .child(markdown(("plan-text", ix), plan)),
                    ),
                    None => d.child(div().flex().gap_1().text_sm().child("Allow").child(div().font_weight(FontWeight::SEMIBOLD).child(title.clone())).child("?")).child(
                        div()
                            .text_size(px(12.))
                            .font_family(cx.theme().mono_font_family.clone())
                            .text_color(theme.muted_foreground)
                            .whitespace_normal()
                            .child(describe_input(input)),
                    ),
                })
                .child(match answer {
                    Some(a) => div().text_sm().text_color(theme.muted_foreground).child(format!("→ {a}")),
                    None => div().flex().flex_wrap().gap_2().children(options.iter().enumerate().map(|(i, (oid, label, kind))| {
                        let (view, id, oid) = (view.clone(), id.clone(), oid.clone());
                        let b = Button::new(("perm", ix * 16 + i)).label(label.clone());
                        let b = match kind.as_str() {
                            "allow_once" => b.primary(),
                            k if k.starts_with("allow") => b.outline(),
                            "reject_once" => b.danger(),
                            _ => b.ghost(),
                        };
                        b.on_click(move |_, _, cx| view.update(cx, |v, _| v.respond(id.clone(), oid.clone())))
                    })),
                })
                .into_any_element(),
            Row::Elicitation(e) => self.render_elicitation(ix, e, view, cx),
            Row::Info(text) => div().text_sm().text_color(theme.danger).child(text.clone()).into_any_element(),
        };
        div().py_1p5().child(el).into_any_element()
    }

    /// A sent message: linkified, with its attachments, clamped when long.
    /// `pinned` is the copy shown as the turn's sticky header (always clamped).
    #[allow(clippy::too_many_arguments)]
    pub(super) fn user_bubble(
        &self,
        ix: usize,
        text: &str,
        attachments: &[(String, bool)],
        ts: Option<i64>,
        pinned: bool,
        view: &Entity<ChatView>,
        cx: &App,
    ) -> Stateful<Div> {
        let theme = cx.theme().colors;
        let x = theme::extra(cx);
        let clamps = overflows_clamp(text);
        let expanded = !pinned && self.open.contains(&ix);
        // A ⌘F match in your message tints the bubble (as in agent replies).
        let found = self.find_query().is_some_and(|q| !super::find::ranges(text, q).is_empty());
        let v = view.clone();
        div()
            .id((if pinned { "pinned-user" } else { "user" }, ix))
            .flex()
            .flex_col()
            .gap_1()
            .max_w(rems(42.))
            .px_3()
            .py_2()
            .rounded_lg()
            .bg(theme.list_active)
            .when(found, |d| d.border_1().border_color(x.amber))
            .when_some(ts.filter(|_| !pinned), |d, ts| d.tooltip(move |w, cx| Tooltip::new(clock_time(ts)).build(w, cx)))
            .when(!attachments.is_empty(), |d| {
                d.child(div().flex().flex_wrap().gap_1p5().children(attachments.iter().map(|(name, image)| {
                    div()
                        .px_2()
                        .py_0p5()
                        .rounded(px(5.))
                        .border_1()
                        .border_color(x.border_strong)
                        .text_size(px(11.5))
                        .text_color(theme.muted_foreground)
                        .child(format!("{} {name}", if *image { "🖼" } else { "📎" }))
                })))
            })
            .child(
                div()
                    .whitespace_normal()
                    .when(clamps && !expanded, |d| d.max_h(px(80.)).overflow_hidden())
                    // Selectable (and its links clickable), like the agent's replies.
                    .child(TextView::markdown((if pinned { "pinned-user-text" } else { "user-text" }, ix), plain_markdown(text))),
            )
            .when(clamps && !pinned, |d| {
                d.child(
                    div()
                        .id(("show-more", ix))
                        .text_size(px(12.))
                        .text_color(theme.primary)
                        .cursor_pointer()
                        .child(if expanded { "Show less" } else { "Show more" })
                        .on_click(move |_, _, cx| v.update(cx, |c, cx| c.toggle(ix, false, cx))),
                )
            })
    }

    /// The question of the turn under the top edge, pinned over the transcript.
    pub(super) fn render_pinned(&self, view: &Entity<ChatView>, cx: &App) -> Option<AnyElement> {
        let top = self.scroller.read(cx).logical_scroll_top();
        // Past the end: a tail scroll that hasn't settled yet.
        if top.item_ix >= self.items.len() {
            return None;
        }
        let heights = self.item_h.borrow();
        let question_h = heights.get(&top.item_ix).copied().unwrap_or(px(f32::MAX));
        let pin_h = self.pinned_h.get();
        let h = header_at(&self.items, top.item_ix, top.offset_in_item, question_h, pin_h)?;
        let push = push_up(&self.items, top.item_ix, top.offset_in_item, pin_h, |j| heights.get(&j).copied());
        drop(heights);
        if push >= pin_h {
            return None;
        }
        let Node::Row(r) = self.items[h].node else { return None };
        let Some(Row::User { text, attachments, .. }) = self.rows.rows.get(r) else { return None };
        let theme = cx.theme().colors;
        let v = view.clone();
        let pinned_h = self.pinned_h.clone();
        Some(
            div()
                .child(canvas(move |b, _, _| pinned_h.set(b.size.height), |_, _, _, _| {}).absolute().size_full())
                .absolute()
                .top(px(0.) - push)
                .left_0()
                .right_0()
                .px(px(32.))
                .pt_1()
                .pb_2()
                .flex()
                .justify_end()
                .bg(theme.background)
                .border_b_1()
                .border_color(theme.border)
                .child(self.user_bubble(r, text, attachments, None, true, view, cx).cursor_pointer().on_click(move |_, _, cx| {
                    v.update(cx, |c, cx| {
                        c.scroller.update(cx, |s, cx| {
                            s.scroll_to_item(h, cx);
                        })
                    })
                }))
                .into_any_element(),
        )
    }

    /// Tree + forest word while working, "Lacing up…" while starting — but not
    /// while the answer itself is streaming.
    pub(super) fn render_activity(&self, cx: &App) -> Option<AnyElement> {
        let label = match self.status {
            Status::Starting => "Lacing up…".to_string(),
            Status::Working => {
                let streaming = self.rows.rows.iter().rev().find(|r| !hidden(r)).is_some_and(|r| matches!(r, Row::Assistant { .. }));
                if streaming {
                    return None;
                }
                format!("{}…", self.forest_word)
            }
            Status::Idle => return None,
        };
        let theme = cx.theme().colors;
        Some(
            div()
                .flex()
                .items_center()
                .gap_2()
                .px(px(32.))
                .pt_1()
                .pb_3()
                .text_size(px(13.))
                .text_color(theme.muted_foreground)
                .child(sidebar::icon("fr/tree.svg", TREE_PX, theme.primary).with_transformation(tree_sway(crate::anim::phase(2800))))
                .child(label)
                .into_any_element(),
        )
    }

    /// "Plan · d/n done", expandable to the entries.
    pub(super) fn render_plan(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let plan = &self.rows.plan;
        if plan.is_empty() {
            return None;
        }
        let theme = cx.theme().colors;
        let x = theme::extra(cx);
        let done = plan.iter().filter(|(_, s)| s == "completed").count();
        let open = self.plan_open;
        Some(
            div()
                .flex()
                .flex_col()
                .gap_1()
                .text_size(px(12.5))
                .text_color(theme.muted_foreground)
                .child(
                    div()
                        .id("plan")
                        .flex()
                        .items_center()
                        .gap_1p5()
                        .cursor_pointer()
                        .child(chevron(open, x.faint))
                        .child(format!("Plan · {done}/{} done", plan.len()))
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.plan_open = !this.plan_open;
                            cx.notify();
                        })),
                )
                .when(open, |d| {
                    d.children(plan.iter().map(|(content, status)| {
                        let (mark, color) = match status.as_str() {
                            "completed" => ("●", x.green),
                            "in_progress" => ("◐", theme.primary),
                            _ => ("○", x.faint),
                        };
                        div()
                            .flex()
                            .gap_2()
                            .pl_5()
                            .when(status == "completed", |d| d.line_through())
                            .child(div().flex_shrink_0().text_color(color).child(mark))
                            .child(div().min_w_0().whitespace_normal().child(content.clone()))
                    }))
                })
                .into_any_element(),
        )
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn plain_markdown_shows_text_as_typed() {
        use super::plain_markdown;
        assert_eq!(plain_markdown("fix *this* #1"), "fix \\*this\\* \\#1");
        assert_eq!(plain_markdown("a\nb"), "a\\\nb");
        assert_eq!(plain_markdown("  code"), "\u{00A0}\u{00A0}code");
        assert_eq!(plain_markdown("see https://x.dev/a_b."), "see <https://x.dev/a_b>\\.");
    }

    use gpui_kit::px;
    use super::{FOREST_WORDS, Node, Row, build_items, describe_input, find_urls, header_at, is_blank, next_forest_word, push_up, strip_rules, tool_preview};

    fn user(t: &str, ts: i64) -> Row {
        Row::User { text: t.into(), steered: false, attachments: vec![], ts: Some(ts) }
    }
    fn tool() -> Row {
        Row::Tool { title: "Read".into(), status: "done", output: String::new(), diffs: vec![] }
    }
    fn said(t: &str) -> Row {
        Row::Assistant { text: t.into(), message_id: None, ts: None }
    }

    #[test]
    fn folds_tool_runs_into_turns() {
        let h = 3_600_001;
        let rows = vec![user("a", 0), tool(), tool(), said("---\n"), tool(), said("ok"), user("b", h), user("c", h), tool()];
        let items = build_items(&rows);
        let nodes: Vec<_> = items.iter().map(|i| i.node.clone()).collect();
        // The blank chunk is hidden, so all three tools fold into one strip.
        assert_eq!(nodes, [Node::Row(0), Node::Strip(vec![1, 2, 4]), Node::Row(5), Node::Row(6), Node::Row(7), Node::Row(8)]);
        assert_eq!(items.iter().map(|i| i.turn_start).collect::<Vec<_>>(), [true, false, false, true, false, false]);
        assert_eq!(items[3].divider, Some(h));
        let (q, p) = (px(100.), px(40.));
        assert_eq!(header_at(&items, 5, px(0.), q, p), Some(4));
        assert_eq!(header_at(&items, 4, px(0.), q, p), None);
        assert_eq!(header_at(&items, 0, px(30.), q, p), None); // most of it still shows
        assert_eq!(header_at(&items, 0, px(70.), q, p), Some(0)); // the pinned copy covers the rest

        // Question 3's turn runs to item 5; the next question is item 6. With item 5
        // (30px) at the top, scrolled 10px in, item 6 starts 20px down: the 40px pin
        // is pushed up 20px. Further away, at the top, or unmeasured: see below.
        let rows = vec![user("a", 0), said("x"), said("y"), user("b", 1), said("z"), said("w"), user("c", 2)];
        let items = build_items(&rows);
        let h = |j: usize| [px(50.), px(50.), px(50.), px(50.), px(30.), px(30.), px(50.)].get(j).copied();
        assert_eq!(push_up(&items, 5, px(10.), p, h), px(20.));
        assert_eq!(push_up(&items, 4, px(0.), p, h), px(0.)); // 30 + 30 = 60px down: clear
        assert_eq!(push_up(&items, 5, px(30.), p, h), p); // it reached the top: pin fully off
        assert_eq!(push_up(&items, 5, px(10.), p, |_| None), px(0.));
    }

    #[test]
    fn text_helpers() {
        assert_eq!(find_urls("see https://x.com/a. and (http://y.io/b)").iter().map(|u| u.1.as_str()).collect::<Vec<_>>(), [
            "https://x.com/a",
            "http://y.io/b"
        ]);
        let s = "a https://z.dev/q?x=1, b";
        let u = &find_urls(s)[0];
        assert_eq!(&s[u.0.clone()], "https://z.dev/q?x=1");
        assert!(is_blank("\n---\n  ***\n") && !is_blank("--- x"));
        assert_eq!(strip_rules("a\n\n---\n\nb\n```\n---\n```\nTitle\n---\n"), "a\n\n\nb\n```\n---\n```\nTitle\n---\n");
        assert_eq!(describe_input(&serde_json::json!({ "command": "ls" })), "ls");
        assert_eq!(tool_preview("```\n\n  first\nsecond"), "first");
        let recent = &FOREST_WORDS[..7];
        let mut n = 0;
        assert!(!recent.contains(&next_forest_word(recent, || {
            n += 1;
            n
        })));
    }
}

/// The working-indicator pine, as in the Electron app (16px).
const TREE_PX: f32 = 16.;

/// The pine swaying in the wind — the Electron app's `treeSway` keyframes: an
/// ease-in-out back-and-forth between -8° at 95% scale and +8° at full size,
/// pivoting at the base of the trunk (transform-origin 50% 96%). `t` is the
/// 0..1 position in the cycle.
fn tree_sway(t: f32) -> Transformation {
    let phase = (1. - (t * std::f32::consts::TAU).cos()) / 2.; // 0 → 1 → 0, eased
    let angle = (-8. + 16. * phase).to_radians();
    let scale = 0.95 + 0.05 * phase;
    // GPUI rotates/scales about the centre; shift so the pivot is the trunk's base.
    let dy = (0.96 - 0.5) * TREE_PX;
    let (sin, cos) = angle.sin_cos();
    Transformation::rotate(radians(angle))
        .with_scaling(size(scale, scale))
        .with_translation(point(px(sin * scale * dy), px(dy - cos * scale * dy)))
}

