//! A chat's event log — the same files the Electron app writes (agentChat.ts):
//! `<id>.jsonl`, one AgentChatEvent per line, append-only; and `<id>.meta.json`, a
//! ChatLogMeta sidecar that files the chat under its worktree.

use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde_json::{Value, json};

use crate::data::data_dir;

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

fn chat_dir() -> PathBuf {
    data_dir().join("chats")
}

pub struct ChatLog {
    pub id: String,
    pub worktree_id: Option<String>,
    pub project_id: Option<String>,
    pub provider: String,
    pub model: Option<String>,
    pub events: Vec<Value>,
    /// A user rename; saved as the meta's name with `renamed: true`.
    pub custom_name: Option<String>,
    /// Events at the front already on disk. They're frozen: a new chunk never
    /// merges into them, so the file only ever needs appending.
    written: usize,
}

/// Errors and exits describe one run of the agent — never persisted. Neither is
/// `steer_result`, which only tells the live view how a steer went.
fn transient(e: &Value) -> bool {
    matches!(e["type"].as_str(), Some("exited" | "error" | "steer_result"))
}

fn mtime(p: &Path) -> Option<SystemTime> {
    fs::metadata(p).and_then(|m| m.modified()).ok()
}

/// Merge a streamed chunk into the previous entry (or replace the last usage
/// report), unless that entry is at or before `frozen` (already on disk). Else push it.
fn append(events: &mut Vec<Value>, e: Value, frozen: usize) {
    let kind = e["type"].as_str().unwrap_or_default();
    let mutable_tail = events.len() > frozen;
    let Some(last) = events.last_mut().filter(|_| mutable_tail) else { return events.push(e) };
    if kind == "usage" && last["type"] == "usage" {
        return *last = e;
    }
    if (kind == "assistant_text" || kind == "thinking") && last["type"] == kind {
        let text = format!("{}{}", last["text"].as_str().unwrap_or_default(), e["text"].as_str().unwrap_or_default());
        last["text"] = text.into();
        // The merged entry keeps the newest message id (branch points).
        if e["messageId"].is_string() {
            last["messageId"] = e["messageId"].clone();
        }
        return;
    }
    events.push(e);
}

/// Drop transient events and merge streamed chunks (as a load does).
fn coalesce(events: impl IntoIterator<Item = Value>) -> Vec<Value> {
    let mut out = vec![];
    for e in events.into_iter().filter(|e| !transient(e)) {
        append(&mut out, e, 0);
    }
    out
}

/// Read a chat's events: the `.jsonl`, unless a legacy `.json` array is newer (not
/// yet migrated) — then it's converted to `.jsonl` (the `.json` stays) and used.
fn load_events(dir: &Path, id: &str) -> Vec<Value> {
    let jsonl = dir.join(format!("{id}.jsonl"));
    let legacy = dir.join(format!("{id}.json"));
    if mtime(&legacy).is_some_and(|lt| mtime(&jsonl).is_none_or(|jt| lt > jt)) {
        let Some(Value::Array(arr)) = fs::read_to_string(&legacy).ok().and_then(|s| serde_json::from_str(&s).ok()) else {
            return vec![];
        };
        let events = coalesce(arr);
        let _ = fs::write(&jsonl, events.iter().map(|e| format!("{e}\n")).collect::<String>());
        return events;
    }
    coalesce(fs::read_to_string(jsonl).unwrap_or_default().lines().filter_map(|l| serde_json::from_str(l).ok()))
}

impl ChatLog {
    pub fn new(id: String, worktree_id: String, project_id: String, provider: String) -> Self {
        Self {
            id,
            worktree_id: Some(worktree_id),
            project_id: Some(project_id),
            provider,
            model: None,
            events: vec![],
            custom_name: None,
            written: 0,
        }
    }

    /// Load a saved chat. A torn last line (crash mid-write) is skipped.
    pub fn open(id: &str) -> Self {
        let dir = chat_dir();
        let meta: Value = fs::read_to_string(dir.join(format!("{id}.meta.json")))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        let events = load_events(&dir, id);
        let s = |k: &str| meta[k].as_str().map(str::to_string);
        Self {
            id: id.to_string(),
            worktree_id: s("worktreeId"),
            project_id: s("projectId"),
            provider: s("provider").unwrap_or_else(|| "claude".into()),
            model: s("model"),
            custom_name: if meta["renamed"] == true { s("name") } else { None },
            written: events.len(),
            events,
        }
    }

    /// Record an event (stamped), merging streamed text into the previous chunk
    /// and keeping only the latest usage report — unless that entry is on disk.
    pub fn push(&mut self, mut e: Value) {
        if e.get("ts").is_none() {
            e["ts"] = now_ms().into();
        }
        append(&mut self.events, e, self.written);
    }

    /// Append not-yet-written events. A trailing text/thinking entry may still be
    /// streaming, so it waits for the next flush unless `all`.
    pub fn flush(&mut self, all: bool) {
        let growing = !all
            && self.events.last().is_some_and(|e| matches!(e["type"].as_str(), Some("assistant_text" | "thinking")));
        let to = if growing { self.events.len() - 1 } else { self.events.len() };
        if to <= self.written {
            return;
        }
        let lines: String = self.events[self.written..to]
            .iter()
            .filter(|e| !transient(e))
            .map(|e| format!("{e}\n"))
            .collect();
        let _ = fs::create_dir_all(chat_dir());
        let ok = lines.is_empty()
            || OpenOptions::new()
                .create(true)
                .append(true)
                .open(chat_dir().join(format!("{}.jsonl", self.id)))
                .and_then(|mut f| f.write_all(lines.as_bytes()))
                .is_ok();
        if ok {
            self.written = to;
        }
    }

    /// Write the `.meta.json` sidecar (name + last real activity).
    pub fn write_meta(&self) {
        if self.events.is_empty() {
            return;
        }
        const WORK: [&str; 5] = ["user_text", "assistant_text", "tool_use", "tool_result", "result"];
        let updated = self
            .events
            .iter()
            .rev()
            .find(|e| WORK.contains(&e["type"].as_str().unwrap_or_default()) && e["ts"].is_i64())
            .and_then(|e| e["ts"].as_i64())
            // Logs from before events had a ts keep their saved time, so reopening
            // a chat doesn't make its worktree look just-used.
            .or_else(|| {
                let prev = fs::read_to_string(chat_dir().join(format!("{}.meta.json", self.id))).ok()?;
                serde_json::from_str::<Value>(&prev).ok()?["updatedAt"].as_i64()
            })
            .unwrap_or_else(now_ms);
        let mut meta = json!({
            "sessionId": self.id,
            "worktreeId": self.worktree_id,
            "projectId": self.project_id,
            "provider": self.provider,
            "model": self.model,
            "name": self.custom_name.clone().unwrap_or_else(|| self.name()),
            "updatedAt": updated,
        });
        if self.custom_name.is_some() {
            meta["renamed"] = true.into();
        }
        let _ = fs::write(chat_dir().join(format!("{}.meta.json", self.id)), meta.to_string());
    }

    /// The first user message, collapsed and truncated — the chat's name.
    pub fn name(&self) -> String {
        let first = self.events.iter().find(|e| e["type"] == "user_text").and_then(|e| e["text"].as_str());
        let line = first.unwrap_or_default().split_whitespace().collect::<Vec<_>>().join(" ");
        if line.is_empty() {
            return "Chat".into();
        }
        if line.chars().count() > 48 { format!("{}…", line.chars().take(48).collect::<String>().trim_end()) } else { line }
    }

    /// The agent's own session id, to resume its context.
    pub fn resume_id(&self) -> Option<String> {
        self.events.iter().rev().find(|e| e["type"] == "system").and_then(|e| e["sessionId"].as_str()).map(str::to_string)
    }

    pub fn last(&self, kind: &str) -> Option<&Value> {
        self.events.iter().rev().find(|e| e["type"] == kind)
    }
}

/// Branch a chat: a new log `new_id` holding `src` up to and including agent
/// message `message_id` (None = all of it), resuming agent session `new_session`.
/// Written to disk like Electron's forkChat.
#[allow(dead_code)] // chat's Branch from here (wave 2)
pub fn fork_log(src: &ChatLog, message_id: Option<&str>, new_id: String, new_session: &str) -> Result<ChatLog, String> {
    let mut log = ChatLog {
        id: new_id,
        worktree_id: src.worktree_id.clone(),
        project_id: src.project_id.clone(),
        provider: src.provider.clone(),
        model: src.model.clone(),
        events: fork_events(&src.events, message_id)?,
        custom_name: None,
        written: 0,
    };
    log.events.push(json!({ "type": "system", "sessionId": new_session, "model": null, "ts": now_ms() }));
    log.flush(true);
    log.write_meta();
    Ok(log)
}

/// The transcript a branch starts with: cut after the message, minus transient
/// events and unanswered prompts, with a mid-turn cut closed by a result.
fn fork_events(events: &[Value], message_id: Option<&str>) -> Result<Vec<Value>, String> {
    let cut = match message_id {
        None => events.len(),
        Some(mid) => {
            events.iter().rposition(|e| e["type"] == "assistant_text" && e["messageId"] == mid).ok_or("That message isn't in this chat's history")?
                + 1
        }
    };
    let copied: Vec<&Value> = events[..cut].iter().filter(|e| !transient(e)).collect();
    let answered: Vec<&Value> = copied
        .iter()
        .filter(|e| matches!(e["type"].as_str(), Some("permission_resolved" | "elicitation_resolved")))
        .map(|e| &e["id"])
        .collect();
    let mut seeded: Vec<Value> = copied
        .into_iter()
        .filter(|e| !matches!(e["type"].as_str(), Some("permission" | "elicitation")) || answered.contains(&&e["id"]))
        .cloned()
        .collect();
    if let Some(u) = seeded.iter().rposition(|e| e["type"] == "user_text") {
        if !seeded[u..].iter().any(|e| e["type"] == "result") {
            seeded.push(json!({ "type": "result", "ok": true, "durationMs": null, "ts": now_ms() }));
        }
    }
    Ok(seeded)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coalesces_chunks_and_drops_transient() {
        let out = coalesce([
            json!({ "type": "assistant_text", "text": "a" }),
            json!({ "type": "error", "message": "x" }),
            json!({ "type": "assistant_text", "text": "b", "messageId": "m1" }),
            json!({ "type": "usage", "used": 1 }),
            json!({ "type": "usage", "used": 2 }),
        ]);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0]["text"], "ab");
        assert_eq!(out[0]["messageId"], "m1");
        assert_eq!(out[1]["used"], 2);
    }

    #[test]
    fn migrates_newer_legacy_json() {
        let dir = std::env::temp_dir().join(format!("fr-log-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("c.jsonl"), "{\"type\":\"user_text\",\"text\":\"old\"}\n").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(20));
        fs::write(dir.join("c.json"), r#"[{"type":"user_text","text":"new"},{"type":"exited","code":0}]"#).unwrap();
        assert_eq!(load_events(&dir, "c")[0]["text"], "new");
        // Migrated: the .jsonl now holds it, and the .json stays.
        assert!(fs::read_to_string(dir.join("c.jsonl")).unwrap().contains("new"));
        assert!(dir.join("c.json").exists());
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn fork_cuts_and_closes_turn() {
        let ev = vec![
            json!({ "type": "user_text", "text": "hi" }),
            json!({ "type": "assistant_text", "text": "a", "messageId": "m1" }),
            json!({ "type": "permission", "id": "p1" }),
            json!({ "type": "permission", "id": "p2" }),
            json!({ "type": "permission_resolved", "id": "p2" }),
            json!({ "type": "assistant_text", "text": "b", "messageId": "m2" }),
            json!({ "type": "result", "ok": true }),
        ];
        let f = fork_events(&ev, Some("m2")).unwrap();
        let kinds: Vec<&str> = f.iter().map(|e| e["type"].as_str().unwrap()).collect();
        assert_eq!(kinds, ["user_text", "assistant_text", "permission", "permission_resolved", "assistant_text", "result"]);
        assert_eq!(f[2]["id"], "p2");
        assert_eq!(fork_events(&ev, None).unwrap().len(), 6);
        assert!(fork_events(&ev, Some("nope")).is_err());
    }
}
