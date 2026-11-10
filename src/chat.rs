//! One chat tab: its event log (shared format with the Electron app), the rows
//! derived from it in a virtualized MessageScroller, and the composer. Saved and
//! new chats are the same thing: the agent starts lazily on first send, resuming
//! its own context from the log's last `system` event.

mod agent_diff;
mod elicitation;
mod find;
mod fresh;
mod pins;
mod transcript;

pub(crate) use pins::{NoteView, pin_title, pinned_text};

use std::{
    collections::{HashMap, HashSet},
    time::{Duration, Instant},
};

use gpui_kit::component::button::{Button, ButtonCustomVariant, ButtonVariants as _};
use gpui_kit::component::popover::Popover;
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::component::input::{InputEvent, Textarea, TextareaState};
use gpui_kit::component::menu::{DropdownMenu as _, PopupMenuItem};
use gpui_kit::component::message_scroller::{MessageScroller, MessageScrollerState};
use gpui_kit::component::*;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;
use serde_json::{Value, json};

use crate::acp::{Agent, StartOpts};
use crate::log::{self as chatlog, ChatLog, now_ms};
use crate::settings::Settings;
use crate::{sidebar, theme};
use elicitation::Elicit;
use agent_diff::FileDiff;
use transcript::Item;

/// What a chat tells the shell around it.
pub enum ChatEvent {
    /// "View diff" on an agent's edit: the file's text before and after.
    OpenDiff { path: String, old: String, new: String },
    /// A forked or Start fresh chat to open in a new tab (it already has its title).
    Branched { log_id: String },
    /// `attention()` changed.
    StatusChanged,
    /// "Open beside" on a pinned message: show it in a read-only tab next to the chat.
    OpenNote { key: String, title: String, text: String },
    TitleChanged,
}

impl EventEmitter<ChatEvent> for ChatView {}

/// What a chat wants from you, most urgent first (for tab / sidebar dots): `min` is the most urgent.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum Attention {
    NeedsAnswer,
    Working,
    Unread,
    Idle,
}

enum Row {
    User { text: String, steered: bool, attachments: Vec<(String, bool)>, ts: Option<i64> },
    Assistant { text: String, message_id: Option<String>, ts: Option<i64> },
    Thinking(String),
    Tool { title: String, status: &'static str, output: String, diffs: Vec<FileDiff> },
    Permission { id: String, title: String, input: Value, options: Vec<(String, String, String)>, answer: Option<String> },
    Elicitation(Elicit),
    Info(String),
}

/// How an event changed the rows.
enum Change {
    None,
    Appended,
    Updated(usize),
}

#[derive(Default)]
struct Rows {
    rows: Vec<Row>,
    tools: HashMap<String, usize>,
    perms: HashMap<String, usize>,
    elicits: HashMap<String, usize>,
    /// The latest plan: (content, status).
    plan: Vec<(String, String)>,
    /// Pinned agent messages' ids, newest first.
    pins: Vec<String>,
}

impl Rows {
    fn apply(&mut self, e: &Value) -> Change {
        let s = |k: &str| e[k].as_str().unwrap_or_default().to_string();
        let ts = e["ts"].as_i64();
        match e["type"].as_str().unwrap_or_default() {
            "user_text" => self.push(Row::User {
                text: s("text"),
                steered: e["steered"] == true,
                attachments: e["attachments"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|a| a["name"].as_str().map(|n| (n.to_string(), a["isImage"] == true)))
                    .collect(),
                ts,
            }),
            "assistant_text" => match self.rows.last_mut() {
                Some(Row::Assistant { text, message_id, .. }) => {
                    text.push_str(&s("text"));
                    if let Some(mid) = e["messageId"].as_str() {
                        *message_id = Some(mid.to_string());
                    }
                    Change::Updated(self.rows.len() - 1)
                }
                _ => self.push(Row::Assistant { text: s("text"), message_id: e["messageId"].as_str().map(str::to_string), ts }),
            },
            "thinking" => match self.rows.last_mut() {
                Some(Row::Thinking(t)) => {
                    t.push_str(&s("text"));
                    Change::Updated(self.rows.len() - 1)
                }
                _ => self.push(Row::Thinking(s("text"))),
            },
            "tool_use" => {
                self.tools.insert(s("id"), self.rows.len());
                self.push(Row::Tool { title: s("name"), status: "running", output: String::new(), diffs: diffs_of(e) })
            }
            "tool_result" => {
                let Some(&ix) = self.tools.get(&s("id")) else { return Change::None };
                if let Some(Row::Tool { status, output, diffs, .. }) = self.rows.get_mut(ix) {
                    *status = if e["ok"] == false { "failed" } else { "done" };
                    *output = s("summary");
                    if diffs.is_empty() {
                        *diffs = diffs_of(e);
                    }
                }
                Change::Updated(ix)
            }
            "permission" => {
                self.perms.insert(s("id"), self.rows.len());
                let options = e["options"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|o| {
                        let f = |k: &str| o[k].as_str().unwrap_or_default().to_string();
                        (f("id"), f("label"), f("kind"))
                    })
                    .collect();
                self.push(Row::Permission { id: s("id"), title: s("toolName"), input: e["input"].clone(), options, answer: None })
            }
            "permission_resolved" => {
                let Some(&ix) = self.perms.get(&s("id")) else { return Change::None };
                if let Some(Row::Permission { answer, .. }) = self.rows.get_mut(ix) {
                    *answer = Some(s("label"));
                }
                Change::Updated(ix)
            }
            "elicitation" => {
                self.elicits.insert(s("id"), self.rows.len());
                self.push(Row::Elicitation(Elicit::from_event(e)))
            }
            "elicitation_resolved" => {
                let Some(&ix) = self.elicits.get(&s("id")) else { return Change::None };
                if let Some(Row::Elicitation(el)) = self.rows.get_mut(ix) {
                    el.done = true;
                }
                Change::Updated(ix)
            }
            "plan" => {
                self.plan = e["entries"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(|p| (p["content"].as_str().unwrap_or_default().to_string(), p["status"].as_str().unwrap_or_default().to_string()))
                    .collect();
                Change::None
            }
            "pin" => {
                self.apply_pin(&s("messageId"), e["on"] != false);
                Change::None
            }
            "error" => self.push(Row::Info(format!("Error: {}", s("message")))),
            _ => Change::None,
        }
    }

    fn push(&mut self, row: Row) -> Change {
        self.rows.push(row);
        Change::Appended
    }

    /// Open (permission prompts, elicitation forms) waiting on you.
    fn open_asks(&self) -> (usize, usize) {
        (
            self.perms.values().filter(|&&ix| matches!(self.rows.get(ix), Some(Row::Permission { answer: None, .. }))).count(),
            self.elicits.values().filter(|&&ix| matches!(self.rows.get(ix), Some(Row::Elicitation(e)) if !e.done)).count(),
        )
    }

    fn pending_ask(&self) -> bool {
        self.open_asks() != (0, 0)
    }

    /// Resolution events for every open ask — for when the agent that asked is gone.
    fn cancel_asks(&self) -> Vec<Value> {
        let perms = self.perms.iter().filter(|&(_, &ix)| matches!(self.rows.get(ix), Some(Row::Permission { answer: None, .. })));
        let elicits = self.elicits.iter().filter(|&(_, &ix)| matches!(self.rows.get(ix), Some(Row::Elicitation(e)) if !e.done));
        perms
            .map(|(id, _)| json!({ "type": "permission_resolved", "id": id, "label": "Cancelled" }))
            .chain(elicits.map(|(id, _)| json!({ "type": "elicitation_resolved", "id": id })))
            .collect()
    }
}

fn diffs_of(e: &Value) -> Vec<FileDiff> {
    let s = |d: &Value, k: &str| d[k].as_str().unwrap_or_default().to_string();
    e["diffs"].as_array().into_iter().flatten().filter(|d| d["path"].is_string()).map(|d| FileDiff::new(s(d, "path"), s(d, "oldText"), s(d, "newText"))).collect()
}

/// A file or image attached to the next message.
#[derive(Clone)]
struct Attachment {
    name: String,
    mime: String,
    bytes: std::sync::Arc<Vec<u8>>,
    /// Decoded for the thumbnail chip (images only).
    image: Option<std::sync::Arc<Image>>,
}

impl Attachment {
    fn from_path(path: &std::path::Path) -> Option<Self> {
        let bytes = std::fs::read(path).ok()?;
        let name = path.file_name()?.to_string_lossy().into_owned();
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or_default().to_lowercase();
        let format = match ext.as_str() {
            "png" => Some(ImageFormat::Png),
            "jpg" | "jpeg" => Some(ImageFormat::Jpeg),
            "gif" => Some(ImageFormat::Gif),
            "webp" => Some(ImageFormat::Webp),
            _ => None,
        };
        Some(match format {
            Some(f) => Self::image(name, f, bytes),
            None => Self { name, mime: "application/octet-stream".into(), bytes: bytes.into(), image: None },
        })
    }

    fn image(name: String, format: ImageFormat, bytes: Vec<u8>) -> Self {
        let image = std::sync::Arc::new(Image::from_bytes(format, bytes.clone()));
        Self { name, mime: format.mime_type().into(), bytes: bytes.into(), image: Some(image) }
    }
}

/// A message on its way out (or waiting in the queue).
#[derive(Clone)]
struct Outgoing {
    text: String,
    attachments: Vec<Attachment>,
}

impl Outgoing {
    /// ACP content blocks, like the Electron driver's promptBlocks: images as image
    /// blocks, text files inlined in a fence, binaries noted by name.
    fn blocks(&self) -> Value {
        use base64::Engine as _;
        let mut blocks = vec![];
        if !self.text.is_empty() {
            blocks.push(json!({ "type": "text", "text": self.text }));
        }
        for a in &self.attachments {
            if a.mime.starts_with("image/") {
                let data = base64::engine::general_purpose::STANDARD.encode(a.bytes.as_slice());
                blocks.push(json!({ "type": "image", "data": data, "mimeType": a.mime }));
            } else {
                let text = match std::str::from_utf8(&a.bytes) {
                    Ok(t) => format!("Attached file `{}`:\n```\n{t}\n```", a.name),
                    Err(_) => format!("Attached file `{}` (binary, not included).", a.name),
                };
                blocks.push(json!({ "type": "text", "text": text }));
            }
        }
        if blocks.is_empty() {
            blocks.push(json!({ "type": "text", "text": "" }));
        }
        Value::Array(blocks)
    }
}

#[derive(PartialEq, Clone, Copy)]
enum Status {
    Idle,
    Starting,
    Working,
}

pub struct ChatView {
    log: ChatLog,
    cwd: String,
    rows: Rows,
    scroller: Entity<MessageScrollerState>,
    input: Entity<TextareaState>,
    agent: Option<Agent>,
    status: Status,
    /// The agent's config options (model / mode / effort …), as last reported.
    config: Vec<Value>,
    /// The chat's own last choices, re-applied when a resumed agent comes up.
    restore_config: Option<Vec<Value>>,
    queue: Vec<Outgoing>,
    attachments: Vec<Attachment>,
    /// The composer has text (drives Send vs Stop / Queue).
    has_text: bool,
    /// Switched provider: the next agent starts a fresh session (the old id
    /// belongs to the other agent).
    fresh: bool,
    /// The agent's slash commands (name, description), and the "/prefix" being typed.
    commands: Vec<(String, String)>,
    slash: Option<String>,
    /// The ✦ settings menu: open, and which row's choices are showing.
    menu_open: bool,
    menu_row: Option<usize>,
    persist: Option<Task<()>>,
    persist_due: bool,
    ticker: crate::anim::Ticker,
    /// The list items the scroller shows (rows folded into strips).
    items: Vec<Item>,
    /// Disclosures flipped from their default, by row; strips by their first row.
    open: HashSet<usize>,
    open_strips: HashSet<usize>,
    plan_open: bool,
    /// The pins strip is expanded; the message highlighted after "Jump to".
    pins_open: bool,
    flash: Option<usize>,
    flash_task: Option<Task<()>>,
    forest_word: &'static str,
    recent_words: Vec<&'static str>,
    activity: Option<Task<()>>,
    /// A composer image shown full size.
    viewing: Option<std::sync::Arc<Image>>,
    /// A turn finished while you weren't looking.
    unread: bool,
    /// Marked unread at this agent message: opening the chat again jumps to it.
    unread_at: Option<String>,
    focused_by_user: bool,
    attention: Attention,
    /// Bumped whenever the agent is replaced, so a stopped one's late events are ignored.
    agent_gen: u64,
    /// An agent ran for this chat in this run (so a relaunch restores its picks
    /// rather than applying the default mode).
    had_agent: bool,
    /// The agent's session is up (it can fork / set modes).
    session_up: bool,
    /// Settings' default mode, applied once the first agent reports its options.
    default_mode: Option<String>,
    /// A permission mode picked from the built-in list (agents with no mode option);
    /// the next launch starts in it.
    permission_mode: Option<String>,
    /// Steers waiting on their `steer_result`, by tag.
    steers: HashMap<String, Outgoing>,
    /// After a cancel: treat the turn as over if the agent never says so.
    grace: Option<Task<()>>,
    /// The provider changed mid-turn: relaunch when it ends.
    relaunch: bool,
    /// The tag of the prompt whose turn is running (see acp `Pending::Prompt`).
    current_prompt: Option<String>,
    /// Prompts given up on after a cancel: their late result / error is dropped.
    stale_prompts: HashSet<String>,
    /// "Branch from here" waiting for the session to come up.
    pending_branch: Option<String>,
    last_activity: Instant,
    find: Option<find::Find>,
    fresh_banner: bool,
    /// Drawn heights, for pinning: each list item (as last painted), and the pinned copy.
    item_h: std::rc::Rc<std::cell::RefCell<HashMap<usize, Pixels>>>,
    pinned_h: std::rc::Rc<std::cell::Cell<Pixels>>,
    forms: HashMap<String, elicitation::Form>,
    _tasks: Vec<Task<()>>,
    _subs: Vec<Subscription>,
}

impl ChatView {
    /// A saved chat. Nothing runs until you send. (A just-made Start fresh chat
    /// starts right away, sending its carry-over.)
    pub fn open(id: &str, cwd: &str, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let Some((log, prompt)) = fresh::take(id) else { return Self::build(ChatLog::open(id), cwd, window, cx) };
        let mut view = Self::build(log, cwd, window, cx);
        match prompt {
            Some(p) => view.send_text(p, cx),
            None => view.ensure_agent(cx),
        }
        view
    }

    /// A new chat; its agent starts right away so its options show.
    pub fn new(log: ChatLog, cwd: &str, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut view = Self::build(log, cwd, window, cx);
        view.ensure_agent(cx);
        view
    }

    /// The message box and its subscription, in `window`.
    fn composer(provider: &str, window: &mut Window, cx: &mut Context<Self>) -> (Entity<TextareaState>, Subscription) {
        let input = cx.new(|cx| {
            TextareaState::new(window, cx)
                .auto_grow(1, 10)
                .submit_on_enter(true)
                .placeholder(format!(
                    "Message {}…  (Enter to send, paste images)",
                    if provider == "codex" { "Codex" } else { "Claude" }
                ))
        });
        let sub = cx.subscribe_in(&input, window, |this, input, ev: &InputEvent, window, cx| match ev {
            InputEvent::PressEnter { shift: false, secondary } => this.submit(*secondary, window, cx),
            InputEvent::Change => {
                let value = input.read(cx).value();
                let has = !value.trim().is_empty();
                // A bare "/prefix" (no space yet) opens the slash-command menu.
                let slash = value.strip_prefix('/').filter(|q| !q.contains(char::is_whitespace)).map(|q| q.to_lowercase());
                if has != this.has_text || slash != this.slash {
                    this.has_text = has;
                    this.slash = slash;
                    cx.notify();
                }
            }
            _ => {}
        });
        (input, sub)
    }

    /// Moved into another window (a popped-out or docked worktree): rebuild what's
    /// tied to the old one — the message box (keeping its text) and open forms.
    pub fn move_to_window(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.input.read(cx).value().to_string();
        let (input, sub) = Self::composer(&self.log.provider, window, cx);
        input.update(cx, |s, cx| s.set_value(text, window, cx));
        self.input = input;
        self._subs[0] = sub;
        self.forms.clear();
        self.find = None;
        cx.notify();
    }

    fn build(log: ChatLog, cwd: &str, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let mut rows = Rows::default();
        for e in &log.events {
            rows.apply(e);
        }
        let config = log.last("configOptions").and_then(|e| e["options"].as_array().cloned()).unwrap_or_default();
        let items = transcript::build_items(&rows.rows);
        let scroller = cx.new(|cx| MessageScrollerState::new(items.len(), cx));
        // The pinned question follows the scroll position.
        let scrolled = cx.observe(&scroller, |_, _, cx| cx.notify());
        let (input, sub) = Self::composer(&log.provider, window, cx);
        input.update(cx, |s, cx| s.focus(window, cx));
        let commands = log.last("commands").map(commands_of).unwrap_or_default();
        find::bind(cx);
        let fresh_banner = fresh::cold(&log.events, now_ms());
        // Cmd-Q may not drop views: write out the log on quit.
        let quit = cx.on_app_quit(|v, _| {
            v.log.flush(true);
            v.log.write_meta();
            async {}
        });
        // Stop the agent after 30 idle minutes; the next send resumes it.
        let idle = cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor().timer(Duration::from_secs(60)).await;
                if this.update(cx, |v, cx| v.idle_check(cx)).is_err() {
                    break;
                }
            }
        });
        Self {
            log,
            cwd: cwd.to_string(),
            rows,
            scroller,
            input,
            agent: None,
            status: Status::Idle,
            config,
            restore_config: None,
            queue: vec![],
            attachments: vec![],
            has_text: false,
            fresh: false,
            commands,
            slash: None,
            menu_open: false,
            menu_row: None,
            persist: None,
            persist_due: false,
            ticker: Default::default(),
            items,
            open: HashSet::new(),
            open_strips: HashSet::new(),
            plan_open: false,
            pins_open: false,
            flash: None,
            flash_task: None,
            forest_word: transcript::FOREST_WORDS[0],
            recent_words: vec![],
            activity: None,
            viewing: None,
            unread: false,
            unread_at: None,
            focused_by_user: true,
            attention: Attention::Idle,
            agent_gen: 0,
            had_agent: false,
            session_up: false,
            default_mode: None,
            permission_mode: None,
            steers: HashMap::new(),
            grace: None,
            relaunch: false,
            current_prompt: None,
            stale_prompts: HashSet::new(),
            pending_branch: None,
            last_activity: Instant::now(),
            find: None,
            fresh_banner,
            item_h: Default::default(),
            pinned_h: std::rc::Rc::new(std::cell::Cell::new(px(56.))),
            forms: HashMap::new(),
            _tasks: vec![idle],
            _subs: vec![sub, scrolled, quit],
        }
    }

    pub fn session_id(&self) -> &str {
        &self.log.id
    }

    pub fn title(&self) -> String {
        if let Some(t) = &self.log.custom_name {
            return t.clone();
        }
        if self.log.events.iter().any(|e| e["type"] == "user_text") { self.log.name() } else { "New chat".into() }
    }

    /// Rename the chat (None goes back to its first message). Saved as the meta's
    /// name, flagged `renamed` so reopening keeps it.
    pub fn set_custom_title(&mut self, title: Option<String>, cx: &mut Context<Self>) {
        let title = title.map(|t| t.trim().to_string()).filter(|t| !t.is_empty());
        if title == self.log.custom_name {
            return;
        }
        self.log.custom_name = title;
        self.log.write_meta();
        cx.emit(ChatEvent::TitleChanged);
        cx.notify();
    }

    /// Open (permission prompts, elicitation forms); none without a running agent.
    pub fn open_asks(&self) -> (usize, usize) {
        if self.agent.is_some() { self.rows.open_asks() } else { (0, 0) }
    }

    pub fn attention(&self) -> Attention {
        if self.agent.is_some() && self.rows.pending_ask() {
            Attention::NeedsAnswer
        } else if self.status != Status::Idle {
            Attention::Working
        } else if self.unread {
            Attention::Unread
        } else {
            Attention::Idle
        }
    }

    pub fn mark_read(&mut self, cx: &mut Context<Self>) {
        if self.unread {
            self.unread = false;
            self.sync_attention(cx);
            cx.notify();
        }
    }

    /// Whether you're looking at this chat (its tab is showing in a focused window).
    pub fn set_focused_by_user(&mut self, focused: bool, cx: &mut Context<Self>) {
        self.focused_by_user = focused;
        if focused {
            self.mark_read(cx);
            if let Some(mid) = self.unread_at.take() {
                self.jump_to(&mid, cx);
            }
        }
    }

    /// ⋯ → Mark unread on an agent message: the chat shows as ready again (tab and
    /// sidebar), and coming back to it lands on that message.
    pub(super) fn mark_unread(&mut self, mid: String, cx: &mut Context<Self>) {
        self.unread = true;
        self.unread_at = Some(mid);
        self.sync_attention(cx);
        cx.notify();
    }

    /// `FR_BENCH`: look like a running turn (activity, pulsing dots) with no agent.
    pub(crate) fn bench_working(&mut self, cx: &mut Context<Self>) {
        self.status = Status::Working;
        self.start_activity(cx);
        self.sync_attention(cx);
        cx.notify();
    }

    fn sync_attention(&mut self, cx: &mut Context<Self>) {
        let now = self.attention();
        if now != self.attention {
            self.attention = now;
            cx.emit(ChatEvent::StatusChanged);
        }
    }

    /// Rotate the forest word every 7s while a turn runs.
    fn start_activity(&mut self, cx: &mut Context<Self>) {
        self.activity = Some(cx.spawn(async move |this, cx| {
            loop {
                let working = this
                    .update(cx, |v, cx| {
                        let w = transcript::next_forest_word(&v.recent_words, || uuid::Uuid::new_v4().as_u128() as usize);
                        v.recent_words.insert(0, w);
                        v.recent_words.truncate(7);
                        v.forest_word = w;
                        cx.notify();
                        v.status == Status::Working
                    })
                    .unwrap_or(false);
                if !working {
                    break;
                }
                cx.background_executor().timer(Duration::from_secs(7)).await;
            }
        }));
    }

    /// Re-fold the rows and move the scroller's items to match.
    fn sync_items(&mut self, changed: Option<usize>, cx: &mut Context<Self>) {
        // A row changed in place (streamed text, a tool finishing, an answer) keeps
        // the same items — row kinds and times decide those — unless it was hidden
        // (blank) until now. So per streamed token: remeasure one item, no rebuild.
        if let Some(r) = changed {
            if self.rows.rows.get(r).is_some_and(transcript::hidden) {
                return;
            }
            if let Some(ix) = self.item_of_row(r) {
                self.scroller.update(cx, |s, cx| s.remeasure_items(ix..ix + 1, cx));
                return;
            }
        }
        let items = transcript::build_items(&self.rows.rows);
        let old = std::mem::replace(&mut self.items, items);
        let first = old.iter().zip(&self.items).position(|(a, b)| a != b).unwrap_or(old.len().min(self.items.len()));
        let (old_len, new_len) = (old.len(), self.items.len());
        let changed_item = changed.and_then(|r| self.item_of_row(r)).filter(|&ix| ix < first);
        self.scroller.update(cx, |s, cx| {
            if first < old_len || first < new_len {
                s.splice(first..old_len, new_len - first, cx);
            }
            if let Some(ix) = changed_item {
                s.remeasure_items(ix..ix + 1, cx);
            }
        });
    }

    fn ensure_agent(&mut self, cx: &mut Context<Self>) {
        if self.agent.is_some() {
            return;
        }
        // Prompts still open in a reopened log belong to an agent that's gone.
        for e in self.rows.cancel_asks() {
            self.apply(e, cx);
        }
        let first = !self.had_agent;
        // First start this run: the user's default mode, not the chat's saved one
        // (agents don't keep per-chat mode across restarts). A relaunch restores it all.
        self.default_mode = first.then(|| cx.try_global::<Settings>()?.default_mode_by_provider.get(&self.log.provider).cloned()).flatten();
        let saved_mode = self.config.iter().find(|o| is_mode(o)).and_then(|o| o["currentValue"].as_str()).map(str::to_string);
        let initial_mode = self.permission_mode.clone().or_else(|| self.default_mode.clone()).or_else(|| saved_mode.filter(|_| !first));
        let (tx, rx) = async_channel::unbounded();
        let opts = StartOpts {
            provider: self.log.provider.clone(),
            cwd: self.cwd.clone(),
            model: self.log.model.clone(),
            resume_id: if self.fresh { None } else { self.log.resume_id() },
        };
        match Agent::spawn_with_mode(opts, initial_mode.as_deref(), tx) {
            Ok(a) => {
                self.agent = Some(a);
                self.agent_gen += 1;
                self.had_agent = true;
                self.session_up = false;
                self.status = Status::Starting;
                self.last_activity = Instant::now();
                let restore: Vec<Value> = self.config.iter().filter(|o| !(first && is_mode(o))).cloned().collect();
                self.restore_config = Some(restore).filter(|c| !c.is_empty());
                let generation = self.agent_gen;
                self._tasks.push(cx.spawn(async move |this, cx| {
                    while let Ok(e) = rx.recv().await {
                        let live = this.update(cx, |v, cx| {
                            if v.agent_gen == generation {
                                v.apply(e, cx)
                            }
                        });
                        if live.is_err() {
                            break;
                        }
                    }
                }));
            }
            Err(err) => self.info(format!("Couldn't start the agent: {err}"), cx),
        }
    }

    /// Stop the agent (it's killed on drop); its late events are ignored. Its open
    /// prompts can't be answered any more, and steers it never took go back in the queue.
    fn drop_agent(&mut self, cx: &mut Context<Self>) {
        self.agent = None;
        self.agent_gen += 1;
        self.session_up = false;
        for e in self.rows.cancel_asks() {
            self.apply(e, cx);
        }
        for (_, out) in self.steers.drain() {
            self.queue.insert(0, out);
        }
    }

    /// An error row that isn't the end of a turn (not logged).
    fn info(&mut self, msg: String, cx: &mut Context<Self>) {
        self.rows.push(Row::Info(msg));
        self.sync_items(None, cx);
        cx.notify();
    }

    fn idle_check(&mut self, cx: &mut Context<Self>) {
        const IDLE_STOP: Duration = Duration::from_secs(30 * 60);
        if self.agent.is_some() && self.status == Status::Idle && !self.rows.pending_ask() && self.last_activity.elapsed() >= IDLE_STOP {
            self.drop_agent(cx);
            cx.notify();
        }
    }

    /// The last question has no answer yet.
    fn turn_pending(&self) -> bool {
        self.log.events.iter().rev().find(|e| e["type"] == "user_text" || e["type"] == "result").is_some_and(|e| e["type"] == "user_text")
    }

    /// The turn is over: relaunch for a provider switch, then send the next queued message.
    fn turn_ended(&mut self, cx: &mut Context<Self>) {
        self.status = Status::Idle;
        self.grace = None;
        if std::mem::take(&mut self.relaunch) {
            self.relaunch_agent(cx);
        }
        if !self.queue.is_empty() {
            let next = self.queue.remove(0);
            self.send(next, cx);
        }
    }

    fn apply(&mut self, mut e: Value, cx: &mut Context<Self>) {
        // A cancelled prompt's late answer: its turn was already ended.
        if let Some(tag) = e["prompt"].as_str() {
            if self.stale_prompts.remove(tag) {
                return;
            }
            if self.current_prompt.as_deref() == Some(tag) {
                self.current_prompt = None;
            }
        }
        if e.get("ts").is_none() {
            e["ts"] = now_ms().into();
        }
        self.last_activity = Instant::now();
        let first_message = e["type"] == "user_text" && !self.log.events.iter().any(|e| e["type"] == "user_text");
        // Ending the turn may send the next queued message: log this event first.
        let mut end_turn = false;
        match e["type"].as_str().unwrap_or_default() {
            "system" => {
                self.fresh = false;
                self.session_up = true;
                if self.status == Status::Starting {
                    // A message sent while it started is already running.
                    let pending = self.turn_pending();
                    self.status = if pending { Status::Working } else { Status::Idle };
                    if pending {
                        self.start_activity(cx);
                    }
                }
                if let Some(mid) = self.pending_branch.take() {
                    self.fork(mid, cx);
                }
            }
            "configOptions" => {
                self.config = e["options"].as_array().cloned().unwrap_or_default();
                // A resumed agent starts on its defaults — put back this chat's picks.
                if let (Some(prev), Some(agent)) = (self.restore_config.take(), &self.agent) {
                    for p in prev {
                        let want = p["currentValue"].as_str().unwrap_or_default();
                        if self.config.iter().any(|o| o["id"] == p["id"] && should_switch(o, want)) {
                            agent.set_config(p["id"].as_str().unwrap_or_default(), want);
                        }
                    }
                }
                if let (Some(want), Some(agent)) = (self.default_mode.take(), &self.agent) {
                    let mode = self.config.iter().find(|o| is_mode(o));
                    if let Some(m) = mode.filter(|m| should_switch(m, &want)) {
                        agent.set_config(m["id"].as_str().unwrap_or_default(), &want);
                    }
                }
            }
            "commands" => self.commands = commands_of(&e),
            "steer_result" => {
                if let Some(out) = self.steers.remove(e["id"].as_str().unwrap_or_default()) {
                    // Taken into the turn, or (not taken) sent by acp as the next prompt.
                    let steered = e["injected"] == true;
                    self.apply(user_event(&out, steered), cx);
                    if !steered {
                        // acp sent it as a prompt, tagged with the steer's id.
                        self.current_prompt = e["id"].as_str().map(str::to_string);
                    }
                    if !steered && self.status == Status::Idle {
                        self.status = Status::Working;
                        self.start_activity(cx);
                    }
                }
            }
            "elicitation_resolved" => _ = self.forms.remove(e["id"].as_str().unwrap_or_default()),
            "result" => {
                if !self.focused_by_user {
                    self.unread = true;
                }
                end_turn = true;
            }
            // A refused setting change: shown, but the turn goes on.
            "error" if e["soft"] == true => {}
            "error" => {
                self.status = Status::Idle;
                // An error may be the adapter dying ("exited" follows): wait a beat
                // so the queue drains into a new agent rather than the dead one.
                self.grace = Some(cx.spawn(async move |this, cx| {
                    cx.background_executor().timer(Duration::from_millis(300)).await;
                    let _ = this.update(cx, |v, cx| {
                        if v.status == Status::Idle {
                            v.turn_ended(cx);
                        }
                    });
                }));
            }
            "exited" => {
                self.drop_agent(cx);
                end_turn = true;
            }
            _ => {}
        }
        match self.rows.apply(&e) {
            Change::Appended => self.sync_items(None, cx),
            Change::Updated(ix) => self.sync_items(Some(ix), cx),
            Change::None => {}
        }
        let flush_now = matches!(e["type"].as_str(), Some("result" | "error"));
        self.log.push(e);
        if flush_now {
            self.log.flush(true);
        }
        self.schedule_persist(cx);
        self.sync_attention(cx);
        if first_message && self.log.custom_name.is_none() {
            cx.emit(ChatEvent::TitleChanged);
        }
        if end_turn {
            self.turn_ended(cx);
        }
        cx.notify();
    }

    /// Append + meta write at most every 400ms (throttled, not debounced: a busy
    /// stream would otherwise never be written until the turn ends).
    fn schedule_persist(&mut self, cx: &mut Context<Self>) {
        if self.persist_due {
            return;
        }
        self.persist_due = true;
        self.persist = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_millis(400)).await;
            let _ = this.update(cx, |v, _| {
                v.persist_due = false;
                v.log.flush(false);
                v.log.write_meta();
            });
        }));
    }

    fn submit(&mut self, steer: bool, window: &mut Window, cx: &mut Context<Self>) {
        let text = self.input.read(cx).value().trim().to_string();
        if text.is_empty() && self.attachments.is_empty() {
            return;
        }
        self.input.update(cx, |s, cx| s.set_value(String::new(), window, cx));
        self.has_text = false;
        let out = Outgoing { text, attachments: std::mem::take(&mut self.attachments) };
        let idle = self.status == Status::Idle || (self.status == Status::Starting && !self.turn_pending());
        match (idle, steer) {
            (true, _) => self.send(out, cx),
            // ⌘Enter while working: add it to the running turn.
            (false, true) => self.steer_now(out, window, cx),
            _ => {
                self.queue.push(out);
                cx.notify();
            }
        }
    }

    /// Send a message now, or queue it for after the running turn (as Enter does).
    pub fn send_or_queue(&mut self, text: String, cx: &mut Context<Self>) {
        let out = Outgoing { text, attachments: vec![] };
        if self.status == Status::Idle || (self.status == Status::Starting && !self.turn_pending()) {
            return self.send(out, cx);
        }
        self.queue.push(out);
        cx.notify();
    }

    /// Send a message as if typed (e.g. a seeded "Agent merge" prompt).
    pub fn send_text(&mut self, text: String, cx: &mut Context<Self>) {
        self.send(Outgoing { text, attachments: vec![] }, cx);
    }

    fn send(&mut self, out: Outgoing, cx: &mut Context<Self>) {
        self.fresh_banner = false; // sending is "Continue here"
        self.apply(user_event(&out, false), cx);
        self.ensure_agent(cx);
        // Couldn't start (the error row says why): nothing is running.
        let Some(agent) = &self.agent else { return cx.notify() };
        let tag = uuid::Uuid::new_v4().to_string();
        agent.prompt(out.blocks(), &tag);
        self.current_prompt = Some(tag);
        if self.status == Status::Idle {
            self.status = Status::Working;
            self.start_activity(cx);
        }
        self.sync_attention(cx);
        cx.notify();
    }

    /// Add a message to the running turn (it's shown once the agent takes it). An
    /// agent that can't steer is stopped and sent it instead.
    fn steer_now(&mut self, out: Outgoing, window: &mut Window, cx: &mut Context<Self>) {
        match (self.status, &self.agent) {
            (Status::Idle, _) => self.send(out, cx),
            (Status::Starting, _) => self.queue.insert(0, out),
            (_, Some(a)) if a.can_steer() => {
                let tag = uuid::Uuid::new_v4().to_string();
                a.steer_tagged(&tag, out.blocks());
                self.steers.insert(tag, out);
            }
            _ => {
                window.push_notification(crate::notify::info("This agent can't take messages mid-turn — stopped it and sent yours instead."), cx);
                self.queue.insert(0, out);
                self.cancel_turn(cx);
            }
        }
        cx.notify();
    }

    /// Cancel the running turn. Agents don't always report the end of a cancelled
    /// turn, so after 3s it's treated as over (and the queue drains).
    fn cancel_turn(&mut self, cx: &mut Context<Self>) {
        if let Some(a) = &self.agent {
            a.cancel();
        }
        self.grace = Some(cx.spawn(async move |this, cx| {
            cx.background_executor().timer(Duration::from_secs(3)).await;
            let _ = this.update(cx, |v, cx| {
                if v.status == Status::Working {
                    // Give up on it: its answer, if it ever comes, is dropped (else
                    // it would end whatever turn runs next). Log the end ourselves.
                    if let Some(t) = v.current_prompt.take() {
                        v.stale_prompts.insert(t);
                    }
                    v.apply(json!({ "type": "result", "ok": true, "durationMs": null, "stopReason": "cancelled" }), cx);
                    v.sync_attention(cx);
                }
            });
        }));
    }

    /// Stop: cancel the turn and return everything queued to the composer, so the
    /// cancelled turn's end doesn't send it.
    fn stop(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let queued = std::mem::take(&mut self.queue);
        let text = queued.iter().map(|q| q.text.as_str()).filter(|t| !t.is_empty()).collect::<Vec<_>>().join("\n\n");
        self.restore_composer(&text, queued.into_iter().flat_map(|q| q.attachments).collect(), window, cx);
        self.cancel_turn(cx);
    }

    /// Put text (before what's there) and attachments back into the composer.
    fn restore_composer(&mut self, text: &str, attachments: Vec<Attachment>, window: &mut Window, cx: &mut Context<Self>) {
        if !text.is_empty() {
            let cur = self.input.read(cx).value().to_string();
            let next = if cur.trim().is_empty() { text.to_string() } else { format!("{text}\n\n{cur}") };
            self.input.update(cx, |s, cx| s.set_value(next, window, cx));
            self.has_text = true;
        }
        self.attachments.splice(0..0, attachments);
        cx.notify();
    }

    /// Cancel a queued message: back into the composer.
    fn unqueue(&mut self, i: usize, window: &mut Window, cx: &mut Context<Self>) {
        if i < self.queue.len() {
            let q = self.queue.remove(i);
            self.restore_composer(&q.text, q.attachments, window, cx);
        }
    }

    /// Branch the chat at an agent message: fork the agent's session there (starting
    /// one if needed) and save the result as a new chat for the shell to open.
    pub(super) fn branch_from(&mut self, message_id: String, cx: &mut Context<Self>) {
        self.ensure_agent(cx);
        if self.agent.is_none() {
            return;
        }
        if self.session_up { self.fork(message_id, cx) } else { self.pending_branch = Some(message_id) }
    }

    fn fork(&mut self, message_id: String, cx: &mut Context<Self>) {
        let Some(agent) = &self.agent else { return };
        let rx = agent.fork(Some(&message_id));
        cx.spawn(async move |this, cx| {
            let r = rx.recv().await.unwrap_or_else(|_| Err("Branch failed: the agent stopped".into()));
            let _ = this.update(cx, |v, cx| {
                let made = r.and_then(|sid| chatlog::fork_log(&v.log, Some(&message_id), uuid::Uuid::new_v4().to_string(), &sid));
                match made {
                    Ok(mut log) => {
                        log.custom_name = Some(format!("⑂ {}", v.title()));
                        log.write_meta();
                        cx.emit(ChatEvent::Branched { log_id: log.id.clone() });
                    }
                    Err(e) => v.info(e, cx),
                }
            });
        })
        .detach();
    }

    fn add_paths(&mut self, paths: &[std::path::PathBuf], cx: &mut Context<Self>) {
        self.attachments.extend(paths.iter().filter(|p| p.is_file()).filter_map(|p| Attachment::from_path(p)));
        cx.notify();
    }

    /// Paste: images and copied files become attachments; text pastes normally.
    fn paste(&mut self, item: &ClipboardItem, cx: &mut Context<Self>) -> bool {
        let mut handled = false;
        for entry in item.entries() {
            match entry {
                ClipboardEntry::Image(img) => {
                    let name = format!("pasted-{}.{}", self.attachments.len() + 1, img.format().extension());
                    self.attachments.push(Attachment::image(name, img.format(), img.bytes().to_vec()));
                    handled = true;
                }
                ClipboardEntry::ExternalPaths(paths) => {
                    self.add_paths(paths.paths(), cx);
                    handled = true;
                }
                _ => {}
            }
        }
        cx.notify();
        handled
    }

    fn pick_files(&mut self, cx: &mut Context<Self>) {
        let picked = cx.prompt_for_paths(PathPromptOptions { files: true, directories: false, multiple: true, prompt: Some("Attach".into()) });
        cx.spawn(async move |this, cx| {
            if let Ok(Ok(Some(paths))) = picked.await {
                let _ = this.update(cx, |v, cx| v.add_paths(&paths, cx));
            }
        })
        .detach();
    }

    /// Switch agent (Claude ↔ Codex). The current one stops (once its turn ends);
    /// the other starts with a fresh session (this transcript stays).
    fn set_provider(&mut self, provider: &str, cx: &mut Context<Self>) {
        if self.log.provider == provider {
            return;
        }
        self.log.provider = provider.into();
        self.log.model = None;
        let idle = self.status == Status::Idle || (self.status == Status::Starting && !self.turn_pending());
        if idle { self.relaunch_agent(cx) } else { self.relaunch = true }
        cx.notify();
    }

    fn relaunch_agent(&mut self, cx: &mut Context<Self>) {
        self.drop_agent(cx);
        self.config.clear();
        self.restore_config = None;
        self.permission_mode = None;
        // The new provider's own default mode applies.
        self.had_agent = false;
        self.fresh = true;
        self.ensure_agent(cx);
    }

    fn respond(&mut self, id: String, option: String) {
        if let Some(a) = &self.agent {
            a.respond(&id, &option);
        }
    }

    fn set_config(&mut self, id: String, value: String, cx: &mut Context<Self>) {
        self.ensure_agent(cx);
        if self.config.iter().any(|o| o["id"] == id.as_str() && is_mode(o)) {
            // An explicit pick beats the default mode.
            self.default_mode = None;
        }
        if self.status == Status::Starting {
            // Not up yet: apply once it is, along with the chat's other picks.
            let mut picks = self.restore_config.take().unwrap_or_else(|| self.config.clone());
            match picks.iter_mut().find(|o| o["id"] == id.as_str()) {
                Some(o) => o["currentValue"] = value.into(),
                None => picks.push(json!({ "id": id, "currentValue": value })),
            }
            self.restore_config = Some(picks);
        } else if let Some(a) = &self.agent {
            a.set_config(&id, &value);
        }
    }

    /// An option's current value and its choices.
    fn option_values(opt: &Value) -> (String, String, Vec<(String, String)>) {
        let current = opt["currentValue"].as_str().unwrap_or_default().to_string();
        let choices: Vec<(String, String)> = opt["options"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|o| (o["value"].as_str().unwrap_or_default().into(), o["label"].as_str().unwrap_or_default().into()))
            .collect();
        let label = choices.iter().find(|c| c.0 == current).map(|c| c.1.clone()).unwrap_or(current.clone());
        (current, label, choices)
    }

    /// The ✦ menu's rows: (key, label, current value, current label, choices).
    /// "provider" is ours; the rest are the agent's options except mode.
    fn menu_rows(&self) -> Vec<(String, String, String, String, Vec<(String, String)>)> {
        let p = self.log.provider.clone();
        let mut rows = vec![(
            "provider".to_string(),
            "Provider".to_string(),
            p.clone(),
            if p == "codex" { "Codex" } else { "Claude" }.to_string(),
            vec![("claude".into(), "Claude".into()), ("codex".into(), "Codex".into())],
        )];
        for opt in self.config.iter().filter(|o| !is_mode(o)) {
            let (current, label, choices) = Self::option_values(opt);
            let id = opt["id"].as_str().unwrap_or_default().to_string();
            rows.push((id, opt["name"].as_str().unwrap_or_default().to_string(), current, label, choices));
        }
        rows
    }

    fn pick(&mut self, key: String, value: String, cx: &mut Context<Self>) {
        self.menu_open = false;
        self.menu_row = None;
        if key == "provider" { self.set_provider(&value, cx) } else { self.set_config(key, value, cx) }
        cx.notify();
    }

    /// The open menu (ChatSettingsMenu.tsx): "Label  value ›" rows. Hovering one
    /// opens its choices as a separate panel beside it (an overlay, so the menu
    /// itself never resizes).
    fn render_menu(&self, view: Entity<ChatView>, cx: &App) -> AnyElement {
        let theme = cx.theme().colors;
        let x = theme::extra(cx);
        div()
            .flex()
            .flex_col()
            .w(px(230.))
            .children(self.menu_rows().into_iter().enumerate().map(|(i, (key, label, current, value, choices))| {
                let v = view.clone();
                let active = self.menu_row == Some(i);
                div()
                    .id(("menu-row", i))
                    .relative()
                    .flex()
                    .items_center()
                    .gap_2()
                    .h(px(34.))
                    .px(px(10.))
                    .rounded(px(6.))
                    .text_size(px(13.))
                    .cursor_pointer()
                    .when(active, |d| d.bg(x.hover))
                    .child(div().flex_1().child(label))
                    .child(div().text_color(theme.muted_foreground).child(value))
                    .child(sidebar::icon("fr/chevron.svg", 13., x.faint))
                    .on_hover(move |hovered, window, cx| {
                        if *hovered {
                            v.update(cx, |c, _| c.menu_row = Some(i));
                            window.refresh();
                        }
                    })
                    .when(active, |d| {
                        let panel = div()
                            .flex()
                            .flex_col()
                            .min_w(px(180.))
                            .p_1()
                            .rounded(px(8.))
                            .border_1()
                            .border_color(theme.border)
                            .bg(theme.popover)
                            .shadow_lg()
                            .children(choices.into_iter().enumerate().map(|(j, (value, label))| {
                                let (v, key, checked) = (view.clone(), key.clone(), value == current);
                                div()
                                    .id(("menu-choice", j))
                                    .flex()
                                    .items_center()
                                    .gap_2()
                                    .h(px(32.))
                                    .px(px(10.))
                                    .rounded(px(6.))
                                    .text_size(px(13.))
                                    .cursor_pointer()
                                    .hover(|s| s.bg(x.hover))
                                    .child(div().w(px(14.)).text_color(theme.primary).child(if checked { "✓" } else { "" }))
                                    .child(label)
                                    // Mouse-down, and stop it there: this panel sits outside the
                                    // popover's bounds, which would otherwise read as a click-away.
                                    .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                                        cx.stop_propagation();
                                        v.update(cx, |c, cx| c.pick(key.clone(), value.clone(), cx));
                                        window.refresh();
                                    })
                            }));
                        d.child(
                            div()
                                .absolute()
                                .top(px(-5.))
                                .left_full()
                                .ml(px(12.))
                                .child(deferred(anchored().snap_to_window_with_margin(px(8.)).child(panel)).with_priority(2)),
                        )
                    })
            }))
            .into_any_element()
    }

    /// "✦ Claude · Opus 5.5 ⌃⌄" — opens the settings menu above it.
    fn settings_menu(&self, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().colors;
        let this = cx.entity();
        let provider_label = if self.log.provider == "codex" { "Codex" } else { "Claude" };
        let model = self
            .config
            .iter()
            .find(|o| o["id"] == "model" || o["category"] == "model")
            .map(|o| Self::option_values(o).1)
            .unwrap_or_else(|| self.log.model.clone().unwrap_or_else(|| "default".into()));
        let working = self.status != Status::Idle;
        let (open_view, content_view) = (this.clone(), this.clone());
        Popover::new("chat-settings")
            .anchor(Anchor::BottomLeft)
            .open(self.menu_open)
            .on_open_change(move |open, window, cx| {
                open_view.update(cx, |c, cx| {
                    c.menu_open = *open;
                    c.menu_row = None;
                    // A saved chat shows the options logged by its last agent (maybe an
                    // older CLI); start the agent so the list is current.
                    if *open {
                        c.ensure_agent(cx);
                    }
                });
                window.refresh();
            })
            .trigger(
                Button::new("chat-settings-btn")
                    .ghost()
                    .child(sidebar::icon("fr/sparkle.svg", 13., if working { theme.primary.opacity(0.6) } else { theme.primary }))
                    .child(div().font_weight(FontWeight::MEDIUM).text_color(theme.foreground).child(format!("{provider_label} · {model}")))
                    .child(sidebar::icon("fr/chevron-up-down.svg", 13., theme.muted_foreground)),
            )
            .content(move |_, _, cx| {
                let view = content_view.clone();
                content_view.read(cx).render_menu(view, cx)
            })
            .into_any_element()
    }

    /// Slash-command autocomplete: commands starting with what's typed after "/".
    fn slash_menu(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let q = self.slash.as_ref()?;
        let matches: Vec<_> = self.commands.iter().filter(|(n, _)| n.to_lowercase().starts_with(q.as_str())).take(6).cloned().collect();
        if matches.is_empty() {
            return None;
        }
        let theme = cx.theme().colors;
        let x = theme::extra(cx);
        let mono = cx.theme().mono_font_family.clone();
        Some(
            div()
                .flex()
                .flex_col()
                .py_1()
                .rounded(px(8.))
                .border_1()
                .border_color(x.border_strong)
                .bg(theme.background)
                .children(matches.into_iter().enumerate().map(|(i, (name, desc))| {
                    div()
                        .id(("slash", i))
                        .flex()
                        .items_center()
                        .gap(px(10.))
                        .px(px(12.))
                        .py(px(6.))
                        .cursor_pointer()
                        .hover(|s| s.bg(x.hover))
                        .child(div().flex_shrink_0().font_family(mono.clone()).text_size(px(13.)).text_color(theme.primary).child(format!("/{name}")))
                        .child(div().min_w_0().truncate().text_size(px(12.5)).text_color(theme.muted_foreground).child(desc))
                        .on_click(cx.listener(move |this, _, window, cx| {
                            let text = format!("/{name} ");
                            let end = text.chars().count() as u32;
                            this.input.update(cx, |s, cx| {
                                s.set_value(text, window, cx);
                                s.focus(window, cx);
                                s.set_cursor_position(gpui_kit::component::input::Position::new(0, end), window, cx);
                            });
                            this.slash = None;
                            this.has_text = true;
                            cx.notify();
                        }))
                }))
                .into_any_element(),
        )
    }

    /// The permission/edit mode, kept inline as a quick picker (right of the bar).
    /// The agent's mode option; else its session modes; else the built-in list.
    fn mode_choices(&self) -> (ModeKind, String, String, Vec<(String, String)>) {
        if let Some(opt) = self.config.iter().find(|o| is_mode(o)) {
            let (current, label, choices) = Self::option_values(opt);
            return (ModeKind::Config(opt["id"].as_str().unwrap_or_default().to_string()), current, label, choices);
        }
        let modes = self.log.last("modes").filter(|m| m["available"].as_array().is_some_and(|a| !a.is_empty()));
        if let Some(m) = modes {
            let choices: Vec<(String, String)> = m["available"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|o| (o["id"].as_str().unwrap_or_default().to_string(), o["name"].as_str().unwrap_or_default().to_string()))
                .collect();
            let current = m["current"].as_str().map(str::to_string).unwrap_or_else(|| choices[0].0.clone());
            let label = choices.iter().find(|c| c.0 == current).map(|c| c.1.clone()).unwrap_or(current.clone());
            return (ModeKind::Session, current, label, choices);
        }
        let current = self.permission_mode.clone().unwrap_or_else(|| "default".into());
        let choices: Vec<(String, String)> = PERMISSION_MODES.iter().map(|(v, l)| (v.to_string(), l.to_string())).collect();
        let label = choices.iter().find(|c| c.0 == current).map(|c| c.1.clone()).unwrap_or(current.clone());
        (ModeKind::Permission, current, label, choices)
    }

    fn pick_mode(&mut self, kind: &ModeKind, value: String, cx: &mut Context<Self>) {
        match kind {
            ModeKind::Config(id) => self.set_config(id.clone(), value, cx),
            ModeKind::Session => {
                self.ensure_agent(cx);
                if let Some(a) = &self.agent {
                    a.set_session_mode(&value);
                }
            }
            // Only settable at launch: an idle agent restarts in it on the next send.
            ModeKind::Permission => {
                self.permission_mode = Some(value);
                if self.status == Status::Idle && self.agent.is_some() {
                    self.drop_agent(cx);
                }
                cx.notify();
            }
        }
    }

    fn mode_picker(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        let theme = cx.theme().colors;
        let x = theme::extra(cx);
        let (kind, current, label, choices) = self.mode_choices();
        let this = cx.entity();
        Some(
            div()
                .flex()
                .items_center()
                .gap(px(6.))
                .child(div().text_size(px(12.)).text_color(x.faint).child("Mode"))
                .child(
                    Button::new("mode")
                        .ghost()
                        .child(div().text_color(theme.foreground).child(label))
                        .child(sidebar::icon("fr/chevron-up-down.svg", 13., theme.muted_foreground))
                        .dropdown_menu_with_anchor(Anchor::BottomRight, move |menu, _, _| {
                            choices.iter().fold(menu, |m, (value, label)| {
                                let (t, kind, value) = (this.clone(), kind.clone(), value.clone());
                                m.item(PopupMenuItem::new(label.clone()).checked(value == current).on_click(move |_, _, cx| {
                                    t.update(cx, |v, cx| v.pick_mode(&kind, value.clone(), cx))
                                }))
                            })
                        }),
                )
                .into_any_element(),
        )
    }
}

/// The logged `user_text` for a message.
fn user_event(out: &Outgoing, steered: bool) -> Value {
    let mut e = json!({ "type": "user_text", "text": out.text });
    if !out.attachments.is_empty() {
        e["attachments"] = out.attachments.iter().map(|a| json!({ "name": a.name, "isImage": a.image.is_some() })).collect::<Vec<_>>().into();
    }
    if steered {
        e["steered"] = true.into();
    }
    e
}

#[derive(Clone)]
enum ModeKind {
    Config(String),
    Session,
    Permission,
}

/// Permission modes for agents that report no mode option (chatConfig.ts).
const PERMISSION_MODES: [(&str, &str); 4] =
    [("default", "Default (ask to edit)"), ("acceptEdits", "Accept edits"), ("plan", "Plan mode"), ("bypassPermissions", "Bypass permissions")];

fn commands_of(e: &Value) -> Vec<(String, String)> {
    e["commands"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|c| (c["name"].as_str().unwrap_or_default().to_string(), c["description"].as_str().unwrap_or_default().to_string()))
        .collect()
}

fn is_mode(o: &Value) -> bool {
    o["id"] == "mode" || o["category"] == "mode"
}

/// A config option isn't on `value` yet, and offers it.
fn should_switch(opt: &Value, value: &str) -> bool {
    opt["currentValue"] != value && opt["options"].as_array().is_some_and(|os| os.iter().any(|o| o["value"] == value))
}

impl Drop for ChatView {
    fn drop(&mut self) {
        self.log.flush(true);
        self.log.write_meta();
    }
}

fn fmt_tokens(n: f64) -> String {
    if n >= 1_000_000. { format!("{:.1}M", n / 1_000_000.) } else { format!("{}k", (n / 1000.).round()) }
}

impl Render for ChatView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // The swaying tree and a running strip's dot (see `anim`).
        self.ticker.keep(self.status == Status::Working, cx);
        self.ensure_forms(window, cx);
        let this = cx.entity();
        let theme = cx.theme().colors;
        let x = theme::extra(cx);
        let danger: Hsla = rgb(0xe5746f).into();
        let usage = self.log.last("usage").map(|u| {
            let used = u["used"].as_f64().unwrap_or(0.);
            let size = u["size"].as_f64().unwrap_or(0.);
            let cost = u["cost"]["amount"].as_f64().map(|c| format!(" · ${c:.2}")).unwrap_or_default();
            (format!("{} / {}{cost}", fmt_tokens(used), fmt_tokens(size)), used >= fresh::BIG_CONTEXT)
        });
        let working = self.status != Status::Idle;
        let has_content = self.has_text || !self.attachments.is_empty();
        let settings = self.settings_menu(cx);
        let mode = self.mode_picker(cx);
        let paste_target = this.clone();
        let meter_view = this.clone();
        let slash_menu = self.slash_menu(cx);
        let pinned = self.render_pinned(&this, cx);
        let activity = self.render_activity(cx);
        let plan = self.render_plan(cx);
        let find_bar = self.render_find_bar(cx);
        let pins = self.render_pins(cx);
        let banner = self.render_fresh_banner(cx);

        // Send / Stop / Queue ▾ — as the Electron composer.
        let send: AnyElement = if working && !has_content {
            Button::new("stop")
                .custom(ButtonCustomVariant::new(cx).color(transparent_black()).foreground(danger).hover(danger.opacity(0.12)).active(danger.opacity(0.2)))
                .border_1()
                .border_color(danger.opacity(0.5))
                .px(px(16.))
                .label("Stop")
                .on_click(cx.listener(|this, _, window, cx| this.stop(window, cx)))
                .into_any_element()
        } else if working {
            let t = this.clone();
            div()
                .flex()
                .child(
                    Button::new("queue")
                        .primary()
                        .px(px(14.))
                        .label("Queue")
                        .tooltip("Send after this turn finishes (↩)")
                        .on_click(cx.listener(|this, _, window, cx| this.submit(false, window, cx))),
                )
                .child(
                    Button::new("send-more")
                        .primary()
                        .compact()
                        .ml(px(1.))
                        .icon(Icon::empty().path("fr/chevron-down.svg"))
                        .dropdown_menu_with_anchor(Anchor::BottomRight, move |menu, _, _| {
                            let (t1, t2) = (t.clone(), t.clone());
                            menu.item(PopupMenuItem::new("Queue — send after this turn  ↩").on_click(move |_, window, cx| {
                                t1.update(cx, |v, cx| v.submit(false, window, cx))
                            }))
                            .item(PopupMenuItem::new("Steer now — agent takes it at its next step  ⌘↩").on_click(move |_, window, cx| {
                                t2.update(cx, |v, cx| v.submit(true, window, cx))
                            }))
                        }),
                )
                .into_any_element()
        } else {
            Button::new("send")
                .primary()
                .px(px(18.))
                .label("Send")
                .disabled(!has_content)
                .on_click(cx.listener(|this, _, window, cx| this.submit(false, window, cx)))
                .into_any_element()
        };

        div()
            .relative()
            .flex()
            .flex_col()
            .size_full()
            .key_context("ChatView")
            .on_action(cx.listener(Self::open_find))
            .on_key_down(cx.listener(|this, e: &KeyDownEvent, _, cx| {
                if e.keystroke.key == "escape" && this.viewing.take().is_some() {
                    cx.stop_propagation();
                    cx.notify();
                }
            }))
            // Drop files anywhere on the chat to attach them.
            .drag_over::<ExternalPaths>(move |s, _, _, _| s.bg(theme.list_active))
            .on_drop(cx.listener(|this, paths: &ExternalPaths, _, cx| this.add_paths(paths.paths(), cx)))
            .children(find_bar)
            .children(pins)
            .child(
                div()
                    .relative()
                    // Clips the pinned question as the next one pushes it up and off.
                    .overflow_hidden()
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .flex_col()
                    .child(
                        MessageScroller::new("transcript", self.scroller.clone(), move |ix, _, cx| {
                            let view = this.clone();
                            this.read(cx).render_item(ix, view, cx)
                        })
                        .flex_1()
                        .with_content_style(StyleRefinement::default().px(px(20.)).py(px(8.)))
                        // The kit pads 32px under every row; our rows carry their own
                        // 6px top/bottom (12px between items, as the Electron app had).
                        .with_row_style(StyleRefinement::default().pb(px(0.))),
                    )
                    .children(pinned),
            )
            .children(activity)
            .children(banner)
            .child(
                div()
                    .flex()
                    .flex_col()
                    .gap_2()
                    .px(px(12.))
                    .py(px(10.))
                    .children(plan)
                    .children(self.queue.iter().enumerate().map(|(i, q)| {
                        div()
                            .flex()
                            .items_center()
                            .gap_2()
                            .text_sm()
                            .text_color(theme.muted_foreground)
                            .child(div().text_xs().text_color(x.faint).child("queued"))
                            .child(div().flex_1().truncate().child(if q.text.is_empty() {
                                format!("📎 {} attachment(s)", q.attachments.len())
                            } else {
                                q.text.clone()
                            }))
                            .child(Button::new(("steer-queued", i)).small().ghost().label("Steer now").on_click(cx.listener(
                                move |this, _, window, cx| {
                                    if i < this.queue.len() {
                                        let q = this.queue.remove(i);
                                        this.steer_now(q, window, cx);
                                    }
                                },
                            )))
                            .child(Button::new(("unqueue", i)).small().ghost().label("Cancel").on_click(cx.listener(
                                move |this, _, window, cx| this.unqueue(i, window, cx),
                            )))
                    }))
                    .when_some(slash_menu, |d, m| d.child(m))
                    .when(!self.attachments.is_empty(), |d| {
                        d.child(div().flex().flex_wrap().gap_2().children(self.attachments.iter().enumerate().map(|(i, a)| {
                            let chip = match &a.image {
                                Some(img) => div()
                                    .id(("thumb", i))
                                    .cursor_pointer()
                                    .on_click({
                                        let img = img.clone();
                                        cx.listener(move |this, _, _, cx| {
                                            this.viewing = Some(img.clone());
                                            cx.notify();
                                        })
                                    })
                                    .size(px(52.))
                                    .rounded(px(6.))
                                    .overflow_hidden()
                                    .border_1()
                                    .border_color(x.border_strong)
                                    .child(gpui_kit::img(img.clone()).size_full().object_fit(ObjectFit::Cover)),
                                None => div()
                                    .id(("file-chip", i))
                                    .max_w(px(160.))
                                    .px(px(10.))
                                    .py(px(8.))
                                    .rounded(px(6.))
                                    .border_1()
                                    .border_color(x.border_strong)
                                    .bg(theme.sidebar)
                                    .text_size(px(12.))
                                    .text_color(theme.muted_foreground)
                                    .truncate()
                                    .child(a.name.clone()),
                            };
                            div().relative().child(chip).child(
                                div()
                                    .id(("unattach", i))
                                    .absolute()
                                    .top(px(-6.))
                                    .right(px(-6.))
                                    .size(px(16.))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .rounded_full()
                                    .bg(theme.background)
                                    .border_1()
                                    .border_color(x.border_strong)
                                    .text_size(px(10.))
                                    .cursor_pointer()
                                    .child("×")
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        if i < this.attachments.len() {
                                            this.attachments.remove(i);
                                        }
                                        cx.notify();
                                    })),
                            )
                        })))
                    })
                    .child(
                        Textarea::new(&self.input)
                            .bg(theme.sidebar)
                            .on_paste(move |item, _, cx| paste_target.update(cx, |v, cx| v.paste(item, cx))),
                    )
                    .child(
                        div()
                            .flex()
                            .flex_wrap()
                            .items_center()
                            .gap_1()
                            .child(
                                div()
                                    .id("attach")
                                    .size(px(28.))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .rounded(px(6.))
                                    .cursor_pointer()
                                    .hover(|s| s.bg(x.hover))
                                    .child(sidebar::icon("fr/plus.svg", 15., theme.muted_foreground))
                                    .tooltip(|window, cx| Tooltip::new("Attach files or images").build(window, cx))
                                    .on_click(cx.listener(|this, _, _, cx| this.pick_files(cx))),
                            )
                            .child(settings)
                            .when_some(usage, |d, (text, big)| {
                                let view = meter_view.clone();
                                d.child(
                                    Button::new("meter")
                                        .ghost()
                                        .small()
                                        .child(div().text_size(px(12.)).text_color(if big { x.amber } else { x.faint }).child(text))
                                        .tooltip("Context this chat sends with every message — click to start fresh")
                                        .dropdown_menu_with_anchor(Anchor::BottomLeft, move |menu, _, _| fresh::menu_items(menu, &view)),
                                )
                            })
                            .child(div().flex_1())
                            .children(mode)
                            .child(div().w(px(6.)))
                            .child(send),
                    ),
            )
            .when_some(self.viewing.clone(), |d, img| {
                d.child(
                    div()
                        .id("lightbox")
                        .absolute()
                        .inset_0()
                        .flex()
                        .items_center()
                        .justify_center()
                        .p_6()
                        .bg(gpui_kit::black().opacity(0.7))
                        .cursor_pointer()
                        .child(gpui_kit::img(img).max_w_full().max_h_full().object_fit(ObjectFit::Contain))
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.viewing = None;
                            cx.notify();
                        })),
                )
            })
    }
}
