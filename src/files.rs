//! A file editor tab (the Electron app's Monaco FileEditor): the kit's code
//! editor with tree-sitter highlighting, ⌘S / Save button, a dirty dot on the tab,
//! and the cursor + scroll remembered per file.

use std::collections::VecDeque;
use std::sync::Mutex;

use gpui_kit::component::button::Button;
use gpui_kit::component::input::{Editor, EditorState, InputEvent, Position};
use gpui_kit::component::*;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::git;

actions!(file_view, [Save]);

pub enum FileEvent {
    /// The first edit after a clean state (pins a preview tab).
    Edited,
    Saved,
}

impl EventEmitter<FileEvent> for FileView {}

pub struct FileView {
    pub rel: String,
    root: String,
    /// None when the file couldn't be read as text: then there's nothing to save,
    /// so saving can't overwrite a binary file with an empty buffer.
    editor: Option<Entity<EditorState>>,
    pub dirty: bool,
    saving: bool,
    /// Bumped on every edit; a save only clears `dirty` if nothing changed meanwhile.
    version: u64,
    error: Option<String>,
    unreadable: Option<String>,
    _subs: Vec<Subscription>,
}

/// Fill in grammars the kit links without highlight rules (C# parses but has an
/// empty query there, so nothing is coloured). Call once, after the kit's init.
pub fn register_grammars() {
    use gpui_kit::component::highlighter::{GrammarConfig, LanguageRegistry};
    let cs = GrammarConfig::new("csharp", tree_sitter_c_sharp::LANGUAGE.into(), vec![], tree_sitter_c_sharp::HIGHLIGHTS_QUERY, "", "");
    LanguageRegistry::singleton().register("csharp", &cs);
}

/// Language for highlighting: well-known file names, then aliases, then the extension.
pub fn language_for(rel: &str) -> String {
    let name = rel.rsplit('/').next().unwrap_or(rel).to_lowercase();
    let by_name = match name.as_str() {
        "makefile" | "gnumakefile" => Some("make"),
        "dockerfile" | "containerfile" => Some("dockerfile"),
        "cmakelists.txt" => Some("cmake"),
        "gemfile" | "rakefile" | "podfile" | "brewfile" => Some("ruby"),
        "cargo.lock" | "pipfile" => Some("toml"),
        ".bashrc" | ".zshrc" | ".profile" | ".bash_profile" => Some("bash"),
        _ => None,
    };
    if let Some(l) = by_name {
        return l.into();
    }
    let ext = name.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
    match ext {
        "" => "text",
        "vue" => "html",
        // XML: no grammar of its own; HTML's reads it well.
        "svg" | "xml" | "plist" | "csproj" | "fsproj" | "vbproj" | "props" | "targets" | "resx" | "nuspec" => "html",
        // C headers too: the C++ grammar covers C.
        "c" | "h" | "hpp" | "hh" | "hxx" | "cc" | "cxx" | "ino" => "cpp",
        "mdx" | "mdc" => "markdown",
        "jsonc" | "json5" => "json",
        "tf" | "tfvars" => "hcl",
        "mjs" | "cjs" | "jsx" => "javascript",
        "mts" | "cts" => "typescript",
        "zsh" => "bash",
        e => e,
    }
    .into()
}

/// Cursor (line, column) and scroll offset per file, so a reopened file lands
/// where you left it. ponytail: 200-entry LRU behind a global lock (as monaco.ts).
static VIEW_STATES: Mutex<VecDeque<(String, (u32, u32, f32, f32))>> = Mutex::new(VecDeque::new());
const VIEW_STATE_CAP: usize = 200;

fn save_view_state(key: String, s: (u32, u32, f32, f32)) {
    let mut m = VIEW_STATES.lock().unwrap();
    m.retain(|(k, _)| *k != key);
    m.push_back((key, s));
    if m.len() > VIEW_STATE_CAP {
        m.pop_front();
    }
}

fn view_state(key: &str) -> Option<(u32, u32, f32, f32)> {
    VIEW_STATES.lock().unwrap().iter().find(|(k, _)| k == key).map(|(_, s)| *s)
}

impl FileView {
    pub fn new(root: &str, rel: &str, line: Option<u32>, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut this = Self {
            rel: rel.to_string(),
            root: root.to_string(),
            editor: None,
            dirty: false,
            saving: false,
            version: 0,
            error: None,
            unreadable: None,
            _subs: vec![],
        };
        let text = match git::read_file(root, rel) {
            Ok(t) => t,
            Err(e) => {
                this.unreadable = Some(e);
                return this;
            }
        };
        let lang = language_for(rel);
        let editor = cx.new(|cx| {
            let mut s = EditorState::new(window, cx).language(lang).line_number(true).searchable(true);
            s.set_value(text, window, cx);
            s
        });
        let key = format!("{root}\0{rel}");
        match (line, view_state(&key)) {
            (Some(line), _) => editor.update(cx, |s, cx| s.set_cursor_position(Position::new(line.saturating_sub(1), 0), window, cx)),
            (None, Some((l, c, x, y))) => editor.update(cx, |s, cx| {
                s.set_cursor_position(Position::new(l, c), window, cx);
                s.set_scroll_offset(point(px(x), px(y)), cx);
            }),
            _ => {}
        }
        this._subs.push(cx.subscribe(&editor, |this: &mut Self, _, ev: &InputEvent, cx| {
            if matches!(ev, InputEvent::Change) {
                this.version += 1;
                if !this.dirty {
                    this.dirty = true;
                    cx.emit(FileEvent::Edited);
                    cx.notify();
                }
            }
        }));
        this._subs.push(cx.on_release(move |this: &mut Self, cx| {
            if let Some(ed) = &this.editor {
                let ed = ed.read(cx);
                let (p, o) = (ed.cursor_position(), ed.scroll_offset());
                save_view_state(key.clone(), (p.line, p.character, o.x.into(), o.y.into()));
            }
        }));
        this.editor = Some(editor);
        this
    }

    pub fn title(&self) -> String {
        let name = std::path::Path::new(&self.rel).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        if self.dirty { format!("{name} ●") } else { name }
    }

    pub fn is_dirty(&self) -> bool {
        self.dirty
    }

    /// Move the cursor to a 1-based line and scroll it into view.
    pub fn goto_line(&mut self, line: u32, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(ed) = &self.editor {
            ed.update(cx, |s, cx| s.set_cursor_position(Position::new(line.saturating_sub(1), 0), window, cx));
        }
    }

    pub fn save(&mut self, cx: &mut Context<Self>) {
        let Some(ed) = &self.editor else { return };
        if self.saving || !self.dirty {
            return;
        }
        let text = ed.read(cx).value().to_string();
        let (root, rel, version) = (self.root.clone(), self.rel.clone(), self.version);
        self.saving = true;
        cx.notify();
        let work = cx.background_executor().spawn(async move { git::write_file(&root, &rel, &text) });
        cx.spawn(async move |this, cx| {
            let res = work.await;
            let _ = this.update(cx, |this, cx| {
                this.saving = false;
                match res {
                    Ok(()) => {
                        this.error = None;
                        this.dirty = this.version != version;
                        cx.emit(FileEvent::Saved);
                    }
                    Err(e) => this.error = Some(e),
                }
                cx.notify();
            });
        })
        .detach();
    }
}

impl Render for FileView {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().colors;
        div()
            .flex()
            .flex_col()
            .size_full()
            .key_context("FileView")
            .on_action(cx.listener(|this, _: &Save, _, cx| this.save(cx)))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_2()
                    .px_3()
                    .py_1()
                    .text_xs()
                    .text_color(theme.muted_foreground)
                    .border_b_1()
                    .border_color(theme.border)
                    .child(div().flex_1().min_w_0().truncate().child(self.rel.clone()))
                    .children(self.error.clone().map(|e| div().text_color(theme.danger).child(e)))
                    .when(self.editor.is_some(), |d| {
                        d.child(
                            Button::new("save")
                                .small()
                                .outline()
                                .label(if self.saving { "Saving…" } else { "Save" })
                                .disabled(!self.dirty || self.saving)
                                .on_click(cx.listener(|this, _, _, cx| this.save(cx))),
                        )
                    }),
            )
            .child(div().flex_1().min_h_0().child(match (&self.editor, &self.unreadable) {
                (Some(ed), _) => div().size_full().child(Editor::new(ed).h_full().bordered(false)),
                (None, why) => div()
                    .size_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .text_sm()
                    .text_color(theme.muted_foreground)
                    .child(match why.as_deref() {
                        Some("binary file") | None => "Binary file — can't edit as text.".to_string(),
                        Some(e) => format!("Can't open this file: {e}"),
                    }),
            }))
    }
}

#[cfg(test)]
mod tests {
    use super::{VIEW_STATE_CAP, language_for, save_view_state, view_state};

    #[test]
    fn languages() {
        assert_eq!(language_for("src/Makefile"), "make");
        assert_eq!(language_for("Dockerfile"), "dockerfile");
        assert_eq!(language_for("a/b.mdx"), "markdown");
        assert_eq!(language_for("x.tfvars"), "hcl");
        assert_eq!(language_for("x.rs"), "rs");
        assert_eq!(language_for("App/App.csproj"), "html");
        assert_eq!(language_for("Directory.Build.props"), "html");
        assert_eq!(language_for("src/a.h"), "cpp");
        assert_eq!(language_for("src/a.cpp"), "cpp");
        assert_eq!(language_for("LICENSE"), "text");
    }

    #[test]
    fn view_state_lru() {
        for i in 0..(VIEW_STATE_CAP + 5) {
            save_view_state(format!("lru-{i}"), (i as u32, 0, 0., 0.));
        }
        assert!(view_state("lru-0").is_none());
        assert_eq!(view_state(&format!("lru-{}", VIEW_STATE_CAP + 4)).map(|s| s.0), Some(VIEW_STATE_CAP as u32 + 4));
    }
}

#[cfg(test)]
mod highlight_tests {
    use gpui_kit::component::Rope;
    use gpui_kit::component::highlighter::{HighlightTheme, SyntaxHighlighter};

    /// Coloured spans for `code` highlighted as `lang`.
    fn coloured(lang: &str, code: &str) -> usize {
        super::register_grammars();
        let mut h = SyntaxHighlighter::new(lang);
        h.update(None, &Rope::from(code), None);
        h.styles(&(0..code.len()), &*HighlightTheme::default_light()).iter().filter(|(_, s)| s.color.is_some()).count()
    }

    #[test]
    fn csharp_is_coloured() {
        assert!(coloured(&super::language_for("A.cs"), "namespace A { public class B { public int C(string d) => 1; } }") > 3);
    }
}
