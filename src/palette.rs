//! The quick-jump palettes (the Electron app's CommandPalette / FilePalette):
//! ⌘T / ⌘K — any worktree or project; ⌘P — any file (or changed file's diff) in
//! the current worktree. Type to filter, ↑/↓ to move, ↩ to open, Esc to close.

use gpui_kit::component::input::{Input, InputEvent, InputState};
use gpui_kit::component::*;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::sidebar::icon;
use crate::theme;

#[derive(Clone)]
pub enum Item {
    Worktree { id: String, label: String, note: Option<String>, project: String },
    Project { id: String, name: String },
    File { path: String, ignored: bool },
    /// A changed file's diff: uncommitted (base None) or vs the branch's base.
    Diff { path: String, base: Option<String> },
}

impl Item {
    fn label(&self) -> &str {
        match self {
            Item::Worktree { label, .. } => label,
            Item::Project { name, .. } => name,
            Item::File { path, .. } | Item::Diff { path, .. } => path,
        }
    }
}

pub enum PaletteEvent {
    Pick(Item),
    Dismiss,
}

impl EventEmitter<PaletteEvent> for Palette {}

pub struct Palette {
    files: bool,
    items: Option<Vec<Item>>,
    input: Entity<InputState>,
    sel: usize,
    /// ⌘P: rank of each recently opened file (0 = newest).
    recent: std::collections::HashMap<String, usize>,
    scroll: ScrollHandle,
    _sub: Subscription,
}

impl Palette {
    /// `items` is None while it's still loading (set it with `set_items`).
    pub fn new(files: bool, items: Option<Vec<Item>>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let placeholder = if files { "Open a file…" } else { "Jump to a worktree or project…" };
        let input = cx.new(|cx| InputState::new(window, cx).placeholder(placeholder));
        input.update(cx, |s, cx| s.focus(window, cx));
        let sub = cx.subscribe(&input, |this: &mut Self, _, ev: &InputEvent, cx| match ev {
            InputEvent::Change => {
                this.sel = 0;
                cx.notify();
            }
            InputEvent::PressEnter { .. } => this.activate(this.sel, cx),
            _ => {}
        });
        Self { files, items, input, sel: 0, recent: Default::default(), scroll: ScrollHandle::new(), _sub: sub }
    }

    pub fn set_items(&mut self, items: Vec<Item>, cx: &mut Context<Self>) {
        self.items = Some(items);
        cx.notify();
    }

    /// Recently opened files (newest first) rank ahead of the rest.
    pub fn set_recent(&mut self, recent: &[String]) {
        self.recent = recent.iter().enumerate().map(|(i, p)| (p.clone(), i)).collect();
    }

    fn results(&self, cx: &App) -> Vec<Item> {
        let items = self.items.as_deref().unwrap_or_default();
        let q = self.input.read(cx).value().trim().to_lowercase();
        if self.files {
            return rank_files(items, &q, &self.recent, 60);
        }
        let limit = 50;
        if q.is_empty() {
            return items.iter().take(limit).cloned().collect();
        }
        let mut scored: Vec<(u8, usize, usize, &Item)> = items
            .iter()
            .enumerate()
            .filter_map(|(idx, it)| {
                // Label prefix, then label/branch anywhere, then project-only.
                let (label, note, sub) = match it {
                    Item::Worktree { label, note, project, .. } => (label.to_lowercase(), note.clone().unwrap_or_default().to_lowercase(), project.to_lowercase()),
                    Item::Project { name, .. } => (name.to_lowercase(), String::new(), "project".into()),
                    _ => return None,
                };
                let at = format!("{label} {note} {sub}").find(&q)?;
                let rank = if label.starts_with(&q) { 0 } else if label.contains(&q) || note.contains(&q) { 1 } else { 2 };
                Some((rank, at, idx, it))
            })
            .collect();
        scored.sort_by_key(|(rank, at, idx, _)| (*rank, *at, *idx));
        scored.into_iter().take(limit).map(|s| s.3.clone()).collect()
    }

    fn activate(&mut self, i: usize, cx: &mut Context<Self>) {
        if let Some(it) = self.results(cx).get(i).cloned() {
            cx.emit(PaletteEvent::Pick(it));
        }
    }

    fn on_key(&mut self, ev: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        let n = self.results(cx).len();
        match ev.keystroke.key.as_str() {
            "down" => self.sel = (self.sel + 1).min(n.saturating_sub(1)),
            "up" => self.sel = self.sel.saturating_sub(1),
            "escape" => cx.emit(PaletteEvent::Dismiss),
            _ => return,
        }
        self.scroll.scroll_to_item(self.sel);
        cx.stop_propagation();
        cx.notify();
    }
}

/// ⌘P ordering (FilePalette.tsx): no query → recent files first, then list order
/// (a file's diff entry stays after it); a query → file-name matches, then
/// recency, then match position.
fn rank_files(items: &[Item], q: &str, recent: &std::collections::HashMap<String, usize>, limit: usize) -> Vec<Item> {
    let rec = |it: &Item| recent.get(it.label()).copied().unwrap_or(usize::MAX);
    let mut scored: Vec<(u8, usize, usize, usize, &Item)> = items
        .iter()
        .enumerate()
        .filter_map(|(idx, it)| {
            if q.is_empty() {
                return Some((0, rec(it), 0, idx, it));
            }
            let path = it.label().to_lowercase();
            let at = path.find(q)?;
            let name = path.rsplit('/').next().unwrap_or(&path);
            Some((if name.contains(q) { 0 } else { 1 }, rec(it), at, idx, it))
        })
        .collect();
    scored.sort_by_key(|s| (s.0, s.1, s.2, s.3));
    scored.into_iter().take(limit).map(|s| s.4.clone()).collect()
}

impl Render for Palette {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().colors;
        let x = theme::extra(cx);
        let mono = cx.theme().mono_font_family.clone();
        let results = self.results(cx);
        let sel = self.sel.min(results.len().saturating_sub(1));
        div()
            .id("palette")
            .w(px(560.))
            .flex()
            .flex_col()
            .p_3()
            .rounded(px(10.))
            .border_1()
            .border_color(theme.border)
            .bg(theme.popover)
            .shadow_xl()
            // Capture arrows/Esc before the text input handles them.
            .capture_key_down(cx.listener(Self::on_key))
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .child(Input::new(&self.input).appearance(false).text_size(px(16.)))
            .child(div().h(px(1.)).mt_2().bg(theme.border))
            .child(
                div()
                    .id("palette-results")
                    .flex()
                    .flex_col()
                    .gap(px(1.))
                    .mt_2()
                    .max_h(px(440.))
                    .overflow_y_scroll()
                    .track_scroll(&self.scroll)
                    .when(results.is_empty(), |d| {
                        d.child(div().px_2().py_4().text_size(px(13.)).text_color(x.faint).child(if self.items.is_none() {
                            "Loading…"
                        } else {
                            "No matches"
                        }))
                    })
                    .children(results.into_iter().enumerate().map(|(i, it)| {
                        let (glyph, label, note, sub) = match &it {
                            Item::Worktree { label, note, project, .. } => ("fr/git-branch.svg", label.clone(), note.clone(), project.clone()),
                            Item::Project { name, .. } => ("fr/folder.svg", name.clone(), None, "project".into()),
                            Item::File { path, ignored } => {
                                ("fr/file.svg", path.clone(), None, if *ignored { "ignored".into() } else { String::new() })
                            }
                            Item::Diff { path, base } => (
                                "fr/git-branch.svg",
                                path.clone(),
                                None,
                                match base {
                                    None => "diff · uncommitted".into(),
                                    Some(b) => format!("diff vs {b}"),
                                },
                            ),
                        };
                        div()
                            .id(("pal", i))
                            .flex()
                            .items_center()
                            .gap(px(9.))
                            .px(px(10.))
                            .py(px(8.))
                            .rounded(px(6.))
                            .cursor_pointer()
                            .when(i == sel, |d| d.bg(x.active))
                            .on_hover(cx.listener(move |this, hovered: &bool, _, cx| {
                                if *hovered && this.sel != i {
                                    this.sel = i;
                                    cx.notify();
                                }
                            }))
                            .on_click(cx.listener(move |this, _, _, cx| this.activate(i, cx)))
                            .child(icon(glyph, 14., x.faint))
                            .child(
                                div()
                                    .flex()
                                    .min_w_0()
                                    .gap_1()
                                    .font_family(mono.clone())
                                    .text_size(px(13.))
                                    .child(div().truncate().child(label))
                                    .when_some(note, |d, n| d.child(div().flex_shrink_0().text_color(x.faint).child(format!("({n})")))),
                            )
                            .child(div().flex_1())
                            .child(div().flex_shrink_0().max_w(px(260.)).truncate().text_size(px(12.)).text_color(x.faint).child(sub))
                    })),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::{Item, rank_files};

    #[test]
    fn recent_files_first() {
        let file = |p: &str| Item::File { path: p.into(), ignored: false };
        let items = vec![file("a/main.rs"), Item::Diff { path: "a/main.rs".into(), base: None }, file("b/lib.rs"), file("c/main.txt")];
        let recent = [("c/main.txt".to_string(), 0)].into_iter().collect();
        let labels = |v: Vec<Item>| v.iter().map(|i| i.label().to_string()).collect::<Vec<_>>();
        assert_eq!(labels(rank_files(&items, "", &recent, 60)), ["c/main.txt", "a/main.rs", "a/main.rs", "b/lib.rs"]);
        assert_eq!(labels(rank_files(&items, "main", &recent, 60)), ["c/main.txt", "a/main.rs", "a/main.rs"]);
        assert_eq!(labels(rank_files(&items, "a/", &recent, 60)), ["a/main.rs", "a/main.rs"]);
    }
}
