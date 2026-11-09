//! Code-host status (src/main/github.ts, gitlab.ts + the integration RPCs in
//! index.ts), ported: per-branch PR/MR + checks via the `gh` / `glab` CLIs and
//! their own logins. Token / OAuth connections are encrypted with Electron's
//! safeStorage, so they're reported as unsupported here rather than called.

use std::{process::Command, time::Duration};

use rusqlite::{Connection as Db, OpenFlags, OptionalExtension};
use serde_json::{Map, Value};

use crate::data::{data_dir, db_rw};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Provider {
    GitHub,
    GitLab,
}

impl Provider {
    pub const ALL: [Provider; 2] = [Provider::GitHub, Provider::GitLab];

    pub fn label(self) -> &'static str {
        match self {
            Self::GitHub => "GitHub",
            Self::GitLab => "GitLab",
        }
    }
    pub fn cli(self) -> &'static str {
        match self {
            Self::GitHub => "gh",
            Self::GitLab => "glab",
        }
    }
    /// The `integrations.type` / `projects.integration` key.
    fn key(self) -> &'static str {
        match self {
            Self::GitHub => "github",
            Self::GitLab => "gitlab",
        }
    }
    fn default_host(self) -> &'static str {
        match self {
            Self::GitHub => "github.com",
            Self::GitLab => "https://gitlab.com",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum Connection {
    Cli { user: Option<String> },
    Token,
    OAuth { user: Option<String> },
    None,
}
#[derive(Clone, Debug, PartialEq)]
pub struct IntegrationInfo {
    pub provider: Provider,
    pub enabled: bool,
    pub host: String,
    pub connection: Connection,
}

/// Normalized like the TS; `Other` carries a raw state the TS passes through (e.g. "locked").
#[derive(Clone, Debug, PartialEq)]
pub enum ReqState {
    Open,
    Merged,
    Closed,
    Other(String),
}

/// `Other` carries a raw status the TS passes through (e.g. "canceled", "skipped", "manual").
#[derive(Clone, Debug, PartialEq)]
pub enum CheckState {
    Success,
    Failed,
    Running,
    Pending,
    Other(String),
}

#[derive(Clone, Debug, PartialEq)]
pub struct BranchStatus {
    pub provider: Provider,
    pub project_url: String,
    /// (number, title, state, url)
    pub request: Option<(u64, String, ReqState, String)>,
    /// (status, url)
    pub checks: Option<(CheckState, String)>,
    pub error: Option<String>,
    /// Matched a token / sign-in integration set up in the Electron app, which we can't call.
    pub unsupported: bool,
}

// ---- stored config (index.ts readStored) ----

fn db_ro() -> Result<Db, String> {
    let db = Db::open_with_flags(
        data_dir().join("forest-ranger.db"),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| e.to_string())?;
    db.busy_timeout(Duration::from_secs(3)).map_err(|e| e.to_string())?;
    Ok(db)
}

/// (enabled, config) for a provider; missing row = disabled, `{}`.
fn read_row(db: &Db, p: Provider) -> (bool, Map<String, Value>) {
    let row = db
        .query_row("SELECT enabled, config FROM integrations WHERE type = ?1", [p.key()], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })
        .optional()
        .ok()
        .flatten();
    let Some((enabled, config)) = row else { return (false, Map::new()) };
    (enabled != 0, migrate(serde_json::from_str::<Value>(&config).ok().and_then(|v| v.as_object().cloned()).unwrap_or_default()))
}

/// Carry over a glab connection made before CLI support covered GitHub too.
fn migrate(mut s: Map<String, Value>) -> Map<String, Value> {
    if truthy(&s, "useGlab") && !s.contains_key("useCli") {
        s.remove("useGlab");
        let user = s.remove("glabUser");
        s.insert("useCli".into(), Value::Bool(true));
        if let Some(u) = user {
            s.insert("cliUser".into(), u);
        }
    }
    s
}

fn truthy(s: &Map<String, Value>, k: &str) -> bool {
    match s.get(k) {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64() != Some(0.0),
        Some(Value::String(t)) => !t.is_empty(),
        Some(_) => true,
    }
}

fn str_of<'a>(s: &'a Map<String, Value>, k: &str) -> Option<&'a str> {
    s.get(k).and_then(Value::as_str).filter(|v| !v.is_empty())
}

fn host_of(p: Provider, s: &Map<String, Value>) -> String {
    str_of(s, "host").unwrap_or(p.default_host()).to_string()
}

fn connection(p: Provider, s: &Map<String, Value>) -> Connection {
    let nonempty = |k: &str| str_of(s, k).map(str::to_string);
    if truthy(s, "useCli") {
        Connection::Cli { user: nonempty("cliUser") }
    } else if p == Provider::GitLab && truthy(s, "oauth") {
        Connection::OAuth { user: s["oauth"].get("user").and_then(Value::as_str).filter(|u| !u.is_empty()).map(str::to_string) }
    } else if ["tokenEnc", "tokenPlain", "token"].iter().any(|k| str_of(s, k).is_some()) {
        // ponytail: a tokenEnc the keychain can't decrypt still shows as Token (TS would show none).
        Connection::Token
    } else {
        Connection::None
    }
}

pub fn integrations() -> Vec<IntegrationInfo> {
    let db = db_ro().ok();
    Provider::ALL
        .iter()
        .map(|&p| {
            let (enabled, s) = db.as_ref().map(|db| read_row(db, p)).unwrap_or_default();
            IntegrationInfo { provider: p, enabled, host: host_of(p, &s), connection: connection(p, &s) }
        })
        .collect()
}

fn upsert(db: &Db, p: Provider, enabled: bool, config: &Map<String, Value>) -> Result<(), String> {
    db.execute(
        "INSERT INTO integrations (type, enabled, config) VALUES (?1, ?2, ?3)
         ON CONFLICT(type) DO UPDATE SET enabled = excluded.enabled, config = excluded.config",
        rusqlite::params![p.key(), enabled as i64, Value::Object(config.clone()).to_string()],
    )
    .map(|_| ())
    .map_err(|e| e.to_string())
}

/// Flip `enabled` only; the config (incl. Electron's encrypted tokens) is untouched.
pub fn set_enabled(p: Provider, enabled: bool) -> Result<(), String> {
    db_rw()?
        .execute(
            "INSERT INTO integrations (type, enabled, config) VALUES (?1, ?2, '{}')
             ON CONFLICT(type) DO UPDATE SET enabled = excluded.enabled",
            rusqlite::params![p.key(), enabled as i64],
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// The stored host unless `typed` is non-blank (index.ts: `host.trim() || prev.host || DEFAULT_HOST`).
fn host_or_stored(p: Provider, typed: &str) -> Result<String, String> {
    let typed = typed.trim();
    Ok(if typed.is_empty() { host_of(p, &read_row(&db_ro()?, p).1) } else { typed.to_string() })
}

/// The `integrationUseCli` RPC with enable=true: check the CLI is signed in to
/// `host` (blank = the stored one), then store host + useCli + cliUser and turn
/// the integration on.
pub fn use_cli_host(p: Provider, host: &str) -> Result<String, String> {
    let host = host_or_stored(p, host)?;
    let user = test_cli(p, &host).map_err(|e| {
        let bare = strip_scheme(&host);
        format!("{e} — sign {0} in with `{0} auth login --hostname {bare}`", p.cli())
    })?;
    // Re-read after the (slow) CLI call so we don't clobber a concurrent Electron write.
    let db = db_rw()?;
    let (_, mut s) = read_row(&db, p);
    s.insert("host".into(), Value::String(host));
    s.insert("useCli".into(), Value::Bool(true));
    s.insert("cliUser".into(), Value::String(user.clone()));
    upsert(&db, p, true, &s)?;
    Ok(user)
}

/// "Test connection" through the CLI's login on `host` (blank = stored); Ok = user.
pub fn test_connection(p: Provider, host: &str) -> Result<String, String> {
    test_cli(p, &host_or_stored(p, host)?)
}

/// Same host after normalizing scheme / slash / case.
pub fn same_host(a: &str, b: &str) -> bool {
    bare_host(a) == bare_host(b)
}

/// The `integrationUseCli` RPC with enable=false: drop useCli + cliUser, keep the rest.
pub fn stop_cli(p: Provider) -> Result<(), String> {
    let db = db_rw()?;
    let (enabled, mut s) = read_row(&db, p);
    s.remove("useCli");
    s.remove("cliUser");
    upsert(&db, p, enabled, &s)
}

/// testConnection via the CLI: GET /user → login / username.
fn test_cli(p: Provider, host: &str) -> Result<String, String> {
    let u = api(p, host, "/user")?;
    let k = if p == Provider::GitHub { "login" } else { "username" };
    Ok(u[k].as_str().unwrap_or_default().to_string())
}

// ---- CLI transport (ghCli / glabApi) ----

pub(crate) fn strip_scheme(h: &str) -> &str {
    let lower = h.to_ascii_lowercase();
    if lower.starts_with("https://") {
        &h[8..]
    } else if lower.starts_with("http://") {
        &h[7..]
    } else {
        h
    }
}

/// github.ts bareHost: no scheme, no trailing slash, lowercase.
pub(crate) fn bare_host(h: &str) -> String {
    strip_scheme(h.trim()).trim_end_matches('/').to_lowercase()
}

/// gitlab.ts siteUrl: scheme-qualified, no trailing slash.
pub(crate) fn site_url(h: &str) -> String {
    let h = h.trim().trim_end_matches('/');
    if h.len() == strip_scheme(h).len() { format!("https://{h}") } else { h.to_string() }
}

/// `gh api` / `glab api` GET, parsed as JSON. Errors are prefixed like the TS.
fn api(p: Provider, host: &str, path: &str) -> Result<Value, String> {
    api_with(p, host, path, &[])
}

/// POST when `fields` (string `-f key=value`s) are given, else GET.
fn api_with(p: Provider, host: &str, path: &str, fields: &[(&str, &str)]) -> Result<Value, String> {
    let (prefix, hostname) = match p {
        Provider::GitHub => ("GitHub via gh", bare_host(host)),
        Provider::GitLab => ("GitLab via glab", strip_scheme(&site_url(host)).to_string()),
    };
    let fields: Vec<String> = fields.iter().map(|(k, v)| format!("{k}={v}")).collect();
    let mut args = vec!["api", path.trim_start_matches('/'), "--hostname", &hostname];
    if !fields.is_empty() {
        args.extend(["--method", "POST"]);
    }
    for f in &fields {
        args.extend(["-f", f.as_str()]);
    }
    let stdout = run_cli(p.cli(), &args).map_err(|why| format!("{prefix}: {why}"))?;
    serde_json::from_str(&stdout).map_err(|_| format!("{prefix}: unexpected response"))
}

/// Run a CLI with the augmented PATH and a 30s deadline; Err is the one-line reason.
pub(crate) fn run_cli(cli: &str, args: &[&str]) -> Result<String, String> {
    // Dock-launched apps don't get the shell's PATH (gh / glab live in /opt/homebrew/bin).
    let path = format!("{}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin", std::env::var("PATH").unwrap_or_default());
    let mut cmd = Command::new(cli);
    cmd.args(args).env("PATH", path).env("GH_PROMPT_DISABLED", "1");
    let o = crate::git::output_with_deadline(&mut cmd, Duration::from_secs(30)).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound { format!("{cli} isn't installed (brew install {cli})") } else { e.to_string() }
    })?;
    let (status, stdout, stderr) = (o.status, String::from_utf8_lossy(&o.stdout).into_owned(), String::from_utf8_lossy(&o.stderr).into_owned());
    if status.success() {
        return Ok(stdout);
    }
    let last = stderr.trim().lines().last().unwrap_or_default().to_string();
    Err(if last.is_empty() { format!("{cli} exited with {status}") } else { last })
}

/// JS encodeURIComponent.
fn enc(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

// ---- remotes (git.ts remoteUrl / parseRemote) ----

/// origin's URL, else the first remote's.
fn remote_url(repo: &str) -> Option<String> {
    crate::git::git_line(repo, &["remote", "get-url", "origin"]).or_else(|| {
        let remotes = crate::git::git_line(repo, &["remote"]).unwrap_or_default();
        let first = remotes.lines().map(str::trim).find(|l| !l.is_empty())?;
        crate::git::git_line(repo, &["remote", "get-url", first])
    })
}

/// Host + project path from a remote URL: scp-like `git@host:group/proj.git` or
/// `scheme://[user@]host[:port]/group/proj(.git)`.
fn parse_remote(url: &str) -> Option<(String, String)> {
    let u = url.trim();
    let strip = |p: &str| {
        let p = p.strip_suffix(".git").unwrap_or(p);
        p.strip_prefix('/').unwrap_or(p).to_string()
    };
    // scp-like: [\w.+-]+@([^:]+):(.+)
    if let Some((user, rest)) = u.split_once('@') {
        let user_ok = !user.is_empty() && user.chars().all(|c| c.is_alphanumeric() || "_.+-".contains(c));
        if let Some((host, path)) = rest.split_once(':') {
            if user_ok && !host.is_empty() && !path.is_empty() {
                return Some((host.to_string(), strip(path)));
            }
        }
    }
    // [a-z][\w+.-]*://(?:[^@/]+@)?([^/]+)/(.+)
    let (scheme, rest) = u.split_once("://")?;
    let mut sc = scheme.chars();
    if !sc.next()?.is_ascii_alphabetic() || !sc.all(|c| c.is_alphanumeric() || "_+.-".contains(c)) {
        return None;
    }
    let (auth, path) = rest.split_once('/')?;
    let host = match auth.rsplit_once('@') {
        Some((_, h)) => h,
        None => auth,
    };
    if host.is_empty() || path.is_empty() {
        return None;
    }
    // Drop a trailing :port.
    let host = match host.rsplit_once(':') {
        Some((h, port)) if !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) => h,
        _ => host,
    };
    Some((host.to_string(), strip(path)))
}

/// projectPathFor / repoSlug: the repo path if origin's host is the configured
/// one (or any host when forced by a project override).
fn match_remote(remote: Option<&str>, host: &str, force: bool) -> Option<String> {
    let (rhost, path) = parse_remote(remote?)?;
    (force || rhost.to_lowercase() == bare_host(host)).then_some(path)
}

// ---- state mapping ----

fn mr_state(s: &str) -> ReqState {
    match s {
        "opened" | "open" => ReqState::Open,
        "merged" => ReqState::Merged,
        "closed" => ReqState::Closed,
        _ => ReqState::Other(s.into()),
    }
}

/// GitLab pipeline status → shared vocabulary.
fn pipe_state(s: &str) -> CheckState {
    match s {
        "failed" => CheckState::Failed,
        "success" => CheckState::Success,
        "running" => CheckState::Running,
        "pending" | "created" | "preparing" | "scheduled" | "waiting_for_resource" => CheckState::Pending,
        _ => CheckState::Other(s.into()),
    }
}

/// GitHub combined status → shared vocabulary.
fn check_state(s: &str) -> CheckState {
    match s {
        "success" => CheckState::Success,
        "failure" | "error" => CheckState::Failed,
        "pending" => CheckState::Pending,
        _ => CheckState::Other(s.into()),
    }
}

// ---- branch status (the branchIntegrations RPC) ----

pub(crate) fn project_url(p: Provider, host: &str, path: &str) -> String {
    match p {
        Provider::GitHub => format!("https://{}/{path}", bare_host(host)),
        Provider::GitLab => format!("{}/{path}", site_url(host)),
    }
}

fn github(host: &str, slug: &str, branch: &str) -> Result<BranchStatus, String> {
    let owner = slug.split('/').next().unwrap_or_default();
    let url = project_url(Provider::GitHub, host, slug);
    let pulls = api(
        Provider::GitHub,
        host,
        &format!("/repos/{slug}/pulls?head={}&state=all&sort=updated&direction=desc&per_page=1", enc(&format!("{owner}:{branch}"))),
    )?;
    let pr = pulls.get(0).filter(|v| !v.is_null());
    let pr_url = pr.and_then(|p| p["html_url"].as_str()).map(str::to_string);
    // Combined commit status for the branch tip (total_count 0 = no checks); best-effort.
    let checks = api(Provider::GitHub, host, &format!("/repos/{slug}/commits/{}/status", enc(branch)))
        .ok()
        .filter(|st| st["total_count"].as_u64().unwrap_or(0) > 0)
        .map(|st| (check_state(st["state"].as_str().unwrap_or_default()), pr_url.clone().unwrap_or_else(|| url.clone())));
    let request = pr.map(|p| {
        let state = if p["merged_at"].is_string() { ReqState::Merged } else { mr_state(p["state"].as_str().unwrap_or_default()) };
        (p["number"].as_u64().unwrap_or(0), p["title"].as_str().unwrap_or_default().to_string(), state, pr_url.clone().unwrap_or_default())
    });
    Ok(BranchStatus { provider: Provider::GitHub, project_url: url, request, checks, error: None, unsupported: false })
}

fn gitlab(host: &str, path: &str, branch: &str) -> Result<BranchStatus, String> {
    let id = enc(path);
    let mrs = api(
        Provider::GitLab,
        host,
        &format!("/projects/{id}/merge_requests?source_branch={}&order_by=updated_at&sort=desc&per_page=1", enc(branch)),
    )?;
    let mr = mrs.get(0).filter(|v| !v.is_null());
    let mut pipeline = mr.map(|m| m["head_pipeline"].clone()).filter(|p| p.is_object());
    if pipeline.is_none() {
        let pls = api(Provider::GitLab, host, &format!("/projects/{id}/pipelines?ref={}&per_page=1", enc(branch)))?;
        pipeline = pls.get(0).filter(|v| !v.is_null()).cloned();
    }
    let s = |v: &Value, k: &str| v[k].as_str().unwrap_or_default().to_string();
    Ok(BranchStatus {
        provider: Provider::GitLab,
        project_url: project_url(Provider::GitLab, host, path),
        request: mr.map(|m| (m["iid"].as_u64().unwrap_or(0), s(m, "title"), mr_state(&s(m, "state")), s(m, "web_url"))),
        checks: pipeline.map(|p| (pipe_state(&s(&p, "status")), s(&p, "web_url"))),
        error: None,
        unsupported: false,
    })
}

/// Integrations to try for a project, honouring `projects.integration`: "none" →
/// none; "github"/"gitlab" → just that one, forced past host matching; else both.
fn for_project(over: Option<&str>) -> Vec<(Provider, bool)> {
    match over {
        Some("none") => vec![],
        Some("github") => vec![(Provider::GitHub, true)],
        Some("gitlab") => vec![(Provider::GitLab, true)],
        _ => Provider::ALL.iter().map(|&p| (p, false)).collect(),
    }
}

/// The first enabled integration with a credential whose host matches the repo's
/// remote: (provider, host, project path, connected via its CLI).
pub(crate) fn matched(project_id: &str, repo_path: &str) -> Option<(Provider, String, String, bool)> {
    let db = db_ro().ok()?;
    let over: Option<String> = db
        .query_row("SELECT integration FROM projects WHERE id = ?1", [project_id], |r| r.get(0))
        .optional()
        .ok()??;
    let mut remote: Option<Option<String>> = None;
    for (p, force) in for_project(over.as_deref()) {
        let (enabled, s) = read_row(&db, p);
        if !enabled {
            continue;
        }
        let conn = connection(p, &s);
        if conn == Connection::None {
            continue; // no credential (integrationAuth → null)
        }
        let host = host_of(p, &s);
        let remote = remote.get_or_insert_with(|| remote_url(repo_path));
        let Some(path) = match_remote(remote.as_deref(), &host, force) else { continue };
        return Some((p, host, path, matches!(conn, Connection::Cli { .. })));
    }
    None
}

// ---- per-project override (projectIntegration / setProjectIntegration RPCs) ----

#[derive(Clone, Debug, PartialEq)]
pub struct ProjectCodeHost {
    /// origin as `host/path`.
    pub remote: Option<String>,
    /// The integration whose configured host is origin's host.
    pub detected: Option<Provider>,
    /// "auto" | "github" | "gitlab" | "none"
    pub choice: String,
    /// (provider, enabled, connection) of the one in effect.
    pub effective: Option<(Provider, bool, Connection)>,
}

pub fn project_code_host(project_id: &str, repo_path: &str) -> ProjectCodeHost {
    let db = db_ro().ok();
    let over: Option<String> = db
        .as_ref()
        .and_then(|db| db.query_row("SELECT integration FROM projects WHERE id = ?1", [project_id], |r| r.get(0)).optional().ok())
        .flatten()
        .flatten();
    let rows: Vec<(Provider, bool, Map<String, Value>)> = Provider::ALL
        .iter()
        .map(|&p| {
            let (en, s) = db.as_ref().map(|db| read_row(db, p)).unwrap_or_default();
            (p, en, s)
        })
        .collect();
    let parsed = remote_url(repo_path).and_then(|u| parse_remote(&u));
    let detected = parsed.as_ref().and_then(|(h, _)| {
        let h = h.to_lowercase();
        rows.iter().find(|(p, _, s)| bare_host(&host_of(*p, s)) == h).map(|r| r.0)
    });
    let forced = match over.as_deref() {
        Some("github") => Some(Provider::GitHub),
        Some("gitlab") => Some(Provider::GitLab),
        _ => None,
    };
    let effective = (if over.as_deref() == Some("none") { None } else { forced.or(detected) })
        .and_then(|p| rows.iter().find(|r| r.0 == p))
        .map(|(p, en, s)| (*p, *en, connection(*p, s)));
    ProjectCodeHost {
        remote: parsed.map(|(h, p)| format!("{h}/{p}")),
        detected,
        choice: over.filter(|o| ["github", "gitlab", "none"].contains(&o.as_str())).unwrap_or_else(|| "auto".into()),
        effective,
    }
}

/// "auto" clears the override (NULL), like setProjectIntegration.
pub fn set_project_code_host(project_id: &str, choice: &str) -> Result<(), String> {
    let v = (choice != "auto").then_some(choice);
    db_rw()?
        .execute("UPDATE projects SET integration = ?1 WHERE id = ?2", rusqlite::params![v, project_id])
        .map(|_| ())
        .map_err(|e| e.to_string())
}

/// The status line under the project's code host picker (ProjectView CodeHostField).
pub fn project_status_line(info: &ProjectCodeHost) -> String {
    let Some((p, enabled, conn)) = &info.effective else {
        return if info.choice == "none" {
            "Turned off for this project.".into()
        } else if info.remote.is_some() {
            "No integration matches this host — pick one above if it should use one.".into()
        } else {
            "No origin remote, so there's nothing to look up.".into()
        };
    };
    let (label, cli) = (p.label(), p.cli());
    let at = |u: &Option<String>| u.as_ref().map(|u| format!(" as @{u}")).unwrap_or_default();
    match conn {
        _ if !enabled => format!("{label} isn't connected — set it up in Settings → Integrations."),
        Connection::None => format!("{label} isn't connected — set it up in Settings → Integrations."),
        Connection::Cli { user } => format!("Using {label} via {cli}{}.", at(user)),
        // Electron-only credentials: say so rather than claim it works here.
        Connection::OAuth { user } => format!("{label} uses a browser sign-in{} from the Electron app, which can't be used here — switch it to {cli} in Settings → Integrations.", at(user)),
        Connection::Token => format!("{label} uses an access token from the Electron app, which can't be used here — switch it to {cli} in Settings → Integrations."),
    }
}

/// PR/MR + checks for a branch via the first enabled, usable integration whose host
/// matches the repo's remote. None = no project / no match.
pub fn branch_status(project_id: &str, repo_path: &str, branch: &str) -> Option<BranchStatus> {
    if branch.is_empty() {
        return None;
    }
    let (p, host, path, cli) = matched(project_id, repo_path)?;
    let project_url = project_url(p, &host, &path);
    if !cli {
        return Some(BranchStatus { provider: p, project_url, request: None, checks: None, error: None, unsupported: true });
    }
    let res = match p {
        Provider::GitHub => github(&host, &path, branch),
        Provider::GitLab => gitlab(&host, &path, branch),
    };
    Some(res.unwrap_or_else(|e| BranchStatus { provider: p, project_url, request: None, checks: None, error: Some(e), unsupported: false }))
}

/// Open a PR/MR from `branch` into `base`, titled after the branch (the
/// createReviewRequest RPC; push first). Ok = (number, url).
pub fn create_review_request(project_id: &str, repo_path: &str, branch: &str, base: &str) -> Result<(u64, String), String> {
    let (p, host, path, cli) = matched(project_id, repo_path).ok_or("No integration matches this repo's remote")?;
    if !cli {
        return Err(format!("Connected with a token in the Electron app — switch {} to its CLI in Settings.", p.label()));
    }
    let base = base.strip_prefix("origin/").unwrap_or(base);
    let (v, num, url) = match p {
        Provider::GitHub => {
            (api_with(p, &host, &format!("/repos/{path}/pulls"), &[("title", branch), ("head", branch), ("base", base)])?, "number", "html_url")
        }
        Provider::GitLab => (
            api_with(
                p,
                &host,
                &format!("/projects/{}/merge_requests", enc(&path)),
                &[("source_branch", branch), ("target_branch", base), ("title", branch)],
            )?,
            "iid",
            "web_url",
        ),
    };
    Ok((v[num].as_u64().unwrap_or(0), v[url].as_str().unwrap_or_default().to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn remotes_hosts_states() {
        let p = |u| parse_remote(u).map(|(h, p)| format!("{h} {p}"));
        assert_eq!(p("git@gitlab.com:xysense/xynger.git").as_deref(), Some("gitlab.com xysense/xynger"));
        assert_eq!(p("https://github.com/a/b.git").as_deref(), Some("github.com a/b"));
        assert_eq!(p("ssh://git@host.io:2222/g/sub/p").as_deref(), Some("host.io g/sub/p"));
        assert_eq!(p("https://user:pw@GitHub.com/a/b").as_deref(), Some("GitHub.com a/b"));
        assert_eq!(p("/local/path"), None);

        assert_eq!(match_remote(Some("git@GitHub.com:a/b.git"), "https://github.com/", false).as_deref(), Some("a/b"));
        assert_eq!(match_remote(Some("git@gh-alias:a/b.git"), "github.com", false), None);
        assert_eq!(match_remote(Some("git@gh-alias:a/b.git"), "github.com", true).as_deref(), Some("a/b"));
        assert_eq!(site_url("gitlab.example.com/"), "https://gitlab.example.com");
        assert_eq!(project_url(Provider::GitLab, "https://gitlab.com", "g/p"), "https://gitlab.com/g/p");
        assert_eq!(project_url(Provider::GitHub, "HTTPS://GitHub.com", "o/r"), "https://github.com/o/r");
        assert_eq!(enc("o:feature/mcp"), "o%3Afeature%2Fmcp");

        assert_eq!(mr_state("opened"), ReqState::Open);
        assert_eq!(mr_state("locked"), ReqState::Other("locked".into()));
        assert_eq!(pipe_state("waiting_for_resource"), CheckState::Pending);
        assert_eq!(pipe_state("canceled"), CheckState::Other("canceled".into()));
        assert_eq!(check_state("error"), CheckState::Failed);

        let m = migrate(serde_json::from_str::<Value>(r#"{"useGlab":true,"glabUser":"x","host":"h"}"#).unwrap().as_object().unwrap().clone());
        assert_eq!(connection(Provider::GitLab, &m), Connection::Cli { user: Some("x".into()) });
        assert!(!m.contains_key("useGlab"));
        assert_eq!(for_project(Some("none")), vec![]);
        assert_eq!(for_project(Some("gitlab")), vec![(Provider::GitLab, true)]);
    }

    #[test]
    fn project_status() {
        let mut i = ProjectCodeHost { remote: None, detected: None, choice: "none".into(), effective: None };
        assert_eq!(project_status_line(&i), "Turned off for this project.");
        i.choice = "auto".into();
        assert!(project_status_line(&i).starts_with("No origin remote"));
        i.remote = Some("gitlab.com/g/p".into());
        assert!(project_status_line(&i).starts_with("No integration matches"));
        i.effective = Some((Provider::GitLab, true, Connection::Cli { user: Some("luke".into()) }));
        assert_eq!(project_status_line(&i), "Using GitLab via glab as @luke.");
        i.effective = Some((Provider::GitHub, false, Connection::Cli { user: None }));
        assert_eq!(project_status_line(&i), "GitHub isn't connected — set it up in Settings → Integrations.");
        assert!(same_host("https://GitHub.com/", "github.com"));
    }

    /// Read-only against the real DB + CLIs: `cargo test codehost:: -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn live_smoke() {
        for i in integrations() {
            println!("{i:?}");
        }
        println!("{:?}", branch_status("6de7ca25-c709-4086-b4de-19eb58c21594", "/Users/lukemurray/xysense/xynger", "feature/mcp"));
    }
}
