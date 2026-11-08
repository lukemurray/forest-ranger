//! Headless checks: `--check` (read-only over real data) and `--agent` (a live chat).

use super::*;

/// `cargo run -- --check`: load everything the UI reads, headless, and report.
pub(crate) fn check() {
    let projects = data::load_projects().expect("load projects");
    let wts: usize = projects.iter().map(|p| p.worktrees.len()).sum();
    println!("{} projects, {wts} worktrees", projects.len());
    let bad = projects
        .iter()
        .flat_map(|p| p.worktrees.iter().map(move |w| (p, w)))
        .filter(|(p, w)| data::worktree_id(&p.id, &w.path) != w.id)
        .count();
    println!("worktree ids matching the Electron scheme: {}/{wts}", wts - bad);
    let mut biggest = (0usize, String::new());
    for w in projects.iter().flat_map(|p| &p.worktrees) {
        for c in data::chats_for(&w.id) {
            let t = std::time::Instant::now();
            let rows = log::ChatLog::open(&c.session_id).events.len();
            if rows > biggest.0 {
                biggest = (rows, format!("{} ({rows} events, parsed in {:?})", c.name, t.elapsed()));
            }
        }
    }
    println!("biggest chat: {}", biggest.1);
    if let Some((p, w)) = projects.iter().max_by_key(|p| p.worktrees.len()).and_then(|p| p.worktrees.first().map(|w| (p, w))) {
        let t = std::time::Instant::now();
        let d = git::detail(&w.path, &p.path, None);
        println!(
            "review {}: branch {:?}, base {:?} ↑{} ↓{}, {} committed / {} uncommitted files, {} branches ({:?})",
            w.label().0, d.branch, d.base, d.ahead, d.behind, d.committed.len(), d.uncommitted.len(), d.branches.len(), t.elapsed()
        );
        let t = std::time::Instant::now();
        let (files, ignored) = git::list_files(&w.path);
        println!("files view: {} files, {} ignored ({:?})", files.len(), ignored.len(), t.elapsed());
        let t = std::time::Instant::now();
        let tree = tree::Dir::build(&files, &ignored, &Default::default(), "");
        let mut rows = vec![];
        tree.flatten("", 0, &Default::default(), false, &mut rows);
        let filtered = tree::Dir::build(&files, &ignored, &Default::default(), "skill");
        let mut frows = vec![];
        filtered.flatten("", 0, &Default::default(), true, &mut frows);
        println!("file tree: {} top-level rows, filter \"skill\" → {} rows ({:?} for both)", rows.len(), frows.len(), t.elapsed());
    }

}

/// `cargo run -- --agent` (use a temp FOREST_RANGER_DATA_DIR): a two-turn chat
/// that's persisted, reopened from disk, and resumed — the agent should still
/// remember the first turn.
pub(crate) fn check_agent() {
    let run = |chat: &mut log::ChatLog, text: &str| -> String {
        let (tx, rx) = async_channel::unbounded();
        let opts = acp::StartOpts {
            provider: "claude".into(),
            cwd: std::env::temp_dir().to_string_lossy().into(),
            model: None,
            resume_id: chat.resume_id(),
        };
        let agent = acp::Agent::spawn(opts, tx).expect("spawn agent");
        chat.push(serde_json::json!({ "type": "user_text", "text": text }));
        agent.prompt(acp::text_prompt(text), "check");
        let mut reply = String::new();
        while let Ok(e) = rx.recv_blocking() {
            let kind = e["type"].as_str().unwrap_or_default().to_string();
            if kind == "assistant_text" {
                reply.push_str(e["text"].as_str().unwrap_or_default());
            }
            chat.push(e);
            if matches!(kind.as_str(), "result" | "error" | "exited") {
                break;
            }
        }
        chat.flush(true);
        chat.write_meta();
        reply
    };
    let id = uuid::Uuid::new_v4().to_string();
    let mut chat = log::ChatLog::new(id.clone(), "wt".into(), "proj".into(), "claude".into());
    println!("turn 1: {:?}", run(&mut chat, "Remember the word ORCHID. Reply with just: ok"));
    let mut reopened = log::ChatLog::open(&id);
    println!("reopened: {} events, name {:?}, resume id {:?}", reopened.events.len(), reopened.name(), reopened.resume_id());
    println!("turn 2: {:?}", run(&mut reopened, "What word did I ask you to remember? Reply with just the word."));
    println!("on disk: {} events", log::ChatLog::open(&id).events.len());
}

/// Smoke test for quit-on-close: FR_SMOKE_CLOSE=1 closes the window after 4s;
/// the process should then exit by itself.
pub(crate) fn smoke_close(cx: &mut App) {
    if std::env::var_os("FR_SMOKE_CLOSE").is_none() {
        return;
    }
    // FR_SMOKE_AGENT=1 also starts an agent (no prompt sent), as a live chat would.
    let agent = std::env::var_os("FR_SMOKE_AGENT").map(|_| {
        let (tx, rx) = async_channel::unbounded();
        let opts = acp::StartOpts { provider: "claude".into(), cwd: std::env::temp_dir().to_string_lossy().into(), model: None, resume_id: None };
        (acp::Agent::spawn(opts, tx).ok(), rx)
    });
    cx.spawn(async move |cx| {
        let _agent = agent;
        cx.background_executor().timer(std::time::Duration::from_secs(4)).await;
        let _ = cx.update(|cx| {
            for w in cx.windows() {
                let _ = w.update(cx, |_, window, _| window.remove_window());
            }
        });
    })
    .detach();
}
