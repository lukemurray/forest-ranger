//! The Electron app's data: projects/worktrees from its SQLite DB (read here)
//! and the chat list from its meta sidecars. Chat logs themselves: see log.rs.

use std::{fs, path::{Path, PathBuf}};

use crate::git;

use rusqlite::{Connection, OpenFlags};
use serde_json::Value;

pub fn data_dir() -> PathBuf {
    std::env::var_os("FOREST_RANGER_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".forest-ranger"))
}

/// Write a file via a temp file + rename, so a crash mid-write never leaves it
/// truncated. Keeps the old file's permissions.
pub fn write_atomic(path: &Path, contents: impl AsRef<[u8]>) -> std::io::Result<()> {
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    fs::write(&tmp, contents)?;
    if let Ok(m) = fs::metadata(path) {
        let _ = fs::set_permissions(&tmp, m.permissions());
    }
    fs::rename(&tmp, path).inspect_err(|_| _ = fs::remove_file(&tmp))
}

pub struct Project {
    pub id: String,
    pub name: String,
    pub path: String,
    pub worktrees: Vec<Worktree>,
}

pub struct Worktree {
    pub id: String,
    pub path: String,
    /// User label (the Electron app's double-click rename).
    pub name: Option<String>,
    pub branch: Option<String>,
    /// For a detached HEAD: the branch it was checked out from (reflog).
    pub detached_from: Option<String>,
    pub is_primary: bool,
    /// Newest of HEAD commit time and dirty-file mtimes (ms); 0 until computed.
    pub activity: i64,
}

impl Worktree {
    /// Display label plus a muted note — the Electron app's `worktreeLabel` rule.
    pub fn label(&self) -> (String, Option<String>) {
        let origin = self.branch.clone().or_else(|| self.detached_from.clone()).or_else(|| folder(&self.path));
        if let Some(name) = &self.name {
            let note = match (&self.branch, &origin) {
                (Some(b), _) => b.clone(),
                (None, Some(o)) => format!("{o}, detached"),
                _ => "detached".into(),
            };
            return (name.clone(), Some(note));
        }
        match &self.branch {
            Some(b) => (b.clone(), None),
            None => (origin.unwrap_or_else(|| "detached".into()), Some("detached".into())),
        }
    }
}

fn folder(path: &str) -> Option<String> {
    Path::new(path).file_name().map(|n| n.to_string_lossy().into_owned())
}

pub fn load_projects() -> Result<Vec<Project>, String> {
    let db = Connection::open_with_flags(
        data_dir().join("forest-ranger.db"),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| e.to_string())?;
    let projects = db
        .prepare("SELECT id, name, path FROM projects ORDER BY COALESCE(last_opened_at, added_at) DESC")
        .and_then(|mut s| {
            s.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?)))?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|e| e.to_string())?;
    let mut wts = db
        .prepare("SELECT id, path, name FROM worktrees WHERE project_id = ?")
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for (id, name, path) in projects {
        let worktrees = wts
            .query_map([&id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?)))
            .and_then(|rows| rows.collect::<Result<Vec<_>, _>>())
            .map_err(|e| e.to_string())?
            .into_iter()
            .filter(|(_, p, _)| Path::new(p).exists())
            .map(|(id, p, label)| {
                let gitdir = gitdir(&p);
                let branch = gitdir.as_deref().and_then(head_branch);
                let detached_from = if branch.is_none() { gitdir.as_deref().and_then(reflog_origin) } else { None };
                Worktree { is_primary: p == path, id, path: p, name: label, branch, detached_from, activity: 0 }
            })
            .collect();
        out.push(Project { id, name, path, worktrees });
    }
    Ok(out)
}

/// A worktree's git dir: `.git` itself, or where a linked worktree's `.git` file
/// points (relative to the worktree, with `worktree.useRelativePaths`).
pub(crate) fn gitdir(path: &str) -> Option<PathBuf> {
    let dot = Path::new(path).join(".git");
    if dot.is_dir() {
        return Some(dot);
    }
    let s = fs::read_to_string(&dot).ok()?;
    Some(Path::new(path).join(s.strip_prefix("gitdir:")?.trim()))
}

/// The checked-out branch, read straight from HEAD (no git process per worktree).
fn head_branch(gitdir: &Path) -> Option<String> {
    let head = fs::read_to_string(gitdir.join("HEAD")).ok()?;
    head.trim().strip_prefix("ref: refs/heads/").map(str::to_string)
}

/// Where a detached HEAD came from: the newest "checkout: moving from A to B" in
/// the reflog naming a branch (prefer the target), like the Electron app.
pub(crate) fn reflog_origin(gitdir: &Path) -> Option<String> {
    let log = fs::read_to_string(gitdir.join("logs/HEAD")).ok()?;
    let branch_of = |r: &str| {
        let r = r.trim();
        let r = r.strip_prefix("origin/").unwrap_or(r);
        (!r.is_empty() && !r.chars().all(|c| c.is_ascii_hexdigit())).then(|| r.to_string())
    };
    log.lines().rev().take(50).find_map(|line| {
        let msg = line.split_once('\t')?.1;
        let (from, to) = msg.strip_prefix("checkout: moving from ")?.split_once(" to ")?;
        branch_of(to).or_else(|| branch_of(from))
    })
}

/// Last activity (ms): HEAD commit time or the newest dirty file's mtime.
pub fn activity(path: &str) -> i64 {
    let mut latest = git::git_line(path, &["log", "-1", "--format=%ct"]).and_then(|s| s.parse::<i64>().ok()).unwrap_or(0) * 1000;
    // -z: "XY path" fields, unquoted; a rename/copy's old path follows as its own field.
    let status = git::git(path, &["status", "--porcelain", "-z"]).stdout;
    let mut fields = status.split('\0');
    while let Some(f) = fields.next() {
        let Some(rel) = f.get(3..) else { continue };
        if f.as_bytes()[..2].iter().any(|c| matches!(c, b'R' | b'C')) {
            fields.next();
        }
        if let Ok(m) = fs::metadata(Path::new(path).join(rel)).and_then(|m| m.modified()) {
            let ms = m.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
            latest = latest.max(ms);
        }
    }
    latest
}

pub fn relative_time(ms: i64) -> String {
    if ms <= 0 {
        return "—".into();
    }
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0);
    let r = |n: i64, d: i64| (n as f64 / d as f64).round() as i64;
    let sec = r(now - ms, 1000);
    if sec < 60 {
        return "just now".into();
    }
    let min = r(sec, 60);
    if min < 60 {
        return format!("{min}m ago");
    }
    let hr = r(min, 60);
    if hr < 24 {
        return format!("{hr}h ago");
    }
    let day = r(hr, 24);
    if day < 30 {
        return format!("{day}d ago");
    }
    let mo = r(day, 30);
    if mo < 12 { format!("{mo}mo ago") } else { format!("{}y ago", r(mo, 12)) }
}

pub struct ChatMeta {
    pub session_id: String,
    pub name: String,
    /// meta.json `updatedAt` (ms).
    pub updated_at: i64,
}

/// Saved chats for a worktree, newest first.
pub fn chats_for(worktree_id: &str) -> Vec<ChatMeta> {
    let dir = data_dir().join("chats");
    let mut metas: Vec<ChatMeta> = fs::read_dir(&dir)
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().ends_with(".meta.json"))
        .filter_map(|e| serde_json::from_str::<Value>(&fs::read_to_string(e.path()).ok()?).ok())
        .filter(|m| m["worktreeId"].as_str() == Some(worktree_id))
        .map(|m| ChatMeta {
            session_id: m["sessionId"].as_str().unwrap_or_default().to_string(),
            name: m["name"].as_str().unwrap_or("Chat").to_string(),
            updated_at: m["updatedAt"].as_i64().unwrap_or(0),
        })
        .collect();
    metas.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    metas
}


/// Create the database and bring an older one up to date. Same schema and
/// migrations as the former Electron app's db.ts, so either's DB works here.
pub fn ensure_schema() -> Result<(), String> {
    fs::create_dir_all(data_dir()).map_err(|e| e.to_string())?;
    ensure_schema_at(&data_dir().join("forest-ranger.db"))
}

fn ensure_schema_at(path: &Path) -> Result<(), String> {
    let db = Connection::open(path).map_err(|e| e.to_string())?;
    db.busy_timeout(std::time::Duration::from_secs(3)).map_err(|e| e.to_string())?;
    db.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA foreign_keys = ON;
         CREATE TABLE IF NOT EXISTS projects (
             id             TEXT PRIMARY KEY,
             name           TEXT NOT NULL,
             path           TEXT NOT NULL UNIQUE,
             added_at       INTEGER NOT NULL,
             last_opened_at INTEGER,
             worktree_dir   TEXT
         );
         CREATE TABLE IF NOT EXISTS worktrees (
             id             TEXT PRIMARY KEY,
             project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
             path           TEXT NOT NULL,
             last_opened_at INTEGER,
             created_at     INTEGER NOT NULL,
             UNIQUE(project_id, path)
         );
         CREATE TABLE IF NOT EXISTS project_commands (
             id         TEXT PRIMARY KEY,
             project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
             label      TEXT NOT NULL,
             command    TEXT NOT NULL,
             dir        TEXT NOT NULL DEFAULT '',
             run_target TEXT NOT NULL DEFAULT 'in-app',
             sort       INTEGER NOT NULL DEFAULT 0,
             created_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS integrations (
             type    TEXT PRIMARY KEY,
             enabled INTEGER NOT NULL DEFAULT 0,
             config  TEXT NOT NULL DEFAULT '{}'
         );",
    )
    .map_err(|e| e.to_string())?;
    // Columns added after a table first shipped.
    let migrations = [
        ("project_commands", "dir", "TEXT NOT NULL DEFAULT ''"),
        ("project_commands", "run_target", "TEXT NOT NULL DEFAULT 'in-app'"),
        ("projects", "worktree_dir", "TEXT"),
        ("projects", "integration", "TEXT"),
        ("worktrees", "name", "TEXT"),
    ];
    for (table, column, decl) in migrations {
        let mut stmt = db.prepare(&format!("PRAGMA table_info({table})")).map_err(|e| e.to_string())?;
        let cols: Vec<String> = stmt.query_map([], |r| r.get(1)).and_then(|r| r.collect()).map_err(|e| e.to_string())?;
        if !cols.iter().any(|c| c == column) {
            db.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} {decl}")).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

pub(crate) fn db_rw() -> Result<Connection, String> {
    let db = Connection::open(data_dir().join("forest-ranger.db")).map_err(|e| e.to_string())?;
    // The Electron app may be writing too; wait for its lock instead of failing.
    db.busy_timeout(std::time::Duration::from_secs(3)).map_err(|e| e.to_string())?;
    Ok(db)
}

fn now() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// The Electron app's stable worktree id: project id + a hash of the path.
pub fn worktree_id(project_id: &str, path: &str) -> String {
    format!("{project_id}-{}", &sha1_smol::Sha1::from(path).digest().to_string()[..12])
}

/// Make the DB match `git worktree list` for a project (git is the source of
/// truth for which worktrees exist), exactly like the Electron app's syncWorktrees.
pub fn sync_worktrees(project_id: &str, repo: &str) -> Result<(), String> {
    let paths: Vec<String> = git::try_list_worktrees(repo)?.into_iter().map(|w| w.path).collect();
    let mut db = db_rw()?;
    let db = db.transaction().map_err(|e| e.to_string())?;
    for p in &paths {
        db.execute(
            "INSERT INTO worktrees (id, project_id, path, last_opened_at, created_at) VALUES (?1, ?2, ?3, NULL, ?4)
             ON CONFLICT(project_id, path) DO UPDATE SET id = excluded.id",
            rusqlite::params![worktree_id(project_id, p), project_id, p, now()],
        )
        .map_err(|e| e.to_string())?;
    }
    db.execute(
        "DELETE FROM worktrees WHERE project_id = ?1 AND path NOT IN (SELECT value FROM json_each(?2))",
        rusqlite::params![project_id, serde_json::to_string(&paths).unwrap_or_default()],
    )
    .map_err(|e| e.to_string())?;
    db.commit().map_err(|e| e.to_string())
}

/// Add a git repo as a project (its top level), or return the existing one's id.
pub fn add_project(picked: &Path) -> Result<String, String> {
    let top = git::git_line(&picked.to_string_lossy(), &["rev-parse", "--show-toplevel"]).ok_or("That folder isn't a git repository.")?;
    let db = db_rw()?;
    if let Ok(id) = db.query_row("SELECT id FROM projects WHERE path = ?1", [&top], |r| r.get::<_, String>(0)) {
        return Ok(id);
    }
    let id = uuid::Uuid::new_v4().to_string();
    let name = folder(&top).unwrap_or_else(|| top.clone());
    db.execute(
        "INSERT INTO projects (id, name, path, added_at) VALUES (?1, ?2, ?3, ?4)",
        rusqlite::params![id, name, top, now()],
    )
    .map_err(|e| e.to_string())?;
    sync_worktrees(&id, &top)?;
    Ok(id)
}

/// Record that a worktree was opened (feeds recency, shared with the Electron app).
pub fn touch_worktree(id: &str) {
    if let Ok(db) = db_rw() {
        let _ = db.execute("UPDATE worktrees SET last_opened_at = ?1 WHERE id = ?2", rusqlite::params![now(), id]);
    }
}

/// Set (or clear, with None) a worktree's label.
pub fn set_label(id: &str, name: Option<&str>) {
    if let Ok(db) = db_rw() {
        let _ = db.execute("UPDATE worktrees SET name = ?1 WHERE id = ?2", rusqlite::params![name, id]);
    }
}

/// Forget a project (the repo on disk is untouched). Electron's FK cascade,
/// done by hand since this connection doesn't enable foreign keys.
pub fn remove_project(id: &str) -> Result<(), String> {
    let mut db = db_rw()?;
    let db = db.transaction().map_err(|e| e.to_string())?;
    for sql in ["DELETE FROM project_commands WHERE project_id = ?1", "DELETE FROM worktrees WHERE project_id = ?1", "DELETE FROM projects WHERE id = ?1"] {
        db.execute(sql, [id]).map_err(|e| e.to_string())?;
    }
    db.commit().map_err(|e| e.to_string())
}

pub fn set_worktree_dir(project_id: &str, dir: &str) {
    if let Ok(db) = db_rw() {
        let _ = db.execute("UPDATE projects SET worktree_dir = ?1 WHERE id = ?2", rusqlite::params![dir, project_id]);
    }
}

pub fn project_worktree_dir(id: &str) -> Option<String> {
    db_rw().ok()?.query_row("SELECT worktree_dir FROM projects WHERE id = ?1", [id], |r| r.get::<_, Option<String>>(0)).ok().flatten()
}

/// Where new worktrees go — Electron's worktreeParentFor: the saved dir, else
/// `<repo>.worktrees` if used or present, else the most common existing parent.
pub fn worktree_parent(project: &Project) -> String {
    if let Some(d) = project_worktree_dir(&project.id).filter(|d| !d.is_empty()) {
        return d;
    }
    let conventional = format!("{}.worktrees", project.path);
    let parents: Vec<String> = project
        .worktrees
        .iter()
        .filter(|w| w.path != project.path)
        .filter_map(|w| Path::new(&w.path).parent().map(|p| p.to_string_lossy().into_owned()))
        .collect();
    if parents.contains(&conventional) || Path::new(&conventional).exists() {
        return conventional;
    }
    let mut counts: Vec<(String, usize)> = vec![];
    for p in parents {
        match counts.iter_mut().find(|c| c.0 == p) {
            Some(c) => c.1 += 1,
            None => counts.push((p, 1)),
        }
    }
    // max_by_key keeps the last of equals; reversed, the first seen wins ties, as JS's stable sort does.
    counts.into_iter().rev().max_by_key(|c| c.1).map_or(conventional, |c| c.0)
}

/// A project's run command (the shared `project_commands` table).
#[derive(Clone, Debug, PartialEq)]
pub struct RunCommand {
    pub id: String,
    pub label: String,
    pub command: String,
    /// Relative to the worktree root; "" is the root.
    pub dir: String,
    /// "default" | "in-app" | "external"
    pub run_target: String,
}

pub fn list_commands(project_id: &str) -> Vec<RunCommand> {
    let Ok(db) = db_rw() else { return vec![] };
    db.prepare("SELECT id, label, command, dir, run_target FROM project_commands WHERE project_id = ?1 ORDER BY sort, created_at")
        .and_then(|mut s| {
            s.query_map([project_id], |r| {
                Ok(RunCommand { id: r.get(0)?, label: r.get(1)?, command: r.get(2)?, dir: r.get(3)?, run_target: r.get(4)? })
            })?
            .collect()
        })
        .unwrap_or_default()
}

/// Appended after the project's last command, like Electron's commandsRepo.insert.
pub fn add_command(project_id: &str, label: &str, command: &str, dir: &str, run_target: &str) -> Result<(), String> {
    let db = db_rw()?;
    let max: Option<i64> = db.query_row("SELECT MAX(sort) FROM project_commands WHERE project_id = ?1", [project_id], |r| r.get(0)).map_err(|e| e.to_string())?;
    db.execute(
        "INSERT INTO project_commands (id, project_id, label, command, dir, run_target, sort, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        rusqlite::params![uuid::Uuid::new_v4().to_string(), project_id, label, command, dir, run_target, max.unwrap_or(-1) + 1, now()],
    )
    .map(drop)
    .map_err(|e| e.to_string())
}

pub fn update_command(id: &str, label: &str, command: &str, dir: &str, run_target: &str) -> Result<(), String> {
    db_rw()?
        .execute("UPDATE project_commands SET label = ?1, command = ?2, dir = ?3, run_target = ?4 WHERE id = ?5", rusqlite::params![label, command, dir, run_target, id])
        .map(drop)
        .map_err(|e| e.to_string())
}

pub fn delete_command(id: &str) -> Result<(), String> {
    db_rw()?.execute("DELETE FROM project_commands WHERE id = ?1", [id]).map(drop).map_err(|e| e.to_string())
}

pub fn expand_tilde(p: &str) -> String {
    match p.strip_prefix('~') {
        Some(rest) => format!("{}{rest}", std::env::var("HOME").unwrap_or_default()),
        None => p.to_string(),
    }
}

pub fn tilde_path(p: &str) -> String {
    let home = std::env::var("HOME").unwrap_or_default();
    match p.strip_prefix(&home) {
        Some(rest) if !home.is_empty() && (rest.is_empty() || rest.starts_with('/')) => format!("~{rest}"),
        _ => p.to_string(),
    }
}

/// The branch a new worktree gets: the typed name, else a remote base's local
/// name (origin/foo → foo), else `worktree-<6 random>` — like createWorktree.
pub fn new_branch_name(name: &str, base: Option<&str>) -> String {
    let name = name.trim();
    if !name.is_empty() {
        return name.to_string();
    }
    if let Some(b) = base.and_then(|b| b.strip_prefix("origin/")) {
        return b.to_string();
    }
    format!("worktree-{}", &uuid::Uuid::new_v4().simple().to_string()[..6])
}

/// The folder for a branch: slugified (feature/foo → feature-foo), -2, -3… on collision.
pub fn worktree_folder(parent: &str, branch: &str) -> PathBuf {
    // JS `replace(/[^\w.-]+/g, "-")`: each run of other chars becomes one dash.
    let (mut slug, mut in_run) = (String::new(), false);
    for c in branch.chars() {
        let keep = c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-');
        if keep {
            slug.push(c);
        } else if !in_run {
            slug.push('-');
        }
        in_run = !keep;
    }
    let slug = slug.trim_matches('-');
    let slug = if slug.is_empty() { "worktree" } else { slug };
    let mut path = Path::new(parent).join(slug);
    let mut n = 2;
    while path.exists() {
        path = Path::new(parent).join(format!("{slug}-{n}"));
        n += 1;
    }
    path
}

#[cfg(test)]
mod tests {
    #[test]
    fn schema_creates_and_migrates() {
        let dir = std::env::temp_dir().join(format!("fr-schema-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        // An "old" DB: worktrees without the later `name` column.
        let old = dir.join("old.db");
        rusqlite::Connection::open(&old)
            .unwrap()
            .execute_batch("CREATE TABLE worktrees (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, path TEXT NOT NULL, last_opened_at INTEGER, created_at INTEGER NOT NULL, UNIQUE(project_id, path));")
            .unwrap();
        for db in [dir.join("new.db"), old] {
            super::ensure_schema_at(&db).unwrap();
            super::ensure_schema_at(&db).unwrap(); // idempotent
            let c = rusqlite::Connection::open(&db).unwrap();
            for (t, col) in [("projects", "integration"), ("worktrees", "name"), ("project_commands", "run_target"), ("integrations", "config")] {
                let n: i64 = c.query_row(&format!("SELECT COUNT(*) FROM pragma_table_info('{t}') WHERE name = ?1"), [col], |r| r.get(0)).unwrap();
                assert_eq!(n, 1, "{t}.{col}");
            }
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    use super::*;

    #[test]
    fn worktree_naming() {
        assert_eq!(new_branch_name("  feat/x ", Some("origin/y")), "feat/x");
        assert_eq!(new_branch_name("", Some("origin/y")), "y");
        assert!(new_branch_name("", Some("main")).starts_with("worktree-"));
        let dir = std::env::temp_dir().join(format!("fr-data-test-{}", uuid::Uuid::new_v4()));
        let parent = dir.to_str().unwrap();
        assert_eq!(worktree_folder(parent, "feature/foo bar"), dir.join("feature-foo-bar"));
        assert_eq!(worktree_folder(parent, "/@@/"), dir.join("worktree"));
        assert_eq!(worktree_folder(parent, "a-/b"), dir.join("a--b"));
        fs::create_dir_all(dir.join("x")).unwrap();
        assert_eq!(worktree_folder(parent, "x"), dir.join("x-2"));
        fs::remove_dir_all(&dir).unwrap();
    }
}
