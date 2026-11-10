//! The Electron app's git layer (src/main/git.ts), ported: shells out to `git`
//! synchronously. Same commands, flags and parsing as the TS.

use std::{
    collections::HashSet,
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    process::{Command, Output, Stdio},
    time::{Duration, Instant},
};

pub(crate) struct Out {
    pub ok: bool,
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

/// Run a command, killing it after `limit`; both pipes are drained on threads so
/// a big output can't block the child. Err: couldn't start, or timed out.
pub(crate) fn output_with_deadline(cmd: &mut Command, limit: Duration) -> std::io::Result<Output> {
    let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn()?;
    let drain = |mut r: Box<dyn Read + Send>| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = r.read_to_end(&mut buf);
            buf
        })
    };
    let out = drain(Box::new(child.stdout.take().expect("piped")));
    let err = drain(Box::new(child.stderr.take().expect("piped")));
    let deadline = Instant::now() + limit;
    let status = loop {
        match child.try_wait()? {
            Some(s) => break s,
            None if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(10)),
            None => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(std::io::Error::new(std::io::ErrorKind::TimedOut, format!("timed out after {}s", limit.as_secs())));
            }
        }
    };
    Ok(Output { status, stdout: out.join().unwrap_or_default(), stderr: err.join().unwrap_or_default() })
}

/// git with a GUI app's environment: Homebrew on PATH, and never a prompt (a
/// credential or SSH question would hang with no terminal). Bounded at 120s, like
/// the Electron app's push/rebase.
pub(crate) fn git(cwd: &str, args: &[&str]) -> Out {
    let path = format!("{}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin", std::env::var("PATH").unwrap_or_default());
    let ssh = std::env::var("GIT_SSH_COMMAND")
        .unwrap_or_else(|_| "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10".into());
    let mut cmd = Command::new("git");
    cmd.args(args).current_dir(cwd).env("PATH", path).env("GIT_TERMINAL_PROMPT", "0").env("GIT_SSH_COMMAND", ssh);
    match output_with_deadline(&mut cmd, Duration::from_secs(120)) {
        Ok(o) => Out {
            ok: o.status.success(),
            code: o.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&o.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&o.stderr).into_owned(),
        },
        Err(e) => Out { ok: false, code: -1, stdout: String::new(), stderr: e.to_string() },
    }
}

/// Trimmed stdout when the command succeeded and printed something.
pub(crate) fn git_line(cwd: &str, args: &[&str]) -> Option<String> {
    let o = git(cwd, args);
    let s = o.stdout.trim();
    (o.ok && !s.is_empty()).then(|| s.to_string())
}

fn run(cwd: &str, args: &[&str], what: &str) -> Result<(), String> {
    let o = git(cwd, args);
    if o.ok { Ok(()) } else { Err(err_text(&o, what)) }
}

fn err_text(o: &Out, what: &str) -> String {
    let e = o.stderr.trim();
    if e.is_empty() { what.into() } else { e.into() }
}

fn lines(s: &str) -> impl Iterator<Item = &str> {
    s.lines().map(str::trim).filter(|l| !l.is_empty())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ChangeKind {
    Modified,
    Added,
    Deleted,
    Renamed,
    Untracked,
    Typechange,
    Conflicted,
}

impl ChangeKind {
    /// name-status letter → kind (index.ts `letterKind`).
    fn from_letter(c: char) -> Self {
        match c {
            'A' | 'C' => Self::Added,
            'D' => Self::Deleted,
            'R' => Self::Renamed,
            'T' => Self::Typechange,
            'U' => Self::Conflicted,
            '?' => Self::Untracked,
            _ => Self::Modified,
        }
    }
}

#[derive(Clone, Debug)]
pub struct ChangedFile {
    pub path: String,
    pub kind: ChangeKind,
    pub insertions: Option<u32>,
    pub deletions: Option<u32>,
    pub staged: bool,
}

#[derive(Debug)]
pub struct Detail {
    pub branch: Option<String>,
    pub head: Option<String>,
    pub upstream: Option<String>,
    pub upstream_ahead: u32,
    pub upstream_behind: u32,
    pub base: Option<String>,
    pub branches: Vec<String>,
    pub ahead: u32,
    pub behind: u32,
    pub committed: Vec<ChangedFile>,
    pub uncommitted: Vec<ChangedFile>,
}

/// `--name-status -z` + `--numstat -z` → files (unquoted paths; a rename is keyed
/// by its new path). numstat `-` (binary) → None.
fn parse_changes(name_status: &str, numstat: &str) -> Vec<ChangedFile> {
    let num = |s: &str| if s == "-" { None } else { s.parse().ok() };
    let mut stats = std::collections::HashMap::new();
    let mut it = numstat.split('\0');
    while let Some(rec) = it.next() {
        let mut p = rec.splitn(3, '\t');
        let (Some(a), Some(d), Some(path)) = (p.next(), p.next(), p.next()) else { continue };
        // A rename: the path field is empty, then old and new follow as fields.
        let path = if path.is_empty() { it.nth(1).unwrap_or_default() } else { path };
        stats.insert(path, (num(a), num(d)));
    }
    let mut out = vec![];
    let mut it = name_status.split('\0');
    while let Some(status) = it.next() {
        let Some(letter) = status.chars().next() else { continue };
        if matches!(letter, 'R' | 'C') {
            it.next(); // the old path
        }
        let Some(path) = it.next() else { break };
        let (insertions, deletions) = stats.get(path).copied().unwrap_or((None, None));
        out.push(ChangedFile { path: path.into(), kind: ChangeKind::from_letter(letter), insertions, deletions, staged: false });
    }
    out
}

/// NUL-separated output (`-z`) → its non-empty fields.
fn nul_fields(s: &str) -> impl Iterator<Item = &str> {
    s.split('\0').filter(|f| !f.is_empty())
}

/// Two numbers from `rev-list --count --left-right A...B`.
fn left_right(cwd: &str, range: &str) -> (u32, u32) {
    let o = git(cwd, &["rev-list", "--count", "--left-right", range]);
    let mut it = o.stdout.split_whitespace().map(|n| n.parse().unwrap_or(0));
    if !o.ok { return (0, 0) }
    (it.next().unwrap_or(0), it.next().unwrap_or(0))
}

fn local_branches(repo: &str) -> Vec<String> {
    lines(&git(repo, &["branch", "--format=%(refname:short)"]).stdout).map(String::from).collect()
}

/// Local branches plus origin-only ones (`origin/foo`) — TS `listBranches`.
pub fn list_branches(repo: &str) -> Vec<String> {
    let mut out = local_branches(repo);
    let local: HashSet<String> = out.iter().cloned().collect();
    let remote = git(repo, &["branch", "-r", "--format=%(refname:short)"]);
    out.extend(
        lines(&remote.stdout)
            .filter(|b| !b.contains("->"))
            .filter(|b| b.strip_prefix("origin/").is_some_and(|n| !local.contains(n)))
            .map(String::from),
    );
    out
}

/// The preferred ref if it resolves, else main/master — TS `resolveBaseBranch`.
pub fn resolve_base(repo: &str, preferred: Option<&str>) -> Option<String> {
    if let Some(p) = preferred.filter(|p| !p.is_empty()) {
        if git_line(repo, &["rev-parse", "--verify", "--quiet", p]).is_some() {
            return Some(p.into());
        }
    }
    let branches = local_branches(repo);
    ["main", "master"].into_iter().find(|c| branches.iter().any(|b| b == c)).map(String::from)
}

/// What the TS `worktreeDetail` RPC computes, minus DB/integration/command bits.
pub fn detail(worktree_path: &str, repo_path: &str, base: Option<&str>) -> Detail {
    let wt = worktree_path;
    let branch = git_line(wt, &["symbolic-ref", "--short", "-q", "HEAD"]);
    let head = git_line(wt, &["rev-parse", "HEAD"]);

    // Don't compare a branch against itself.
    let preferred = base.filter(|b| Some(*b) != branch.as_deref());
    let base = resolve_base(repo_path, preferred).filter(|b| Some(b) != branch.as_ref());

    // Uncommitted: working tree vs HEAD, staged flags, plus untracked.
    let mut uncommitted = parse_changes(
        &git(wt, &["diff", "--name-status", "-M", "-z", "HEAD"]).stdout,
        &git(wt, &["diff", "--numstat", "-M", "-z", "HEAD"]).stdout,
    );
    let staged_out = git(wt, &["diff", "--cached", "--name-only", "-z", "HEAD"]).stdout;
    let staged: HashSet<&str> = nul_fields(&staged_out).collect();
    for f in &mut uncommitted {
        f.staged = staged.contains(f.path.as_str());
    }
    let mut seen: HashSet<String> = uncommitted.iter().map(|f| f.path.clone()).collect();
    for p in nul_fields(&git(wt, &["ls-files", "--others", "--exclude-standard", "-z"]).stdout) {
        if seen.insert(p.into()) {
            uncommitted.push(ChangedFile { path: p.into(), kind: ChangeKind::Untracked, insertions: None, deletions: None, staged: false });
        }
    }

    // Committed: HEAD vs the merge-base with base.
    let (mut resolved, mut ahead, mut behind, mut committed) = (None, 0, 0, Vec::new());
    if let Some(b) = &base {
        if let Some(mb) = git_line(wt, &["merge-base", b, "HEAD"]) {
            committed = parse_changes(
                &git(wt, &["diff", "--name-status", "-M", "-z", &mb, "HEAD"]).stdout,
                &git(wt, &["diff", "--numstat", "-M", "-z", &mb, "HEAD"]).stdout,
            );
            (behind, ahead) = left_right(wt, &format!("{b}...HEAD"));
            resolved = Some(b.clone());
        }
    }

    // Tracking: upstream name, and ahead/behind vs origin/<branch> (like the TS).
    let (mut upstream, mut upstream_ahead, mut upstream_behind) = (None, 0, 0);
    if let Some(br) = &branch {
        upstream = git_line(wt, &["rev-parse", "--abbrev-ref", &format!("{br}@{{upstream}}")]);
        let remote = format!("origin/{br}");
        if git_line(wt, &["rev-parse", "--verify", "--quiet", &remote]).is_some() {
            (upstream_ahead, upstream_behind) = left_right(wt, &format!("{br}...{remote}"));
        }
    }

    Detail {
        branch,
        head,
        upstream,
        upstream_ahead,
        upstream_behind,
        base: resolved,
        branches: list_branches(repo_path),
        ahead,
        behind,
        committed,
        uncommitted,
    }
}

/// Stage paths, or everything when empty.
pub fn stage(path: &str, files: &[String]) -> Result<(), String> {
    let mut args = vec!["add"];
    if files.is_empty() { args.push("-A") } else { args.push("--"); args.extend(files.iter().map(String::as_str)) }
    run(path, &args, "stage failed")
}

/// Unstage paths, or everything when empty.
pub fn unstage(path: &str, files: &[String]) -> Result<(), String> {
    let mut args = vec![];
    if files.is_empty() {
        args.extend(["reset", "--quiet", "HEAD", "--"]);
    } else {
        args.extend(["restore", "--staged", "--"]);
        args.extend(files.iter().map(String::as_str));
    }
    run(path, &args, "unstage failed")
}

pub fn commit(path: &str, message: &str) -> Result<(), String> {
    run(path, &["commit", "-m", message], "commit failed")
}

/// Push the current branch to origin, setting upstream (`-u`).
pub fn push(path: &str) -> Result<(), String> {
    run(path, &["push", "-u", "origin", "HEAD"], "push failed")
}

/// Rebase onto or merge in `base`. A conflict leaves the worktree mid-operation.
pub fn update_from_base(path: &str, base: &str, rebase: bool) -> Result<(), String> {
    if rebase {
        run(path, &["rebase", base], "rebase failed")
    } else {
        run(path, &["merge", "--no-edit", base], "merge failed")
    }
}

/// Put a detached worktree back on `branch` without stranding commits: only when
/// HEAD and the branch are in a line (HEAD ahead → switch + ff; behind → switch).
pub fn reattach(path: &str, branch: &str) -> Result<(), String> {
    let head = git(path, &["rev-parse", "HEAD"]).stdout.trim().to_string();
    let Some(tip) = git_line(path, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]) else {
        // No local branch yet: create it here, tracking origin/<branch> if that exists.
        run(path, &["switch", "-c", branch], "couldn't create the branch")?;
        if git_line(path, &["rev-parse", "--verify", "--quiet", &format!("refs/remotes/origin/{branch}")]).is_some() {
            git(path, &["branch", "--set-upstream-to", &format!("origin/{branch}")]);
        }
        return Ok(());
    };
    let head_behind = git(path, &["merge-base", "--is-ancestor", &head, &tip]).ok;
    let head_ahead = git(path, &["merge-base", "--is-ancestor", &tip, &head]).ok;
    if !head_behind && !head_ahead {
        return Err(format!("This checkout and {branch} have diverged — reattach by hand so no commits are lost."));
    }
    run(path, &["switch", branch], "switch failed")?;
    if head_ahead && head != tip {
        run(path, &["merge", "--ff-only", &head], "fast-forward failed")?;
    }
    Ok(())
}

#[derive(Clone, Debug)]
pub struct Commit {
    pub hash: String,
    pub subject: String,
    pub author: String,
    pub relative: String,
    pub insertions: u32,
    pub deletions: u32,
}

/// Commits on HEAD not in `base`, newest first, with --shortstat totals.
pub fn commits_vs_base(path: &str, base: &str) -> Vec<Commit> {
    let o = git(path, &["log", &format!("{base}..HEAD"), "--shortstat", "--format=%x1e%h%x1f%s%x1f%an%x1f%cr"]);
    if !o.ok { return vec![] }
    // "N files changed, N insertions(+), N deletions(-)": the number before `word`.
    let stat = |rest: &str, word: &str| {
        rest.split(',').find(|p| p.contains(word)).and_then(|p| p.split_whitespace().next()?.parse().ok()).unwrap_or(0)
    };
    o.stdout
        .split('\x1e')
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .map(|chunk| {
            let (head, rest) = chunk.split_once('\n').unwrap_or((chunk, ""));
            let mut f = head.split('\x1f').map(String::from);
            let mut next = || f.next().unwrap_or_default();
            Commit {
                hash: next(),
                subject: next(),
                author: next(),
                relative: next(),
                insertions: stat(rest, "insertion"),
                deletions: stat(rest, "deletion"),
            }
        })
        .collect()
}

/// The files one commit changed.
pub fn commit_files(path: &str, hash: &str) -> Vec<ChangedFile> {
    let ns = git(path, &["show", "--name-status", "-M", "-z", "--format=", hash]);
    if !ns.ok { return vec![] }
    let num = git(path, &["show", "--numstat", "-M", "-z", "--format=", hash]);
    parse_changes(&ns.stdout, if num.ok { &num.stdout } else { "" })
}

/// Unified diff for one file: with `base`, merge-base(base, HEAD)..HEAD (committed
/// work); without, working tree vs HEAD, untracked shown as all-added.
/// One file's change within a single commit.
pub fn commit_file_diff(path: &str, hash: &str, file: &str) -> String {
    git(path, &["show", "--format=", "--no-color", "--no-ext-diff", hash, "--", file]).stdout
}

pub fn file_diff(path: &str, file: &str, base: Option<&str>) -> String {
    if let Some(base) = base {
        return match git_line(path, &["merge-base", base, "HEAD"]) {
            Some(mb) => git(path, &["diff", "-M", &mb, "HEAD", "--", file]).stdout,
            None => String::new(),
        };
    }
    let tracked = git(path, &["diff", "-M", "HEAD", "--", file]);
    if tracked.ok && !tracked.stdout.trim().is_empty() {
        return tracked.stdout;
    }
    // `--no-index` exits 1 when the files differ — the normal case, not an error.
    let untracked = git(path, &["diff", "--no-index", "--", "/dev/null", file]);
    if (0..=1).contains(&untracked.code) { untracked.stdout } else { String::new() }
}

/// (tracked + untracked files, sorted; ignored entries collapsed to directories).
pub fn list_files(path: &str) -> (Vec<String>, Vec<String>) {
    let z = |args: &[&str]| -> Vec<String> {
        let o = git(path, args);
        if !o.ok { return vec![] }
        o.stdout.split('\0').filter(|p| !p.is_empty()).map(String::from).collect()
    };
    let mut files = z(&["ls-files", "-z"]);
    files.extend(z(&["ls-files", "--others", "--exclude-standard", "-z"]));
    files.sort();
    files.dedup();
    let mut ignored = z(&["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]);
    ignored.sort();
    (files, ignored)
}

/// `root/rel` normalised lexically (like Node's `resolve`), or None if it escapes root.
fn confined(root: &str, rel: &str) -> Option<PathBuf> {
    let root = Path::new(root);
    let mut out = PathBuf::new();
    for c in root.join(rel).components() {
        match c {
            Component::ParentDir => { out.pop(); }
            Component::CurDir => {}
            c => out.push(c),
        }
    }
    let mut norm_root = PathBuf::new();
    for c in root.components().filter(|c| *c != Component::CurDir) {
        if c == Component::ParentDir { norm_root.pop(); } else { norm_root.push(c) }
    }
    out.starts_with(&norm_root).then_some(out)
}

/// `confined`, with symlinks resolved: the real file must still be in the worktree.
fn confined_real(root: &str, rel: &str) -> Option<PathBuf> {
    let p = confined(root, rel)?;
    let real = match fs::canonicalize(&p) {
        Ok(r) => r,
        Err(_) => fs::canonicalize(p.parent()?).ok()?.join(p.file_name()?),
    };
    real.starts_with(fs::canonicalize(root).ok()?).then_some(real)
}

/// Branch names come from the user: one starting with `-` would be read as a flag.
fn check_branch(name: &str) -> Result<(), String> {
    if name.starts_with('-') { Err(format!("Invalid branch name: {name}")) } else { Ok(()) }
}

const MAX_DIR_ENTRIES: usize = 2000;

/// One directory level inside the worktree (for ignored folders git won't list):
/// (name, is_dir), folders first, `.git` hidden, capped.
pub fn list_dir(path: &str, rel: &str) -> Vec<(String, bool)> {
    let Some(abs) = confined(path, rel) else { return vec![] };
    let Ok(rd) = fs::read_dir(abs) else { return vec![] };
    let mut v: Vec<(String, bool)> = rd
        .flatten()
        .map(|e| (e.file_name().to_string_lossy().into_owned(), e.file_type().is_ok_and(|t| t.is_dir())))
        .filter(|(n, _)| n != ".git")
        .collect();
    // ponytail: byte-order sort, TS uses localeCompare; use a collator if case ordering matters.
    v.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    v.truncate(MAX_DIR_ENTRIES);
    v
}

#[derive(Clone, Debug)]
pub struct Hit {
    pub path: String,
    pub line: u32,
    pub text: String,
}

const MAX_HITS: usize = 500;

/// Case-insensitive literal search across tracked files (`git grep`), capped.
pub fn search(path: &str, query: &str) -> Vec<Hit> {
    if query.trim().is_empty() { return vec![] }
    // Exit 1 = no matches; just parse whatever stdout there is.
    // -z: `path\0line\0text` — unquoted paths, and colons in them don't matter.
    let o = git(path, &["grep", "-n", "-z", "-I", "-F", "-i", "-e", query, "--", "."]);
    o.stdout.lines().filter_map(parse_hit).take(MAX_HITS).collect()
}

fn parse_hit(l: &str) -> Option<Hit> {
    let mut p = l.splitn(3, '\0');
    let (path, line, text) = (p.next()?, p.next()?.parse().ok()?, p.next()?);
    Some(Hit { path: path.into(), line, text: text.chars().take(300).collect() })
}

/// A working-tree file's text; Err for paths outside the worktree, read errors, or binary (NUL bytes).
pub fn read_file(path: &str, rel: &str) -> Result<String, String> {
    let full = confined_real(path, rel).ok_or("path is outside the worktree")?;
    let bytes = fs::read(full).map_err(|e| e.to_string())?;
    if bytes.contains(&0) { return Err("binary file".into()) }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Overwrite a working-tree file (the editor's save) — atomically, through symlinks.
pub fn write_file(path: &str, rel: &str, content: &str) -> Result<(), String> {
    let full = confined_real(path, rel).ok_or("path is outside the worktree")?;
    crate::data::write_atomic(&full, content).map_err(|e| e.to_string())
}

/// Add a worktree at `path` on `branch`: check it out if it exists locally,
/// else create it off `base` — TS `addWorktree` (non-detached).
pub fn worktree_add(repo: &str, path: &str, branch: &str, base: Option<&str>) -> Result<(), String> {
    check_branch(branch)?;
    let exists = git_line(repo, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{branch}")]).is_some();
    let mut args = vec!["worktree", "add", path];
    if !exists {
        args.extend(["-b", branch]);
        args.extend(base);
    } else {
        args.push(branch);
    }
    run(repo, &args, "git worktree add failed")
}

/// Remove a worktree. Without `force`, git's refusal stands (it may be guarding
/// changes) — unless the folder is already gone, which a prune clears. With
/// `force`: double force, then prune plus deleting the leftover folder if it's
/// still one of this repo's worktrees.
pub fn worktree_remove(repo: &str, path: &str, force: bool) -> Result<(), String> {
    let mut args = vec!["worktree", "remove"];
    if force {
        args.push("--force");
    }
    args.push(path);
    let first = git(repo, &args);
    if first.ok {
        return Ok(());
    }
    if !force {
        if Path::new(path).exists() {
            return Err(err_text(&first, "git worktree remove failed"));
        }
        return run(repo, &["worktree", "prune"], "git worktree prune failed");
    }
    let second = git(repo, &["worktree", "remove", "--force", "--force", path]);
    if second.ok {
        return Ok(());
    }
    git(repo, &["worktree", "prune"]);
    let list = git(repo, &["worktree", "list", "--porcelain"]).stdout;
    if list.lines().any(|l| l.trim() == format!("worktree {path}")) {
        let e = if first.stderr.trim().is_empty() { &second } else { &first };
        return Err(err_text(e, "git worktree remove failed"));
    }
    if path != repo && is_worktree_of(repo, path) {
        let _ = fs::remove_dir_all(path);
    }
    Ok(())
}

/// `path/.git` is a file pointing at `<repo's git dir>/worktrees/<name>` — so the
/// folder really is (or was) this repo's linked worktree, not something else since
/// created at the same path.
fn is_worktree_of(repo: &str, path: &str) -> bool {
    let Some(common) = git_line(repo, &["rev-parse", "--path-format=absolute", "--git-common-dir"]) else { return false };
    let Some(gitdir) = crate::data::gitdir(path) else { return false };
    let (Some(wt_dir), Some(common_dir)) = (gitdir.parent(), gitdir.parent().and_then(Path::parent)) else { return false };
    wt_dir.file_name().is_some_and(|n| n == "worktrees")
        && fs::canonicalize(common_dir).ok().is_some_and(|c| fs::canonicalize(common).is_ok_and(|r| r == c))
}

/// Why removing a worktree loses nothing, or None if it might: no uncommitted or
/// untracked files, and HEAD's commits are all on `origin/<branch>` or in the base
/// (local or origin's). A folder already gone has nothing to lose either. Any git
/// failure counts as "not safe".
pub fn safe_to_remove(repo: &str, path: &str) -> Option<String> {
    if !Path::new(path).exists() {
        return Some("folder already deleted".into());
    }
    let status = git(path, &["status", "--porcelain", "--untracked-files=all"]);
    if !status.ok || !status.stdout.trim().is_empty() {
        return None;
    }
    // Commits on HEAD that `r` lacks; None if `r` doesn't exist or git fails.
    let ahead_of = |r: &str| {
        git_line(path, &["rev-parse", "--verify", "--quiet", r])?;
        let o = git(path, &["rev-list", "--count", &format!("{r}..HEAD")]);
        if o.ok { o.stdout.trim().parse::<u32>().ok() } else { None }
    };
    let branch = git_line(path, &["symbolic-ref", "--short", "-q", "HEAD"]);
    if let Some(b) = &branch
        && ahead_of(&format!("origin/{b}")) == Some(0)
    {
        return Some("pushed to origin".into());
    }
    // A branch that's only ever been created is "in" the base too — but nothing was merged.
    if branch.is_some_and(|b| never_committed(path, &b)) {
        return Some("no commits yet".into());
    }
    let base = resolve_base(repo, None)?;
    [base.clone(), format!("origin/{base}")].iter().any(|r| ahead_of(r) == Some(0)).then(|| format!("merged into {base}"))
}

/// No uncommitted or untracked files.
pub fn is_clean(path: &str) -> bool {
    let o = git(path, &["status", "--porcelain", "--untracked-files=all"]);
    o.ok && o.stdout.trim().is_empty()
}

/// Is `commit` (e.g. HEAD) in `sha`'s history? False if either is unknown here.
pub fn is_ancestor(path: &str, commit: &str, sha: &str) -> bool {
    git(path, &["merge-base", "--is-ancestor", commit, sha]).ok
}

/// The branch's reflog has only its creation: nothing was ever committed on it here.
fn never_committed(path: &str, branch: &str) -> bool {
    let o = git(path, &["reflog", "show", "--format=%gs", &format!("refs/heads/{branch}")]);
    let mut entries = lines(&o.stdout).peekable();
    o.ok && entries.peek().is_some() && entries.all(|e| e.starts_with("branch: Created from"))
}

pub struct WorktreeStatus {
    pub branch: Option<String>,
    pub uncommitted: u32,
    /// Commits lost if the branch were deleted: ahead of origin/<branch>, or
    /// (with no upstream) ahead of the base.
    pub unpushed: u32,
    pub has_upstream: bool,
}

/// What the remove dialog shows — TS `worktreeRemovalInfo`.
pub fn worktree_status(repo: &str, path: &str) -> WorktreeStatus {
    let branch = git_line(path, &["symbolic-ref", "--short", "-q", "HEAD"]);
    let uncommitted = lines(&git(path, &["status", "--porcelain", "--untracked-files=all"]).stdout).count() as u32;
    let upstream = branch.as_ref().and_then(|b| git_line(path, &["rev-parse", "--abbrev-ref", &format!("{b}@{{upstream}}")]));
    let unpushed = match (&branch, &upstream) {
        (Some(b), Some(_)) => {
            let remote = format!("origin/{b}");
            if git_line(path, &["rev-parse", "--verify", "--quiet", &remote]).is_some() { left_right(path, &format!("{b}...{remote}")).0 } else { 0 }
        }
        _ => resolve_base(repo, None)
            .filter(|b| Some(b) != branch.as_ref())
            .map_or(0, |b| left_right(path, &format!("{b}...HEAD")).1),
    };
    WorktreeStatus { branch, uncommitted, unpushed, has_upstream: upstream.is_some() }
}

pub fn delete_branch(repo: &str, name: &str, force: bool) -> Result<(), String> {
    run(repo, &["branch", if force { "-D" } else { "-d" }, name], "delete failed")
}

/// Delete a local branch that cleanup found merged. Contained in `base` (checked
/// here, by full ref — a tag can share the name): `-D`. Plain `-d` would judge by
/// the branch's upstream instead, and refuse a merged branch whose remote moved on.
/// Not contained: `-d`, git's own check (e.g. fully pushed to its upstream).
pub fn delete_merged_branch(repo: &str, name: &str, base: Option<&str>) -> Result<(), String> {
    check_branch(name)?;
    let merged = base.is_some_and(|b| git(repo, &["merge-base", "--is-ancestor", &format!("refs/heads/{name}"), b]).ok);
    delete_branch(repo, name, merged)
}

pub fn rename_branch(repo: &str, from: &str, to: &str) -> Result<(), String> {
    check_branch(to)?;
    run(repo, &["branch", "-m", from, to], "rename failed")
}

/// A branch for the Branches tab — TS `branchGraph`. Ahead/behind are vs the
/// base (None without one, or on git < 2.41); `worktrees` are the paths that
/// have it checked out.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct BranchInfo {
    pub name: String,
    pub local: bool,
    pub remote: bool,
    /// Newest committer time of the local/origin refs, in ms (0 = unknown).
    pub last_commit: i64,
    pub ahead: Option<u32>,
    pub behind: Option<u32>,
    pub worktrees: Vec<String>,
}

pub fn branch_graph(repo: &str, base: Option<&str>) -> Vec<BranchInfo> {
    let ab = base.map(|b| format!("%(ahead-behind:{b})")).unwrap_or_default();
    let o = git(repo, &["for-each-ref", &format!("--format=%(refname)|%(committerdate:unix)|{ab}"), "refs/heads/", "refs/remotes/origin/"]);
    if !o.ok {
        return vec![];
    }
    let mut out = parse_branch_graph(&o.stdout);
    for w in list_worktrees(repo) {
        if let Some(b) = out.iter_mut().find(|b| w.branch.as_ref() == Some(&b.name)) {
            b.worktrees.push(w.path);
        }
    }
    out
}

fn parse_branch_graph(out: &str) -> Vec<BranchInfo> {
    let mut v: Vec<BranchInfo> = vec![];
    for l in lines(out) {
        let mut f = l.split('|');
        let (refname, date, ab) = (f.next().unwrap_or_default(), f.next().unwrap_or_default(), f.next().unwrap_or_default());
        let (name, local) = if let Some(n) = refname.strip_prefix("refs/heads/") {
            (n, true)
        } else if let Some(n) = refname.strip_prefix("refs/remotes/origin/").filter(|n| *n != "HEAD") {
            (n, false)
        } else {
            continue;
        };
        let i = v.iter().position(|b| b.name == name).unwrap_or_else(|| {
            v.push(BranchInfo { name: name.into(), ..Default::default() });
            v.len() - 1
        });
        let b = &mut v[i];
        if local { b.local = true } else { b.remote = true }
        b.last_commit = b.last_commit.max(date.parse::<i64>().unwrap_or(0) * 1000);
        // Prefer the local ref's divergence; origin's only when there's no local.
        let mut n = ab.split_whitespace().map(|x| x.parse::<u32>().ok());
        if let (Some(Some(a)), Some(Some(bh))) = (n.next(), n.next()) {
            if local || b.ahead.is_none() {
                (b.ahead, b.behind) = (Some(a), Some(bh));
            }
        }
    }
    v
}

/// One `git worktree list --porcelain` entry.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct WorktreeEntry {
    pub path: String,
    pub head: Option<String>,
    pub branch: Option<String>,
    pub locked: bool,
}

fn parse_worktree_list(out: &str) -> Vec<WorktreeEntry> {
    out.split("\n\n")
        .filter_map(|entry| {
            let mut e = WorktreeEntry::default();
            let mut bare = false;
            for l in entry.lines() {
                if let Some(p) = l.strip_prefix("worktree ") {
                    e.path = p.into();
                } else if let Some(h) = l.strip_prefix("HEAD ") {
                    e.head = Some(h.into());
                } else if let Some(b) = l.strip_prefix("branch ") {
                    e.branch = Some(b.strip_prefix("refs/heads/").unwrap_or(b).into());
                } else if l == "locked" || l.starts_with("locked ") {
                    e.locked = true;
                } else if l == "bare" {
                    bare = true;
                }
            }
            (!e.path.is_empty() && !bare).then_some(e)
        })
        .collect()
}

pub fn list_worktrees(repo: &str) -> Vec<WorktreeEntry> {
    try_list_worktrees(repo).unwrap_or_default()
}

/// `list_worktrees`, but a git failure is an error rather than "none".
pub fn try_list_worktrees(repo: &str) -> Result<Vec<WorktreeEntry>, String> {
    let o = git(repo, &["worktree", "list", "--porcelain"]);
    if o.ok { Ok(parse_worktree_list(&o.stdout)) } else { Err(err_text(&o, "git worktree list failed")) }
}

/// An MR/PR's head as `origin/<branch>`, for review. Fetched by its MR/PR ref
/// (GitHub `pull/N/head`, GitLab `merge-requests/N/head`), so a fork's branch works
/// too; skipped when `origin/<branch>` is already at `head` (no network round trip).
pub fn fetch_review_head(repo: &str, github: bool, number: u64, branch: &str, head: &str) -> Result<(), String> {
    check_branch(branch)?;
    let remote = format!("refs/remotes/origin/{branch}");
    if !head.is_empty() && git_line(repo, &["rev-parse", "--verify", "--quiet", &remote]).as_deref() == Some(head) {
        return Ok(());
    }
    let src = if github { format!("pull/{number}/head") } else { format!("merge-requests/{number}/head") };
    run(repo, &["fetch", "origin", &format!("+refs/{src}:{remote}")], "fetch failed")
}

/// Fetch origin (pruned), then best-effort fast-forward the local base: through
/// its worktree when it's checked out, else via a refspec — TS `fetchProject`.
pub fn fetch_base(repo: &str, base: Option<&str>) -> Result<(), String> {
    run(repo, &["fetch", "origin", "--prune"], "fetch failed")?;
    if let Some(b) = base {
        let remote = format!("origin/{b}");
        match list_worktrees(repo).into_iter().find(|w| w.branch.as_deref() == Some(b)) {
            Some(w) => _ = git(&w.path, &["merge", "--ff-only", &remote]),
            None => _ = git(repo, &["fetch", "origin", &format!("{b}:{b}")]),
        }
    }
    Ok(())
}

/// (ahead, behind) of `base` vs `origin/<base>`; None without that remote branch — TS `branchTracking`.
pub fn base_status(repo: &str, base: &str) -> Option<(u32, u32)> {
    let remote = format!("origin/{base}");
    git_line(repo, &["rev-parse", "--verify", "--quiet", &remote])?;
    Some(left_right(repo, &format!("{base}...{remote}")))
}

/// The newest `n` commits on `base` (no stats) — TS `recentCommits`.
pub fn base_log(repo: &str, base: &str, n: usize) -> Vec<Commit> {
    let o = git(repo, &["log", &format!("-n{n}"), "--format=%h%x00%s%x00%an%x00%cr", base]);
    if !o.ok {
        return vec![];
    }
    lines(&o.stdout)
        .map(|l| {
            let mut f = l.split('\0').map(String::from);
            let mut next = || f.next().unwrap_or_default();
            Commit { hash: next(), subject: next(), author: next(), relative: next(), insertions: 0, deletions: 0 }
        })
        .collect()
}

/// A file's patch; `full` asks git for the whole file as context.
pub fn diff_patch(root: &str, file: &str, base: Option<&str>, full: bool) -> String {
    if !full {
        return match base {
            Some(b) if b.starts_with("commit:") => commit_file_diff(root, &b["commit:".len()..], file),
            b => file_diff(root, file, b),
        };
    }
    let git = |args: &[&str]| git(root, args).stdout;
    const U: &str = "-U1000000";
    let out = match base {
        Some(b) if b.starts_with("commit:") => git(&["show", "--format=", "--no-color", "--no-ext-diff", U, &b["commit:".len()..], "--", file]),
        Some(b) => {
            let mb = git(&["merge-base", b, "HEAD"]);
            if mb.trim().is_empty() { String::new() } else { git(&["diff", "-M", U, mb.trim(), "HEAD", "--", file]) }
        }
        None => git(&["diff", "-M", U, "HEAD", "--", file]),
    };
    // Untracked files are all-added already.
    if out.trim().is_empty() { diff_patch(root, file, base, false) } else { out }
}

/// Rewrite `git diff --no-index a b` output as a patch of `file`.
fn rehead(file: &str, out: &str) -> String {
    match out.find("\n@@") {
        Some(i) => format!("diff --git a/{file} b/{file}\n--- a/{file}\n+++ b/{file}\n{}", &out[i + 1..]),
        None => String::new(),
    }
}

/// A unified patch between two texts of `file`.
pub fn text_patch(file: &str, old: &str, new: &str) -> String {
    let dir = std::env::temp_dir().join(format!("forest-ranger-diff-{}", uuid::Uuid::new_v4()));
    if std::fs::create_dir_all(&dir).is_err() || std::fs::write(dir.join("a"), old).is_err() || std::fs::write(dir.join("b"), new).is_err() {
        return String::new();
    }
    let out = git(&dir.to_string_lossy(), &["diff", "--no-index", "--no-color", "--no-ext-diff", "a", "b"]).stdout;
    let _ = std::fs::remove_dir_all(&dir);
    rehead(file, &out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_patch() {
        let p = text_patch("src/x.rs", "a\nb\n", "a\nc\n");
        assert!(p.starts_with("diff --git a/src/x.rs b/src/x.rs\n--- a/src/x.rs\n+++ b/src/x.rs\n@@"), "{p}");
        assert!(p.contains("\n-b\n+c\n"));
        assert_eq!(text_patch("x", "same", "same"), "");
        assert_eq!(rehead("x", "diff --git a/a b/b\nnew file mode 100644\n--- /dev/null\n"), "");
    }

    #[test]
    fn parses_nul_changes() {
        let ns = "R100\0old.txt\0new.txt\0M\0\u{e9}.txt\0";
        let num = "0\t0\t\0old.txt\0new.txt\0\x31\t0\t\u{e9}.txt\0-\t-\tbin\0";
        let c = parse_changes(ns, num);
        assert_eq!(c.len(), 2);
        assert_eq!((c[0].path.as_str(), c[0].kind, c[0].insertions), ("new.txt", ChangeKind::Renamed, Some(0)));
        assert_eq!((c[1].path.as_str(), c[1].kind, c[1].insertions), ("\u{e9}.txt", ChangeKind::Modified, Some(1)));
    }

    #[test]
    fn round_trip() {
        let dir = std::env::temp_dir().join(format!("fr-git-test-{}-{}", std::process::id(), uuid::Uuid::new_v4()));
        fs::create_dir_all(&dir).unwrap();
        let p = dir.to_str().unwrap().to_string();
        let sh = |args: &[&str]| assert!(git(&p, args).ok, "git {args:?} failed");
        sh(&["init", "-q", "-b", "main"]);
        sh(&["config", "user.email", "t@t"]);
        sh(&["config", "user.name", "T"]);
        fs::write(dir.join("a.txt"), "hello\n").unwrap();
        sh(&["add", "-A"]);
        sh(&["commit", "-qm", "init"]);
        sh(&["switch", "-qc", "feat"]);

        // Uncommitted: one modified (staged), one untracked.
        write_file(&p, "a.txt", "hello\nworld\n").unwrap();
        fs::write(dir.join("new file.txt"), "Needle here\n").unwrap();
        stage(&p, &["a.txt".into()]).unwrap();
        let d = detail(&p, &p, None);
        assert_eq!(d.branch.as_deref(), Some("feat"));
        assert_eq!(d.base.as_deref(), Some("main"));
        assert_eq!(d.branches, vec!["feat", "main"]);
        let a = d.uncommitted.iter().find(|f| f.path == "a.txt").unwrap();
        assert!(a.staged && a.kind == ChangeKind::Modified && a.insertions == Some(1));
        let n = d.uncommitted.iter().find(|f| f.path == "new file.txt").unwrap();
        assert!(n.kind == ChangeKind::Untracked && !n.staged);
        assert!(file_diff(&p, "new file.txt", None).contains("+Needle here"));
        assert!(read_file(&p, "../x").is_err());

        // Commit both; then the committed view vs main.
        stage(&p, &[]).unwrap();
        commit(&p, "feat work").unwrap();
        let d = detail(&p, &p, Some("main"));
        assert!(d.uncommitted.is_empty());
        assert_eq!((d.ahead, d.behind, d.committed.len()), (1, 0, 2));
        let c = commits_vs_base(&p, "main");
        assert_eq!(c.len(), 1);
        assert_eq!((c[0].subject.as_str(), c[0].insertions, c[0].deletions), ("feat work", 2, 0));
        assert_eq!(commit_files(&p, &c[0].hash).len(), 2);
        assert!(file_diff(&p, "a.txt", Some("main")).contains("+world"));

        let hits = search(&p, "needle");
        assert_eq!(hits.len(), 1);
        assert_eq!((hits[0].path.as_str(), hits[0].line), ("new file.txt", 1));
        assert!(list_dir(&p, ".").iter().any(|(n, d)| n == "a.txt" && !d));

        // Worktree lifecycle.
        let wt = format!("{p}-wt");
        worktree_add(&p, &wt, "side", Some("main")).unwrap();
        fs::write(Path::new(&wt).join("x.txt"), "x").unwrap();
        let st = worktree_status(&p, &wt);
        assert_eq!((st.branch.as_deref(), st.uncommitted, st.unpushed, st.has_upstream), (Some("side"), 1, 0, false));
        assert!(worktree_remove(&p, &wt, false).is_err());
        worktree_remove(&p, &wt, true).unwrap();
        assert!(!Path::new(&wt).exists());
        // Cleanup safety: fresh off main is safe; a change or an unshared commit isn't.
        worktree_add(&p, &wt, "tidy", Some("main")).unwrap();
        // …but it's "not started", not "merged": that's only once its commits land.
        assert_eq!(safe_to_remove(&p, &wt).as_deref(), Some("no commits yet"));
        fs::write(Path::new(&wt).join("n.txt"), "n").unwrap();
        assert_eq!(safe_to_remove(&p, &wt), None);
        assert!(git(&wt, &["add", "-A"]).ok && git(&wt, &["commit", "-qm", "n"]).ok);
        assert_eq!(safe_to_remove(&p, &wt), None);
        // Merged: main moves up to include it (then back, for the checks below).
        let main = git_line(&p, &["rev-parse", "main"]).unwrap();
        assert!(git(&p, &["update-ref", "refs/heads/main", "refs/heads/tidy"]).ok);
        assert_eq!(safe_to_remove(&p, &wt).as_deref(), Some("merged into main"));
        assert!(git(&p, &["update-ref", "refs/heads/main", &main]).ok);
        worktree_remove(&p, &wt, true).unwrap();
        assert_eq!(safe_to_remove(&p, &wt).as_deref(), Some("folder already deleted"));
        delete_branch(&p, "tidy", true).unwrap();
        // Folder deleted outside the app: a plain remove just prunes it.
        worktree_add(&p, &wt, "gone", Some("main")).unwrap();
        fs::remove_dir_all(&wt).unwrap();
        worktree_remove(&p, &wt, false).unwrap();
        assert!(list_worktrees(&p).iter().all(|w| w.path != wt));
        delete_branch(&p, "gone", true).unwrap();
        assert!(rename_branch(&p, "side", "-f").is_err());
        // Merged into main, but its upstream has moved on: -d refuses, cleanup deletes.
        sh(&["branch", "merged", "main"]);
        sh(&["remote", "add", "origin", &p]);
        let unrelated = git(&p, &["commit-tree", "HEAD^{tree}", "-m", "rewritten"]).stdout.trim().to_string();
        sh(&["update-ref", "refs/remotes/origin/merged", &unrelated]);
        sh(&["config", "branch.merged.remote", "origin"]);
        sh(&["config", "branch.merged.merge", "refs/heads/merged"]);
        assert!(delete_branch(&p, "merged", false).is_err(), "-d judges by the upstream");
        delete_merged_branch(&p, "merged", Some("main")).unwrap();
        assert!(delete_merged_branch(&p, "feat", Some("main")).is_err(), "feat has commits main lacks");
        // Review of an MR already here: no fetch (this origin has no pull refs, so one would fail).
        let main_sha = git_line(&p, &["rev-parse", "main"]).unwrap();
        sh(&["update-ref", "refs/remotes/origin/pr-branch", &main_sha]);
        fetch_review_head(&p, true, 7, "pr-branch", &main_sha).unwrap();
        assert!(fetch_review_head(&p, true, 7, "pr-branch", "0000").is_err(), "a different head is fetched");
        sh(&["update-ref", "-d", "refs/remotes/origin/pr-branch"]);
        sh(&["remote", "remove", "origin"]);
        rename_branch(&p, "side", "side2").unwrap();
        delete_branch(&p, "side2", false).unwrap();
        assert_eq!(list_branches(&p), vec!["feat", "main"]);
        let log = base_log(&p, "main", 5);
        assert_eq!((log.len(), log[0].subject.as_str(), log[0].author.as_str()), (1, "init", "T"));
        assert_eq!(base_status(&p, "main"), None);
        assert_eq!(list_worktrees(&p)[0].branch.as_deref(), Some("feat"));
        let g = branch_graph(&p, Some("main"));
        let feat = g.iter().find(|b| b.name == "feat").unwrap();
        assert_eq!((feat.local, feat.remote, feat.ahead, feat.worktrees.len()), (true, false, Some(1), 1));

        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn branch_graph_parse() {
        let out = "refs/heads/main|100|0 0\nrefs/heads/feat|300|2 1\nrefs/remotes/origin/HEAD|50|\nrefs/remotes/origin/feat|400|1 1\nrefs/remotes/origin/gone|200|0 3\nrefs/tags/v1|9|\n";
        let v = parse_branch_graph(out);
        assert_eq!(v.iter().map(|b| b.name.as_str()).collect::<Vec<_>>(), ["main", "feat", "gone"]);
        let feat = &v[1];
        assert_eq!((feat.local, feat.remote, feat.last_commit, feat.ahead, feat.behind), (true, true, 400_000, Some(2), Some(1)));
        assert_eq!((v[2].local, v[2].remote, v[2].behind), (false, true, Some(3)));
        assert_eq!(parse_branch_graph("refs/heads/x|5|\n")[0].ahead, None);
    }

    #[test]
    fn worktree_list_parse() {
        let out = "worktree /r\nHEAD abc\nbranch refs/heads/main\n\nworktree /r-wt\nHEAD def\ndetached\nlocked reason\n\nworktree /b\nbare\n";
        let w = parse_worktree_list(out);
        assert_eq!(w.len(), 2);
        assert_eq!(w[0], WorktreeEntry { path: "/r".into(), head: Some("abc".into()), branch: Some("main".into()), locked: false });
        assert_eq!((w[1].branch.as_deref(), w[1].locked), (None, true));
    }
}
