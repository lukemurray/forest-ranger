//! The Electron app's git layer (src/main/git.ts), ported: shells out to `git`
//! synchronously. Same commands, flags and parsing as the TS.
#![allow(dead_code)]

use std::{
    collections::HashSet,
    fs,
    path::{Component, Path, PathBuf},
    process::Command,
};

struct Out {
    ok: bool,
    code: i32,
    stdout: String,
    stderr: String,
}

// ponytail: no timeouts (TS bounds push/rebase at 120s); add a wait-with-deadline if a hang shows up.
fn git(cwd: &str, args: &[&str]) -> Out {
    let path = format!("{}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin", std::env::var("PATH").unwrap_or_default());
    let ssh = std::env::var("GIT_SSH_COMMAND")
        .unwrap_or_else(|_| "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10".into());
    match Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("PATH", path)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_SSH_COMMAND", ssh)
        .output()
    {
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
fn git_line(cwd: &str, args: &[&str]) -> Option<String> {
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

/// `--name-status` + `--numstat` → files. Path is the last tab field (rename target);
/// numstat `-` (binary) → None.
fn parse_changes(name_status: &str, numstat: &str) -> Vec<ChangedFile> {
    let num = |s: &str| if s == "-" { None } else { s.parse().ok() };
    let stats: std::collections::HashMap<&str, (Option<u32>, Option<u32>)> = lines(numstat)
        .filter_map(|l| {
            let mut p = l.splitn(3, '\t');
            let (a, d, path) = (p.next()?, p.next()?, p.next()?);
            Some((path, (num(a), num(d))))
        })
        .collect();
    lines(name_status)
        .map(|l| {
            let path = l.rsplit('\t').next().unwrap_or_default();
            let (insertions, deletions) = stats.get(path).copied().unwrap_or((None, None));
            let kind = ChangeKind::from_letter(l.chars().next().unwrap_or('M'));
            ChangedFile { path: path.into(), kind, insertions, deletions, staged: false }
        })
        .collect()
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
        &git(wt, &["diff", "--name-status", "-M", "HEAD"]).stdout,
        &git(wt, &["diff", "--numstat", "-M", "HEAD"]).stdout,
    );
    let staged_out = git(wt, &["diff", "--cached", "--name-only", "HEAD"]).stdout;
    let staged: HashSet<&str> = lines(&staged_out).collect();
    for f in &mut uncommitted {
        f.staged = staged.contains(f.path.as_str());
    }
    let mut seen: HashSet<String> = uncommitted.iter().map(|f| f.path.clone()).collect();
    for p in lines(&git(wt, &["ls-files", "--others", "--exclude-standard"]).stdout) {
        if seen.insert(p.into()) {
            uncommitted.push(ChangedFile { path: p.into(), kind: ChangeKind::Untracked, insertions: None, deletions: None, staged: false });
        }
    }

    // Committed: HEAD vs the merge-base with base.
    let (mut resolved, mut ahead, mut behind, mut committed) = (None, 0, 0, Vec::new());
    if let Some(b) = &base {
        if let Some(mb) = git_line(wt, &["merge-base", b, "HEAD"]) {
            committed = parse_changes(
                &git(wt, &["diff", "--name-status", "-M", &mb, "HEAD"]).stdout,
                &git(wt, &["diff", "--numstat", "-M", &mb, "HEAD"]).stdout,
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
    let ns = git(path, &["show", "--name-status", "-M", "--format=", hash]);
    if !ns.ok { return vec![] }
    let num = git(path, &["show", "--numstat", "-M", "--format=", hash]);
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
    pub column: u32,
    pub text: String,
}

const MAX_HITS: usize = 500;

/// Case-insensitive literal search across tracked files (`git grep`), capped.
pub fn search(path: &str, query: &str) -> Vec<Hit> {
    if query.trim().is_empty() { return vec![] }
    // Exit 1 = no matches; just parse whatever stdout there is.
    let o = git(path, &["grep", "-n", "--column", "-I", "-F", "-i", "-e", query, "--", "."]);
    o.stdout.lines().filter_map(parse_hit).take(MAX_HITS).collect()
}

/// `path:line:col:text`, splitting at the first `:N:N:` (TS `/^(.+?):(\d+):(\d+):(.*)$/`).
fn parse_hit(l: &str) -> Option<Hit> {
    let num = |s: &str| (!s.is_empty() && s.bytes().all(|b| b.is_ascii_digit())).then(|| s.parse().ok()).flatten();
    l.match_indices(':').filter(|(i, _)| *i > 0).find_map(|(i, _)| {
        let mut p = l[i + 1..].splitn(3, ':');
        let (line, column, text) = (num(p.next()?)?, num(p.next()?)?, p.next()?);
        Some(Hit { path: l[..i].into(), line, column, text: text.chars().take(300).collect() })
    })
}

/// A working-tree file's text; Err for paths outside the worktree, read errors, or binary (NUL bytes).
pub fn read_file(path: &str, rel: &str) -> Result<String, String> {
    let full = confined(path, rel).ok_or("path is outside the worktree")?;
    let bytes = fs::read(full).map_err(|e| e.to_string())?;
    if bytes.contains(&0) { return Err("binary file".into()) }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

/// Overwrite a working-tree file (the editor's save).
pub fn write_file(path: &str, rel: &str, content: &str) -> Result<(), String> {
    let full = confined(path, rel).ok_or("path is outside the worktree")?;
    fs::write(full, content).map_err(|e| e.to_string())
}

/// Add a worktree at `path` on `branch`: check it out if it exists locally,
/// else create it off `base` — TS `addWorktree` (non-detached).
pub fn worktree_add(repo: &str, path: &str, branch: &str, base: Option<&str>) -> Result<(), String> {
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

/// Remove a worktree; a broken/locked one falls back to double force, then prune
/// plus deleting the leftover folder — TS `removeWorktree`.
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
    // Dirty without force is a refusal, not breakage: never fall through to --force.
    if !force && first.stderr.contains("modified or untracked") {
        return Err(err_text(&first, "git worktree remove failed"));
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
    if path != repo && Path::new(path).exists() {
        let _ = fs::remove_dir_all(path);
    }
    Ok(())
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

pub fn rename_branch(repo: &str, from: &str, to: &str) -> Result<(), String> {
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
    parse_worktree_list(&git(repo, &["worktree", "list", "--porcelain"]).stdout)
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

#[cfg(test)]
mod tests {
    use super::*;

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
        assert_eq!((hits[0].path.as_str(), hits[0].line, hits[0].column), ("new file.txt", 1, 1));
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
