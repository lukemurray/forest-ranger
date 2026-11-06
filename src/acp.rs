//! ACP client: spawns the same adapters the Electron app uses (Claude / Codex) and
//! speaks newline-delimited JSON-RPC to them on plain threads. It emits events in
//! the Electron app's `AgentChatEvent` JSON shape (src/shared/types.ts), so chats
//! persist in the same format and either app can open them.
//! ponytail: hand-rolled protocol; swap in the `agent-client-protocol` crate if
//! this needs much more of the spec.

use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
};

use async_channel::{Receiver, Sender};
use serde_json::{Value, json};

pub struct StartOpts {
    pub provider: String,
    pub cwd: String,
    pub model: Option<String>,
    /// The agent's own session id to resume (from the chat's last `system` event).
    pub resume_id: Option<String>,
}

enum Pending {
    Init,
    Load,
    New,
    Prompt,
    SetConfig,
    /// Fire-and-forget (session/set_mode): the agent reports the change itself.
    #[allow(dead_code)]
    Ignore,
    /// The steered blocks and our id for the `steer_result` event.
    Steer(Value, String),
    #[allow(dead_code)]
    Fork(Sender<Result<String, String>>),
}

#[derive(Default)]
struct Shared {
    next_id: u64,
    pending: HashMap<u64, Pending>,
    session: Option<String>,
    /// Prompts (ACP content blocks) sent before the session was up.
    queued: Vec<Value>,
    /// While resuming, the agent replays history as updates — we already have it.
    suppress: bool,
    /// Open permission requests: our id → (JSON-RPC id, optionId → label).
    perms: HashMap<String, (Value, HashMap<String, String>)>,
    /// Open elicitations: our id → JSON-RPC id.
    elicits: HashMap<String, Value>,
    modes: Vec<Value>,
    /// Current permission mode (from the agent's mode option), for auto-allow.
    mode: String,
    can_steer: bool,
    /// The adapter's latest stderr lines — the detail behind a bare "Internal error".
    stderr_tail: std::collections::VecDeque<String>,
}

pub struct Agent {
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<ChildStdin>>,
    shared: Arc<Mutex<Shared>>,
    tx: Sender<Value>,
    #[allow(dead_code)]
    cwd: String,
}

/// The user's installed Claude CLI, from the usual install locations or PATH.
/// An installed agent CLI (`claude`, `codex`), from the usual install locations
/// or PATH. We don't ship the agents themselves — the app drives the user's own.
fn installed(bin: &str) -> Option<String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let path = std::env::var("PATH").unwrap_or_default();
    [format!("{home}/.local/bin"), format!("{home}/.claude/local"), "/opt/homebrew/bin".into(), "/usr/local/bin".into()]
        .into_iter()
        .chain(path.split(':').map(str::to_string))
        .map(|d| format!("{d}/{bin}"))
        .find(|p| Path::new(p).is_file())
}

/// Where the adapters live: `Forest Ranger.app/Contents/Resources` when running
/// from the app bundle (scripts/bundle-macos.sh), else the repo (`cargo run`).
fn resources_root() -> String {
    std::env::current_exe()
        .ok()
        .and_then(|exe| Some(exe.parent()?.parent()?.join("Resources")))
        .filter(|r| r.join("agents").is_dir())
        .map(|r| r.to_string_lossy().into_owned())
        .unwrap_or_else(|| env!("CARGO_MANIFEST_DIR").to_string())
}

/// How to launch an adapter: Node runs the npm package from `agents/`, driving the
/// user's installed CLI (`claude` via CLAUDE_CODE_EXECUTABLE, `codex` via
/// CODEX_PATH — either env var overrides the lookup). We don't ship the agents.
fn adapter_command(provider: &str) -> std::io::Result<Command> {
    let (pkg, bin, env, install) = if provider == "codex" {
        ("codex-acp", "codex", "CODEX_PATH", "`npm i -g @openai/codex` or `brew install codex`")
    } else {
        ("claude-agent-acp", "claude", "CLAUDE_CODE_EXECUTABLE", "see claude.com/claude-code")
    };
    let cli = std::env::var(env).ok().or_else(|| installed(bin)).ok_or_else(|| {
        let name = if provider == "codex" { "Codex" } else { "Claude Code" };
        std::io::Error::new(std::io::ErrorKind::NotFound, format!("{name} isn't installed ({install}) — install it, then start a new chat"))
    })?;
    let mut cmd = Command::new("node");
    cmd.arg(format!("{}/agents/node_modules/@agentclientprotocol/{pkg}/dist/index.js", resources_root())).env(env, cli);
    Ok(cmd)
}

fn write(stdin: &Mutex<ChildStdin>, msg: Value) {
    let mut w = stdin.lock().unwrap();
    let _ = writeln!(w, "{msg}");
    let _ = w.flush();
}

fn request(stdin: &Mutex<ChildStdin>, shared: &Mutex<Shared>, kind: Pending, method: &str, params: Value) {
    let id = {
        let mut s = shared.lock().unwrap();
        s.next_id += 1;
        let id = s.next_id;
        s.pending.insert(id, kind);
        id
    };
    write(stdin, json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }));
}

/// A plain-text prompt as ACP content blocks.
pub fn text_prompt(text: &str) -> Value {
    json!([{ "type": "text", "text": text }])
}

/// Codex's initial agent mode for one of our permission modes (or a Codex mode as-is).
pub fn codex_mode(permission_mode: &str) -> &'static str {
    match permission_mode {
        "bypassPermissions" | "agent-full-access" => "agent-full-access",
        "plan" | "read-only" => "read-only",
        _ => "agent",
    }
}

impl Agent {
    pub fn spawn(opts: StartOpts, tx: Sender<Value>) -> std::io::Result<Self> {
        Self::spawn_with_mode(opts, None, tx)
    }

    /// `initial_mode`: the permission mode Codex starts in (see `codex_mode`); "agent" when None.
    pub fn spawn_with_mode(opts: StartOpts, initial_mode: Option<&str>, tx: Sender<Value>) -> std::io::Result<Self> {
        let home = std::env::var("HOME").unwrap_or_default();
        let path = format!(
            "{}:{home}/.local/bin:{home}/.claude/local:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin",
            std::env::var("PATH").unwrap_or_default()
        );
        let mut cmd = adapter_command(&opts.provider)?;
        cmd.current_dir(&opts.cwd)
            .env("PATH", &path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if opts.provider == "codex" {
            cmd.env("INITIAL_AGENT_MODE", codex_mode(initial_mode.unwrap_or("agent")));
            if let Some(m) = &opts.model {
                cmd.env("CODEX_CONFIG", json!({ "model": m }).to_string());
            }
        } else if let Some(m) = &opts.model {
            cmd.env("ANTHROPIC_MODEL", m);
        }
        let mut child = cmd.spawn()?;
        let stdin = Arc::new(Mutex::new(child.stdin.take().unwrap()));
        let stdout = child.stdout.take().unwrap();
        let stderr = child.stderr.take().unwrap();
        let child = Arc::new(Mutex::new(child));
        let shared = Arc::new(Mutex::new(Shared::default()));
        // Echo the adapter's log to our stderr, keeping the tail for error messages.
        let (tail, tag) = (shared.clone(), opts.provider.clone());
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                eprintln!("[{tag}] {line}");
                let mut s = tail.lock().unwrap();
                s.stderr_tail.push_back(line);
                if s.stderr_tail.len() > 20 {
                    s.stderr_tail.pop_front();
                }
            }
        });

        request(
            &stdin,
            &shared,
            Pending::Init,
            "initialize",
            json!({
                "protocolVersion": 1,
                // Client-mediated file I/O makes edits arrive as structured diffs.
                "clientCapabilities": {
                    "fs": { "readTextFile": true, "writeTextFile": true },
                    "elicitation": { "form": {}, "url": {} },
                }
            }),
        );

        let cwd = opts.cwd.clone();
        let ctx = Reader { stdin: stdin.clone(), shared: shared.clone(), tx: tx.clone(), opts };
        let proc = child.clone();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                if let Ok(msg) = serde_json::from_str::<Value>(&line) {
                    ctx.handle(&msg);
                }
            }
            // Killed by us (no code) or a clean exit: just "exited".
            let code = exit_code(&proc).unwrap_or(0);
            if code != 0 {
                let name = if ctx.opts.provider == "codex" { "Codex" } else { "Claude" };
                ctx.emit(json!({ "type": "error", "message": format!("{name} adapter exited with code {code}") }));
            }
            ctx.emit(json!({ "type": "exited", "code": code }));
        });

        Ok(Self { child, stdin, shared, tx, cwd })
    }

    /// Send a prompt (ACP content blocks: text, images).
    pub fn prompt(&self, blocks: Value) {
        let session = self.shared.lock().unwrap().session.clone();
        match session {
            Some(sid) => request(&self.stdin, &self.shared, Pending::Prompt, "session/prompt", json!({ "sessionId": sid, "prompt": blocks })),
            None => self.shared.lock().unwrap().queued.push(blocks),
        }
    }

    pub fn can_steer(&self) -> bool {
        self.shared.lock().unwrap().can_steer
    }

    /// Add a message to the running turn; the agent takes it at its next step.
    /// If no turn is running after all, it's sent as a normal prompt.
    /// Emits `{type:"steer_result", id, injected}` (with the caller's id) once the agent answers.
    pub fn steer_tagged(&self, id: &str, blocks: Value) {
        let Some(sid) = self.shared.lock().unwrap().session.clone() else {
            let _ = self.tx.send_blocking(json!({ "type": "steer_result", "id": id, "injected": false }));
            return self.prompt(blocks);
        };
        request(
            &self.stdin,
            &self.shared,
            Pending::Steer(blocks.clone(), id.to_string()),
            "_session/steering",
            json!({ "sessionId": sid, "prompt": blocks, "_meta": { "steering": { "idleBehavior": "promptRequired" } } }),
        );
    }

    pub fn respond(&self, id: &str, option_id: &str) {
        let Some((rpc_id, labels)) = self.shared.lock().unwrap().perms.remove(id) else { return };
        write(
            &self.stdin,
            json!({ "jsonrpc": "2.0", "id": rpc_id, "result": { "outcome": { "outcome": "selected", "optionId": option_id } } }),
        );
        let label = labels.get(option_id).cloned().unwrap_or_else(|| option_id.to_string());
        let _ = self.tx.send_blocking(json!({ "type": "permission_resolved", "id": id, "label": label }));
    }

    /// Answer an open elicitation: `action` is accept, decline or cancel.
    #[allow(dead_code)] // chat wires these up in wave 2
    pub fn answer_elicitation(&self, id: &str, action: &str, content: Option<Value>) {
        let rpc_id = self.shared.lock().unwrap().elicits.remove(id);
        if let Some(rpc_id) = rpc_id {
            write(&self.stdin, json!({ "jsonrpc": "2.0", "id": rpc_id, "result": elicit_response(action, content) }));
        }
        let _ = self.tx.send_blocking(json!({ "type": "elicitation_resolved", "id": id }));
    }

    /// Fork the agent's session at an agent message (None = its latest state). The
    /// receiver yields the new session's id.
    #[allow(dead_code)]
    pub fn fork(&self, message_id: Option<&str>) -> Receiver<Result<String, String>> {
        let (tx, rx) = async_channel::bounded(1);
        let Some(sid) = self.shared.lock().unwrap().session.clone() else {
            let _ = tx.try_send(Err("Chat isn't connected".into()));
            return rx;
        };
        let mut params = json!({ "sessionId": sid, "cwd": self.cwd, "mcpServers": [] });
        if let Some(mid) = message_id {
            params["_meta"] = json!({ "jetbrains": { "air": { "fork": { "version": 1, "messageId": mid } } } });
        }
        request(&self.stdin, &self.shared, Pending::Fork(tx), "session/fork", params);
        rx
    }

    /// Switch the agent's advertised session mode (it confirms via current_mode_update).
    #[allow(dead_code)]
    pub fn set_session_mode(&self, mode_id: &str) {
        let Some(sid) = self.shared.lock().unwrap().session.clone() else { return };
        request(&self.stdin, &self.shared, Pending::Ignore, "session/set_mode", json!({ "sessionId": sid, "modeId": mode_id }));
    }

    pub fn set_config(&self, config_id: &str, value: &str) {
        let Some(sid) = self.shared.lock().unwrap().session.clone() else { return };
        request(
            &self.stdin,
            &self.shared,
            Pending::SetConfig,
            "session/set_config_option",
            json!({ "sessionId": sid, "configId": config_id, "value": value }),
        );
    }

    /// Stop the running turn (keeps the session). Open permission prompts are
    /// answered "cancelled" so the turn can actually end.
    pub fn cancel(&self) {
        let (sid, perms, elicits) = {
            let mut s = self.shared.lock().unwrap();
            (s.session.clone(), std::mem::take(&mut s.perms), std::mem::take(&mut s.elicits))
        };
        for (id, rpc_id) in elicits {
            write(&self.stdin, json!({ "jsonrpc": "2.0", "id": rpc_id, "result": elicit_response("cancel", None) }));
            let _ = self.tx.send_blocking(json!({ "type": "elicitation_resolved", "id": id }));
        }
        for (id, (rpc_id, _)) in perms {
            write(&self.stdin, json!({ "jsonrpc": "2.0", "id": rpc_id, "result": { "outcome": { "outcome": "cancelled" } } }));
            let _ = self.tx.send_blocking(json!({ "type": "permission_resolved", "id": id, "label": "Cancelled" }));
        }
        if let Some(sid) = sid {
            write(&self.stdin, json!({ "jsonrpc": "2.0", "method": "session/cancel", "params": { "sessionId": sid } }));
        }
    }
}

impl Drop for Agent {
    fn drop(&mut self) {
        let _ = self.child.lock().map(|mut c| c.kill());
    }
}

struct Reader {
    stdin: Arc<Mutex<ChildStdin>>,
    shared: Arc<Mutex<Shared>>,
    tx: Sender<Value>,
    opts: StartOpts,
}

impl Reader {
    fn emit(&self, e: Value) {
        let _ = self.tx.send_blocking(e);
    }

    fn reply(&self, id: &Value, result: Result<Value, String>) {
        write(
            &self.stdin,
            match result {
                Ok(r) => json!({ "jsonrpc": "2.0", "id": id, "result": r }),
                Err(m) => json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32603, "message": m } }),
            },
        );
    }

    fn handle(&self, msg: &Value) {
        match msg["method"].as_str() {
            None => self.on_response(msg),
            Some(method) if !msg["id"].is_null() => self.on_request(method, msg),
            Some("session/update") => self.on_update(&msg["params"]["update"]),
            // A URL elicitation finished on the agent's side.
            Some("elicitation/complete") => {
                if let Some(id) = msg["params"]["elicitationId"].as_str() {
                    if let Some(rpc_id) = self.shared.lock().unwrap().elicits.remove(id) {
                        self.reply(&rpc_id, Ok(elicit_response("accept", None)));
                    }
                    self.emit(json!({ "type": "elicitation_resolved", "id": id }));
                }
            }
            Some(_) => {}
        }
    }

    fn new_session(&self) {
        request(&self.stdin, &self.shared, Pending::New, "session/new", json!({ "cwd": self.opts.cwd, "mcpServers": [] }));
    }

    /// The session is up: report it, then send anything typed while starting.
    fn session_ready(&self, sid: String, result: &Value) {
        self.emit_modes(&result["modes"]);
        self.emit_config(&result["configOptions"]);
        self.emit(json!({ "type": "system", "sessionId": sid, "model": null }));
        let queued = {
            let mut s = self.shared.lock().unwrap();
            s.session = Some(sid.clone());
            std::mem::take(&mut s.queued)
        };
        for blocks in queued {
            request(&self.stdin, &self.shared, Pending::Prompt, "session/prompt", json!({ "sessionId": sid, "prompt": blocks }));
        }
    }

    /// An error's message plus whatever explains it: the JSON-RPC `data`, else (for a
    /// generic one like "Internal error") the adapter's last log lines.
    fn error_text(&self, e: &Value) -> String {
        let message = e["message"].as_str().unwrap_or("agent error").to_string();
        let data = match &e["data"] {
            Value::Null => None,
            Value::String(s) => Some(s.clone()),
            d => d["details"].as_str().or(d["message"].as_str()).map(str::to_string).or_else(|| Some(d.to_string())),
        };
        if let Some(d) = data.filter(|d| !d.is_empty() && *d != message) {
            return format!("{message}: {d}");
        }
        if message.len() > 40 {
            return message;
        }
        let tail = self.shared.lock().unwrap().stderr_tail.iter().rev().take(3).rev().cloned().collect::<Vec<_>>().join(" · ");
        if tail.is_empty() { message } else { format!("{message} — {tail}") }
    }

    fn on_response(&self, msg: &Value) {
        let Some(id) = msg["id"].as_u64() else { return };
        let Some(kind) = self.shared.lock().unwrap().pending.remove(&id) else { return };
        let err = msg.get("error").map(|e| self.error_text(e));
        let result = &msg["result"];
        match kind {
            Pending::Init => {
                if let Some(e) = err {
                    return self.emit(json!({ "type": "error", "message": format!("ACP init failed: {e}") }));
                }
                self.shared.lock().unwrap().can_steer = result["_meta"]["steering"]["supported"].as_bool() == Some(true);
                let can_load = result["agentCapabilities"]["loadSession"].as_bool() == Some(true);
                match (&self.opts.resume_id, can_load) {
                    (Some(rid), true) => {
                        self.shared.lock().unwrap().suppress = true;
                        request(
                            &self.stdin,
                            &self.shared,
                            Pending::Load,
                            "session/load",
                            json!({ "sessionId": rid, "cwd": self.opts.cwd, "mcpServers": [] }),
                        );
                    }
                    _ => self.new_session(),
                }
            }
            Pending::Load => {
                self.shared.lock().unwrap().suppress = false;
                match err {
                    // Stale/expired — fall back to a fresh session.
                    Some(_) => self.new_session(),
                    None => self.session_ready(self.opts.resume_id.clone().unwrap_or_default(), result),
                }
            }
            Pending::New => match err {
                Some(e) => self.emit(json!({ "type": "error", "message": format!("Couldn't start a session: {e}") })),
                None => self.session_ready(result["sessionId"].as_str().unwrap_or_default().to_string(), result),
            },
            Pending::Prompt => match err {
                Some(e) => self.emit(json!({ "type": "error", "message": format!("Send failed: {e}") })),
                None => self.emit(json!({ "type": "result", "ok": result["stopReason"] != "refusal", "durationMs": null })),
            },
            Pending::Ignore => {}
            Pending::Fork(tx) => {
                let r = match err {
                    Some(e) => Err(format!("Branch failed: {e}")),
                    None => result["sessionId"].as_str().map(str::to_string).ok_or_else(|| "Branch failed: no session id".into()),
                };
                let _ = tx.try_send(r);
            }
            Pending::SetConfig => match err {
                Some(e) => self.emit(json!({ "type": "error", "message": e })),
                None => self.emit_config(&result["configOptions"]),
            },
            // Not taken into a running turn — send it as a normal prompt.
            Pending::Steer(blocks, tag) => {
                let injected = err.is_none() && (result["outcome"] == "injected" || result["outcome"] == "startedNewTurn");
                self.emit(json!({ "type": "steer_result", "id": tag, "injected": injected }));
                if !injected {
                    let sid = self.shared.lock().unwrap().session.clone().unwrap_or_default();
                    request(&self.stdin, &self.shared, Pending::Prompt, "session/prompt", json!({ "sessionId": sid, "prompt": blocks }));
                }
            }
        }
    }

    fn on_request(&self, method: &str, msg: &Value) {
        let (id, p) = (&msg["id"], &msg["params"]);
        match method {
            "fs/read_text_file" => self.reply(
                id,
                self.in_cwd(p["path"].as_str().unwrap_or_default()).and_then(|path| {
                    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
                    let (line, limit) = (p["line"].as_u64(), p["limit"].as_u64());
                    if line.is_none() && limit.is_none() {
                        return Ok(json!({ "content": text }));
                    }
                    let start = line.map(|l| l.saturating_sub(1) as usize).unwrap_or(0);
                    let lines: Vec<&str> = text.split('\n').collect();
                    let end = limit.map(|l| (start + l as usize).min(lines.len())).unwrap_or(lines.len());
                    Ok(json!({ "content": lines.get(start..end).unwrap_or_default().join("\n") }))
                }),
            ),
            "fs/write_text_file" => self.reply(
                id,
                self.in_cwd(p["path"].as_str().unwrap_or_default()).and_then(|path| {
                    fs::write(path, p["content"].as_str().unwrap_or_default()).map_err(|e| e.to_string())?;
                    Ok(json!({}))
                }),
            ),
            "session/request_permission" => self.on_permission(id, p),
            "elicitation/create" => self.on_elicitation(id, p),
            _ => write(
                &self.stdin,
                json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "not supported" } }),
            ),
        }
    }

    /// Confine the agent's client-mediated file I/O to the worktree.
    fn in_cwd(&self, p: &str) -> Result<PathBuf, String> {
        let root = fs::canonicalize(&self.opts.cwd).map_err(|e| e.to_string())?;
        let path = Path::new(p);
        let parent = path.parent().and_then(|d| fs::canonicalize(d).ok()).ok_or("bad path")?;
        if !parent.starts_with(&root) {
            return Err(format!("path outside worktree: {p}"));
        }
        Ok(parent.join(path.file_name().ok_or("bad path")?))
    }

    fn on_permission(&self, rpc_id: &Value, p: &Value) {
        let options: Vec<&Value> = p["options"].as_array().map(|a| a.iter().collect()).unwrap_or_default();
        let allow = options
            .iter()
            .find(|o| o["kind"] == "allow_once")
            .or_else(|| options.iter().find(|o| o["kind"] == "allow_always"));
        let kind = p["toolCall"]["kind"].as_str().unwrap_or_default();
        let mode = self.shared.lock().unwrap().mode.clone();
        let auto = mode == "bypassPermissions" || (mode == "acceptEdits" && ["edit", "delete", "move"].contains(&kind));
        if let (true, Some(a)) = (auto, allow) {
            return self.reply(rpc_id, Ok(json!({ "outcome": { "outcome": "selected", "optionId": a["optionId"] } })));
        }
        let id = p["toolCall"]["toolCallId"].as_str().map(str::to_string).unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let labels = options
            .iter()
            .map(|o| (o["optionId"].as_str().unwrap_or_default().to_string(), o["name"].as_str().unwrap_or_default().to_string()))
            .collect();
        self.shared.lock().unwrap().perms.insert(id.clone(), (rpc_id.clone(), labels));
        self.emit(json!({
            "type": "permission",
            "id": id,
            "toolName": p["toolCall"]["title"].as_str().unwrap_or("tool"),
            "input": p["toolCall"]["rawInput"],
            "options": options.iter().map(|o| json!({ "id": o["optionId"], "label": o["name"], "kind": o["kind"] })).collect::<Vec<_>>(),
        }));
    }

    fn on_elicitation(&self, rpc_id: &Value, p: &Value) {
        let message = p["message"].clone();
        let (id, e) = if p["mode"] == "url" {
            let id = p["elicitationId"].as_str().map(str::to_string).unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            let e = json!({ "type": "elicitation", "id": id, "mode": "url", "message": message, "fields": [], "url": p["url"] });
            (id, e)
        } else {
            let id = uuid::Uuid::new_v4().to_string();
            let e = json!({ "type": "elicitation", "id": id, "mode": "form", "message": message, "fields": normalize_schema(&p["requestedSchema"]) });
            (id, e)
        };
        self.shared.lock().unwrap().elicits.insert(id, rpc_id.clone());
        self.emit(e);
    }

    fn emit_modes(&self, modes: &Value) {
        let Some(available) = modes["availableModes"].as_array() else { return };
        let available: Vec<Value> = available
            .iter()
            .map(|m| json!({ "id": m["id"], "name": m["name"], "description": m["description"] }))
            .collect();
        self.shared.lock().unwrap().modes = available.clone();
        self.emit(json!({ "type": "modes", "current": modes["currentModeId"], "available": available }));
    }

    /// Normalize the agent's select-type config options (model/mode/effort/…).
    fn emit_config(&self, opts: &Value) {
        let Some(opts) = opts.as_array() else { return };
        let mapped: Vec<Value> = opts
            .iter()
            .filter(|o| o["type"] == "select")
            .map(|o| {
                json!({
                    "id": o["id"],
                    "name": o["name"],
                    "category": o["category"],
                    "currentValue": o["currentValue"],
                    "options": o["options"].as_array().into_iter().flatten()
                        .map(|v| json!({ "value": v["value"], "label": v["name"], "description": v["description"] }))
                        .collect::<Vec<_>>(),
                })
            })
            .collect();
        if let Some(mode) = mapped.iter().find(|o| o["id"] == "mode" || o["category"] == "mode") {
            self.shared.lock().unwrap().mode = mode["currentValue"].as_str().unwrap_or_default().to_string();
        }
        self.emit(json!({ "type": "configOptions", "options": mapped }));
    }

    fn on_update(&self, u: &Value) {
        if self.shared.lock().unwrap().suppress {
            return;
        }
        let text = || u["content"]["text"].as_str().unwrap_or_default();
        match u["sessionUpdate"].as_str().unwrap_or_default() {
            "agent_message_chunk" if u["content"]["type"] == "text" => {
                let mut e = json!({ "type": "assistant_text", "text": text() });
                if let Some(mid) = u["messageId"].as_str() {
                    e["messageId"] = mid.into();
                }
                self.emit(e);
            }
            "agent_thought_chunk" if u["content"]["type"] == "text" => {
                self.emit(json!({ "type": "thinking", "text": text() }))
            }
            "tool_call" => {
                let mut e = json!({
                    "type": "tool_use",
                    "id": u["toolCallId"],
                    "name": u["title"].as_str().filter(|t| !t.is_empty()).or(u["kind"].as_str()).unwrap_or("tool"),
                    "input": u["rawInput"],
                });
                if let Some(d) = diffs(&u["content"]) {
                    e["diffs"] = d;
                }
                self.emit(e);
            }
            "tool_call_update" if u["status"] == "completed" || u["status"] == "failed" => {
                let mut e = json!({
                    "type": "tool_result",
                    "id": u["toolCallId"],
                    "ok": u["status"] == "completed",
                    "summary": content_text(&u["content"]),
                });
                if let Some(d) = diffs(&u["content"]) {
                    e["diffs"] = d;
                }
                self.emit(e);
            }
            "usage_update" => {
                let mut e = json!({ "type": "usage", "used": u["used"], "size": u["size"] });
                if u["cost"].is_object() {
                    e["cost"] = json!({ "amount": u["cost"]["amount"], "currency": u["cost"]["currency"] });
                }
                self.emit(e);
            }
            "plan" => self.emit(json!({
                "type": "plan",
                "entries": u["entries"].as_array().into_iter().flatten()
                    .map(|e| json!({ "content": e["content"], "status": e["status"] })).collect::<Vec<_>>(),
            })),
            "available_commands_update" => self.emit(json!({
                "type": "commands",
                "commands": u["availableCommands"].as_array().into_iter().flatten()
                    .map(|c| json!({ "name": c["name"], "description": c["description"] })).collect::<Vec<_>>(),
            })),
            "current_mode_update" => {
                let available = self.shared.lock().unwrap().modes.clone();
                self.emit(json!({ "type": "modes", "current": u["currentModeId"], "available": available }));
            }
            "config_option_update" => self.emit_config(&u["configOptions"]),
            _ => {}
        }
    }
}

/// A tool's text output, flattened and capped (like the Electron driver).
fn content_text(content: &Value) -> String {
    let text = content
        .as_array()
        .into_iter()
        .flatten()
        .map(|c| c["content"]["text"].as_str().or(c["text"].as_str()).unwrap_or_default())
        .collect::<Vec<_>>()
        .join("\n");
    let text = text.trim();
    if text.chars().count() > 4000 {
        format!("{}\n…(truncated)", text.chars().take(4000).collect::<String>())
    } else {
        text.to_string()
    }
}

/// Structured file edits (`type: "diff"` blocks) from a tool's content.
fn diffs(content: &Value) -> Option<Value> {
    let out: Vec<Value> = content
        .as_array()
        .into_iter()
        .flatten()
        .filter(|c| c["type"] == "diff" && c["path"].is_string() && c["newText"].is_string())
        .map(|c| json!({ "path": c["path"], "oldText": c["oldText"], "newText": c["newText"] }))
        .collect();
    (!out.is_empty()).then(|| Value::Array(out))
}

/// The adapter's exit code once it's gone; None if killed by a signal (or still
/// running after its stdout closed).
fn exit_code(child: &Mutex<Child>) -> Option<i32> {
    for _ in 0..100 {
        match child.lock().ok()?.try_wait() {
            Ok(Some(status)) => return status.code(),
            Ok(None) => thread::sleep(std::time::Duration::from_millis(20)),
            Err(_) => return None,
        }
    }
    None
}

/// The ACP response to an elicitation answer.
fn elicit_response(action: &str, content: Option<Value>) -> Value {
    match action {
        "accept" => json!({ "action": "accept", "content": content.unwrap_or_else(|| json!({})) }),
        "decline" => json!({ "action": "decline" }),
        _ => json!({ "action": "cancel" }),
    }
}

fn enum_options(enum_values: &Value, one_of: &Value) -> Vec<Value> {
    if let Some(o) = one_of.as_array().filter(|a| !a.is_empty()) {
        return o.iter().map(|o| json!({ "value": o["const"], "label": o["title"] })).collect();
    }
    enum_values.as_array().into_iter().flatten().map(|v| json!({ "value": v, "label": v })).collect()
}

/// An elicitation form's JSON schema as flat fields (Electron's ElicitationField).
fn normalize_schema(schema: &Value) -> Value {
    let required: Vec<&str> = schema["required"].as_array().into_iter().flatten().filter_map(|r| r.as_str()).collect();
    let fields = schema["properties"].as_object().into_iter().flatten().map(|(key, p)| {
        let mut f = json!({
            "key": key,
            "label": p["title"].as_str().filter(|t| !t.is_empty()).unwrap_or(key),
            "required": required.contains(&key.as_str()),
        });
        if p["description"].is_string() {
            f["description"] = p["description"].clone();
        }
        if !p["default"].is_null() {
            f["default"] = p["default"].clone();
        }
        let (input, options) = match p["type"].as_str() {
            Some(t @ ("boolean" | "number" | "integer")) => (t, None),
            Some("array") => ("multiselect", Some(enum_options(&p["items"]["enum"], &p["items"]["oneOf"]))),
            _ => match enum_options(&p["enum"], &p["oneOf"]) {
                o if o.is_empty() => ("text", None),
                o => ("select", Some(o)),
            },
        };
        f["input"] = input.into();
        if let Some(o) = options {
            f["options"] = o.into();
        }
        f
    });
    Value::Array(fields.collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_fields() {
        let f = normalize_schema(&json!({
            "properties": {
                "name": { "type": "string", "title": "Name" },
                "ok": { "type": "boolean", "default": true },
                "pick": { "type": "string", "oneOf": [{ "const": "a", "title": "A" }] },
                "tags": { "type": "array", "items": { "enum": ["x", "y"] } },
            },
            "required": ["name"],
        }));
        let by = |k: &str| f.as_array().unwrap().iter().find(|x| x["key"] == k).unwrap().clone();
        assert_eq!(by("name")["input"], "text");
        assert_eq!(by("name")["required"], true);
        assert_eq!(by("ok")["label"], "ok");
        assert_eq!(by("ok")["default"], true);
        assert_eq!(by("pick")["options"], json!([{ "value": "a", "label": "A" }]));
        assert_eq!(by("tags")["input"], "multiselect");
        assert_eq!(by("tags")["options"][1]["value"], "y");
    }

    #[test]
    fn codex_modes() {
        assert_eq!(codex_mode("bypassPermissions"), "agent-full-access");
        assert_eq!(codex_mode("plan"), "read-only");
        assert_eq!(codex_mode("default"), "agent");
    }
}
