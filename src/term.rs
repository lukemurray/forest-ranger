//! The in-app terminal tab: your login shell (or a run command) on a PTY,
//! emulated by alacritty_terminal and drawn cell by cell on a canvas.

use std::borrow::Cow;
use std::cell::Cell;
use std::collections::HashMap;
use std::ops::Range;
use std::rc::Rc;
use std::sync::Arc;

use alacritty_terminal::event::{Event as TermEvent, EventListener, Notify as _, WindowSize};
use alacritty_terminal::event_loop::{EventLoop, Msg, Notifier};
use alacritty_terminal::grid::{Dimensions, Scroll};
use alacritty_terminal::index::{Column, Line, Point as GridPoint, Side};
use alacritty_terminal::selection::{Selection, SelectionType};
use alacritty_terminal::sync::FairMutex;
use alacritty_terminal::term::cell::Flags;
use alacritty_terminal::term::color::Colors;
use alacritty_terminal::term::{Config, Term, TermMode};
use alacritty_terminal::tty;
use alacritty_terminal::vte::ansi::{Color, CursorShape, NamedColor, Rgb};
use gpui_kit::component::*;
use gpui_kit::*;

const FONT_SIZE: f32 = 13.;
const PAD: f32 = 8.;

#[derive(Clone)]
struct Listener(async_channel::Sender<TermEvent>);

impl EventListener for Listener {
    fn send_event(&self, e: TermEvent) {
        let _ = self.0.try_send(e);
    }
}

#[derive(Clone, Copy, PartialEq)]
struct GridSize {
    cols: usize,
    rows: usize,
}

impl Dimensions for GridSize {
    fn total_lines(&self) -> usize {
        self.rows
    }
    fn screen_lines(&self) -> usize {
        self.rows
    }
    fn columns(&self) -> usize {
        self.cols
    }
}

/// Where the grid was last drawn: its top-left and one cell's size.
#[derive(Clone, Copy)]
struct Geometry {
    origin: Point<Pixels>,
    cell: gpui_kit::Size<Pixels>,
}

/// Its title changed or its process exited: the tab strip should redraw.
pub struct TermChanged;

pub struct TerminalView {
    pub id: String,
    label: Option<String>,
    shell_title: Option<String>,
    term: Arc<FairMutex<Term<Listener>>>,
    notifier: Notifier,
    exited: Option<Option<i32>>,
    focus: FocusHandle,
    geometry: Rc<Cell<Option<Geometry>>>,
    window_size: Rc<Cell<WindowSize>>,
    selecting: bool,
    /// The button held down while reporting the mouse to the program, and the
    /// last cell reported (motion is sent once per cell).
    mouse_button: Option<u8>,
    mouse_cell: Option<(usize, usize)>,
    /// Text being composed by the input method (dead keys, CJK…), drawn at the cursor.
    marked: Option<String>,
    /// Where the cursor was last drawn, for the input method's candidate window.
    cursor_bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
    scroll_px: f32,
    _events: Task<()>,
}

impl EventEmitter<TermChanged> for TerminalView {}

impl Focusable for TerminalView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl Drop for TerminalView {
    fn drop(&mut self) {
        // The loop exits and drops the PTY, which hangs up the shell.
        let _ = self.notifier.0.send(Msg::Shutdown);
    }
}

/// A started shell, before it has a view.
pub struct Session {
    label: Option<String>,
    term: Arc<FairMutex<Term<Listener>>>,
    notifier: Notifier,
    rx: async_channel::Receiver<TermEvent>,
    window_size: WindowSize,
}

/// A login shell in `cwd`; with `command` (label, command line), it runs that
/// first and then stays open as an interactive shell, like the external terminal.
pub fn start(cwd: &str, command: Option<(String, String)>) -> std::io::Result<Session> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let args = match &command {
        Some((_, c)) => vec!["-l".into(), "-c".into(), format!("{c}; exec {shell} -i")],
        None => vec!["-l".into()],
    };
    let env = HashMap::from([("TERM".into(), "xterm-256color".into()), ("COLORTERM".into(), "truecolor".into())]);
    let opts = tty::Options { shell: Some(tty::Shell::new(shell, args)), working_directory: Some(cwd.into()), drain_on_exit: true, env };
    let window_size = WindowSize { num_lines: 24, num_cols: 80, cell_width: 8, cell_height: 17 };
    let pty = tty::new(&opts, window_size, 0)?;
    let (tx, rx) = async_channel::unbounded();
    let term = Arc::new(FairMutex::new(Term::new(Config::default(), &GridSize { cols: 80, rows: 24 }, Listener(tx.clone()))));
    let event_loop = EventLoop::new(term.clone(), Listener(tx), pty, true, false)?;
    let notifier = Notifier(event_loop.channel());
    event_loop.spawn();
    Ok(Session { label: command.map(|c| c.0), term, notifier, rx, window_size })
}

impl TerminalView {
    /// `id`: the tab's id from the last run when reopening it (a fresh shell).
    pub fn new(s: Session, id: Option<String>, cx: &mut Context<Self>) -> Self {
        let rx = s.rx;
        let events = cx.spawn(async move |this, cx| {
            while let Ok(ev) = rx.recv().await {
                if this.update(cx, |t, cx| t.on_event(ev, cx)).is_err() {
                    break;
                }
            }
        });
        Self {
            id: id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            label: s.label,
            shell_title: None,
            term: s.term,
            notifier: s.notifier,
            exited: None,
            focus: cx.focus_handle(),
            geometry: Rc::new(Cell::new(None)),
            window_size: Rc::new(Cell::new(s.window_size)),
            selecting: false,
            mouse_button: None,
            mouse_cell: None,
            marked: None,
            cursor_bounds: Rc::new(Cell::new(None)),
            scroll_px: 0.,
            _events: events,
        }
    }

    /// The run command's label, else what the shell calls itself, else "Terminal".
    pub fn title(&self) -> String {
        self.label.clone().or_else(|| self.shell_title.clone().filter(|t| !t.trim().is_empty())).unwrap_or_else(|| "Terminal".into())
    }

    fn write(&self, bytes: impl Into<Cow<'static, [u8]>>) {
        self.notifier.notify(bytes);
    }

    fn on_event(&mut self, ev: TermEvent, cx: &mut Context<Self>) {
        match ev {
            TermEvent::Wakeup => {}
            TermEvent::Title(t) => {
                self.shell_title = Some(t);
                cx.emit(TermChanged);
            }
            TermEvent::ResetTitle => {
                self.shell_title = None;
                cx.emit(TermChanged);
            }
            TermEvent::PtyWrite(s) => self.write(s.into_bytes()),
            TermEvent::ClipboardStore(_, s) => cx.write_to_clipboard(ClipboardItem::new_string(s)),
            TermEvent::ClipboardLoad(_, f) => {
                let text = cx.read_from_clipboard().and_then(|c| c.text()).unwrap_or_default();
                self.write(f(&text).into_bytes());
            }
            TermEvent::ColorRequest(i, f) => {
                let dark = cx.theme().mode.is_dark();
                let colors = *self.term.lock().colors();
                let rgb = colors[i].unwrap_or_else(|| default_rgb(i, dark, cx));
                self.write(f(rgb).into_bytes());
            }
            TermEvent::TextAreaSizeRequest(f) => self.write(f(self.window_size.get()).into_bytes()),
            TermEvent::ChildExit(status) => {
                self.exited = Some(status.code());
                cx.emit(TermChanged);
            }
            _ => return,
        }
        cx.notify();
    }

    fn on_key(&mut self, ev: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        let ks = &ev.keystroke;
        let mut term = self.term.lock();
        if ks.modifiers.platform {
            match ks.key.as_str() {
                "c" => {
                    if let Some(text) = term.selection_to_string().filter(|t| !t.is_empty()) {
                        cx.write_to_clipboard(ClipboardItem::new_string(text));
                        cx.stop_propagation();
                    }
                }
                "v" => {
                    let text = cx.read_from_clipboard().and_then(|c| c.text()).unwrap_or_default();
                    let text = if term.mode().contains(TermMode::BRACKETED_PASTE) {
                        format!("\x1b[200~{}\x1b[201~", text.replace('\x1b', ""))
                    } else {
                        text.replace("\r\n", "\r").replace('\n', "\r")
                    };
                    term.scroll_display(Scroll::Bottom);
                    drop(term);
                    self.write(text.into_bytes());
                    cx.stop_propagation();
                }
                _ => {}
            }
            return;
        }
        let Some(bytes) = key_bytes(ks, *term.mode()) else { return };
        drop(term);
        self.type_bytes(bytes, cx);
        cx.stop_propagation();
    }

    /// Send typed input: back to the bottom, selection cleared.
    fn type_bytes(&mut self, bytes: Vec<u8>, cx: &mut Context<Self>) {
        let mut term = self.term.lock();
        term.selection = None;
        term.scroll_display(Scroll::Bottom);
        drop(term);
        self.write(bytes);
        cx.notify();
    }

    /// The grid cell under a window position: its viewport (col, row), its grid
    /// point, and which half of it.
    fn cell_at(&self, pos: Point<Pixels>) -> Option<(usize, usize, GridPoint, Side)> {
        let g = self.geometry.get()?;
        let term = self.term.lock();
        let x = f32::from(pos.x - g.origin.x) / f32::from(g.cell.width);
        let y = f32::from(pos.y - g.origin.y) / f32::from(g.cell.height);
        let col = (x.max(0.) as usize).min(term.columns() - 1);
        let row = (y.max(0.) as usize).min(term.screen_lines() - 1);
        let side = if x.fract() > 0.5 { Side::Right } else { Side::Left };
        let line = Line(row as i32 - term.grid().display_offset() as i32);
        Some((col, row, GridPoint::new(line, Column(col)), side))
    }

    /// The program asked for mouse events (and ⇧ isn't held to select instead).
    fn mouse_mode(&self, m: &Modifiers) -> Option<TermMode> {
        let mode = *self.term.lock().mode();
        (mode.intersects(TermMode::MOUSE_MODE) && !m.shift).then_some(mode)
    }

    /// Report a mouse event to the program: `button` is xterm's code (0 left,
    /// 1 middle, 2 right, 64/65 wheel; +32 for motion).
    fn report_mouse(&mut self, mode: TermMode, button: u8, pressed: bool, pos: Point<Pixels>, m: &Modifiers) {
        let Some((col, row, ..)) = self.cell_at(pos) else { return };
        let code = button + 4 * m.shift as u8 + 8 * m.alt as u8 + 16 * m.control as u8;
        self.write(mouse_report(mode, code, pressed, col, row));
    }

    fn on_mouse_down(&mut self, ev: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus, cx);
        let button = match ev.button {
            MouseButton::Left => 0,
            MouseButton::Middle => 1,
            MouseButton::Right => 2,
            _ => return,
        };
        if let Some(mode) = self.mouse_mode(&ev.modifiers) {
            self.mouse_button = Some(button);
            return self.report_mouse(mode, button, true, ev.position, &ev.modifiers);
        }
        if button != 0 {
            return;
        }
        let Some((.., point, side)) = self.cell_at(ev.position) else { return };
        let ty = match ev.click_count {
            2 => SelectionType::Semantic,
            3 => SelectionType::Lines,
            _ => SelectionType::Simple,
        };
        self.term.lock().selection = Some(Selection::new(ty, point, side));
        self.selecting = true;
        cx.notify();
    }

    fn on_mouse_move(&mut self, ev: &MouseMoveEvent, _: &mut Window, cx: &mut Context<Self>) {
        let cell = self.cell_at(ev.position).map(|c| (c.0, c.1));
        if let Some(mode) = self.mouse_mode(&ev.modifiers) {
            // Motion is reported once per cell: while dragging (MOUSE_DRAG), or always (MOUSE_MOTION).
            if cell == self.mouse_cell {
                return;
            }
            self.mouse_cell = cell;
            match self.mouse_button.filter(|_| ev.pressed_button.is_some()) {
                Some(b) if mode.intersects(TermMode::MOUSE_DRAG | TermMode::MOUSE_MOTION) => self.report_mouse(mode, b + 32, true, ev.position, &ev.modifiers),
                None if mode.contains(TermMode::MOUSE_MOTION) => self.report_mouse(mode, 3 + 32, true, ev.position, &ev.modifiers),
                _ => {}
            }
            return;
        }
        if !self.selecting || ev.pressed_button != Some(MouseButton::Left) {
            return;
        }
        let Some((.., point, side)) = self.cell_at(ev.position) else { return };
        if let Some(sel) = self.term.lock().selection.as_mut() {
            sel.update(point, side);
        }
        cx.notify();
    }

    fn on_mouse_up(&mut self, ev: &MouseUpEvent, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(b) = self.mouse_button.take()
            && let Some(mode) = self.mouse_mode(&ev.modifiers)
        {
            return self.report_mouse(mode, b, false, ev.position, &ev.modifiers);
        }
        self.selecting = false;
        let mut term = self.term.lock();
        if term.selection.as_ref().is_some_and(|s| s.is_empty()) {
            term.selection = None;
        }
        cx.notify();
    }

    fn on_scroll(&mut self, ev: &ScrollEvent, _: &mut Window, cx: &mut Context<Self>) {
        let Some(g) = self.geometry.get() else { return };
        let line_h = f32::from(g.cell.height);
        self.scroll_px += f32::from(ev.delta.pixel_delta(g.cell.height).y);
        let lines = (self.scroll_px / line_h) as i32;
        if lines == 0 {
            return;
        }
        self.scroll_px -= lines as f32 * line_h;
        if let Some(mode) = self.mouse_mode(&ev.modifiers) {
            for _ in 0..lines.unsigned_abs() {
                self.report_mouse(mode, if lines > 0 { 64 } else { 65 }, true, ev.position, &ev.modifiers);
            }
            return;
        }
        let mut term = self.term.lock();
        let mode = *term.mode();
        if mode.contains(TermMode::ALT_SCREEN | TermMode::ALTERNATE_SCROLL) {
            // Full-screen apps (less, vim…) get arrow keys instead.
            let key: &[u8] = match (lines > 0, mode.contains(TermMode::APP_CURSOR)) {
                (true, true) => b"\x1bOA",
                (true, false) => b"\x1b[A",
                (false, true) => b"\x1bOB",
                (false, false) => b"\x1b[B",
            };
            drop(term);
            self.write(key.repeat(lines.unsigned_abs() as usize));
        } else {
            term.scroll_display(Scroll::Delta(lines));
        }
        cx.notify();
    }
}

/// Typed text from the input method; while composing (e.g. ⌥E then E for é), the
/// pending text is "marked" and drawn at the cursor.
impl EntityInputHandler for TerminalView {
    fn text_for_range(&mut self, _: Range<usize>, _: &mut Option<Range<usize>>, _: &mut Window, _: &mut Context<Self>) -> Option<String> {
        None
    }

    fn selected_text_range(&mut self, _: bool, _: &mut Window, _: &mut Context<Self>) -> Option<UTF16Selection> {
        Some(UTF16Selection { range: 0..0, reversed: false })
    }

    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        self.marked.as_ref().map(|m| 0..m.encode_utf16().count())
    }

    fn unmark_text(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        self.marked = None;
        cx.notify();
    }

    fn replace_text_in_range(&mut self, _: Option<Range<usize>>, text: &str, _: &mut Window, cx: &mut Context<Self>) {
        self.marked = None;
        self.type_bytes(text.as_bytes().to_vec(), cx);
    }

    fn replace_and_mark_text_in_range(&mut self, _: Option<Range<usize>>, text: &str, _: Option<Range<usize>>, _: &mut Window, cx: &mut Context<Self>) {
        self.marked = (!text.is_empty()).then(|| text.to_string());
        cx.notify();
    }

    fn bounds_for_range(&mut self, _: Range<usize>, _: Bounds<Pixels>, _: &mut Window, _: &mut Context<Self>) -> Option<Bounds<Pixels>> {
        self.cursor_bounds.get()
    }

    fn character_index_for_point(&mut self, _: Point<Pixels>, _: &mut Window, _: &mut Context<Self>) -> Option<usize> {
        None
    }
}

/// xterm mouse report bytes for `code` at viewport cell (col, row): SGR when the
/// program enabled it, else the legacy X10 form (release = code 3; cells past 222 can't be sent).
fn mouse_report(mode: TermMode, code: u8, pressed: bool, col: usize, row: usize) -> Vec<u8> {
    if mode.contains(TermMode::SGR_MOUSE) {
        return format!("\x1b[<{code};{};{}{}", col + 1, row + 1, if pressed { 'M' } else { 'm' }).into_bytes();
    }
    let code = if pressed { code } else { 3 + (code & !3) };
    if col > 222 || row > 222 {
        return vec![];
    }
    vec![0x1b, b'[', b'M', 32 + code, 33 + col as u8, 33 + row as u8]
}

/// The bytes a keystroke sends to the shell (xterm conventions), or None to let
/// the app have it.
fn key_bytes(ks: &Keystroke, mode: TermMode) -> Option<Vec<u8>> {
    let m = &ks.modifiers;
    let modp = 1 + m.shift as u8 + 2 * m.alt as u8 + 4 * m.control as u8;
    let app_cursor = mode.contains(TermMode::APP_CURSOR);
    let arrow = |c: char| match (modp > 1, app_cursor) {
        (true, _) => format!("\x1b[1;{modp}{c}"),
        (false, true) => format!("\x1bO{c}"),
        (false, false) => format!("\x1b[{c}"),
    };
    let tilde = |n: u8| if modp > 1 { format!("\x1b[{n};{modp}~") } else { format!("\x1b[{n}~") };
    let s = match ks.key.as_str() {
        "enter" => (if m.alt { "\x1b\r" } else { "\r" }).into(),
        "backspace" => (if m.control { "\x08" } else if m.alt { "\x1b\x7f" } else { "\x7f" }).into(),
        "tab" => (if m.shift { "\x1b[Z" } else { "\t" }).into(),
        "escape" => "\x1b".into(),
        "up" => arrow('A'),
        "down" => arrow('B'),
        "right" => arrow('C'),
        "left" => arrow('D'),
        "home" => arrow('H'),
        "end" => arrow('F'),
        "insert" => tilde(2),
        "delete" => tilde(3),
        "pageup" => tilde(5),
        "pagedown" => tilde(6),
        "f1" => "\x1bOP".into(),
        "f2" => "\x1bOQ".into(),
        "f3" => "\x1bOR".into(),
        "f4" => "\x1bOS".into(),
        f if f.len() > 1 && f.starts_with('f') && f[1..].parse::<u8>().is_ok_and(|n| (5..=12).contains(&n)) => {
            tilde([15, 17, 18, 19, 20, 21, 23, 24][f[1..].parse::<usize>().unwrap() - 5])
        }
        k if m.control && k.chars().count() == 1 => {
            let c = k.chars().next()?.to_ascii_lowercase();
            let b = match c {
                'a'..='z' => c as u8 - b'a' + 1,
                '@' | '2' | ' ' => 0,
                '[' | '3' => 27,
                '\\' | '4' => 28,
                ']' | '5' => 29,
                '^' | '6' => 30,
                '_' | '-' | '7' => 31,
                _ => return None,
            };
            return Some(if m.alt { vec![0x1b, b] } else { vec![b] });
        }
        "space" if m.control => "\0".into(),
        // Typed text arrives through the input method (EntityInputHandler), which
        // also composes dead keys and CJK.
        _ => return None,
    };
    Some(s.into_bytes())
}

// --- Colors -------------------------------------------------------------------

/// The 16 ANSI colors, tuned to the app's dark and light grounds.
const ANSI_DARK: [u32; 16] = [
    0x2a2e37, 0xe06c75, 0x4ec9a5, 0xe2b341, 0x61afef, 0xc678dd, 0x56b6c2, 0xc8ccd4, //
    0x6b7280, 0xff7b85, 0x6ee0bb, 0xf0c95c, 0x7cc0ff, 0xd896ec, 0x6fd0dc, 0xffffff,
];
const ANSI_LIGHT: [u32; 16] = [
    0x1c1f26, 0xc4372f, 0x1f9d5b, 0x9a6b00, 0x2f6fd6, 0x9b3fb5, 0x16849a, 0xc8ccd4, //
    0x5c636e, 0xe0453c, 0x2bb36d, 0xb9852a, 0x4a86e8, 0xb35bcc, 0x1fa0b8, 0xe6e8ec,
];

fn hex(v: u32) -> Rgb {
    Rgb { r: (v >> 16) as u8, g: (v >> 8) as u8, b: v as u8 }
}

fn hsla(c: Rgb) -> Hsla {
    rgb(((c.r as u32) << 16) | ((c.g as u32) << 8) | c.b as u32).into()
}

fn to_rgb(c: Hsla) -> Rgb {
    let c = c.to_rgb();
    Rgb { r: (c.r * 255.) as u8, g: (c.g * 255.) as u8, b: (c.b * 255.) as u8 }
}

/// Color `i` (0–255 palette, then the named ones) before any program overrides it.
fn default_rgb(i: usize, dark: bool, cx: &App) -> Rgb {
    let theme = cx.theme().colors;
    let level = |x: usize| if x == 0 { 0 } else { (55 + x * 40) as u8 };
    match i {
        0..16 => hex(if dark { ANSI_DARK } else { ANSI_LIGHT }[i]),
        16..232 => {
            let i = i - 16;
            Rgb { r: level(i / 36), g: level(i / 6 % 6), b: level(i % 6) }
        }
        232..256 => {
            let v = (8 + (i - 232) * 10) as u8;
            Rgb { r: v, g: v, b: v }
        }
        _ if i == NamedColor::Background as usize => to_rgb(theme.background),
        _ if i >= NamedColor::DimBlack as usize && i <= NamedColor::DimWhite as usize => {
            let c = default_rgb(i - NamedColor::DimBlack as usize, dark, cx);
            Rgb { r: (c.r as f32 * 0.66) as u8, g: (c.g as f32 * 0.66) as u8, b: (c.b as f32 * 0.66) as u8 }
        }
        _ => to_rgb(theme.foreground),
    }
}

fn resolve(c: Color, colors: &Colors, dark: bool, cx: &App) -> Hsla {
    let i = match c {
        Color::Spec(rgb) => return hsla(rgb),
        Color::Indexed(i) => i as usize,
        Color::Named(n) => n as usize,
    };
    hsla(colors[i].unwrap_or_else(|| default_rgb(i, dark, cx)))
}

// --- Drawing ------------------------------------------------------------------

/// One row's text, its style runs, and the cell backgrounds to fill first.
struct Row {
    text: String,
    runs: Vec<TextRun>,
}

struct Frame {
    rows: Vec<ShapedLine>,
    fills: Vec<(Bounds<Pixels>, Hsla)>,
    cursor: Option<(Bounds<Pixels>, Hsla, bool)>,
    line_h: Pixels,
    origin: Point<Pixels>,
    /// Text being composed, over a fill, at the cursor.
    marked: Option<(ShapedLine, Bounds<Pixels>)>,
}

/// What drawing needs from the view, cloned into the canvas.
struct Painter {
    term: Arc<FairMutex<Term<Listener>>>,
    geometry: Rc<Cell<Option<Geometry>>>,
    window_size: Rc<Cell<WindowSize>>,
    tx: alacritty_terminal::event_loop::EventLoopSender,
    cursor_bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
    marked: Option<String>,
}

impl Painter {
    /// Lay out the grid in `bounds`: resize the PTY to fit, then build each row's
    /// shaped text and fills.
    fn frame(&self, bounds: Bounds<Pixels>, focused: bool, window: &mut Window, cx: &mut App) -> Frame {
        let theme = cx.theme().colors;
        let dark = cx.theme().mode.is_dark();
        let mut font = window.text_style().font();
        font.family = cx.theme().mono_font_family.clone();
        let font_size = px(FONT_SIZE);
        let font_id = window.text_system().resolve_font(&font);
        let cell_w = window.text_system().advance(font_id, font_size, 'm').map(|s| s.width).unwrap_or(px(8.));
        let line_h = (font_size * 1.3).round();
        let origin = bounds.origin + point(px(PAD), px(PAD));
        self.geometry.set(Some(Geometry { origin, cell: size(cell_w, line_h) }));

        let size = GridSize {
            cols: (f32::from(bounds.size.width - px(PAD * 2.)) / f32::from(cell_w)).floor().max(2.) as usize,
            rows: (f32::from(bounds.size.height - px(PAD * 2.)) / f32::from(line_h)).floor().max(1.) as usize,
        };
        let mut term = self.term.lock();
        if (term.columns(), term.screen_lines()) != (size.cols, size.rows) {
            term.resize(size);
            let ws = WindowSize { num_lines: size.rows as u16, num_cols: size.cols as u16, cell_width: f32::from(cell_w) as u16, cell_height: f32::from(line_h) as u16 };
            self.window_size.set(ws);
            let _ = self.tx.send(Msg::Resize(ws));
        }

        let content = term.renderable_content();
        let colors = content.colors;
        let offset = content.display_offset as i32;
        let cursor = content.cursor;
        let selection = content.selection;
        let mut rows: Vec<Row> = (0..size.rows).map(|_| Row { text: String::new(), runs: vec![] }).collect();
        let mut fills = vec![];
        let mut cursor_cell = None;
        let cell_bounds = |row: usize, col: usize, w: usize| Bounds::new(origin + point(cell_w * col as f32, line_h * row as f32), gpui_kit::size(cell_w * w as f32, line_h));
        for cell in content.display_iter {
            let row = (cell.point.line.0 + offset) as usize;
            let col = cell.point.column.0;
            let Some(r) = rows.get_mut(row) else { continue };
            let flags = cell.flags;
            let mut fg = resolve(cell.fg, colors, dark, cx);
            let mut bg = resolve(cell.bg, colors, dark, cx);
            let default_bg = matches!(cell.bg, Color::Named(NamedColor::Background));
            let mut paint_bg = !default_bg;
            if flags.contains(Flags::INVERSE) {
                std::mem::swap(&mut fg, &mut bg);
                paint_bg = true;
            }
            if flags.contains(Flags::DIM) {
                fg = fg.opacity(0.7);
            }
            if flags.contains(Flags::HIDDEN) {
                fg = bg;
            }
            if selection.is_some_and(|s| s.contains(cell.point)) {
                bg = theme.selection;
                paint_bg = true;
            }
            let at_cursor = cell.point == cursor.point && cursor.shape != CursorShape::Hidden;
            if at_cursor {
                let wide = if flags.contains(Flags::WIDE_CHAR) { 2 } else { 1 };
                let block = focused && cursor.shape == CursorShape::Block;
                cursor_cell = Some((cell_bounds(row, col, wide), theme.foreground, block, cursor.shape));
                if block {
                    fg = theme.background;
                }
            }
            if paint_bg {
                fills.push((cell_bounds(row, col, 1), bg));
            }
            let ch = if flags.intersects(Flags::WIDE_CHAR_SPACER | Flags::LEADING_WIDE_CHAR_SPACER) { ' ' } else { cell.c };
            let mut f = font.clone();
            if flags.contains(Flags::BOLD) {
                f.weight = FontWeight::BOLD;
            }
            if flags.contains(Flags::ITALIC) {
                f.style = FontStyle::Italic;
            }
            let underline = flags.intersects(Flags::ALL_UNDERLINES).then(|| UnderlineStyle { thickness: px(1.), color: Some(fg), wavy: flags.contains(Flags::UNDERCURL) });
            let strikethrough = flags.contains(Flags::STRIKEOUT).then(|| StrikethroughStyle { thickness: px(1.), color: Some(fg) });
            let len = ch.len_utf8();
            r.text.push(ch);
            match r.runs.last_mut() {
                Some(last) if last.font == f && last.color == fg && last.underline == underline && last.strikethrough == strikethrough => last.len += len,
                _ => r.runs.push(TextRun { len, font: f, color: fg, background_color: None, underline, strikethrough }),
            }
        }
        drop(term);

        let cursor = cursor_cell.map(|(b, color, block, shape)| {
            let b = match shape {
                _ if !focused || block => b,
                CursorShape::Beam => Bounds::new(b.origin, gpui_kit::size(px(2.), b.size.height)),
                CursorShape::Underline => Bounds::new(b.origin + point(px(0.), b.size.height - px(2.)), gpui_kit::size(b.size.width, px(2.))),
                _ => b,
            };
            // Solid for a focused block/beam/underline; an outline when unfocused or hollow.
            let solid = focused && shape != CursorShape::HollowBlock;
            (b, color, solid)
        });
        self.cursor_bounds.set(cursor.map(|c| c.0));
        let marked = self.marked.as_ref().zip(cursor).map(|(m, (b, ..))| {
            let run = TextRun { len: m.len(), font: font.clone(), color: theme.foreground, background_color: None, underline: Some(UnderlineStyle { thickness: px(1.), color: Some(theme.foreground), wavy: false }), strikethrough: None };
            let line = window.text_system().shape_line(m.clone().into(), font_size, &[run], Some(cell_w));
            (line, Bounds::new(b.origin, gpui_kit::size(cell_w * m.chars().count() as f32, line_h)))
        });
        let rows = rows
            .into_iter()
            .map(|r| window.text_system().shape_line(r.text.into(), font_size, &r.runs, Some(cell_w)))
            .collect();
        Frame { rows, fills, cursor, line_h, origin, marked }
    }
}

fn paint(f: Frame, window: &mut Window, cx: &mut App) {
    for (b, c) in &f.fills {
        window.paint_quad(fill(*b, *c));
    }
    if let Some((b, c, true)) = f.cursor {
        window.paint_quad(fill(b, c));
    }
    for (i, line) in f.rows.iter().enumerate() {
        let _ = line.paint(f.origin + point(px(0.), f.line_h * i as f32), f.line_h, TextAlign::Left, None, window, cx);
    }
    if let Some((b, c, false)) = f.cursor {
        window.paint_quad(outline(b, c, BorderStyle::Solid));
    }
    if let Some((line, b)) = f.marked {
        window.paint_quad(fill(b, cx.theme().colors.background));
        let _ = line.paint(b.origin, f.line_h, TextAlign::Left, None, window, cx);
    }
}

impl Render for TerminalView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = cx.theme().colors;
        let focused = self.focus.is_focused(window);
        let painter = Painter { term: self.term.clone(), geometry: self.geometry.clone(), window_size: self.window_size.clone(), tx: self.notifier.0.clone(), cursor_bounds: self.cursor_bounds.clone(), marked: self.marked.clone() };
        let (view, focus) = (cx.entity(), self.focus.clone());
        div()
            .id("terminal")
            .key_context("Terminal")
            .track_focus(&self.focus)
            .flex()
            .flex_col()
            .size_full()
            .bg(theme.background)
            .cursor(CursorStyle::IBeam)
            .on_key_down(cx.listener(Self::on_key))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
            .on_mouse_down(MouseButton::Middle, cx.listener(Self::on_mouse_down))
            .on_mouse_down(MouseButton::Right, cx.listener(Self::on_mouse_down))
            .on_mouse_move(cx.listener(Self::on_mouse_move))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_up(MouseButton::Middle, cx.listener(Self::on_mouse_up))
            .on_mouse_up(MouseButton::Right, cx.listener(Self::on_mouse_up))
            .on_scroll(cx.listener(Self::on_scroll))
            .child(
                canvas(
                    move |bounds, window, cx| painter.frame(bounds, focused, window, cx),
                    move |bounds, frame, window, cx| {
                        window.handle_input(&focus, ElementInputHandler::new(bounds, view), cx);
                        paint(frame, window, cx)
                    },
                )
                .flex_1()
                .min_h_0(),
            )
            .children(self.exited.map(|code| {
                let text = match code {
                    Some(0) | None => "Process exited".to_string(),
                    Some(c) => format!("Process exited with code {c}"),
                };
                div().px_3().py_1().text_xs().text_color(theme.muted_foreground).border_t_1().border_color(theme.border).child(text)
            }))
    }
}

#[cfg(test)]
mod tests {
    use super::{Dimensions as _, Keystroke, TermMode, key_bytes, start};

    fn ks(s: &'static str) -> Keystroke {
        Keystroke::parse(s).unwrap()
    }

    #[test]
    fn keys() {
        let none = TermMode::empty();
        assert_eq!(key_bytes(&ks("enter"), none), Some(b"\r".to_vec()));
        assert_eq!(key_bytes(&ks("a"), none), None);
        assert_eq!(key_bytes(&ks("ctrl-space"), none), Some(vec![0]));
        assert_eq!(key_bytes(&ks("ctrl-c"), none), Some(vec![3]));
        assert_eq!(key_bytes(&ks("up"), none), Some(b"\x1b[A".to_vec()));
        assert_eq!(key_bytes(&ks("up"), TermMode::APP_CURSOR), Some(b"\x1bOA".to_vec()));
        assert_eq!(key_bytes(&ks("shift-right"), none), Some(b"\x1b[1;2C".to_vec()));
        assert_eq!(key_bytes(&ks("f5"), none), Some(b"\x1b[15~".to_vec()));
        assert_eq!(key_bytes(&ks("shift-tab"), none), Some(b"\x1b[Z".to_vec()));
        assert_eq!(super::mouse_report(TermMode::SGR_MOUSE, 0, true, 4, 2), b"\x1b[<0;5;3M");
        assert_eq!(super::mouse_report(TermMode::SGR_MOUSE, 0, false, 4, 2), b"\x1b[<0;5;3m");
        assert_eq!(super::mouse_report(TermMode::empty(), 0, false, 0, 0), [0x1b, b'[', b'M', 35, 33, 33]);
    }

    /// A real shell on a PTY: the command's output lands in the grid.
    #[test]
    fn runs_a_command() {
        let dir = std::env::temp_dir();
        let s = start(&dir.to_string_lossy(), Some(("t".into(), "printf FR-%s OK".into()))).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let text: String = {
                let term = s.term.lock();
                let grid = term.grid();
                (0..term.screen_lines()).flat_map(|l| (0..term.columns()).map(move |c| (l, c))).map(|(l, c)| grid[super::Line(l as i32)][super::Column(c)].c).collect()
            };
            if text.contains("FR-OK") {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "no output: {text:?}");
            let _ = s.rx.recv_blocking();
        }
    }
}
