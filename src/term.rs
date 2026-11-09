//! The in-app terminal tab: your login shell (or a run command) on a PTY,
//! emulated by libghostty-vt (see ghostty.rs) and drawn cell by cell on a canvas.

use std::cell::Cell;
use std::ffi::c_void;
use std::fs::File;
use std::io::{Read as _, Write as _};
use std::ops::Range;
use std::os::fd::{AsRawFd as _, FromRawFd as _};
use std::os::unix::process::CommandExt as _;
use std::ptr::{null, null_mut};
use std::rc::Rc;
use std::sync::{Arc, Mutex, mpsc};

use gpui_kit::component::*;
use gpui_kit::*;

use crate::ghostty as g;

const FONT_SIZE: f32 = 13.;
const PAD: f32 = 8.;
const TIOCSCTTY: libc::c_ulong = 0x2000_7461;
const TIOCSWINSZ: libc::c_ulong = 0x8008_7467;

enum Event {
    Wakeup,
    Title(String),
    Clipboard(String),
    Exit(Option<i32>),
}

/// What the terminal's callbacks (run inside `vt_write`, on the reader thread) need.
struct Ctx {
    events: async_channel::Sender<Event>,
    pty: mpsc::Sender<Vec<u8>>,
}

/// libghostty's terminal plus the render state and encoders that read it.
struct Vt {
    t: g::Terminal,
    rs: g::RenderState,
    rows: g::RowIterator,
    cells: g::RowCells,
    keys: g::KeyEncoder,
    key_ev: g::KeyEvent,
    mouse: g::MouseEncoder,
    mouse_ev: g::MouseEvent,
    size: (u16, u16),
    colors: Option<(g::Rgb, g::Rgb, bool)>,
    _ctx: Box<Ctx>,
}

// The handles are only used under the Mutex that owns them.
unsafe impl Send for Vt {}

impl Drop for Vt {
    fn drop(&mut self) {
        unsafe {
            g::ghostty_mouse_event_free(self.mouse_ev);
            g::ghostty_mouse_encoder_free(self.mouse);
            g::ghostty_key_event_free(self.key_ev);
            g::ghostty_key_encoder_free(self.keys);
            g::ghostty_render_state_row_cells_free(self.cells);
            g::ghostty_render_state_row_iterator_free(self.rows);
            g::ghostty_render_state_free(self.rs);
            g::ghostty_terminal_free(self.t);
        }
    }
}

fn ok(r: g::Result) -> std::io::Result<()> {
    if r == g::SUCCESS { Ok(()) } else { Err(std::io::Error::other(format!("libghostty-vt error {r}"))) }
}

fn opt<T>(v: &T) -> *const c_void {
    v as *const T as *const c_void
}

impl Vt {
    fn new(cols: u16, rows: u16, ctx: Ctx) -> std::io::Result<Self> {
        let ctx = Box::new(ctx);
        let mut vt = Vt { t: null_mut(), rs: null_mut(), rows: null_mut(), cells: null_mut(), keys: null_mut(), key_ev: null_mut(), mouse: null_mut(), mouse_ev: null_mut(), size: (cols, rows), colors: None, _ctx: ctx };
        unsafe {
            ok(g::ghostty_terminal_new(null(), &mut vt.t, cols, rows))?;
            ok(g::ghostty_render_state_new(null(), &mut vt.rs))?;
            ok(g::ghostty_render_state_row_iterator_new(null(), &mut vt.rows))?;
            ok(g::ghostty_render_state_row_cells_new(null(), &mut vt.cells))?;
            ok(g::ghostty_key_encoder_new(null(), &mut vt.keys))?;
            ok(g::ghostty_key_event_new(null(), &mut vt.key_ev))?;
            ok(g::ghostty_mouse_encoder_new(null(), &mut vt.mouse))?;
            ok(g::ghostty_mouse_event_new(null(), &mut vt.mouse_ev))?;
            let t = vt.t;
            g::ghostty_terminal_set(t, g::OPT_USERDATA, &*vt._ctx as *const Ctx as *const c_void);
            g::ghostty_terminal_set(t, g::OPT_WRITE_PTY, on_write_pty as g::WritePtyFn as *const c_void);
            g::ghostty_terminal_set(t, g::OPT_TITLE_CHANGED, on_title as g::NotifyFn as *const c_void);
            g::ghostty_terminal_set(t, g::OPT_CLIPBOARD_WRITE, on_clipboard_write as g::ClipboardWriteFn as *const c_void);
            // 10k lines of scrollback (the default is one ~400KB page).
            g::ghostty_terminal_set(t, g::OPT_SCROLLBACK_MAX_BYTES, opt(&usize::MAX));
            g::ghostty_terminal_set(t, g::OPT_SCROLLBACK_MAX_LINES, opt(&10_000usize));
            g::ghostty_mouse_encoder_set(vt.mouse, g::MOUSE_ENC_TRACK_LAST_CELL, opt(&true));
        }
        Ok(vt)
    }

    fn write(&mut self, bytes: &[u8]) {
        unsafe { g::ghostty_terminal_vt_write(self.t, bytes.as_ptr(), bytes.len()) }
    }

    fn get<T>(&self, key: i32, mut out: T) -> Option<T> {
        (unsafe { g::ghostty_terminal_get(self.t, key, &mut out as *mut T as *mut c_void) } == g::SUCCESS).then_some(out)
    }

    fn mode(&self, mode: u16) -> bool {
        self.get(g::DATA_MODE, g::ModeConfig { mode, value: false }).is_some_and(|m| m.value)
    }

    fn mouse_tracking(&self) -> bool {
        self.get(g::DATA_MOUSE_TRACKING, false).unwrap_or(false)
    }

    fn alt_screen(&self) -> bool {
        self.get(g::DATA_ACTIVE_SCREEN, 0i32) == Some(1)
    }

    fn scroll(&mut self, tag: i32, delta: isize) {
        unsafe { g::ghostty_terminal_scroll_viewport(self.t, g::ScrollViewport::new(tag, delta)) };
    }

    fn grid_ref(&self, tag: i32, x: u16, y: u32) -> Option<g::GridRef> {
        let mut r = g::GridRef { node: null_mut(), x: 0, y: 0 };
        (unsafe { g::ghostty_terminal_grid_ref(self.t, g::Point::new(tag, x, y), &mut r) } == g::SUCCESS).then_some(r)
    }

    /// A viewport cell's position in the whole screen (stays put as output scrolls it).
    fn screen_point(&self, col: u16, row: u16) -> Option<(u16, u32)> {
        let r = self.grid_ref(g::POINT_VIEWPORT, col, row as u32)?;
        let mut p = g::PointCoordinate { x: 0, y: 0 };
        (unsafe { g::ghostty_terminal_point_from_grid_ref(self.t, &r, g::POINT_SCREEN, &mut p) } == g::SUCCESS).then_some((p.x, p.y))
    }

    fn set_selection(&mut self, sel: Option<&g::Selection>) {
        unsafe { g::ghostty_terminal_set(self.t, g::OPT_SELECTION, sel.map_or(null(), |s| opt(s))) };
    }

    /// The selection's text, or (None) the whole screen's.
    fn text(&self, selection: bool) -> Option<String> {
        let none = g::GridRef { node: null_mut(), x: 0, y: 0 };
        let sel = if selection { Some(self.get(g::DATA_SELECTION, g::Selection { start: none, end: none, rectangle: false })?) } else { None };
        unsafe {
            let mut f = null_mut();
            ok(g::ghostty_formatter_terminal_new(null(), &mut f, self.t)).ok()?;
            g::ghostty_formatter_set(f, g::FORMATTER_EMIT, opt(&0i32));
            g::ghostty_formatter_set(f, g::FORMATTER_UNWRAP, opt(&true));
            g::ghostty_formatter_set(f, g::FORMATTER_TRIM, opt(&true));
            if let Some(s) = &sel {
                g::ghostty_formatter_set(f, g::FORMATTER_SELECTION, opt(s));
            }
            let (mut ptr, mut len) = (null_mut(), 0);
            let r = g::ghostty_formatter_format_alloc(f, null(), &mut ptr, &mut len);
            g::ghostty_formatter_free(f);
            ok(r).ok()?;
            if ptr.is_null() {
                return Some(String::new());
            }
            let s = String::from_utf8_lossy(std::slice::from_raw_parts(ptr, len)).into_owned();
            g::ghostty_free(null(), ptr, len);
            Some(s)
        }
    }

    /// Default colors and the palette, from the app theme (re-sent when it changes).
    fn set_colors(&mut self, fg: g::Rgb, bg: g::Rgb, dark: bool) {
        if self.colors == Some((fg, bg, dark)) {
            return;
        }
        self.colors = Some((fg, bg, dark));
        let palette: Vec<g::Rgb> = (0..256).map(|i| palette_rgb(i, dark)).collect();
        unsafe {
            g::ghostty_terminal_set(self.t, g::OPT_COLOR_FOREGROUND, opt(&fg));
            g::ghostty_terminal_set(self.t, g::OPT_COLOR_BACKGROUND, opt(&bg));
            g::ghostty_terminal_set(self.t, g::OPT_COLOR_PALETTE, palette.as_ptr() as *const c_void);
        }
    }

    /// A keystroke as the program expects it (legacy xterm or the Kitty protocol,
    /// per the terminal's modes).
    fn encode_key(&mut self, key: i32, mods: u16, text: &str) -> Vec<u8> {
        unsafe {
            g::ghostty_key_encoder_set_from_terminal(self.keys, self.t);
            g::ghostty_key_encoder_set(self.keys, g::KEY_ENC_OPTION_AS_ALT, opt(&1i32));
            g::ghostty_key_event_set_action(self.key_ev, g::KEY_PRESS);
            g::ghostty_key_event_set_key(self.key_ev, key);
            g::ghostty_key_event_set_mods(self.key_ev, mods);
            g::ghostty_key_event_set_utf8(self.key_ev, g::Str { ptr: text.as_ptr(), len: text.len() });
            g::ghostty_key_event_set_unshifted_codepoint(self.key_ev, text.chars().next().map_or(0, |c| c as u32));
            let mut buf = [0u8; 128];
            let mut n = 0;
            let r = g::ghostty_key_encoder_encode(self.keys, self.key_ev, buf.as_mut_ptr(), buf.len(), &mut n);
            g::ghostty_key_event_set_utf8(self.key_ev, g::Str { ptr: null(), len: 0 });
            if r == g::SUCCESS { buf[..n].to_vec() } else { vec![] }
        }
    }

    /// A mouse event for a program that tracks the mouse; `pos` is in the
    /// encoder's pixel space (see `TerminalView::mouse`).
    fn encode_mouse(&mut self, action: i32, button: Option<i32>, mods: u16, any_pressed: bool, size: &g::MouseEncoderSize, pos: g::MousePosition) -> Vec<u8> {
        unsafe {
            g::ghostty_mouse_encoder_set_from_terminal(self.mouse, self.t);
            g::ghostty_mouse_encoder_set(self.mouse, g::MOUSE_ENC_SIZE, opt(size));
            g::ghostty_mouse_encoder_set(self.mouse, g::MOUSE_ENC_ANY_PRESSED, opt(&any_pressed));
            g::ghostty_mouse_event_set_action(self.mouse_ev, action);
            match button {
                Some(b) => g::ghostty_mouse_event_set_button(self.mouse_ev, b),
                None => g::ghostty_mouse_event_clear_button(self.mouse_ev),
            };
            g::ghostty_mouse_event_set_mods(self.mouse_ev, mods);
            g::ghostty_mouse_event_set_position(self.mouse_ev, pos);
            let mut buf = [0u8; 128];
            let mut n = 0;
            let r = g::ghostty_mouse_encoder_encode(self.mouse, self.mouse_ev, buf.as_mut_ptr(), buf.len(), &mut n);
            if r == g::SUCCESS { buf[..n].to_vec() } else { vec![] }
        }
    }

    fn paste(&self, text: String) -> Vec<u8> {
        let bracketed = self.mode(g::MODE_BRACKETED_PASTE);
        let mut data = text.into_bytes();
        let mut buf = vec![0u8; data.len() * 2 + 16];
        let mut n = 0;
        let r = unsafe { g::ghostty_paste_encode(data.as_mut_ptr(), data.len(), bracketed, buf.as_mut_ptr(), buf.len(), &mut n) };
        if r == g::SUCCESS { buf.truncate(n); buf } else { vec![] }
    }
}

extern "C" fn on_write_pty(_: g::Terminal, ud: *mut c_void, data: *const u8, len: usize) {
    let ctx = unsafe { &*(ud as *const Ctx) };
    let _ = ctx.pty.send(unsafe { std::slice::from_raw_parts(data, len) }.to_vec());
}

extern "C" fn on_title(t: g::Terminal, ud: *mut c_void) {
    let ctx = unsafe { &*(ud as *const Ctx) };
    let mut s = g::Str { ptr: null(), len: 0 };
    if unsafe { g::ghostty_terminal_get(t, g::DATA_TITLE, &mut s as *mut g::Str as *mut c_void) } == g::SUCCESS {
        let title = if s.len == 0 { String::new() } else { String::from_utf8_lossy(unsafe { std::slice::from_raw_parts(s.ptr, s.len) }).into_owned() };
        let _ = ctx.events.try_send(Event::Title(title));
    }
}

/// OSC 52 and friends: put the program's text on the clipboard.
extern "C" fn on_clipboard_write(_: g::Terminal, ud: *mut c_void, w: *const g::ClipboardWrite) {
    let ctx = unsafe { &*(ud as *const Ctx) };
    let w = unsafe { &*w };
    let contents = if w.contents_len == 0 { &[][..] } else { unsafe { std::slice::from_raw_parts(w.contents, w.contents_len) } };
    let bytes = |s: g::Str| if s.len == 0 { &[][..] } else { unsafe { std::slice::from_raw_parts(s.ptr, s.len) } };
    if let Some(c) = contents.iter().find(|c| bytes(c.mime).starts_with(b"text/plain")).or(contents.first()) {
        let _ = ctx.events.try_send(Event::Clipboard(String::from_utf8_lossy(bytes(c.data)).into_owned()));
    }
    (w.reply)(w, &g::ClipboardWriteReply { size: size_of::<g::ClipboardWriteReply>(), result: 0, remember: false });
}

/// Where the grid was last drawn: its top-left and one cell's size.
#[derive(Clone, Copy)]
struct Geometry {
    origin: Point<Pixels>,
    cell: gpui_kit::Size<Pixels>,
}

/// Its title changed or its process exited: the tab strip should redraw.
pub struct TermChanged;

/// A run command with `close_on_success` exited 0: its tab can close.
pub struct TermFinished;

/// The window title a run command's script sets when its command finishes and the
/// interactive shell takes over (it isn't shown: a run tab is titled by its label).
const RUN_DONE: &str = "forest-ranger:run-done";

/// A command for a new terminal to run (a project's run command).
pub struct Run {
    pub label: String,
    pub command: String,
    /// Exit when it succeeds (the tab then closes); on failure the shell stays so
    /// the error can be read.
    pub close_on_success: bool,
}

pub struct TerminalView {
    pub id: String,
    label: Option<String>,
    shell_title: Option<String>,
    vt: Arc<Mutex<Vt>>,
    pty: Arc<Pty>,
    exited: Option<Option<i32>>,
    close_on_success: bool,
    focus: FocusHandle,
    geometry: Rc<Cell<Option<Geometry>>>,
    /// Where a drag selection started, in screen coordinates.
    anchor: Option<(u16, u32)>,
    /// The button held down while reporting the mouse to the program.
    mouse_button: Option<i32>,
    /// Text being composed by the input method (dead keys, CJK…), drawn at the cursor.
    marked: Option<String>,
    /// Where the cursor was last drawn, for the input method's candidate window.
    cursor_bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
    scroll_px: f32,
    /// Still in a run command's own command (before its interactive shell).
    run_phase: bool,
    /// Something other than the idle shell is running (see `TerminalView::busy`).
    busy: bool,
    _events: Task<()>,
    _poll: Task<()>,
}

impl EventEmitter<TermChanged> for TerminalView {}
impl EventEmitter<TermFinished> for TerminalView {}

impl Focusable for TerminalView {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

/// The PTY's master side and the shell on it.
struct Pty {
    master: File,
    pid: i32,
    tx: mpsc::Sender<Vec<u8>>,
}

impl Pty {
    fn write(&self, bytes: Vec<u8>) {
        if !bytes.is_empty() {
            let _ = self.tx.send(bytes);
        }
    }

    fn resize(&self, cols: u16, rows: u16, cell: (u16, u16)) {
        let ws = libc::winsize { ws_row: rows, ws_col: cols, ws_xpixel: cols * cell.0, ws_ypixel: rows * cell.1 };
        unsafe { libc::ioctl(self.master.as_raw_fd(), TIOCSWINSZ, &ws) };
    }
}

impl Drop for Pty {
    fn drop(&mut self) {
        // Hang up the shell, as closing a terminal window does.
        unsafe { libc::kill(self.pid, libc::SIGHUP) };
    }
}

/// A started shell, before it has a view.
pub struct Session {
    label: Option<String>,
    close_on_success: bool,
    vt: Arc<Mutex<Vt>>,
    pty: Arc<Pty>,
    rx: async_channel::Receiver<Event>,
    /// A Wakeup is queued and not yet handled: output bursts send just one.
    woken: Arc<std::sync::atomic::AtomicBool>,
    run_phase: bool,
}

/// A login shell in `cwd`; with a `Run`, it runs that command first and then
/// stays open as an interactive shell, like the external terminal — unless it
/// asks to close on success and the command exits 0.
pub fn start(cwd: &str, run: Option<Run>) -> std::io::Result<Session> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".into());
    let args = match &run {
        // Braces + newline: the whole command line (`a; b`, a trailing comment) is the test.
        // The shell's job control isn't on while the command runs, so it says when it's done.
        Some(r) if r.close_on_success => {
            vec!["-l".into(), "-c".into(), format!("{{ {}\n}} && exit 0; printf '\\033]2;{RUN_DONE}\\007'; exec {shell} -i", r.command)]
        }
        Some(r) => vec!["-l".into(), "-c".into(), format!("{}\nprintf '\\033]2;{RUN_DONE}\\007'; exec {shell} -i", r.command)],
        None => vec!["-l".to_string()],
    };
    let (cols, rows) = (80, 24);
    let (mut master, mut slave) = (0, 0);
    let mut ws = libc::winsize { ws_row: rows, ws_col: cols, ws_xpixel: 0, ws_ypixel: 0 };
    if unsafe { libc::openpty(&mut master, &mut slave, null_mut(), null_mut(), &mut ws) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    unsafe {
        libc::fcntl(master, libc::F_SETFD, libc::FD_CLOEXEC);
        libc::fcntl(slave, libc::F_SETFD, libc::FD_CLOEXEC);
    }
    let (master, slave) = unsafe { (File::from_raw_fd(master), File::from_raw_fd(slave)) };
    let mut cmd = std::process::Command::new(&shell);
    cmd.args(&args).current_dir(cwd).env("TERM", "xterm-256color").env("COLORTERM", "truecolor");
    cmd.stdin(slave.try_clone()?).stdout(slave.try_clone()?).stderr(slave);
    unsafe {
        // Its own session, with the PTY as its controlling terminal (for job control).
        cmd.pre_exec(|| {
            libc::setsid();
            libc::ioctl(0, TIOCSCTTY, 0);
            Ok(())
        });
    }
    let mut child = cmd.spawn()?;
    drop(cmd); // closes our copies of the slave side

    let (events, rx) = async_channel::unbounded();
    let (pty_tx, pty_rx) = mpsc::channel::<Vec<u8>>();
    let vt = Arc::new(Mutex::new(Vt::new(cols, rows, Ctx { events: events.clone(), pty: pty_tx.clone() })?));
    // ponytail: one reader, one writer and one waiter thread per terminal; an
    // event loop on kqueue if anyone opens hundreds.
    let mut writer = master.try_clone()?;
    std::thread::spawn(move || {
        for bytes in pty_rx {
            if writer.write_all(&bytes).is_err() {
                break;
            }
        }
    });
    let mut reader = master.try_clone()?;
    let woken = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (vt2, ev2, woken2) = (vt.clone(), events.clone(), woken.clone());
    std::thread::spawn(move || {
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    vt2.lock().unwrap().write(&buf[..n]);
                    if !woken2.swap(true, std::sync::atomic::Ordering::AcqRel) {
                        let _ = ev2.try_send(Event::Wakeup);
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => break, // EIO: the shell and everything on the PTY exited
            }
        }
    });
    let pid = child.id() as i32;
    std::thread::spawn(move || {
        let code = child.wait().ok().and_then(|s| s.code());
        let _ = events.try_send(Event::Exit(code));
    });
    let close_on_success = run.as_ref().is_some_and(|r| r.close_on_success);
    let run_phase = run.is_some();
    Ok(Session { label: run.map(|r| r.label), close_on_success, vt, pty: Arc::new(Pty { master, pid, tx: pty_tx }), rx, woken, run_phase })
}

/// GPUI key name → libghostty key, and the text it types (for letters and symbols).
fn ghostty_key(key: &str) -> Option<(i32, &str)> {
    let named = match key {
        "enter" => 58,
        "backspace" => 53,
        "tab" => 64,
        "escape" => 120,
        "space" => return Some((63, " ")),
        "up" => 78,
        "down" => 75,
        "left" => 76,
        "right" => 77,
        "home" => 71,
        "end" => 69,
        "pageup" => 74,
        "pagedown" => 73,
        "insert" => 72,
        "delete" => 68,
        f if f.len() > 1 && f.starts_with('f') => match f[1..].parse::<i32>() {
            Ok(n @ 1..=24) => 120 + n,
            _ => return None,
        },
        _ => {
            let mut chars = key.chars();
            let (Some(c), None) = (chars.next(), chars.next()) else { return None };
            let k = match c.to_ascii_lowercase() {
                c @ 'a'..='z' => 20 + (c as i32 - 'a' as i32),
                '0' => 6,
                c @ '1'..='9' => 7 + (c as i32 - '1' as i32),
                '`' => 1,
                '\\' => 2,
                '[' => 3,
                ']' => 4,
                ',' => 5,
                '=' => 16,
                '-' => 46,
                '.' => 47,
                '\'' => 48,
                ';' => 49,
                '/' => 50,
                _ => return None,
            };
            return Some((k, key));
        }
    };
    Some((named, ""))
}

fn mods(m: &Modifiers) -> u16 {
    (m.shift as u16 * g::MODS_SHIFT) | (m.control as u16 * g::MODS_CTRL) | (m.alt as u16 * g::MODS_ALT) | (m.platform as u16 * g::MODS_SUPER)
}

impl TerminalView {
    /// `id`: the tab's id from the last run when reopening it (a fresh shell).
    pub fn new(s: Session, id: Option<String>, cx: &mut Context<Self>) -> Self {
        let (rx, woken) = (s.rx, s.woken);
        let events = cx.spawn(async move |this, cx| {
            while let Ok(ev) = rx.recv().await {
                if matches!(ev, Event::Wakeup) {
                    // Cleared before drawing: output after this point sends a new one.
                    woken.store(false, std::sync::atomic::Ordering::Release);
                }
                if this.update(cx, |t, cx| t.on_event(ev, cx)).is_err() {
                    break;
                }
            }
        });
        Self {
            id: id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            label: s.label,
            shell_title: None,
            vt: s.vt,
            pty: s.pty,
            exited: None,
            close_on_success: s.close_on_success,
            focus: cx.focus_handle(),
            geometry: Rc::new(Cell::new(None)),
            anchor: None,
            mouse_button: None,
            marked: None,
            cursor_bounds: Rc::new(Cell::new(None)),
            scroll_px: 0.,
            run_phase: s.run_phase,
            busy: s.run_phase,
            _events: events,
            // Each second: has a program started or finished? (Tells the sidebar and tab.)
            _poll: cx.spawn(async move |this, cx| {
                loop {
                    cx.background_executor().timer(std::time::Duration::from_secs(1)).await;
                    let alive = this.update(cx, |t, cx| t.check_busy(cx));
                    if alive.is_err() {
                        break;
                    }
                }
            }),
        }
    }

    /// A program is running: a run command's own command, or any foreground job
    /// in the shell (the terminal's foreground process group isn't the shell's).
    pub fn busy(&self) -> bool {
        self.busy
    }

    fn check_busy(&mut self, cx: &mut Context<Self>) {
        let pgrp = unsafe { libc::tcgetpgrp(self.pty.master.as_raw_fd()) };
        let busy = self.exited.is_none() && (self.run_phase || (pgrp > 0 && pgrp != self.pty.pid));
        if busy != self.busy {
            self.busy = busy;
            cx.emit(TermChanged);
        }
    }

    /// The run command's label, else what the shell calls itself, else "Terminal".
    pub fn title(&self) -> String {
        self.label.clone().or_else(|| self.shell_title.clone().filter(|t| !t.trim().is_empty())).unwrap_or_else(|| "Terminal".into())
    }

    fn on_event(&mut self, ev: Event, cx: &mut Context<Self>) {
        match ev {
            Event::Wakeup => {}
            Event::Title(t) if t == RUN_DONE => {
                self.run_phase = false;
                self.check_busy(cx);
            }
            Event::Title(t) => {
                self.shell_title = Some(t);
                cx.emit(TermChanged);
            }
            Event::Clipboard(s) => cx.write_to_clipboard(ClipboardItem::new_string(s)),
            Event::Exit(code) => {
                self.exited = Some(code);
                self.check_busy(cx);
                cx.emit(TermChanged);
                if self.close_on_success && code == Some(0) {
                    cx.emit(TermFinished);
                }
            }
        }
        cx.notify();
    }

    fn on_key(&mut self, ev: &KeyDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        let ks = &ev.keystroke;
        let m = &ks.modifiers;
        if m.platform {
            match ks.key.as_str() {
                "c" => {
                    if let Some(text) = self.vt.lock().unwrap().text(true).filter(|t| !t.is_empty()) {
                        cx.write_to_clipboard(ClipboardItem::new_string(text));
                        cx.stop_propagation();
                    }
                }
                "v" => {
                    let text = cx.read_from_clipboard().and_then(|c| c.text()).unwrap_or_default();
                    let bytes = self.vt.lock().unwrap().paste(text);
                    self.type_bytes(bytes, cx);
                    cx.stop_propagation();
                }
                _ => {}
            }
            return;
        }
        let Some((key, text)) = ghostty_key(&ks.key) else { return };
        // Typed text arrives through the input method (EntityInputHandler), which
        // also composes dead keys and CJK; ⌥ letters type their symbols.
        if !text.is_empty() && !m.control {
            return;
        }
        let bytes = self.vt.lock().unwrap().encode_key(key, mods(m), text);
        if !bytes.is_empty() {
            self.type_bytes(bytes, cx);
            cx.stop_propagation();
        }
    }

    /// Send typed input: back to the bottom, selection cleared.
    fn type_bytes(&mut self, bytes: Vec<u8>, cx: &mut Context<Self>) {
        let mut vt = self.vt.lock().unwrap();
        vt.set_selection(None);
        vt.scroll(g::SCROLL_BOTTOM, 0);
        drop(vt);
        self.pty.write(bytes);
        cx.notify();
    }

    /// The viewport cell under a window position.
    fn cell_at(&self, pos: Point<Pixels>) -> Option<(u16, u16)> {
        let g = self.geometry.get()?;
        let (cols, rows) = self.vt.lock().unwrap().size;
        let x = f32::from(pos.x - g.origin.x) / f32::from(g.cell.width);
        let y = f32::from(pos.y - g.origin.y) / f32::from(g.cell.height);
        Some(((x.max(0.) as u16).min(cols - 1), (y.max(0.) as u16).min(rows - 1)))
    }

    /// The program asked for mouse events (and ⇧ isn't held to select instead).
    fn mouse_mode(&self, m: &Modifiers) -> bool {
        !m.shift && self.vt.lock().unwrap().mouse_tracking()
    }

    /// Report a mouse event to the program (libghostty picks the format and
    /// drops what the program didn't ask for).
    fn mouse(&mut self, action: i32, button: Option<i32>, any_pressed: bool, pos: Point<Pixels>, m: &Modifiers) {
        let Some(g) = self.geometry.get() else { return };
        // The encoder works in whole pixels per cell; map onto a grid of rounded cells.
        let cw = f32::from(g.cell.width);
        let (cw_i, ch_i) = (cw.round().max(1.) as u32, f32::from(g.cell.height).round().max(1.) as u32);
        let (cols, rows) = self.vt.lock().unwrap().size;
        let size = g::MouseEncoderSize { size: size_of::<g::MouseEncoderSize>(), screen_width: 2 * PAD as u32 + cols as u32 * cw_i, screen_height: 2 * PAD as u32 + rows as u32 * ch_i, cell_width: cw_i, cell_height: ch_i, padding_top: PAD as u32, padding_bottom: PAD as u32, padding_right: PAD as u32, padding_left: PAD as u32 };
        let x = PAD + f32::from(pos.x - g.origin.x) / cw * cw_i as f32;
        let y = PAD + f32::from(pos.y - g.origin.y);
        let bytes = self.vt.lock().unwrap().encode_mouse(action, button, mods(m), any_pressed, &size, g::MousePosition { x, y });
        self.pty.write(bytes);
    }

    fn on_mouse_down(&mut self, ev: &MouseDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        window.focus(&self.focus, cx);
        let button = match ev.button {
            MouseButton::Left => 1,
            MouseButton::Right => 2,
            MouseButton::Middle => 3,
            _ => return,
        };
        if self.mouse_mode(&ev.modifiers) {
            self.mouse_button = Some(button);
            return self.mouse(g::MOUSE_PRESS, Some(button), true, ev.position, &ev.modifiers);
        }
        if button != 1 {
            return;
        }
        let Some((col, row)) = self.cell_at(ev.position) else { return };
        let mut vt = self.vt.lock().unwrap();
        self.anchor = vt.screen_point(col, row);
        let sel = vt.grid_ref(g::POINT_VIEWPORT, col, row as u32).and_then(|r| {
            let mut s = g::Selection { start: r, end: r, rectangle: false };
            let found = match ev.click_count {
                2 => unsafe { g::ghostty_terminal_select_word(vt.t, &g::SelectWordOptions { size: size_of::<g::SelectWordOptions>(), grid_ref: r, boundary_codepoints: null(), boundary_codepoints_len: 0 }, &mut s) },
                3 => unsafe { g::ghostty_terminal_select_line(vt.t, &g::SelectLineOptions { size: size_of::<g::SelectLineOptions>(), grid_ref: r, whitespace: null(), whitespace_len: 0, semantic_prompt_boundary: false }, &mut s) },
                _ => return None,
            };
            (found == g::SUCCESS).then_some(s)
        });
        vt.set_selection(sel.as_ref());
        cx.notify();
    }

    fn on_mouse_move(&mut self, ev: &MouseMoveEvent, _: &mut Window, cx: &mut Context<Self>) {
        if self.mouse_mode(&ev.modifiers) {
            let held = self.mouse_button.filter(|_| ev.pressed_button.is_some());
            return self.mouse(g::MOUSE_MOTION, held, held.is_some(), ev.position, &ev.modifiers);
        }
        let (Some((ax, ay)), Some(MouseButton::Left)) = (self.anchor, ev.pressed_button) else { return };
        let Some((col, row)) = self.cell_at(ev.position) else { return };
        let mut vt = self.vt.lock().unwrap();
        if let (Some(start), Some(end)) = (vt.grid_ref(g::POINT_SCREEN, ax, ay), vt.grid_ref(g::POINT_VIEWPORT, col, row as u32)) {
            vt.set_selection(Some(&g::Selection { start, end, rectangle: false }));
        }
        cx.notify();
    }

    fn on_mouse_up(&mut self, ev: &MouseUpEvent, _: &mut Window, _: &mut Context<Self>) {
        self.anchor = None;
        if let Some(b) = self.mouse_button.take()
            && self.mouse_mode(&ev.modifiers)
        {
            self.mouse(g::MOUSE_RELEASE, Some(b), false, ev.position, &ev.modifiers);
        }
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
        if self.mouse_mode(&ev.modifiers) {
            let wheel = if lines > 0 { 4 } else { 5 };
            for _ in 0..lines.unsigned_abs() {
                self.mouse(g::MOUSE_PRESS, Some(wheel), false, ev.position, &ev.modifiers);
            }
            return;
        }
        let mut vt = self.vt.lock().unwrap();
        if vt.alt_screen() && vt.mode(g::MODE_ALT_SCROLL) {
            // Full-screen apps (less, vim…) get arrow keys instead.
            let key: &[u8] = match (lines > 0, vt.mode(g::MODE_CURSOR_KEYS)) {
                (true, true) => b"\x1bOA",
                (true, false) => b"\x1b[A",
                (false, true) => b"\x1bOB",
                (false, false) => b"\x1b[B",
            };
            drop(vt);
            self.pty.write(key.repeat(lines.unsigned_abs() as usize));
        } else {
            vt.scroll(g::SCROLL_DELTA, -lines as isize);
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

fn hex(v: u32) -> g::Rgb {
    g::Rgb { r: (v >> 16) as u8, g: (v >> 8) as u8, b: v as u8 }
}

fn hsla(c: g::Rgb) -> Hsla {
    rgb(((c.r as u32) << 16) | ((c.g as u32) << 8) | c.b as u32).into()
}

fn to_rgb(c: Hsla) -> g::Rgb {
    let c = c.to_rgb();
    g::Rgb { r: (c.r * 255.) as u8, g: (c.g * 255.) as u8, b: (c.b * 255.) as u8 }
}

/// Palette color `i`: our ANSI 16, then xterm's color cube and grays.
fn palette_rgb(i: usize, dark: bool) -> g::Rgb {
    let level = |x: usize| if x == 0 { 0 } else { (55 + x * 40) as u8 };
    match i {
        0..16 => hex(if dark { ANSI_DARK } else { ANSI_LIGHT }[i]),
        16..232 => {
            let i = i - 16;
            g::Rgb { r: level(i / 36), g: level(i / 6 % 6), b: level(i % 6) }
        }
        _ => {
            let v = (8 + (i - 232) * 10) as u8;
            g::Rgb { r: v, g: v, b: v }
        }
    }
}

// --- Drawing ------------------------------------------------------------------

/// One row's text and its style runs.
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
    vt: Arc<Mutex<Vt>>,
    pty: Arc<Pty>,
    geometry: Rc<Cell<Option<Geometry>>>,
    cursor_bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
    marked: Option<String>,
}

fn cell_get<T>(cells: g::RowCells, key: i32, mut out: T) -> Option<T> {
    (unsafe { g::ghostty_render_state_row_cells_get(cells, key, &mut out as *mut T as *mut c_void) } == g::SUCCESS).then_some(out)
}

impl Painter {
    /// Lay out the grid in `bounds`: resize the terminal and PTY to fit, then build
    /// each row's shaped text and fills.
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

        let cols = (f32::from(bounds.size.width - px(PAD * 2.)) / f32::from(cell_w)).floor().clamp(2., u16::MAX as f32) as u16;
        let rows = (f32::from(bounds.size.height - px(PAD * 2.)) / f32::from(line_h)).floor().clamp(1., u16::MAX as f32) as u16;
        let mut vt = self.vt.lock().unwrap();
        let (fg_default, bg_default) = (to_rgb(theme.foreground), to_rgb(theme.background));
        vt.set_colors(fg_default, bg_default, dark);
        if vt.size != (cols, rows) {
            let cell = (f32::from(cell_w) as u16, f32::from(line_h) as u16);
            unsafe { g::ghostty_terminal_resize(vt.t, cols, rows, cell.0 as u32, cell.1 as u32) };
            vt.size = (cols, rows);
            self.pty.resize(cols, rows, cell);
        }

        let mut out_rows: Vec<Row> = Vec::with_capacity(rows as usize);
        let mut fills = vec![];
        let mut cursor_cell = None;
        let cell_bounds = |row: usize, col: usize, w: usize| Bounds::new(origin + point(cell_w * col as f32, line_h * row as f32), gpui_kit::size(cell_w * w as f32, line_h));
        unsafe {
            g::ghostty_render_state_update(vt.rs, vt.t);
            let mut cur = g::Cursor { size: size_of::<g::Cursor>(), ..Default::default() };
            g::ghostty_render_state_get(vt.rs, g::RS_CURSOR, &mut cur as *mut g::Cursor as *mut c_void);
            let cursor_at = (cur.visible && cur.viewport_has_value).then_some((cur.viewport_x as usize, cur.viewport_y as usize));
            let mut iter = vt.rows;
            g::ghostty_render_state_get(vt.rs, g::RS_ROW_ITERATOR, &mut iter as *mut g::RowIterator as *mut c_void);
            let mut row = 0;
            while g::ghostty_render_state_row_iterator_next(iter) {
                let mut r = Row { text: String::new(), runs: vec![] };
                let mut sel = g::RowSelection { size: size_of::<g::RowSelection>(), ..Default::default() };
                let selected = (g::ghostty_render_state_row_get(iter, g::ROW_SELECTION, &mut sel as *mut g::RowSelection as *mut c_void) == g::SUCCESS).then_some(sel.start_x as usize..=sel.end_x as usize);
                let mut cells = vt.cells;
                g::ghostty_render_state_row_get(iter, g::ROW_CELLS, &mut cells as *mut g::RowCells as *mut c_void);
                let mut col = 0;
                while g::ghostty_render_state_row_cells_next(cells) {
                    let style = cell_get(cells, g::CELL_STYLE, g::Style { fg: g::StyleColor { tag: 0, value: [0; 3] }, bg: g::StyleColor { tag: 0, value: [0; 3] }, underline_color: g::StyleColor { tag: 0, value: [0; 3] }, flags: 0, reserved: 0 });
                    let flags = style.map_or(0, |s| s.flags);
                    let mut fg = hsla(cell_get(cells, g::CELL_FG, g::Rgb::default()).unwrap_or(fg_default));
                    let own_bg = cell_get(cells, g::CELL_BG, g::Rgb::default());
                    let mut paint_bg = own_bg.is_some();
                    let mut bg = hsla(own_bg.unwrap_or(bg_default));
                    if flags & g::STYLE_INVERSE != 0 {
                        std::mem::swap(&mut fg, &mut bg);
                        paint_bg = true;
                    }
                    if flags & g::STYLE_FAINT != 0 {
                        fg = fg.opacity(0.7);
                    }
                    if flags & g::STYLE_INVISIBLE != 0 {
                        fg = bg;
                    }
                    if selected.as_ref().is_some_and(|s| s.contains(&col)) {
                        bg = theme.selection;
                        paint_bg = true;
                    }
                    if cursor_at == Some((col, row)) {
                        let wide = cell_get(cells, g::CELL_RAW, 0u64).and_then(|raw| {
                            let mut w = 0i32;
                            (g::ghostty_cell_get(raw, g::CELL_DATA_WIDE, &mut w as *mut i32 as *mut c_void) == g::SUCCESS).then_some(w)
                        }) == Some(g::CELL_WIDE);
                        let block = focused && cur.visual_style == g::CURSOR_BLOCK;
                        cursor_cell = Some((cell_bounds(row, col, if wide { 2 } else { 1 }), block, cur.visual_style));
                        if block {
                            fg = theme.background;
                        }
                    }
                    if paint_bg {
                        fills.push((cell_bounds(row, col, 1), bg));
                    }
                    let mut utf8 = [0u8; 64];
                    let mut buf = g::Buffer { ptr: utf8.as_mut_ptr(), cap: utf8.len(), len: 0 };
                    let text = match g::ghostty_render_state_row_cells_get(cells, g::CELL_UTF8, &mut buf as *mut g::Buffer as *mut c_void) {
                        g::SUCCESS if buf.len > 0 => std::str::from_utf8(&utf8[..buf.len]).unwrap_or(" "),
                        _ => " ",
                    };
                    let mut f = font.clone();
                    if flags & g::STYLE_BOLD != 0 {
                        f.weight = FontWeight::BOLD;
                    }
                    if flags & g::STYLE_ITALIC != 0 {
                        f.style = FontStyle::Italic;
                    }
                    let ul = (flags >> g::UNDERLINE_SHIFT) & 7;
                    let underline = (ul != 0).then(|| UnderlineStyle { thickness: px(1.), color: Some(fg), wavy: ul == 3 });
                    let strikethrough = (flags & g::STYLE_STRIKETHROUGH != 0).then(|| StrikethroughStyle { thickness: px(1.), color: Some(fg) });
                    r.text.push_str(text);
                    match r.runs.last_mut() {
                        Some(last) if last.font == f && last.color == fg && last.underline == underline && last.strikethrough == strikethrough => last.len += text.len(),
                        _ => r.runs.push(TextRun { len: text.len(), font: f, color: fg, background_color: None, underline, strikethrough }),
                    }
                    col += 1;
                }
                out_rows.push(r);
                row += 1;
            }
        }
        drop(vt);

        let cursor = cursor_cell.map(|(b, block, shape)| {
            let b = match shape {
                _ if !focused || block => b,
                g::CURSOR_BAR => Bounds::new(b.origin, gpui_kit::size(px(2.), b.size.height)),
                g::CURSOR_UNDERLINE => Bounds::new(b.origin + point(px(0.), b.size.height - px(2.)), gpui_kit::size(b.size.width, px(2.))),
                _ => b,
            };
            // Solid for a focused block/bar/underline; an outline when unfocused or hollow.
            (b, theme.foreground, focused && shape != g::CURSOR_HOLLOW)
        });
        self.cursor_bounds.set(cursor.map(|c| c.0));
        let marked = self.marked.as_ref().zip(cursor).map(|(m, (b, ..))| {
            let run = TextRun { len: m.len(), font: font.clone(), color: theme.foreground, background_color: None, underline: Some(UnderlineStyle { thickness: px(1.), color: Some(theme.foreground), wavy: false }), strikethrough: None };
            let line = window.text_system().shape_line(m.clone().into(), font_size, &[run], Some(cell_w));
            (line, Bounds::new(b.origin, gpui_kit::size(cell_w * m.chars().count() as f32, line_h)))
        });
        let rows = out_rows
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
        let painter = Painter { vt: self.vt.clone(), pty: self.pty.clone(), geometry: self.geometry.clone(), cursor_bounds: self.cursor_bounds.clone(), marked: self.marked.clone() };
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
    use super::{Ctx, Event, RUN_DONE, Run, Vt, ghostty_key, start};
    use std::os::fd::AsRawFd as _;
    use crate::ghostty as g;

    fn vt() -> Vt {
        Vt::new(80, 24, Ctx { events: async_channel::unbounded().0, pty: std::sync::mpsc::channel().0 }).unwrap()
    }

    fn key(vt: &mut Vt, name: &str, mods: u16) -> Vec<u8> {
        let (k, text) = ghostty_key(name).unwrap();
        vt.encode_key(k, mods, text)
    }

    #[test]
    fn keys() {
        let mut vt = vt();
        assert_eq!(key(&mut vt, "enter", 0), b"\r");
        assert_eq!(key(&mut vt, "c", g::MODS_CTRL), [3]);
        assert_eq!(key(&mut vt, "space", g::MODS_CTRL), [0]);
        assert_eq!(key(&mut vt, "up", 0), b"\x1b[A");
        assert_eq!(key(&mut vt, "right", g::MODS_SHIFT), b"\x1b[1;2C");
        assert_eq!(key(&mut vt, "f5", 0), b"\x1b[15~");
        assert_eq!(key(&mut vt, "tab", g::MODS_SHIFT), b"\x1b[Z");
        assert_eq!(key(&mut vt, "backspace", g::MODS_ALT), b"\x1b\x7f");
        vt.write(b"\x1b[?1h"); // application cursor keys
        assert_eq!(key(&mut vt, "up", 0), b"\x1bOA");
        assert!(ghostty_key("a").is_some_and(|(_, t)| t == "a"));
    }

    #[test]
    fn screen_and_selection() {
        let mut vt = vt();
        vt.write(b"hello \x1b[1;32mworld\x1b[0m\r\nsecond");
        assert_eq!(vt.text(false).unwrap().trim(), "hello world\nsecond");
        let (a, b) = (vt.grid_ref(g::POINT_VIEWPORT, 6, 0).unwrap(), vt.grid_ref(g::POINT_VIEWPORT, 10, 0).unwrap());
        vt.set_selection(Some(&g::Selection { start: a, end: b, rectangle: false }));
        assert_eq!(vt.text(true).unwrap(), "world");
        assert_eq!(vt.screen_point(1, 1), Some((1, 1)));
    }

    /// A real shell on a PTY: the command's output lands in the grid.
    #[test]
    fn runs_a_command() {
        let dir = std::env::temp_dir();
        let s = start(&dir.to_string_lossy(), Some(Run { label: "t".into(), command: "printf FR-%s OK".into(), close_on_success: false })).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let text = s.vt.lock().unwrap().text(false).unwrap_or_default();
            if text.contains("FR-OK") {
                break;
            }
            assert!(std::time::Instant::now() < deadline, "no output: {text:?}");
            let _ = s.rx.recv_blocking();
        }
    }
    /// Close on success: a passing command ends the shell with 0; a failing one
    /// leaves an interactive shell running (no exit).
    #[test]
    fn closes_only_on_success() {
        let run = |command: &str| {
            let dir = std::env::temp_dir();
            let s = start(&dir.to_string_lossy(), Some(Run { label: "t".into(), command: command.into(), close_on_success: true })).unwrap();
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            while std::time::Instant::now() < deadline {
                match s.rx.try_recv() {
                    Ok(Event::Exit(code)) => return Some(code),
                    Ok(_) => {}
                    Err(_) => std::thread::sleep(std::time::Duration::from_millis(20)),
                }
            }
            None
        };
        assert_eq!(run("true; echo done # trailing comment"), Some(Some(0)));
        assert_eq!(run("false"), None, "a failed command keeps the shell open");
    }

    /// Busy detection: a run command announces when it's done; a job typed in the
    /// shell takes the terminal's foreground process group, and gives it back.
    #[test]
    fn busy() {
        let dir = std::env::temp_dir().to_string_lossy().into_owned();
        let s = start(&dir, Some(Run { label: "t".into(), command: "sleep 1".into(), close_on_success: false })).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        while !matches!(s.rx.recv_blocking(), Ok(Event::Title(t)) if t == RUN_DONE) {
            assert!(std::time::Instant::now() < deadline, "no run-done marker");
        }
        let fg = || unsafe { libc::tcgetpgrp(s.pty.master.as_raw_fd()) };
        let wait_for = |want_busy: bool| {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
            while (fg() != s.pty.pid) != want_busy {
                assert!(std::time::Instant::now() < deadline, "foreground group never became busy={want_busy}");
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        };
        wait_for(false);
        s.pty.tx.send(b"sleep 2\n".to_vec()).unwrap();
        wait_for(true);
        wait_for(false);
    }
}
