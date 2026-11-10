//! The right-hand panel (the Electron app's ReviewPanel): Review (branch status,
//! stage / commit / push / update, changed files and commits vs a base), Files
//! (browse + filter every file) and Search (git grep). Opening a file or a diff
//! is emitted as an event; the window turns it into a tab.

mod change_tree;

use std::collections::{HashMap, HashSet};
use std::rc::Rc;
use std::time::{Duration, Instant};

/// Not drawn for this long: the panel is hidden, so it stops polling.
const HIDDEN: Duration = Duration::from_secs(10);

use gpui_kit::component::button::{Button, ButtonCustomVariant, ButtonVariants as _};
use gpui_kit::component::input::{Input, InputEvent, InputState, Textarea, TextareaState};
use gpui_kit::component::menu::{DropdownMenu as _, PopupMenuItem};
use gpui_kit::component::popover::Popover;
use gpui_kit::component::tooltip::Tooltip;
use gpui_kit::component::*;
use gpui_kit::prelude::FluentBuilder as _;
use gpui_kit::*;

use crate::git::{self, ChangeKind, ChangedFile, Commit, Detail, Hit};
use crate::sidebar::icon;
use crate::theme;
use change_tree::Nav;

pub enum ReviewEvent {
    /// Show one file's diff: uncommitted (base None), committed vs `base`, or
    /// within one commit (`base` = "commit:<hash>").
    OpenDiff { file: String, base: Option<String> },
    OpenFile { rel: String, line: Option<u32> },
    /// Start a chat seeded with this prompt.
    StartChat(String),
    /// Send this prompt in the worktree's current chat (queued if it's mid-turn);
    /// a new chat if there's none.
    ContinueChat(String),
    /// Something was committed / pushed / updated — the sidebar may need refreshing.
    Changed,
    /// The Files / Commits toggle flipped (persisted per worktree).
    CommitsToggled,
    /// A row was double-clicked: keep the preview tab it opened.
    Pin,
}

impl EventEmitter<ReviewEvent> for ReviewPanel {}

#[derive(Clone, Copy, PartialEq)]
pub enum View {
    Review,
    Files,
    Search,
}

/// Placeholder rows inside an ignored folder being listed / listed empty.
const LOADING: &str = "Loading…";
const EMPTY_DIR: &str = "(empty)";

pub struct ReviewPanel {
    project_id: String,
    path: String,
    repo: String,
    /// The branch's MR/PR + pipeline from the code host (None until fetched / no match).
    host: Option<crate::codehost::BranchStatus>,
    host_branch: Option<String>,
    /// A "Push & open PR/MR" is in flight.
    creating: bool,
    base: Option<String>,
    detail: Option<Detail>,
    /// For a detached HEAD, the branch it came from; and whether the worktree is locked.
    detached_from: Option<String>,
    locked: bool,
    /// Last activity (ms) — HEAD commit or newest dirty file.
    activity: i64,
    pub view: View,
    last_view: View,
    pub show_commits: bool,
    commits: Option<Vec<Commit>>,
    /// The expanded commit and its files (None while loading).
    open_commit: Option<(String, Option<Vec<ChangedFile>>)>,
    message: Entity<TextareaState>,
    busy: Option<String>,
    notice: Option<(String, bool)>,
    /// Keyboard focus per tree ("u", "c", "commit:<hash>", "files"): handle + focused row.
    trees: HashMap<String, (FocusHandle, usize)>,
    /// Folders collapsed per change tree (they start open).
    collapsed: HashMap<String, HashSet<String>>,
    /// Collapsed sections ("u", "c").
    closed: HashSet<&'static str>,
    u_filter: Entity<InputState>,
    c_filter: Entity<InputState>,
    base_open: bool,
    base_filter: Entity<InputState>,
    files: Option<Vec<String>>,
    /// Gitignored files listed so far, and ignored folders not yet listed.
    ignored_files: Vec<String>,
    unlisted: HashSet<String>,
    expanded: HashSet<String>,
    /// The built tree, for the filter it was built with (rebuilt when either changes).
    tree: Option<(String, crate::tree::Dir)>,
    files_scroll: UniformListScrollHandle,
    filter: Entity<InputState>,
    query: Entity<InputState>,
    hits: Option<Vec<Hit>>,
    /// The pending / running search; replacing it drops a stale one.
    _search: Task<()>,
    /// The latest git refresh (replacing it drops an older one's result), and whether it's running.
    _refresh: Task<()>,
    refreshing: bool,
    /// Last drawn: a panel off screen (another worktree, panel closed) skips polling.
    drawn: Instant,
    _poll: Task<()>,
    _subs: Vec<Subscription>,
}

/// The instruction an "Agent merge" chat is seeded with (same as the Electron app).
fn merge_prompt(base: &str, branch: &str) -> String {
    format!(
        "Merge the latest `{base}` into this branch (`{branch}`) and resolve any conflicts.

1. Fetch and merge (`git fetch` then `git merge origin/{base}`).
2. If there are conflicts:
   - Resolve simple, unambiguous conflicts directly.
   - For conflicts in generated files (build output, lockfiles, generated code, snapshots), don't hand-merge — regenerate them by running the project's codegen/build command, then stage the result.
   - If a conflict is non-trivial or you're unsure, STOP and ask me for direction instead of guessing.
3. When done:
   - If the ONLY conflicts were in generated files, complete the merge commit and push.
   - Otherwise, leave your resolutions staged but do NOT commit — I want to review locally first — and summarize what changed.
4. Ask me before doing anything risky."
    )
}

/// The instruction a "Re-review latest" chat is seeded with: an updated MR/PR checked against its review threads.
fn rereview_prompt(gitlab: bool, n: u64, branch: &str) -> String {
    let (noun, sigil, cli) = if gitlab { ("MR", "!", "glab") } else { ("PR", "#", "gh") };
    format!(
        "{noun} {sigil}{n} (`{branch}`) has been updated since the last review. Re-review it.

1. Update the branch with `git pull --ff-only` — don't check out `origin/…` or detach HEAD.
2. Read the existing review comments and threads (resolved and unresolved) with `{cli}`.
3. Find the commits pushed since those comments and review them against the threads: was each point actually addressed? Any regressions or new issues in the new code?
4. Report:
   - Each earlier comment: addressed / partly / not addressed, citing files and lines.
   - New issues in the latest commits.
   - Remaining blockers for approval, or say plainly that it's ready to approve.

Don't change any code or post anything — this is a read-only review."
    )
}

fn mono(cx: &App) -> SharedString {
    cx.theme().mono_font_family.clone()
}

/// Electron's `.updateBtn`: amber outline, transparent fill.
fn amber_button(id: &'static str, label: String, cx: &App) -> Button {
    let amber = theme::extra(cx).amber;
    Button::new(id)
        .custom(ButtonCustomVariant::new(cx).color(transparent_black()).foreground(amber).hover(amber.opacity(0.12)).active(amber.opacity(0.2)))
        .border_1()
        .border_color(amber.opacity(0.45))
        .label(label)
}

const RED: u32 = 0xe5746f;

fn kind_letter(k: ChangeKind) -> (&'static str, &'static str) {
    match k {
        ChangeKind::Added => ("A", "added"),
        ChangeKind::Deleted => ("D", "deleted"),
        ChangeKind::Renamed => ("R", "renamed"),
        ChangeKind::Untracked => ("U", "untracked"),
        ChangeKind::Typechange => ("T", "type changed"),
        ChangeKind::Conflicted => ("!", "conflicted"),
        ChangeKind::Modified => ("M", "modified"),
    }
}

/// A key the trees handle: no ⌘ / ⌃ / ⌥ (those stay shortcuts, e.g. ⌘S).
fn tree_key(ev: &KeyDownEvent) -> Option<&str> {
    let m = &ev.keystroke.modifiers;
    (!m.platform && !m.control && !m.alt).then_some(ev.keystroke.key.as_str())
}

/// The detached origin (only looked up when detached) and whether a linked
/// worktree is locked (`<gitdir>/locked`).
fn worktree_meta(path: &str, detached: bool) -> (Option<String>, bool) {
    let gitdir = crate::data::gitdir(path);
    let locked = gitdir.as_ref().is_some_and(|g| g.join("locked").exists());
    let from = gitdir.as_deref().filter(|_| detached).and_then(crate::data::reflog_origin);
    (from, locked)
}

fn plural(n: usize) -> &'static str {
    if n == 1 { "" } else { "s" }
}

impl ReviewPanel {
    pub fn new(project_id: &str, path: &str, repo: &str, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let message = cx.new(|cx| TextareaState::new(window, cx).auto_grow(2, 6).placeholder("Commit message…  (⌘↵ to commit)"));
        let filter = cx.new(|cx| InputState::new(window, cx).placeholder("Filter files…"));
        let u_filter = cx.new(|cx| InputState::new(window, cx).placeholder("Filter files…"));
        let c_filter = cx.new(|cx| InputState::new(window, cx).placeholder("Filter files…"));
        let base_filter = cx.new(|cx| InputState::new(window, cx).placeholder("Filter branches…"));
        let query = cx.new(|cx| InputState::new(window, cx).placeholder("Search in tracked files…"));
        let notify = |_: &mut Self, _, ev: &InputEvent, cx: &mut Context<Self>| {
            if matches!(ev, InputEvent::Change) {
                cx.notify();
            }
        };
        let subs = vec![
            cx.subscribe(&filter, notify),
            cx.subscribe(&u_filter, notify),
            cx.subscribe(&c_filter, notify),
            cx.subscribe(&base_filter, |this: &mut Self, _, ev: &InputEvent, cx| match ev {
                InputEvent::Change => cx.notify(),
                InputEvent::PressEnter { .. } => {
                    if let Some(b) = this.base_matches(cx).into_iter().next() {
                        this.base_open = false;
                        this.set_base(b, cx);
                    }
                }
                _ => {}
            }),
            cx.subscribe(&query, |this: &mut Self, _, ev: &InputEvent, cx| match ev {
                InputEvent::Change => this.run_search(true, cx),
                InputEvent::PressEnter { .. } => this.run_search(false, cx),
                _ => {}
            }),
        ];
        // Keep the change list live while the agent edits: re-read every few seconds
        // (git), and the code host's MR/pipeline status once a minute (network).
        let poll = cx.spawn(async move |this, cx| {
            for tick in 1u64.. {
                cx.background_executor().timer(Duration::from_secs(4)).await;
                let ok = this.update(cx, |this, cx| {
                    // A refresh notifies, so a visible panel redraws between ticks;
                    // one not drawn lately is hidden. A slow repo: let the running
                    // refresh finish rather than pile up.
                    if this.drawn.elapsed() > HIDDEN || this.refreshing {
                        return;
                    }
                    this.refresh(cx);
                    if tick % 15 == 0 {
                        this.refresh_host(cx);
                    }
                });
                if ok.is_err() {
                    break;
                }
            }
        });
        let mut this = Self {
            project_id: project_id.into(),
            path: path.into(),
            repo: repo.into(),
            host: None,
            host_branch: None,
            creating: false,
            base: None,
            detail: None,
            detached_from: None,
            locked: false,
            activity: 0,
            view: View::Review,
            last_view: View::Review,
            show_commits: false,
            commits: None,
            open_commit: None,
            message,
            busy: None,
            notice: None,
            trees: HashMap::new(),
            collapsed: HashMap::new(),
            closed: HashSet::new(),
            u_filter,
            c_filter,
            base_open: false,
            base_filter,
            files: None,
            ignored_files: vec![],
            unlisted: Default::default(),
            expanded: Default::default(),
            tree: None,
            files_scroll: UniformListScrollHandle::new(),
            filter,
            query,
            hits: None,
            _search: Task::ready(()),
            _refresh: Task::ready(()),
            refreshing: false,
            drawn: Instant::now(),
            _poll: poll,
            _subs: subs,
        };
        this.refresh(cx);
        this
    }

    fn is_primary(&self) -> bool {
        self.path == self.repo
    }

    /// Re-read git state off the UI thread.
    pub fn refresh(&mut self, cx: &mut Context<Self>) {
        let (path, repo, base) = (self.path.clone(), self.repo.clone(), self.base.clone());
        let show_commits = self.show_commits;
        let work = cx.background_executor().spawn(async move {
            let d = git::detail(&path, &repo, base.as_deref());
            let activity = crate::data::activity(&path);
            let commits = match (&d.base, show_commits) {
                (Some(b), true) => Some(git::commits_vs_base(&path, b)),
                _ => None,
            };
            (d, commits, activity)
        });
        // Replacing the task drops an older refresh's result, so a slow one can't
        // land after a newer one (e.g. put back the base you just changed).
        self.refreshing = true;
        self._refresh = cx.spawn(async move |this, cx| {
            let (d, commits, activity) = work.await;
            let _ = this.update(cx, |this, cx| {
                this.refreshing = false;
                this.activity = activity;
                // First load, or the branch changed: look up its MR/pipeline and
                // detached origin / lock state.
                if this.detail.is_none() || this.host_branch != d.branch {
                    this.host_branch = d.branch.clone();
                    this.refresh_host(cx);
                    this.load_meta(d.branch.is_none(), cx);
                }
                this.base = d.base.clone();
                this.detail = Some(d);
                if commits.is_some() {
                    this.commits = commits;
                }
                cx.notify();
            });
        });
    }

    fn load_meta(&mut self, detached: bool, cx: &mut Context<Self>) {
        let path = self.path.clone();
        let work = cx.background_executor().spawn(async move { worktree_meta(&path, detached) });
        cx.spawn(async move |this, cx| {
            let (from, locked) = work.await;
            let _ = this.update(cx, |this, cx| {
                this.detached_from = from;
                this.locked = locked;
                cx.notify();
            });
        })
        .detach();
    }

    /// Look up the branch's MR/PR and pipeline on the code host (gh / glab).
    pub fn refresh_host(&mut self, cx: &mut Context<Self>) {
        let Some(branch) = self.host_branch.clone() else {
            self.host = None;
            return;
        };
        let (pid, repo) = (self.project_id.clone(), self.repo.clone());
        let work = cx.background_executor().spawn(async move { crate::codehost::branch_status(&pid, &repo, &branch) });
        cx.spawn(async move |this, cx| {
            let status = work.await;
            let _ = this.update(cx, |this, cx| {
                this.host = status;
                cx.notify();
            });
        })
        .detach();
    }

    /// Push the branch, then open a PR/MR for it into the base (BranchIntegrationBar `create`).
    fn open_request(&mut self, cx: &mut Context<Self>) {
        let (Some(branch), Some(base)) = (self.host_branch.clone(), self.base.clone()) else { return };
        if self.creating {
            return;
        }
        self.creating = true;
        let (pid, repo, path) = (self.project_id.clone(), self.repo.clone(), self.path.clone());
        let work = cx.background_executor().spawn(async move {
            git::push(&path).map_err(|e| format!("Push failed: {e}"))?;
            crate::codehost::create_review_request(&pid, &repo, &branch, &base)
        });
        cx.spawn(async move |this, cx| {
            let res = work.await;
            let _ = this.update(cx, |this, cx| {
                this.creating = false;
                match res {
                    Ok((n, url)) => {
                        let sigil = if this.host.as_ref().is_some_and(|h| h.provider == crate::codehost::Provider::GitLab) { "!" } else { "#" };
                        this.notice = Some((format!("Opened {sigil}{n}"), false));
                        if !url.is_empty() {
                            cx.open_url(&url);
                        }
                    }
                    Err(e) => this.notice = Some((e, true)),
                }
                this.refresh(cx);
                this.refresh_host(cx);
                cx.emit(ReviewEvent::Changed);
            });
        })
        .detach();
        cx.notify();
    }

    /// The code-host bar (BranchIntegrationBar.tsx): provider, MR/PR pill, pipeline pill, link.
    fn host_bar(&self, cx: &mut Context<Self>) -> Option<AnyElement> {
        use crate::codehost::{CheckState, ReqState};
        let h = self.host.as_ref()?;
        let theme = cx.theme().colors;
        let x = theme::extra(cx);
        let pill = |id: SharedString, color: Hsla, dot: bool, text: String, url: String| {
            div()
                .id(id)
                .flex()
                .items_center()
                .gap_1p5()
                .px(px(10.))
                .py(px(3.))
                .rounded_full()
                .border_1()
                .border_color(color.opacity(0.45))
                .text_size(px(12.))
                .text_color(color)
                .cursor_pointer()
                .hover(move |s| s.bg(color.opacity(0.1)))
                .when(dot, |d| d.child(div().size(px(7.)).rounded_full().bg(color)))
                .child(text)
                .on_click(move |_, _, cx| cx.open_url(&url))
        };
        let (sigil, noun) = if h.provider == crate::codehost::Provider::GitLab { ("!", "MR") } else { ("#", "PR") };
        let mut row = div()
            .flex()
            .flex_wrap()
            .items_center()
            .gap_2()
            .child(div().text_size(px(10.5)).font_weight(FontWeight::SEMIBOLD).text_color(x.faint).child(h.provider.label().to_uppercase()));
        match &h.request {
            Some((n, title, state, url)) => {
                let (color, label) = match state {
                    ReqState::Open => (x.green, "open".to_string()),
                    ReqState::Merged => (rgb(0x8b7cf6).into(), "merged".into()),
                    ReqState::Closed => (theme.muted_foreground, "closed".into()),
                    ReqState::Other(s) => (theme.muted_foreground, s.clone()),
                };
                row = row.child(pill("req".into(), color, false, format!("{noun} {sigil}{n} · {label}"), url.clone()).tooltip({
                    let t = title.clone();
                    move |window, cx| Tooltip::new(t.clone()).build(window, cx)
                }));
                if let (ReqState::Open, Some(branch)) = (state, &self.host_branch) {
                    let prompt = rereview_prompt(sigil == "!", *n, branch);
                    // A new chat, or the current one (which already knows the MR's history).
                    let me = cx.entity();
                    row = row.child(
                        Button::new("rereview")
                            .small()
                            .ghost()
                            .label("Re-review latest ▾")
                            .tooltip("Check the new commits against the review comments: anything left blocking approval?")
                            .dropdown_menu_with_anchor(Anchor::TopLeft, move |menu, _, _| {
                                let (m1, m2, p1, p2) = (me.clone(), me.clone(), prompt.clone(), prompt.clone());
                                menu.item(PopupMenuItem::new("In a new chat").on_click(move |_, _, cx| {
                                    m1.update(cx, |_, cx| cx.emit(ReviewEvent::StartChat(p1.clone())))
                                }))
                                .item(PopupMenuItem::new("Continue in the current chat").on_click(move |_, _, cx| {
                                    m2.update(cx, |_, cx| cx.emit(ReviewEvent::ContinueChat(p2.clone())))
                                }))
                            }),
                    );
                }
            }
            None if h.error.is_none() && !h.unsupported => {
                row = row.child(if self.base.is_some() && self.host_branch.is_some() {
                    div()
                        .id("open-req")
                        .text_size(px(12.5))
                        .text_color(theme.primary)
                        .cursor_pointer()
                        .hover(|s| s.underline())
                        .child(if self.creating { "Opening…".to_string() } else { format!("Push & open {noun}") })
                        .on_click(cx.listener(|this, _, _, cx| this.open_request(cx)))
                        .into_any_element()
                } else {
                    div().text_size(px(12.)).text_color(x.faint).child(format!("No open {noun}")).into_any_element()
                });
            }
            None => {}
        }
        if let Some((state, url)) = &h.checks {
            let (color, label) = match state {
                CheckState::Success => (x.green, "pipeline passed".to_string()),
                CheckState::Failed => (rgb(RED).into(), "pipeline failed".into()),
                CheckState::Running => (x.amber, "pipeline running".into()),
                CheckState::Pending => (theme.muted_foreground, "pipeline pending".into()),
                CheckState::Other(s) => (theme.muted_foreground, format!("pipeline {s}")),
            };
            row = row.child(pill("checks".into(), color, true, label, url.clone()));
        }
        let note = if h.unsupported {
            Some(format!("Connected with a token in the Electron app — switch {} to its CLI in Settings to see status here.", h.provider.label()))
        } else {
            h.error.clone()
        };
        let url = h.project_url.clone();
        Some(
            div()
                .flex()
                .flex_col()
                .gap_2()
                .pb(px(14.))
                .mb(px(14.))
                .border_b_1()
                .border_color(theme.border)
                .child(row)
                .when_some(note, |d, n| d.child(div().text_size(px(12.)).text_color(x.faint).child(n)))
                .child(
                    div().flex().justify_end().child(
                        div()
                            .id("open-host")
                            .text_size(px(12.5))
                            .text_color(theme.muted_foreground)
                            .cursor_pointer()
                            .hover(|s| s.text_color(theme.foreground))
                            .child(format!("Open in {} ↗", h.provider.label()))
                            .on_click(move |_, _, cx| cx.open_url(&url)),
                    ),
                )
                .into_any_element(),
        )
    }

    /// Run a git action in the background, then report and refresh.
    fn act(&mut self, label: &str, done: String, f: impl FnOnce(&str) -> Result<(), String> + Send + 'static, cx: &mut Context<Self>) {
        if self.busy.is_some() {
            return;
        }
        self.busy = Some(label.into());
        let path = self.path.clone();
        let work = cx.background_executor().spawn(async move { f(&path) });
        cx.spawn(async move |this, cx| {
            let res = work.await;
            let _ = this.update(cx, |this, cx| {
                this.busy = None;
                this.notice = Some(match res {
                    Ok(()) => (done, false),
                    Err(e) => (e, true),
                });
                this.refresh(cx);
                cx.emit(ReviewEvent::Changed);
            });
        })
        .detach();
        cx.notify();
    }

    fn set_staged(&mut self, files: Vec<String>, staged: bool, cx: &mut Context<Self>) {
        let path = self.path.clone();
        // Optimistic: flip the checkboxes now; the refresh confirms.
        if let Some(d) = &mut self.detail {
            for f in &mut d.uncommitted {
                if files.is_empty() || files.contains(&f.path) {
                    f.staged = staged;
                }
            }
        }
        let work = cx.background_executor().spawn(async move {
            if staged { git::stage(&path, &files) } else { git::unstage(&path, &files) }
        });
        cx.spawn(async move |this, cx| {
            let res = work.await;
            let _ = this.update(cx, |this, cx| {
                if let Err(e) = res {
                    this.notice = Some((e, true));
                }
                this.refresh(cx);
            });
        })
        .detach();
        cx.notify();
    }

    fn commit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let msg = self.message.read(cx).value().trim().to_string();
        let staged = self.detail.as_ref().map_or(0, |d| d.uncommitted.iter().filter(|f| f.staged).count());
        if msg.is_empty() || staged == 0 {
            return;
        }
        if self.busy.is_some() {
            return;
        }
        // Clear the message only once the commit succeeds — a failed commit (e.g. a
        // pre-commit hook) keeps what you wrote.
        self.busy = Some("Committing…".into());
        let path = self.path.clone();
        let work = cx.background_executor().spawn(async move { git::commit(&path, &msg) });
        cx.spawn_in(window, async move |this, cx| {
            let res = work.await;
            let _ = this.update_in(cx, |this, window, cx| {
                this.busy = None;
                this.notice = Some(match res {
                    Ok(()) => {
                        this.message.update(cx, |s, cx| s.set_value(String::new(), window, cx));
                        (format!("Committed {staged} file{}", plural(staged)), false)
                    }
                    Err(e) => (e, true),
                });
                this.refresh(cx);
                cx.emit(ReviewEvent::Changed);
            });
        })
        .detach();
        cx.notify();
    }

    fn set_base(&mut self, base: String, cx: &mut Context<Self>) {
        self.base = Some(base);
        self.commits = None;
        self.open_commit = None;
        self.refresh(cx);
    }

    /// Branches for the base picker: everything but the current one, filtered.
    fn base_matches(&self, cx: &App) -> Vec<String> {
        let q = self.base_filter.read(cx).value().trim().to_lowercase();
        let Some(d) = &self.detail else { return vec![] };
        d.branches.iter().filter(|b| Some(*b) != d.branch.as_ref() && b.to_lowercase().contains(&q)).cloned().collect()
    }

    fn open_base(&mut self, open: bool, window: &mut Window, cx: &mut Context<Self>) {
        self.base_open = open;
        if open {
            self.base_filter.update(cx, |s, cx| {
                s.focus(window, cx);
                s.select_all(window, cx);
            });
        }
        cx.notify();
    }

    /// The base picker's dropdown (BranchCombobox.tsx): filter input + branch list.
    fn base_menu(&self, view: Entity<Self>, cx: &App) -> AnyElement {
        let theme = cx.theme().colors;
        let x = theme::extra(cx);
        let matches = self.base_matches(cx);
        div()
            .w(px(280.))
            .flex()
            .flex_col()
            .gap_1()
            .child(Input::new(&self.base_filter).cleanable(true))
            .child(
                div()
                    .id("base-list")
                    .flex()
                    .flex_col()
                    .max_h(px(300.))
                    .overflow_y_scroll()
                    .when(matches.is_empty(), |d| d.child(div().px_2().py_2().text_size(px(12.5)).text_color(x.faint).child("No matching branch")))
                    .children(matches.into_iter().enumerate().map(|(i, b)| {
                        let current = self.base.as_ref() == Some(&b);
                        let view = view.clone();
                        div()
                            .id(("base", i))
                            .px_2()
                            .py(px(4.))
                            .rounded(px(5.))
                            .text_size(px(13.))
                            .truncate()
                            .cursor_pointer()
                            .hover(|s| s.bg(x.hover))
                            .when(current, |d| d.text_color(theme.primary).font_weight(FontWeight::SEMIBOLD))
                            .child(b.clone())
                            .on_click(move |_, window, cx| {
                                view.update(cx, |v, cx| {
                                    v.base_open = false;
                                    v.set_base(b.clone(), cx);
                                });
                                window.refresh();
                            })
                    })),
            )
            .into_any_element()
    }

    /// List every file the first time the Files view shows.
    fn load_files(&mut self, cx: &mut Context<Self>) {
        let path = self.path.clone();
        let work = cx.background_executor().spawn(async move { git::list_files(&path) });
        cx.spawn(async move |this, cx| {
            let (files, ignored) = work.await;
            let _ = this.update(cx, |this, cx| {
                for p in ignored {
                    match p.strip_suffix('/') {
                        Some(dir) => this.unlisted.insert(dir.to_string()),
                        None => {
                            this.ignored_files.push(p);
                            true
                        }
                    };
                }
                this.files = Some(files);
                this.tree = None;
                cx.notify();
            });
        })
        .detach();
    }

    /// git grep in the background — after 200ms of no typing when `debounce`.
    fn run_search(&mut self, debounce: bool, cx: &mut Context<Self>) {
        let q = self.query.read(cx).value().trim().to_string();
        if q.is_empty() {
            self.hits = None;
            self._search = Task::ready(());
            cx.notify();
            return;
        }
        let path = self.path.clone();
        self._search = cx.spawn(async move |this, cx| {
            if debounce {
                cx.background_executor().timer(Duration::from_millis(200)).await;
            }
            let hits = cx.background_executor().spawn(async move { git::search(&path, &q) }).await;
            let _ = this.update(cx, |this, cx| {
                this.hits = Some(hits);
                cx.notify();
            });
        });
    }

    fn toggle_commit(&mut self, hash: String, cx: &mut Context<Self>) {
        if self.open_commit.as_ref().is_some_and(|(h, _)| *h == hash) {
            self.open_commit = None;
            cx.notify();
            return;
        }
        self.open_commit = Some((hash.clone(), None));
        let path = self.path.clone();
        let h = hash.clone();
        let work = cx.background_executor().spawn(async move { git::commit_files(&path, &h) });
        cx.spawn(async move |this, cx| {
            let files = work.await;
            let _ = this.update(cx, |this, cx| {
                if let Some((h, f)) = &mut this.open_commit {
                    if *h == hash {
                        *f = Some(files);
                    }
                }
                cx.notify();
            });
        })
        .detach();
        cx.notify();
    }

    /// A tree's focus handle and focused row, created on first use.
    fn tree_focus(&mut self, key: &str, cx: &mut Context<Self>) -> (FocusHandle, usize) {
        self.trees.entry(key.to_string()).or_insert_with(|| (cx.focus_handle(), 0)).clone()
    }

    fn set_sel(&mut self, key: &str, i: usize) {
        if let Some(t) = self.trees.get_mut(key) {
            t.1 = i;
        }
    }

    fn set_collapsed(&mut self, key: &str, path: &str, collapsed: bool) {
        let set = self.collapsed.entry(key.to_string()).or_default();
        if collapsed {
            set.insert(path.to_string());
        } else {
            set.remove(path);
        }
    }

    /// Enter / click on a change-tree row: toggle a folder, open a file's diff.
    fn activate_change(&mut self, key: &str, row: &change_tree::Row, base: &Option<String>, cx: &mut Context<Self>) {
        if row.is_dir {
            self.set_collapsed(key, &row.path, row.expanded);
        } else {
            cx.emit(ReviewEvent::OpenDiff { file: row.path.clone(), base: base.clone() });
        }
    }

    /// 's' / the checkbox: stage or unstage a file, or everything under a folder.
    fn stage_node(&mut self, row: &change_tree::Row, files: &[ChangedFile], cx: &mut Context<Self>) {
        let under: Vec<&ChangedFile> = change_tree::under(files, &row.path).collect();
        if under.is_empty() {
            return;
        }
        let all = under.iter().all(|f| f.staged);
        let paths = under.into_iter().map(|f| f.path.clone()).collect();
        self.set_staged(paths, !all, cx);
    }

    #[allow(clippy::too_many_arguments)]
    fn change_tree_key(
        &mut self,
        key: &str,
        rows: &[change_tree::Row],
        files: &[ChangedFile],
        base: &Option<String>,
        stage: bool,
        ev: &KeyDownEvent,
        cx: &mut Context<Self>,
    ) {
        let Some(k) = tree_key(ev) else { return };
        let shape: Vec<_> = rows.iter().map(|r| (r.depth, r.is_dir, r.expanded)).collect();
        let sel = self.trees.get(key).map_or(0, |t| t.1);
        match change_tree::nav(k, sel, &shape) {
            Some(Nav::Focus(i)) => self.set_sel(key, i),
            Some(Nav::Expand(i, open)) => self.set_collapsed(key, &rows[i].path, !open),
            Some(Nav::Activate(i)) => self.activate_change(key, &rows[i], base, cx),
            Some(Nav::Stage(i)) if stage => self.stage_node(&rows[i], files, cx),
            _ => return,
        }
        cx.stop_propagation();
        cx.notify();
    }

    /// A list of changed files as a keyboard-navigable folder tree (FileTree).
    #[allow(clippy::too_many_arguments)]
    fn change_tree(
        &mut self,
        key: String,
        files: &[ChangedFile],
        base: Option<String>,
        stage: bool,
        query: &str,
        empty: Option<String>,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> AnyElement {
        let x = theme::extra(cx);
        let note = |t: String| div().px_2().py_1().text_sm().text_color(x.faint).child(t).into_any_element();
        if files.is_empty() {
            return empty.map(note).unwrap_or_else(|| div().into_any_element());
        }
        let q = query.trim().to_lowercase();
        let files: Rc<Vec<ChangedFile>> = Rc::new(files.iter().filter(|f| q.is_empty() || f.path.to_lowercase().contains(&q)).cloned().collect());
        if files.is_empty() {
            return note(format!("No files match “{}”.", query.trim()));
        }
        let no_collapsed = HashSet::new();
        let rows = Rc::new(change_tree::rows(&files, self.collapsed.get(&key).unwrap_or(&no_collapsed), !q.is_empty()));
        let (handle, sel) = self.tree_focus(&key, cx);
        let sel = sel.min(rows.len() - 1);
        let focused = handle.is_focused(window);
        let theme = cx.theme().colors;
        let mono = mono(cx);
        let elements: Vec<AnyElement> = rows
            .iter()
            .enumerate()
            .map(|(i, r)| {
                let file = r.file.map(|i| &files[i]);
                let (staged_n, total) = if r.is_dir {
                    let u: Vec<_> = change_tree::under(&files, &r.path).collect();
                    (u.iter().filter(|f| f.staged).count(), u.len())
                } else {
                    (file.map_or(0, |f| f.staged as usize), 1)
                };
                let (all, some) = (total > 0 && staged_n == total, staged_n > 0);
                let check = stage.then(|| {
                    let (rows, files, key, dir) = (rows.clone(), files.clone(), key.clone(), r.is_dir);
                    div()
                        .id(("stage", i))
                        .size(px(14.))
                        .flex_shrink_0()
                        .flex()
                        .items_center()
                        .justify_center()
                        .rounded(px(3.))
                        .border_1()
                        .border_color(if some { theme.primary } else { x.border_strong })
                        .when(some, |d| d.bg(theme.primary).text_color(gpui_kit::white()).text_size(px(10.)).child(if all { "✓" } else { "–" }))
                        .tooltip(move |window, cx| Tooltip::new(if dir { "Stage folder" } else { "Stage file" }).build(window, cx))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            cx.stop_propagation();
                            this.set_sel(&key, i);
                            this.stage_node(&rows[i], &files, cx);
                        }))
                });
                let glyph = match file {
                    None => icon("fr/folder.svg", 13., theme.muted_foreground).into_any_element(),
                    Some(f) => {
                        let (letter, _) = kind_letter(f.kind);
                        let c: Hsla = match f.kind {
                            ChangeKind::Added | ChangeKind::Untracked => x.green,
                            ChangeKind::Deleted | ChangeKind::Conflicted => rgb(RED).into(),
                            ChangeKind::Modified => x.amber,
                            _ => theme.muted_foreground,
                        };
                        div()
                            .size(px(18.))
                            .flex_shrink_0()
                            .flex()
                            .items_center()
                            .justify_center()
                            .rounded(px(4.))
                            .bg(c.opacity(0.16))
                            .font_family(mono.clone())
                            .text_size(px(11.))
                            .font_weight(FontWeight::BOLD)
                            .text_color(c)
                            .child(letter)
                            .into_any_element()
                    }
                };
                let tip = match file {
                    Some(f) => format!("{} · {}", f.path, kind_letter(f.kind).1),
                    None => r.path.clone(),
                };
                let (rows_c, key_c, base_c, h) = (rows.clone(), key.clone(), base.clone(), handle.clone());
                div()
                    .id(("row", i))
                    .flex()
                    .items_center()
                    .gap(px(8.))
                    .pl(px(4. + r.depth as f32 * 14.))
                    .pr_1()
                    .py(px(4.))
                    .rounded(px(5.))
                    .cursor_pointer()
                    .hover(|s| s.bg(x.hover))
                    .when(focused && i == sel, |d| d.bg(theme.list_active))
                    .children(check)
                    .child(div().w(px(12.)).flex_shrink_0().when(r.is_dir, |d| {
                        d.child(icon(if r.expanded { "fr/chevron-down.svg" } else { "fr/chevron.svg" }, 12., x.faint))
                    }))
                    .child(glyph)
                    .child(div().flex_1().min_w_0().truncate().font_family(mono.clone()).text_size(px(12.5)).child(r.name.clone()))
                    .child(
                        div()
                            .flex()
                            .gap_2()
                            .flex_shrink_0()
                            .font_family(mono.clone())
                            .text_size(px(12.))
                            .when(r.is_dir, |d| d.child(div().text_color(x.faint).child(r.count.to_string())))
                            .when(r.ins > 0, |d| d.child(div().text_color(x.green).child(format!("+{}", r.ins))))
                            .when(r.del > 0, |d| d.child(div().text_color(rgb(RED)).child(format!("−{}", r.del)))),
                    )
                    .tooltip(move |window, cx| Tooltip::new(tip.clone()).build(window, cx))
                    .on_click(cx.listener(move |this, ev: &ClickEvent, window, cx| {
                        this.set_sel(&key_c, i);
                        window.focus(&h, cx);
                        this.activate_change(&key_c, &rows_c[i], &base_c, cx);
                        if ev.click_count() >= 2 {
                            cx.emit(ReviewEvent::Pin);
                        }
                        cx.notify();
                    }))
                    .into_any_element()
            })
            .collect();
        let (k, r, f) = (key.clone(), rows.clone(), files.clone());
        div()
            .id(SharedString::from(key))
            .flex()
            .flex_col()
            .track_focus(&handle)
            .on_key_down(cx.listener(move |this, ev: &KeyDownEvent, _, cx| this.change_tree_key(&k, &r, &f, &base, stage, ev, cx)))
            .children(elements)
            .into_any_element()
    }

    /// A collapsible section head: title, extra controls, and (for file lists) a
    /// filter once there are more than 3 files plus "N files +X −Y".
    fn section_head(
        &self,
        key: &'static str,
        title: &str,
        files: Option<&[ChangedFile]>,
        filter: &Entity<InputState>,
        right: Option<AnyElement>,
        cx: &mut Context<Self>,
    ) -> Div {
        let x = theme::extra(cx);
        let open = !self.closed.contains(key);
        let files = files.unwrap_or_default();
        let (ins, del) = files.iter().fold((0, 0), |(i, d), f| (i + f.insertions.unwrap_or(0), d + f.deletions.unwrap_or(0)));
        div()
            .flex()
            .flex_wrap()
            .items_center()
            .justify_between()
            .gap_2()
            .pt_2()
            .pb(px(10.))
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .gap_3()
                    .child(
                        div()
                            .id(SharedString::from(format!("sec-{key}")))
                            .flex()
                            .items_center()
                            .gap_1()
                            .cursor_pointer()
                            .child(icon(if open { "fr/chevron-down.svg" } else { "fr/chevron.svg" }, 14., x.faint))
                            .child(div().text_size(px(14.)).font_weight(FontWeight::SEMIBOLD).child(title.to_string()))
                            .on_click(cx.listener(move |this, _, _, cx| {
                                if !this.closed.remove(key) {
                                    this.closed.insert(key);
                                }
                                cx.notify();
                            })),
                    )
                    .children(right),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap_3()
                    .when(open && files.len() > 3, |d| d.child(div().w(px(150.)).child(Input::new(filter).cleanable(true))))
                    .when(!files.is_empty(), |d| {
                        d.child(
                            div()
                                .flex()
                                .gap_1()
                                .font_family(mono(cx))
                                .text_size(px(12.))
                                .text_color(cx.theme().muted_foreground)
                                .child(format!("{} file{}", files.len(), plural(files.len())))
                                .when(ins > 0, |d| d.child(div().text_color(x.green).child(format!("+{ins}"))))
                                .when(del > 0, |d| d.child(div().text_color(rgb(RED)).child(format!("−{del}")))),
                        )
                    }),
            )
    }

    fn stat(&self, value: String, label: &str, cx: &App) -> Div {
        div()
            .flex()
            .flex_col()
            .gap(px(2.))
            .child(div().font_family(mono(cx)).text_size(px(14.)).font_weight(FontWeight::SEMIBOLD).child(value))
            .child(div().text_size(px(10.5)).text_color(theme::extra(cx).faint).child(label.to_uppercase()))
    }

    fn badge(label: &'static str, color: Hsla) -> Div {
        div()
            .px(px(7.))
            .py(px(1.))
            .rounded_full()
            .border_1()
            .border_color(color.opacity(0.45))
            .text_size(px(11.))
            .text_color(color)
            .child(label)
    }

    fn commits_body(&mut self, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let x = theme::extra(cx);
        let note = |t: String| div().px_2().py_1().text_sm().text_color(x.faint).child(t).into_any_element();
        let Some(base) = self.base.clone() else { return note("Pick a base branch to compare against.".into()) };
        let Some(commits) = self.commits.clone() else { return note("Loading commits…".into()) };
        if commits.is_empty() {
            return note(format!("No commits on this branch vs {base}."));
        }
        let open = self.open_commit.clone();
        let mono = mono(cx);
        let mut out = div().flex().flex_col();
        for (i, c) in commits.into_iter().enumerate() {
            let expanded = open.as_ref().filter(|(h, _)| *h == c.hash).map(|(_, f)| f.clone());
            let hash = c.hash.clone();
            out = out.child(
                div()
                    .id(("commit", i))
                    .flex()
                    .items_center()
                    .gap_2()
                    .px_1()
                    .py(px(4.))
                    .rounded(px(5.))
                    .text_size(px(12.5))
                    .cursor_pointer()
                    .hover(|s| s.bg(x.hover))
                    .child(icon(if expanded.is_some() { "fr/chevron-down.svg" } else { "fr/chevron.svg" }, 12., x.faint))
                    .child(div().flex_shrink_0().font_family(mono.clone()).text_color(x.faint).child(c.hash[..7.min(c.hash.len())].to_string()))
                    .child(div().flex_1().min_w_0().truncate().child(c.subject.clone()))
                    .child(
                        div()
                            .flex()
                            .flex_shrink_0()
                            .items_center()
                            .gap_2()
                            .font_family(mono.clone())
                            .text_size(px(11.5))
                            .when(c.insertions > 0, |d| d.child(div().text_color(x.green).child(format!("+{}", c.insertions))))
                            .when(c.deletions > 0, |d| d.child(div().text_color(rgb(RED)).child(format!("−{}", c.deletions))))
                            .child(div().text_size(px(11.)).text_color(x.faint).child(c.relative.clone())),
                    )
                    .on_click(cx.listener(move |this, _, _, cx| this.toggle_commit(hash.clone(), cx))),
            );
            match expanded {
                Some(None) => out = out.child(div().pl_6().child(note("Loading…".into()))),
                Some(Some(files)) => {
                    let tree = self.change_tree(format!("commit:{}", c.hash), &files, Some(format!("commit:{}", c.hash)), false, "", None, window, cx);
                    out = out.child(div().pl_4().child(tree));
                }
                None => {}
            }
        }
        out.into_any_element()
    }

    fn review_view(&mut self, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let theme = cx.theme().colors;
        let x = theme::extra(cx);
        let Some(d) = &self.detail else {
            return div().p_4().text_sm().text_color(x.faint).child("Reading git status…").into_any_element();
        };
        let d = Detail { committed: d.committed.clone(), uncommitted: d.uncommitted.clone(), branches: vec![], ..clone_head(d) };
        let staged = d.uncommitted.iter().filter(|f| f.staged).count();
        let detached = d.branch.is_none();
        let can_push = !detached && (d.upstream.is_none() || d.upstream_ahead > 0);
        let base = d.base.clone();
        let this = cx.entity();

        // Summary strip: HEAD, ahead/behind vs base, update, tracking, push, reattach, badges.
        let mut summary = div()
            .flex()
            .flex_1()
            .min_w_0()
            .flex_wrap()
            .items_center()
            .gap(px(20.))
            .child(self.stat(d.head.as_deref().map(|h| h[..7.min(h.len())].to_string()).unwrap_or("—".into()), "HEAD", cx))
            .child(self.stat(crate::data::relative_time(self.activity), "last change", cx));
        if let (Some(b), true) = (&base, d.ahead > 0 || d.behind > 0) {
            summary = summary.child(self.stat(format!("↑{} ↓{}", d.ahead, d.behind), &format!("vs {b}"), cx));
        }
        if let (Some(b), true) = (base.clone(), d.behind > 0 && !self.is_primary()) {
            let t = this.clone();
            let branch = d.branch.clone().unwrap_or_default();
            summary = summary.child(amber_button("update", format!("Update from {b}  ›"), cx).dropdown_menu(move |m, _, _| {
                let (t1, t2, t3, b1, b2) = (t.clone(), t.clone(), t.clone(), b.clone(), b.clone());
                let prompt = merge_prompt(&b, &branch);
                m.item(PopupMenuItem::new(format!("Rebase onto {b}")).on_click(move |_, _, cx| {
                    let b = b1.clone();
                    t1.update(cx, |v, cx| v.act("Rebasing…", format!("Rebased onto {b}"), move |p| git::update_from_base(p, &b, true), cx))
                }))
                .item(PopupMenuItem::new(format!("Merge {b}")).on_click(move |_, _, cx| {
                    let b = b2.clone();
                    t2.update(cx, |v, cx| v.act("Merging…", format!("Merged {b}"), move |p| git::update_from_base(p, &b, false), cx))
                }))
                .item(PopupMenuItem::new(format!("Agent merge from {b}")).on_click(move |_, _, cx| {
                    let prompt = prompt.clone();
                    t3.update(cx, |_, cx| cx.emit(ReviewEvent::StartChat(prompt)))
                }))
            }));
        }
        if let Some(up) = &d.upstream {
            let sync = if d.upstream_ahead == 0 && d.upstream_behind == 0 {
                "in sync".to_string()
            } else {
                format!("↑{} ↓{}", d.upstream_ahead, d.upstream_behind)
            };
            summary = summary.child(self.stat(up.clone(), "tracking", cx)).child(self.stat(sync, "vs tracking", cx));
        }
        if can_push {
            let label = if d.upstream.is_some() { format!("Push ↑{}", d.upstream_ahead) } else { "Publish".into() };
            let branch = d.branch.clone().unwrap_or_default();
            let tip = match &d.upstream {
                Some(up) => format!("Push {} commit{} to {up}", d.upstream_ahead, plural(d.upstream_ahead as usize)),
                None => format!("Push {branch} to origin and track it (it isn't on the remote yet)"),
            };
            summary = summary.child(amber_button("push", label, cx).tooltip(tip).on_click(cx.listener(move |this, _, _, cx| {
                this.act("Pushing…", format!("Pushed {branch} to origin"), git::push, cx)
            })));
        }
        if let (true, Some(from)) = (detached, self.detached_from.clone()) {
            summary = summary.child(
                amber_button("reattach", format!("Reattach to {from}"), cx)
                    .tooltip(format!("Switch back onto {from} (fast-forward only — no commits lost)"))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        let b = from.clone();
                        this.act("Reattaching…", format!("Back on {from}"), move |p| git::reattach(p, &b), cx)
                    })),
            );
        }
        summary = summary
            .child(
                div()
                    .flex()
                    .gap_1()
                    .when(self.is_primary(), |d| d.child(Self::badge("primary", x.green)))
                    .when(detached, |d| d.child(Self::badge("detached", x.amber)))
                    .when(self.locked, |d| d.child(Self::badge("locked", theme.muted_foreground))),
            );
        // The stats wrap; refresh stays pinned top-right rather than wrapping onto a row of its own.
        let summary = div()
            .flex()
            .items_start()
            .gap_2()
            .pt(px(14.))
            .pb(px(16.))
            .mb(px(14.))
            .border_b_1()
            .border_color(theme.border)
            .child(summary)
            .child(
                div()
                    .id("refresh")
                    .flex_shrink_0()
                    .tooltip(|window, cx| Tooltip::new("Refresh git status and the MR/PR").build(window, cx))
                    .size(px(26.))
                    .flex()
                    .items_center()
                    .justify_center()
                    .rounded(px(6.))
                    .cursor_pointer()
                    .hover(|s| s.bg(x.hover))
                    .child(icon("fr/refresh.svg", 14., x.faint))
                    .on_click(cx.listener(|this, _, _, cx| {
                        this.refresh(cx);
                        this.refresh_host(cx);
                    })),
            );
        let host_bar = self.host_bar(cx);

        let changes_right = {
            let seg = |id: &'static str, label: &'static str, active: bool| {
                div()
                    .id(id)
                    .px(px(9.))
                    .py(px(3.))
                    .text_size(px(12.))
                    .cursor_pointer()
                    .text_color(if active { theme.foreground } else { theme.muted_foreground })
                    .when(active, |d| d.bg(theme.list_active))
                    .hover(|s| s.bg(x.hover).text_color(theme.foreground))
                    .child(label)
            };
            let (open_view, content_view) = (this.clone(), this.clone());
            div()
                .flex()
                .items_center()
                .gap_3()
                .child(
                    div()
                        .flex()
                        .overflow_hidden()
                        .rounded(px(6.))
                        .border_1()
                        .border_color(x.border_strong)
                        .child(seg("v-files", "Files", !self.show_commits).on_click(cx.listener(|this, _, _, cx| {
                            this.show_commits = false;
                            cx.emit(ReviewEvent::CommitsToggled);
                            cx.notify();
                        })))
                        .child(seg("v-commits", "Commits", self.show_commits).on_click(cx.listener(|this, _, _, cx| {
                            this.show_commits = true;
                            cx.emit(ReviewEvent::CommitsToggled);
                            this.refresh(cx);
                        }))),
                )
                .child(div().text_size(px(12.)).text_color(x.faint).child("vs"))
                .child(
                    Popover::new("base-picker")
                        .anchor(Anchor::TopRight)
                        .open(self.base_open)
                        .on_open_change(move |open, window, cx| {
                            open_view.update(cx, |v, cx| v.open_base(*open, window, cx));
                            window.refresh();
                        })
                        .trigger(Button::new("base").outline().label(format!("{} ▾", base.clone().unwrap_or("—".into()))))
                        .content(move |_, _, cx| {
                            let view = content_view.clone();
                            content_view.read(cx).base_menu(view, cx)
                        }),
                )
                .into_any_element()
        };

        let c_open = !self.closed.contains("c");
        let committed_body = match (c_open, self.show_commits) {
            (false, _) => None,
            (true, true) => Some(self.commits_body(window, cx)),
            (true, false) => {
                let q = self.c_filter.read(cx).value().to_string();
                let empty = match &base {
                    Some(b) => format!("No commits on this branch vs {b}."),
                    None => "Pick a base branch to compare against.".into(),
                };
                Some(self.change_tree("c".into(), &d.committed, base.clone(), false, &q, Some(empty), window, cx))
            }
        };
        let changes_head = self.section_head("c", "Changes", (!self.show_commits).then_some(&d.committed[..]), &self.c_filter.clone(), Some(changes_right), cx);

        let uncommitted = (!d.uncommitted.is_empty()).then(|| {
            let all_staged = staged == d.uncommitted.len();
            let commit_box = div()
                .flex()
                .flex_col()
                .gap_2()
                .mt(px(4.))
                .mb(px(20.))
                .p(px(12.))
                .rounded(px(8.))
                .border_1()
                .border_color(theme.border)
                .bg(theme.sidebar)
                .child(
                    div()
                        .flex()
                        .items_center()
                        .justify_between()
                        .child(div().text_size(px(12.)).text_color(theme.muted_foreground).child(format!("{staged} of {} staged", d.uncommitted.len())))
                        .child(
                            Button::new("stage-all")
                                .small()
                                .ghost()
                                .label(if all_staged { "Unstage all" } else { "Stage all" })
                                .on_click(cx.listener(move |this, _, _, cx| this.set_staged(vec![], !all_staged, cx))),
                        ),
                )
                .child(
                    // ⌘↵ commits; caught before the textarea turns it into a newline.
                    div()
                        .capture_key_down(cx.listener(|this, ev: &KeyDownEvent, window, cx| {
                            let m = &ev.keystroke.modifiers;
                            if ev.keystroke.key == "enter" && (m.platform || m.control) {
                                cx.stop_propagation();
                                this.commit(window, cx);
                            }
                        }))
                        .child(Textarea::new(&self.message).bg(theme.background)),
                )
                .child(
                    div().flex().justify_end().child(
                        Button::new("commit")
                            .primary()
                            .px(px(16.))
                            .label(if staged == 0 { "Commit".to_string() } else { format!("Commit {staged}") })
                            .disabled(staged == 0)
                            .on_click(cx.listener(|this, _, window, cx| this.commit(window, cx))),
                    ),
                );
            let head = self.section_head("u", "Uncommitted", Some(&d.uncommitted), &self.u_filter.clone(), None, cx);
            let body = (!self.closed.contains("u")).then(|| {
                let q = self.u_filter.read(cx).value().to_string();
                self.change_tree("u".into(), &d.uncommitted, None, true, &q, None, window, cx)
            });
            (commit_box, head, body)
        });

        let mut col = div()
            .id("review-scroll")
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .px(px(16.))
            .pb_4()
            .child(summary)
            .children(host_bar)
            .when_some(self.busy.clone(), |e, b| e.child(div().px_1().text_sm().text_color(theme.muted_foreground).child(b)))
            .when_some(self.notice.clone(), |e, (msg, err)| {
                e.child(
                    div()
                        .id("notice")
                        .mx_1()
                        .my_1()
                        .px_2()
                        .py_1()
                        .rounded(px(5.))
                        .text_sm()
                        .cursor_pointer()
                        .text_color(if err { theme.danger } else { theme.success })
                        .bg(x.hover)
                        .child(msg)
                        .on_click(cx.listener(|this, _, _, cx| {
                            this.notice = None;
                            cx.notify();
                        })),
                )
            });
        if let Some((commit_box, head, body)) = uncommitted {
            col = col.child(commit_box).child(head).children(body);
        }
        // The primary worktree with no base has nothing to compare: just its uncommitted work.
        if self.is_primary() && base.is_none() {
            if d.uncommitted.is_empty() {
                col = col.child(div().px_1().text_size(px(12.5)).text_color(x.faint).child("No uncommitted changes."));
            }
            return col.into_any_element();
        }
        col.child(changes_head).children(committed_body).into_any_element()
    }

    fn toggle_dir(&mut self, path: String, unlisted: bool, cx: &mut Context<Self>) {
        if unlisted {
            // An ignored folder: list it one level in the background (files join the
            // tree, subfolders become unlisted folders of their own).
            self.unlisted.remove(&path);
            let placeholder = format!("{path}/{LOADING}");
            self.ignored_files.push(placeholder.clone());
            self.tree = None;
            let (root, rel) = (self.path.clone(), path.clone());
            let work = cx.background_executor().spawn(async move { git::list_dir(&root, &rel) });
            let dir = path.clone();
            cx.spawn(async move |this, cx| {
                let entries = work.await;
                let _ = this.update(cx, |this, cx| {
                    this.ignored_files.retain(|p| *p != placeholder);
                    if entries.is_empty() {
                        this.ignored_files.push(format!("{dir}/{EMPTY_DIR}"));
                    }
                    for (name, is_dir) in entries {
                        let child = format!("{dir}/{name}");
                        if is_dir {
                            this.unlisted.insert(child);
                        } else {
                            this.ignored_files.push(child);
                        }
                    }
                    this.tree = None;
                    cx.notify();
                });
            })
            .detach();
        }
        if !self.expanded.remove(&path) {
            self.expanded.insert(path);
        }
        cx.notify();
    }

    fn activate_file_row(&mut self, r: &crate::tree::Row, cx: &mut Context<Self>) {
        if r.is_dir {
            self.toggle_dir(r.path.clone(), r.unlisted, cx);
        } else if r.name != LOADING && r.name != EMPTY_DIR {
            cx.emit(ReviewEvent::OpenFile { rel: r.path.clone(), line: None });
        }
    }

    fn files_key(&mut self, rows: &[crate::tree::Row], ev: &KeyDownEvent, cx: &mut Context<Self>) {
        let Some(k) = tree_key(ev) else { return };
        let shape: Vec<_> = rows.iter().map(|r| (r.depth, r.is_dir, r.expanded)).collect();
        let sel = self.trees.get("files").map_or(0, |t| t.1);
        match change_tree::nav(k, sel, &shape) {
            Some(Nav::Focus(i)) => {
                self.set_sel("files", i);
                self.files_scroll.scroll_to_item(i, ScrollStrategy::Nearest);
            }
            Some(Nav::Expand(i, open)) if open != rows[i].expanded => self.toggle_dir(rows[i].path.clone(), rows[i].unlisted, cx),
            Some(Nav::Activate(i)) => self.activate_file_row(&rows[i], cx),
            _ => return,
        }
        cx.stop_propagation();
        cx.notify();
    }

    fn files_view(&mut self, window: &Window, cx: &mut Context<Self>) -> AnyElement {
        let x = theme::extra(cx);
        let filter = self.filter.read(cx).value().trim().to_lowercase();
        if self.files.is_none() {
            return div().p_4().text_sm().text_color(x.faint).child("Listing files…").into_any_element();
        }
        if self.tree.as_ref().is_none_or(|(f, _)| *f != filter) {
            let files = self.files.as_deref().unwrap_or_default();
            self.tree = Some((filter.clone(), crate::tree::Dir::build(files, &self.ignored_files, &self.unlisted, &filter)));
        }
        let mut rows = vec![];
        if let Some((_, t)) = &self.tree {
            t.flatten("", 0, &self.expanded, !filter.is_empty(), &mut rows);
        }
        let count = rows.len();
        let rows = Rc::new(rows);
        let (handle, sel) = self.tree_focus("files", cx);
        let focused = handle.is_focused(window).then_some(sel.min(count.saturating_sub(1)));
        let key_rows = rows.clone();
        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .p(px(16.))
            .gap(px(10.))
            .child(Input::new(&self.filter).cleanable(true))
            .child(if count == 0 {
                div()
                    .p_2()
                    .text_sm()
                    .text_color(x.faint)
                    .child(if filter.is_empty() { "No files.".to_string() } else { format!("No files match “{filter}”.") })
                    .into_any_element()
            } else {
                div()
                    .id("files-tree")
                    .flex_1()
                    .min_h_0()
                    // No frame: rows carry their own 10px inset, so pull them out to line
                    // up with the filter box above.
                    .mx(px(-10.))
                    .track_focus(&handle)
                    .on_key_down(cx.listener(move |this, ev: &KeyDownEvent, _, cx| this.files_key(&key_rows, ev, cx)))
                    .child(
                        uniform_list("files", count, cx.processor(move |_, range: std::ops::Range<usize>, _, cx| {
                            let theme = cx.theme().colors;
                            let x = theme::extra(cx);
                            range
                                .map(|i| {
                                    let r = &rows[i];
                                    let (is_dir, unlisted) = (r.is_dir, r.unlisted);
                                    let placeholder = !is_dir && (r.name == LOADING || r.name == EMPTY_DIR);
                                    let (rows, h) = (rows.clone(), handle.clone());
                                    div()
                                        .id(("file", i))
                                        .flex()
                                        .items_center()
                                        .gap(px(8.))
                                        .pl(px(10. + r.depth as f32 * 16.))
                                        .pr(px(12.))
                                        .py(px(4.))
                                        .text_size(px(13.))
                                        .cursor_pointer()
                                        .hover(|s| s.bg(x.hover))
                                        .when(focused == Some(i), |d| d.bg(theme.list_active))
                                        .when(r.ignored, |d| d.opacity(0.55))
                                        .child(div().w(px(14.)).flex_shrink_0().when(is_dir, |d| {
                                            d.child(icon(if r.expanded { "fr/chevron-down.svg" } else { "fr/chevron.svg" }, 14., x.faint))
                                        }))
                                        .when(!placeholder, |d| {
                                            d.child(icon(if is_dir { "fr/folder.svg" } else { "fr/file.svg" }, 15., theme.muted_foreground))
                                        })
                                        .child(div().flex_1().min_w_0().truncate().when(placeholder, |d| d.italic().text_color(x.faint)).child(r.name.clone()))
                                        .when(r.ignored && !placeholder && (is_dir || r.depth == 0), |d| {
                                            d.child(
                                                div()
                                                    .flex_shrink_0()
                                                    .px_1()
                                                    .rounded(px(4.))
                                                    .border_1()
                                                    .border_color(theme.border)
                                                    .text_size(px(10.5))
                                                    .text_color(x.faint)
                                                    .child("ignored"),
                                            )
                                        })
                                        .when(is_dir && !unlisted, |d| {
                                            d.child(div().flex_shrink_0().text_size(px(12.)).text_color(x.faint).child(r.count.to_string()))
                                        })
                                        .on_click(cx.listener(move |this, ev: &ClickEvent, window, cx| {
                                            this.set_sel("files", i);
                                            window.focus(&h, cx);
                                            this.activate_file_row(&rows[i], cx);
                                            if ev.click_count() >= 2 {
                                                cx.emit(ReviewEvent::Pin);
                                            }
                                        }))
                                })
                                .collect()
                        }))
                        .track_scroll(&self.files_scroll)
                        .size_full(),
                    )
                    .into_any_element()
            })
            .into_any_element()
    }

    fn search_view(&mut self, cx: &mut Context<Self>) -> AnyElement {
        let x = theme::extra(cx);
        // Hits grouped under a header per file, in order: None = header.
        let mut rows: Vec<(String, Option<Hit>, usize)> = vec![];
        for h in self.hits.iter().flatten() {
            match rows.iter().rposition(|r| r.1.is_none()) {
                Some(i) if rows[i].0 == h.path => rows[i].2 += 1,
                _ => rows.push((h.path.clone(), None, 1)),
            }
            rows.push((h.path.clone(), Some(h.clone()), 0));
        }
        let count = rows.len();
        let q = self.query.read(cx).value().trim().to_string();
        div()
            .flex()
            .flex_col()
            .flex_1()
            .min_h_0()
            .p_3()
            .gap_2()
            .child(Input::new(&self.query).cleanable(true))
            .child(div().px_1().text_size(px(11.)).text_color(x.faint).child(match &self.hits {
                None => "Type to search the worktree.".to_string(),
                Some(h) if h.is_empty() => format!("No matches for “{q}”."),
                Some(h) => format!("{} match{}{}", h.len(), if h.len() == 1 { "" } else { "es" }, if h.len() >= 500 { " (first 500)" } else { "" }),
            }))
            .child(
                uniform_list("hits", count, cx.processor(move |_, range: std::ops::Range<usize>, _, cx| {
                    let x = theme::extra(cx);
                    let theme = cx.theme().colors;
                    let mono = cx.theme().mono_font_family.clone();
                    range
                        .map(|i| {
                            let (path, hit, n) = &rows[i];
                            let row = div().id(("hit", i)).h(px(24.)).flex().items_center().gap_2().px_2().rounded(px(5.)).truncate();
                            match hit {
                                None => {
                                    let (dir, name) = path.rsplit_once('/').unwrap_or(("", path));
                                    row
                                        .text_size(px(12.5))
                                        .child(div().flex_shrink_0().font_weight(FontWeight::SEMIBOLD).child(name.to_string()))
                                        .child(div().flex_1().min_w_0().truncate().text_size(px(11.)).text_color(x.faint).child(dir.to_string()))
                                        .child(div().flex_shrink_0().text_size(px(11.)).text_color(x.faint).child(n.to_string()))
                                }
                                Some(h) => {
                                    let (rel, line) = (h.path.clone(), h.line);
                                    row.cursor_pointer()
                                        .hover(|s| s.bg(x.hover))
                                        .child(
                                            div()
                                                .w(px(36.))
                                                .flex_shrink_0()
                                                .text_right()
                                                .font_family(mono.clone())
                                                .text_size(px(11.))
                                                .text_color(x.faint)
                                                .child(h.line.to_string()),
                                        )
                                        .child(
                                            div().flex_1().min_w_0().truncate().text_size(px(12.5)).text_color(theme.muted_foreground).child(h.text.trim().to_string()),
                                        )
                                        .on_click(cx.listener(move |_, _, _, cx| cx.emit(ReviewEvent::OpenFile { rel: rel.clone(), line: Some(line) })))
                                }
                            }
                        })
                        .collect()
                }))
                .flex_1(),
            )
            .into_any_element()
    }
}

/// `Detail` minus its lists (they're cloned separately above).
fn clone_head(d: &Detail) -> Detail {
    Detail {
        branch: d.branch.clone(),
        head: d.head.clone(),
        upstream: d.upstream.clone(),
        upstream_ahead: d.upstream_ahead,
        upstream_behind: d.upstream_behind,
        base: d.base.clone(),
        branches: vec![],
        ahead: d.ahead,
        behind: d.behind,
        committed: vec![],
        uncommitted: vec![],
    }
}

impl Render for ReviewPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // Shown again after a while hidden: catch up now rather than at the next tick.
        if self.drawn.elapsed() > HIDDEN && !self.refreshing {
            self.refresh(cx);
            self.refresh_host(cx);
        }
        self.drawn = Instant::now();
        // The view can be switched from outside (⌘1/⌘2/⌘⇧F set `view` directly).
        if self.view != self.last_view {
            self.last_view = self.view;
            match self.view {
                View::Files if self.files.is_none() => self.load_files(cx),
                View::Search => self.query.update(cx, |s, cx| s.focus(window, cx)),
                _ => {}
            }
        }
        let theme = cx.theme().colors;
        let body = match self.view {
            View::Review => self.review_view(window, cx),
            View::Files => self.files_view(window, cx),
            View::Search => self.search_view(cx),
        };
        div()
            .flex()
            .flex_col()
            .size_full()
            .border_l_1()
            .border_color(theme.border)
            .child(body)
    }
}
