//! Hand-written bindings to the parts of libghostty-vt's C API (1.0, stable ABI)
//! that the terminal tab uses. Headers: vendor/ghostty-vt.xcframework/*/Headers.
#![allow(non_camel_case_types, dead_code)]

use std::ffi::c_void;

pub type Result = i32;
pub const SUCCESS: Result = 0;
pub const OUT_OF_SPACE: Result = -3;
pub const NO_VALUE: Result = -4;

pub type Terminal = *mut c_void;
pub type RenderState = *mut c_void;
pub type RowIterator = *mut c_void;
pub type RowCells = *mut c_void;
pub type KeyEncoder = *mut c_void;
pub type KeyEvent = *mut c_void;
pub type MouseEncoder = *mut c_void;
pub type MouseEvent = *mut c_void;
pub type Formatter = *mut c_void;
type Alloc = *const c_void;

#[repr(C)]
#[derive(Clone, Copy)]
pub struct Str {
    pub ptr: *const u8,
    pub len: usize,
}

#[repr(C)]
pub struct Buffer {
    pub ptr: *mut u8,
    pub cap: usize,
    pub len: usize,
}

#[repr(C)]
#[derive(Clone, Copy, Default, PartialEq)]
pub struct Rgb {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct StyleColor {
    pub tag: u8,
    pub value: [u8; 3],
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct Style {
    pub fg: StyleColor,
    pub bg: StyleColor,
    pub underline_color: StyleColor,
    pub flags: u16,
    pub reserved: u16,
}
pub const STYLE_BOLD: u16 = 1 << 0;
pub const STYLE_ITALIC: u16 = 1 << 1;
pub const STYLE_FAINT: u16 = 1 << 2;
pub const STYLE_INVERSE: u16 = 1 << 4;
pub const STYLE_INVISIBLE: u16 = 1 << 5;
pub const STYLE_STRIKETHROUGH: u16 = 1 << 6;
/// Underline kind, `(flags >> 8) & 7`: 0 none, 3 curly.
pub const UNDERLINE_SHIFT: u16 = 8;

/// `{ tag; union { {u16 x; u32 y}; u64[2] } }` — the union is 8-aligned.
#[repr(C)]
#[derive(Clone, Copy)]
pub struct Point {
    pub tag: i32,
    pub value: PointValue,
}

#[repr(C, align(8))]
#[derive(Clone, Copy)]
pub struct PointValue {
    pub x: u16,
    pub y: u32,
    _pad: u64,
}
pub const POINT_VIEWPORT: i32 = 1;
pub const POINT_SCREEN: i32 = 2;

impl Point {
    pub fn new(tag: i32, x: u16, y: u32) -> Self {
        Point { tag, value: PointValue { x, y, _pad: 0 } }
    }
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct PointCoordinate {
    pub x: u16,
    pub y: u32,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct GridRef {
    pub node: *mut c_void,
    pub x: u16,
    pub y: u16,
}

#[repr(C)]
#[derive(Clone, Copy)]
pub struct Selection {
    pub start: GridRef,
    pub end: GridRef,
    pub rectangle: bool,
}

#[repr(C)]
pub struct SelectWordOptions {
    pub size: usize,
    pub grid_ref: GridRef,
    pub boundary_codepoints: *const u32,
    pub boundary_codepoints_len: usize,
}

#[repr(C)]
pub struct SelectLineOptions {
    pub size: usize,
    pub grid_ref: GridRef,
    pub whitespace: *const u32,
    pub whitespace_len: usize,
    pub semantic_prompt_boundary: bool,
}

#[repr(C)]
pub struct ScrollViewport {
    pub tag: i32,
    pub delta: isize,
    _pad: u64,
}
pub const SCROLL_BOTTOM: i32 = 1;
pub const SCROLL_DELTA: i32 = 2;

impl ScrollViewport {
    pub fn new(tag: i32, delta: isize) -> Self {
        ScrollViewport { tag, delta, _pad: 0 }
    }
}

#[repr(C)]
pub struct ModeConfig {
    pub mode: u16,
    pub value: bool,
}
pub const MODE_CURSOR_KEYS: u16 = 1;
pub const MODE_ALT_SCROLL: u16 = 1007;
pub const MODE_BRACKETED_PASTE: u16 = 2004;

#[repr(C)]
#[derive(Default)]
pub struct Cursor {
    pub size: usize,
    pub viewport_has_value: bool,
    pub viewport_x: u16,
    pub viewport_y: u16,
    pub wide_tail: bool,
    pub visible: bool,
    pub blinking: bool,
    pub password_input: bool,
    pub visual_style: i32,
}
pub const CURSOR_BAR: i32 = 0;
pub const CURSOR_BLOCK: i32 = 1;
pub const CURSOR_UNDERLINE: i32 = 2;
pub const CURSOR_HOLLOW: i32 = 3;

#[repr(C)]
#[derive(Default)]
pub struct RowSelection {
    pub size: usize,
    pub start_x: u16,
    pub end_x: u16,
}

#[repr(C)]
pub struct MouseEncoderSize {
    pub size: usize,
    pub screen_width: u32,
    pub screen_height: u32,
    pub cell_width: u32,
    pub cell_height: u32,
    pub padding_top: u32,
    pub padding_bottom: u32,
    pub padding_right: u32,
    pub padding_left: u32,
}

#[repr(C)]
pub struct MousePosition {
    pub x: f32,
    pub y: f32,
}

#[repr(C)]
pub struct ClipboardContent {
    pub mime: Str,
    pub data: Str,
}

#[repr(C)]
pub struct ClipboardWriteReply {
    pub size: usize,
    pub result: i32,
    pub remember: bool,
}

#[repr(C)]
pub struct ClipboardWrite {
    pub location: i32,
    pub contents: *const ClipboardContent,
    pub contents_len: usize,
    pub name: Str,
    pub granted: bool,
    pub can_remember: bool,
    pub ctx: *const c_void,
    pub reply: extern "C" fn(*const ClipboardWrite, *const ClipboardWriteReply),
}

pub type WritePtyFn = extern "C" fn(Terminal, *mut c_void, *const u8, usize);
pub type NotifyFn = extern "C" fn(Terminal, *mut c_void);
pub type ClipboardWriteFn = extern "C" fn(Terminal, *mut c_void, *const ClipboardWrite);

// Terminal options / data keys.
pub const OPT_USERDATA: i32 = 1;
pub const OPT_WRITE_PTY: i32 = 2;
pub const OPT_TITLE_CHANGED: i32 = 6;
pub const OPT_COLOR_FOREGROUND: i32 = 12;
pub const OPT_COLOR_BACKGROUND: i32 = 13;
pub const OPT_COLOR_PALETTE: i32 = 15;
pub const OPT_SELECTION: i32 = 22;
pub const OPT_CLIPBOARD_WRITE: i32 = 27;
pub const OPT_SCROLLBACK_MAX_BYTES: i32 = 28;
pub const OPT_SCROLLBACK_MAX_LINES: i32 = 29;
pub const DATA_COLS: i32 = 1;
pub const DATA_ROWS: i32 = 2;
pub const DATA_ACTIVE_SCREEN: i32 = 6;
pub const DATA_MOUSE_TRACKING: i32 = 11;
pub const DATA_TITLE: i32 = 12;
pub const DATA_SELECTION: i32 = 31;
pub const DATA_MODE: i32 = 37;

// Render state keys.
pub const RS_ROW_ITERATOR: i32 = 4;
pub const RS_CURSOR: i32 = 18;
pub const ROW_CELLS: i32 = 3;
pub const ROW_SELECTION: i32 = 4;
pub const CELL_RAW: i32 = 1;
pub const CELL_STYLE: i32 = 2;
pub const CELL_BG: i32 = 5;
pub const CELL_FG: i32 = 6;
pub const CELL_UTF8: i32 = 9;
pub const CELL_DATA_WIDE: i32 = 3;
pub const CELL_WIDE: i32 = 1;

// Input.
pub const KEY_PRESS: i32 = 1;
pub const MODS_SHIFT: u16 = 1 << 0;
pub const MODS_CTRL: u16 = 1 << 1;
pub const MODS_ALT: u16 = 1 << 2;
pub const MODS_SUPER: u16 = 1 << 3;
pub const KEY_ENC_OPTION_AS_ALT: i32 = 7;
pub const MOUSE_PRESS: i32 = 0;
pub const MOUSE_RELEASE: i32 = 1;
pub const MOUSE_MOTION: i32 = 2;
pub const MOUSE_ENC_SIZE: i32 = 3;
pub const MOUSE_ENC_ANY_PRESSED: i32 = 4;
pub const MOUSE_ENC_TRACK_LAST_CELL: i32 = 5;
pub const FORMATTER_EMIT: i32 = 1;
pub const FORMATTER_UNWRAP: i32 = 2;
pub const FORMATTER_TRIM: i32 = 3;
pub const FORMATTER_SELECTION: i32 = 4;

unsafe extern "C" {
    pub fn ghostty_terminal_new(alloc: Alloc, out: *mut Terminal, cols: u16, rows: u16) -> Result;
    pub fn ghostty_terminal_free(t: Terminal);
    pub fn ghostty_terminal_resize(t: Terminal, cols: u16, rows: u16, cell_w: u32, cell_h: u32) -> Result;
    pub fn ghostty_terminal_set(t: Terminal, opt: i32, value: *const c_void) -> Result;
    pub fn ghostty_terminal_get(t: Terminal, data: i32, out: *mut c_void) -> Result;
    pub fn ghostty_terminal_vt_write(t: Terminal, data: *const u8, len: usize);
    pub fn ghostty_terminal_scroll_viewport(t: Terminal, s: ScrollViewport) -> Result;
    pub fn ghostty_terminal_grid_ref(t: Terminal, p: Point, out: *mut GridRef) -> Result;
    pub fn ghostty_terminal_point_from_grid_ref(t: Terminal, r: *const GridRef, tag: i32, out: *mut PointCoordinate) -> Result;
    pub fn ghostty_terminal_select_word(t: Terminal, o: *const SelectWordOptions, out: *mut Selection) -> Result;
    pub fn ghostty_terminal_select_line(t: Terminal, o: *const SelectLineOptions, out: *mut Selection) -> Result;

    pub fn ghostty_render_state_new(alloc: Alloc, out: *mut RenderState) -> Result;
    pub fn ghostty_render_state_free(s: RenderState);
    pub fn ghostty_render_state_update(s: RenderState, t: Terminal) -> Result;
    pub fn ghostty_render_state_get(s: RenderState, data: i32, out: *mut c_void) -> Result;
    pub fn ghostty_render_state_row_iterator_new(alloc: Alloc, out: *mut RowIterator) -> Result;
    pub fn ghostty_render_state_row_iterator_free(i: RowIterator);
    pub fn ghostty_render_state_row_iterator_next(i: RowIterator) -> bool;
    pub fn ghostty_render_state_row_get(i: RowIterator, data: i32, out: *mut c_void) -> Result;
    pub fn ghostty_render_state_row_cells_new(alloc: Alloc, out: *mut RowCells) -> Result;
    pub fn ghostty_render_state_row_cells_free(c: RowCells);
    pub fn ghostty_render_state_row_cells_next(c: RowCells) -> bool;
    pub fn ghostty_render_state_row_cells_get(c: RowCells, data: i32, out: *mut c_void) -> Result;
    pub fn ghostty_cell_get(cell: u64, data: i32, out: *mut c_void) -> Result;

    pub fn ghostty_key_encoder_new(alloc: Alloc, out: *mut KeyEncoder) -> Result;
    pub fn ghostty_key_encoder_free(e: KeyEncoder);
    pub fn ghostty_key_encoder_set(e: KeyEncoder, opt: i32, value: *const c_void) -> Result;
    pub fn ghostty_key_encoder_set_from_terminal(e: KeyEncoder, t: Terminal) -> Result;
    pub fn ghostty_key_encoder_encode(e: KeyEncoder, ev: KeyEvent, buf: *mut u8, len: usize, written: *mut usize) -> Result;
    pub fn ghostty_key_event_new(alloc: Alloc, out: *mut KeyEvent) -> Result;
    pub fn ghostty_key_event_free(ev: KeyEvent);
    pub fn ghostty_key_event_set_action(ev: KeyEvent, a: i32) -> Result;
    pub fn ghostty_key_event_set_key(ev: KeyEvent, k: i32) -> Result;
    pub fn ghostty_key_event_set_mods(ev: KeyEvent, m: u16) -> Result;
    pub fn ghostty_key_event_set_utf8(ev: KeyEvent, s: Str) -> Result;
    pub fn ghostty_key_event_set_unshifted_codepoint(ev: KeyEvent, c: u32) -> Result;

    pub fn ghostty_mouse_encoder_new(alloc: Alloc, out: *mut MouseEncoder) -> Result;
    pub fn ghostty_mouse_encoder_free(e: MouseEncoder);
    pub fn ghostty_mouse_encoder_set(e: MouseEncoder, opt: i32, value: *const c_void) -> Result;
    pub fn ghostty_mouse_encoder_set_from_terminal(e: MouseEncoder, t: Terminal) -> Result;
    pub fn ghostty_mouse_encoder_encode(e: MouseEncoder, ev: MouseEvent, buf: *mut u8, len: usize, written: *mut usize) -> Result;
    pub fn ghostty_mouse_event_new(alloc: Alloc, out: *mut MouseEvent) -> Result;
    pub fn ghostty_mouse_event_free(ev: MouseEvent);
    pub fn ghostty_mouse_event_set_action(ev: MouseEvent, a: i32) -> Result;
    pub fn ghostty_mouse_event_set_button(ev: MouseEvent, b: i32) -> Result;
    pub fn ghostty_mouse_event_clear_button(ev: MouseEvent) -> Result;
    pub fn ghostty_mouse_event_set_mods(ev: MouseEvent, m: u16) -> Result;
    pub fn ghostty_mouse_event_set_position(ev: MouseEvent, p: MousePosition) -> Result;

    pub fn ghostty_paste_encode(data: *mut u8, len: usize, bracketed: bool, buf: *mut u8, buf_len: usize, written: *mut usize) -> Result;

    pub fn ghostty_formatter_terminal_new(alloc: Alloc, out: *mut Formatter, t: Terminal) -> Result;
    pub fn ghostty_formatter_set(f: Formatter, opt: i32, value: *const c_void) -> Result;
    pub fn ghostty_formatter_format_alloc(f: Formatter, alloc: Alloc, out: *mut *mut u8, len: *mut usize) -> Result;
    pub fn ghostty_formatter_free(f: Formatter);
    pub fn ghostty_free(alloc: Alloc, ptr: *mut u8, len: usize);
}
