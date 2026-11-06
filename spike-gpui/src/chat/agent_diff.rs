//! Inline preview of an agent's file edit (AgentDiff.tsx): a line diff per file,
//! unchanged runs collapsed to ⋯, with "View diff" for the full side-by-side.

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::*;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use super::{ChatEvent, ChatView};
use crate::theme;

#[derive(Clone, Copy, PartialEq, Debug)]
pub(super) enum Kind {
    Ctx,
    Add,
    Del,
}

/// One edited file, diffed once when the event arrives.
pub(super) struct FileDiff {
    pub path: String,
    pub old: String,
    pub new: String,
    /// The collapsed preview: `None` marks a run of hidden context.
    lines: Vec<Option<(Kind, String)>>,
    add: usize,
    del: usize,
}

impl FileDiff {
    pub fn new(path: String, old: String, new: String) -> Self {
        let all = line_diff(&old, &new);
        let add = all.iter().filter(|l| l.0 == Kind::Add).count();
        let del = all.iter().filter(|l| l.0 == Kind::Del).count();
        let lines = collapse_context(all, 3);
        Self { path, old, new, lines, add, del }
    }
}

// ponytail: O(m·n) LCS, capped like the Electron one; swap for Myers if it bites.
const MAX_CELLS: usize = 2_000_000;

fn split(s: &str) -> Vec<&str> {
    if s.is_empty() { vec![] } else { s.split('\n').collect() }
}

pub(super) fn line_diff(old: &str, new: &str) -> Vec<(Kind, String)> {
    let (a, b) = (split(old), split(new));
    let (m, n) = (a.len(), b.len());
    if m * n > MAX_CELLS {
        return a.iter().map(|t| (Kind::Del, t.to_string())).chain(b.iter().map(|t| (Kind::Add, t.to_string()))).collect();
    }
    // dp[i][j] = LCS length of a[i..] and b[j..], flattened.
    let w = n + 1;
    let mut dp = vec![0u32; (m + 1) * w];
    for i in (0..m).rev() {
        for j in (0..n).rev() {
            dp[i * w + j] = if a[i] == b[j] { dp[(i + 1) * w + j + 1] + 1 } else { dp[(i + 1) * w + j].max(dp[i * w + j + 1]) };
        }
    }
    let (mut out, mut i, mut j) = (vec![], 0, 0);
    while i < m && j < n {
        if a[i] == b[j] {
            out.push((Kind::Ctx, a[i].to_string()));
            i += 1;
            j += 1;
        } else if dp[(i + 1) * w + j] >= dp[i * w + j + 1] {
            out.push((Kind::Del, a[i].to_string()));
            i += 1;
        } else {
            out.push((Kind::Add, b[j].to_string()));
            j += 1;
        }
    }
    out.extend(a[i..].iter().map(|t| (Kind::Del, t.to_string())));
    out.extend(b[j..].iter().map(|t| (Kind::Add, t.to_string())));
    out
}

/// Keep `pad` context lines around each change; each other run becomes one `None`.
pub(super) fn collapse_context(lines: Vec<(Kind, String)>, pad: usize) -> Vec<Option<(Kind, String)>> {
    let mut keep = vec![false; lines.len()];
    for (i, l) in lines.iter().enumerate() {
        if l.0 != Kind::Ctx {
            let hi = (i + pad).min(lines.len() - 1);
            keep[i.saturating_sub(pad)..=hi].iter_mut().for_each(|k| *k = true);
        }
    }
    let mut out = vec![];
    for (l, k) in lines.into_iter().zip(keep) {
        if k {
            out.push(Some(l));
        } else if out.last().is_none_or(|o: &Option<_>| o.is_some()) {
            out.push(None);
        }
    }
    out
}

impl ChatView {
    pub(super) fn render_diffs(&self, row: usize, diffs: &[FileDiff], view: &Entity<ChatView>, cx: &App) -> Div {
        let theme = cx.theme().colors;
        let x = theme::extra(cx);
        let mono = cx.theme().mono_font_family.clone();
        div().flex().flex_col().gap_2().children(diffs.iter().enumerate().map(|(i, d)| {
            let name = d.path.rsplit('/').next().unwrap_or(&d.path).to_string();
            let (view, path, old, new) = (view.clone(), d.path.clone(), d.old.clone(), d.new.clone());
            div()
                .flex()
                .flex_col()
                .overflow_hidden()
                .when(i > 0, |d| d.pt_2().border_t_1().border_color(theme.border))
                .child(
                    div()
                        .flex()
                        .items_center()
                        .gap_2()
                        .pb(px(5.))
                        .mb_1()
                        .border_b_1()
                        .border_color(theme.border)
                        .child(div().min_w_0().truncate().font_family(mono.clone()).text_size(px(12.)).text_color(theme.foreground).child(name))
                        .child(
                            div()
                                .flex()
                                .gap_1p5()
                                .text_size(px(11.5))
                                .font_family(mono.clone())
                                .when(d.add > 0, |s| s.child(div().text_color(x.green).child(format!("+{}", d.add))))
                                .when(d.del > 0, |s| s.child(div().text_color(theme.danger).child(format!("−{}", d.del)))),
                        )
                        .child(div().flex_1())
                        .child(Button::new(("view-diff", row * 64 + i)).small().ghost().label("View diff").on_click(move |_, _, cx| {
                            let ev = ChatEvent::OpenDiff { path: path.clone(), old: old.clone(), new: new.clone() };
                            view.update(cx, |_, cx| cx.emit(ev));
                        })),
                )
                .child(div().flex().flex_col().font_family(mono.clone()).text_size(px(12.)).children(d.lines.iter().map(|l| match l {
                    None => div().text_center().text_color(x.faint).child("⋯"),
                    Some((kind, text)) => {
                        let (sign, fg, bg) = match kind {
                            Kind::Add => ("+", x.green, x.green.opacity(0.12)),
                            Kind::Del => ("−", theme.danger, theme.danger.opacity(0.12)),
                            Kind::Ctx => (" ", theme.muted_foreground, transparent_black()),
                        };
                        div()
                            .flex()
                            .bg(bg)
                            .text_color(fg)
                            .child(div().w(px(16.)).flex_shrink_0().text_center().child(sign))
                            .child(div().min_w_0().whitespace_normal().child(if text.is_empty() { " ".to_string() } else { text.clone() }))
                    }
                })))
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::{FileDiff, Kind, collapse_context, line_diff};

    #[test]
    fn diffs_and_collapses() {
        let d = line_diff("a\nb\nc", "a\nB\nc");
        assert_eq!(d.iter().map(|l| l.0).collect::<Vec<_>>(), [Kind::Ctx, Kind::Del, Kind::Add, Kind::Ctx]);
        assert_eq!(line_diff("", "x").len(), 1);

        let old: String = (0..20).map(|i| format!("{i}\n")).collect();
        let new = old.replace("10\n", "ten\n");
        let c = collapse_context(line_diff(&old, &new), 3);
        // gap, 7..9, -10, +ten, 11..13, gap
        assert!(c[0].is_none() && c.last().unwrap().is_none());
        assert_eq!(c.iter().filter(|l| l.is_some()).count(), 8);
        let f = FileDiff::new("p".into(), old, new);
        assert_eq!((f.add, f.del), (1, 1));
    }
}
