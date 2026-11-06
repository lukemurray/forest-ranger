//! Start fresh: a new chat in this worktree, optionally carrying the last few
//! messages over as its first message — and the banner offering it when a big
//! chat is reopened after its prompt cache went cold.

use std::sync::Mutex;

use gpui_kit::component::button::{Button, ButtonVariants as _};
use gpui_kit::component::menu::{DropdownMenu as _, PopupMenu, PopupMenuItem};
use gpui_kit::component::*;
use gpui_kit::*;
use serde_json::Value;

use super::{ChatEvent, ChatView, Row};
use crate::log::{ChatLog, now_ms};
use crate::theme;

/// Context size past which every message re-sends a lot.
pub(super) const BIG_CONTEXT: f64 = 150_000.;
/// After this long idle the prompt cache is gone.
const CACHE_COLD_MS: i64 = 60 * 60 * 1000;

/// Fresh chats not yet opened as tabs: the log (not on disk while empty) and
/// the carry-over prompt to send once it opens.
static PENDING: Mutex<Vec<(ChatLog, Option<String>)>> = Mutex::new(Vec::new());

pub(super) fn take(id: &str) -> Option<(ChatLog, Option<String>)> {
    let mut p = PENDING.lock().unwrap();
    let i = p.iter().position(|(l, _)| l.id == id)?;
    Some(p.remove(i))
}

/// First message of a fresh chat carrying recent messages over (prose only, capped).
pub(super) fn carry_over_prompt(msgs: &[(bool, &str)]) -> String {
    const MAX_EACH: usize = 2000;
    const MAX_TOTAL: usize = 12_000;
    let clip = |t: &str| {
        let t = t.trim();
        if t.chars().count() > MAX_EACH { format!("{}…", t.chars().take(MAX_EACH).collect::<String>()) } else { t.to_string() }
    };
    let mut body = msgs.iter().map(|(user, t)| format!("{}: {}", if *user { "Me" } else { "You" }, clip(t))).collect::<Vec<_>>().join("\n\n");
    let n = body.chars().count();
    if n > MAX_TOTAL {
        body = format!("…{}", body.chars().skip(n - MAX_TOTAL).collect::<String>());
    }
    format!(
        "Carrying over the last {} messages from an earlier chat in this worktree, for context:\n\n---\n{body}\n---\n\nTreat this as background. Reply with one short line saying you're ready, then wait for my next message.",
        msgs.len()
    )
}

/// A big chat whose last activity was over an hour ago.
pub(super) fn cold(events: &[Value], now: i64) -> bool {
    let big = events.iter().rev().find(|e| e["type"] == "usage").and_then(|u| u["used"].as_f64()).is_some_and(|u| u >= BIG_CONTEXT);
    let last = events.iter().filter_map(|e| e["ts"].as_i64()).max();
    big && last.is_some_and(|t| now - t > CACHE_COLD_MS)
}

/// The Start fresh choices, as menu items.
pub(super) fn menu_items(menu: PopupMenu, view: &Entity<ChatView>) -> PopupMenu {
    let item = |label: String, n: usize| {
        let v = view.clone();
        PopupMenuItem::new(label).on_click(move |_, _, cx| v.update(cx, |c, cx| c.start_fresh(n, cx)))
    };
    [3, 5, 10]
        .into_iter()
        .fold(menu.item(item("Start fresh — empty chat".into(), 0)), |m, n| m.item(item(format!("Start fresh with the last {n} messages"), n)))
}

impl ChatView {
    pub(super) fn start_fresh(&mut self, last_n: usize, cx: &mut Context<Self>) {
        self.fresh_banner = false;
        let recent: Vec<(bool, &str)> = self
            .rows
            .rows
            .iter()
            .filter(|r| !super::transcript::hidden(r))
            .filter_map(|r| match r {
                Row::User { text, .. } => Some((true, text.as_str())),
                Row::Assistant { text, .. } => Some((false, text.as_str())),
                _ => None,
            })
            .collect();
        let recent = &recent[recent.len().saturating_sub(last_n)..];
        let prompt = (last_n > 0 && !recent.is_empty()).then(|| carry_over_prompt(recent));
        let src = &self.log;
        let mut log = ChatLog::new(
            uuid::Uuid::new_v4().to_string(),
            src.worktree_id.clone().unwrap_or_default(),
            src.project_id.clone().unwrap_or_default(),
            src.provider.clone(),
        );
        log.model = src.model.clone();
        let log_id = log.id.clone();
        PENDING.lock().unwrap().push((log, prompt));
        cx.emit(ChatEvent::Branched { log_id });
        cx.notify();
    }

    /// "This chat is Nk tokens and was last used X ago…" with Start fresh ▾ / Continue here.
    pub(super) fn render_fresh_banner(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        if !self.fresh_banner {
            return None;
        }
        let used = self.log.last("usage")?["used"].as_f64()?;
        let last = self.log.events.iter().filter_map(|e| e["ts"].as_i64()).max().unwrap_or_else(now_ms);
        let theme = cx.theme().colors;
        let x = theme::extra(cx);
        let view = cx.entity();
        Some(
            div()
                .flex()
                .flex_wrap()
                .items_center()
                .gap_2()
                .mx(px(12.))
                .mb_1()
                .px_3()
                .py_2()
                .rounded_md()
                .border_1()
                .border_color(x.amber.opacity(0.5))
                .text_size(px(12.5))
                .text_color(theme.muted_foreground)
                .child(div().flex_1().min_w(px(200.)).whitespace_normal().child(format!(
                    "This chat is {} tokens and was last used {} — continuing re-reads all of it.",
                    super::fmt_tokens(used),
                    crate::data::relative_time(last)
                )))
                .child(
                    Button::new("fresh-banner")
                        .outline()
                        .label("Start fresh ▾")
                        .dropdown_menu_with_anchor(Anchor::BottomRight, move |menu, _, _| menu_items(menu, &view)),
                )
                .child(Button::new("fresh-dismiss").ghost().label("Continue here").on_click(cx.listener(|this, _, _, cx| {
                    this.fresh_banner = false;
                    cx.notify();
                })))
                .into_any_element(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::{CACHE_COLD_MS, carry_over_prompt, cold};
    use serde_json::json;

    #[test]
    fn carry_over_caps() {
        let p = carry_over_prompt(&[(true, " hi "), (false, "yo")]);
        assert!(p.starts_with("Carrying over the last 2 messages"));
        assert!(p.contains("---\nMe: hi\n\nYou: yo\n---"));
        let long = "x".repeat(5000);
        let p = carry_over_prompt(&[(true, long.as_str()); 10]);
        assert!(p.contains(&format!("Me: {}…", "x".repeat(2000))));
        assert!(p.contains("---\n…"));
    }

    #[test]
    fn cold_big_chats() {
        let now = 10 * CACHE_COLD_MS;
        let ev = |used: i64, ts: i64| vec![json!({ "type": "usage", "used": used, "ts": ts })];
        assert!(cold(&ev(200_000, now - CACHE_COLD_MS - 1), now));
        assert!(!cold(&ev(200_000, now - 1000), now));
        assert!(!cold(&ev(1000, 0), now));
    }
}
