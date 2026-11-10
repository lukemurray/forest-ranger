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
    // Merge requests per project (read-only gh / glab calls), with a timing.
    for p in &projects {
        let t = std::time::Instant::now();
        match crate::reviews::list(&p.id, &p.path) {
            Ok((host, mrs)) => {
                let count = |s: crate::reviews::Section| mrs.iter().filter(|m| m.section() == s).count();
                println!(
                    "{}: {} {} open — needs you {}, ready {}, yours {}, others {} ({:?})",
                    p.name,
                    host.label(),
                    mrs.len(),
                    count(crate::reviews::Section::NeedsYou),
                    count(crate::reviews::Section::Ready),
                    count(crate::reviews::Section::Mine),
                    count(crate::reviews::Section::Others),
                    t.elapsed()
                );
                for m in mrs.iter().filter(|m| m.section() == crate::reviews::Section::NeedsYou).take(5) {
                    println!("    #{} {} — {}", m.number, m.title.chars().take(50).collect::<String>(), m.needs_you().join(", "));
                }
            }
            Err(e) => println!("{}: {e}", p.name),
        }
    }
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

/// `FR_BENCH=1` (or `=idle`: same scene, not working): open the most recently used worktree that has a saved chat tab and
/// make that chat look like it's working (no agent runs) — a repeatable scene for
/// measuring CPU and memory while a chat works.
pub(crate) fn bench(window: &mut Window, cx: &mut Context<ForestRanger>) {
    if std::env::var_os("FR_BENCH").is_none() {
        return;
    }
    cx.spawn_in(window, async move |this, cx| {
        cx.background_executor().timer(std::time::Duration::from_secs(1)).await;
        let _ = this.update(cx, |fr, cx| {
            let saved = &SessionState::get(cx).worktrees;
            let wt = fr
                .projects
                .iter()
                .flat_map(|p| &p.worktrees)
                .filter(|w| saved.get(&w.id).is_some_and(|s| s.tabs.iter().any(|k| k.starts_with("chat:"))))
                .max_by_key(|w| w.activity)
                .map(|w| w.id.clone());
            if let Some(wt) = wt {
                fr.select(wt, cx);
            }
        });
        // Saved tabs reopen on the next render.
        cx.background_executor().timer(std::time::Duration::from_secs(2)).await;
        let _ = this.update(cx, |fr, cx| {
            let chat = fr.tabs.get(fr.selected.as_deref().unwrap_or_default()).and_then(|t| {
                t.open.iter().find_map(|t| match t {
                    Tab::Chat(c) => Some(c.clone()),
                    _ => None,
                })
            });
            let idle = std::env::var("FR_BENCH").is_ok_and(|v| v == "idle");
            if let Some(c) = &chat {
                eprintln!("FR_BENCH: {} chat {}", if idle { "idle" } else { "working" }, c.read(cx).session_id());
            }
            match chat {
                Some(_) if idle => {}
                Some(c) => c.update(cx, |c, cx| c.bench_working(cx)),
                None => eprintln!("FR_BENCH: no chat tab to mark working"),
            }
        });
    })
    .detach();
}

/// `FR_SMOKE_POPOUT=1` (run on a copy of your data): pop the most recent worktree
/// with a chat tab out into its own window, check the same live chat arrived there,
/// dock it back, check it came home, then quit. Prints PASS/FAIL lines.
pub(crate) fn smoke_popout(window: &mut Window, cx: &mut Context<ForestRanger>) {
    if std::env::var_os("FR_SMOKE_POPOUT").is_none() {
        return;
    }
    let wait = |s| std::time::Duration::from_millis(s);
    cx.spawn_in(window, async move |this, cx| {
        cx.background_executor().timer(wait(1000)).await;
        let _ = this.update(cx, |fr, cx| {
            let saved = &SessionState::get(cx).worktrees;
            let wt = fr.projects.iter().flat_map(|p| &p.worktrees)
                .filter(|w| saved.get(&w.id).is_some_and(|s| s.tabs.iter().any(|k| k.starts_with("chat:"))))
                .max_by_key(|w| w.activity).map(|w| w.id.clone());
            match wt {
                Some(wt) => fr.select(wt, cx),
                None => eprintln!("FR_SMOKE_POPOUT: FAIL no worktree with a chat tab"),
            }
        });
        cx.background_executor().timer(wait(2000)).await;
        let Ok(Some((wt, chat))) = this.update(cx, |fr, _| {
            let wt = fr.selected.clone()?;
            let chat = fr.tabs.get(&wt)?.open.iter().find_map(|t| match t { Tab::Chat(c) => Some(c.entity_id()), _ => None })?;
            Some((wt, chat))
        }) else {
            eprintln!("FR_SMOKE_POPOUT: FAIL no chat reopened");
            return;
        };
        let _ = this.update(cx, |fr, cx| fr.pop_out(&wt, cx));
        cx.background_executor().timer(wait(2000)).await;
        let there = cx.update(|_, cx| {
            let (_, popped) = crate::windows::Windows::popped(cx, &wt)?;
            let p = popped.read(cx);
            Some(p.tabs.get(&wt).is_some_and(|t| t.open.iter().any(|t| matches!(t, Tab::Chat(c) if c.entity_id() == chat))))
        });
        let gone_here = this.update(cx, |fr, _| !fr.tabs.contains_key(&wt)).unwrap_or(false);
        eprintln!("FR_SMOKE_POPOUT: {} same chat entity in the new window, {} gone from main", ok(matches!(there, Ok(Some(true)))), ok(gone_here));
        // Dock back, as closing the window does.
        let _ = cx.update(|_, cx| {
            if let Some((h, popped)) = crate::windows::Windows::popped(cx, &wt) {
                popped.update(cx, |p, cx| p.dock_back(cx));
                let _ = h.update(cx, |_, window, _| window.remove_window());
            }
        });
        cx.background_executor().timer(wait(2000)).await;
        let home = this.update(cx, |fr, _| {
            fr.selected.as_deref() == Some(wt.as_str())
                && fr.tabs.get(&wt).is_some_and(|t| t.open.iter().any(|t| matches!(t, Tab::Chat(c) if c.entity_id() == chat)))
        });
        eprintln!("FR_SMOKE_POPOUT: {} same chat entity back in main, selected", ok(matches!(home, Ok(true))));
        // Pop out again and resize it: its bounds are remembered for that worktree.
        let _ = this.update(cx, |fr, cx| fr.pop_out(&wt, cx));
        cx.background_executor().timer(wait(2000)).await;
        let _ = cx.update(|_, cx| {
            if let Some((h, _)) = crate::windows::Windows::popped(cx, &wt) {
                let _ = h.update(cx, |_, window, _| window.resize(size(px(901.), px(701.))));
            }
        });
        cx.background_executor().timer(wait(1000)).await;
        let saved = cx.update(|_, cx| SessionState::get(cx).popped_bounds.get(&wt).copied());
        eprintln!("FR_SMOKE_POPOUT: {} bounds saved for the worktree: {saved:?}", ok(matches!(saved, Ok(Some([_, _, w, h])) if w == 901. && h == 701.)));
        // As if the worktree were removed: the main window closes its window.
        let _ = this.update(cx, |fr, cx| {
            for p in &mut fr.projects {
                p.worktrees.retain(|w| w.id != wt);
            }
            fr.close_removed_popped(cx);
        });
        cx.background_executor().timer(wait(1000)).await;
        let closed = cx.update(|_, cx| {
            crate::windows::Windows::popped(cx, &wt).is_none()
                && cx.windows().len() == 1
                && !SessionState::get(cx).popped.contains(&wt)
                && !SessionState::get(cx).popped_bounds.contains_key(&wt)
        });
        let not_adopted = this.update(cx, |fr, _| fr.adopted.is_empty()).unwrap_or(false);
        eprintln!("FR_SMOKE_POPOUT: {} removed worktree's window closed and forgotten, {} nothing docked back", ok(matches!(closed, Ok(true))), ok(not_adopted));
        let _ = cx.update(|_, cx| cx.quit());
    })
    .detach();
}

fn ok(b: bool) -> &'static str {
    if b { "PASS" } else { "FAIL" }
}
