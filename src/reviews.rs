//! The project's open merge requests / pull requests, sorted by what they need from
//! you: via the same `glab` / `gh` sign-in as the branch status (codehost.rs).
//! GitLab: one GraphQL query (per-reviewer state, unresolved threads, merge status,
//! pipeline). GitHub: `gh pr list --json` (review requests, decision, merge state,
//! checks; no thread counts — "changes requested" stands in).

use std::collections::HashMap;

use serde_json::Value;

use crate::codehost::{self, CheckState, Provider};

/// Is the MR mergeable, as far as the host says?
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Merge {
    Ready,
    Conflicts,
    /// Behind its target and needs a rebase.
    Behind,
    /// Draft, unapproved, unresolved threads, pipeline… (the other fields say which).
    Blocked,
    /// Not computed yet (GitLab computes it lazily).
    Unknown,
}

/// Your part as a reviewer.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum MyReview {
    NotRequested,
    /// Requested and not given yet (or reset by new commits).
    Pending,
    Done,
}

#[derive(Clone, Debug, PartialEq)]
pub struct Mr {
    pub number: u64,
    pub title: String,
    pub url: String,
    pub author: String,
    pub branch: String,
    pub draft: bool,
    pub mine: bool,
    /// A bot's (dependabot, renovate…): nobody else will merge it.
    pub bot: bool,
    pub my_review: MyReview,
    pub approved: bool,
    pub changes_requested: bool,
    pub unresolved: u32,
    pub pipeline: Option<CheckState>,
    pub merge: Merge,
    /// ISO 8601, newest first in each section.
    pub updated_at: String,
    /// The head commit (to skip fetching when it's already here).
    pub head: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Section {
    NeedsYou,
    Ready,
    Mine,
    Others,
}

impl Section {
    pub const ALL: [Section; 4] = [Section::NeedsYou, Section::Ready, Section::Mine, Section::Others];

    pub fn title(self, mrs: &str) -> String {
        match self {
            Section::NeedsYou => "Needs you".into(),
            Section::Ready => "Ready to merge".into(),
            Section::Mine => format!("Your other open {mrs}"),
            Section::Others => format!("Everyone else's {mrs}"),
        }
    }
}

impl Mr {
    /// Why it needs you, most pressing first (empty: it doesn't).
    pub fn needs_you(&self) -> Vec<String> {
        let mut why = vec![];
        // A draft isn't asking for review yet.
        if !self.mine && !self.draft && self.my_review == MyReview::Pending {
            why.push("Review requested".into());
        }
        if self.mine {
            if self.changes_requested {
                why.push("Changes requested".into());
            }
            if self.unresolved > 0 {
                why.push(format!("{} unresolved thread{}", self.unresolved, if self.unresolved == 1 { "" } else { "s" }));
            }
            if self.pipeline == Some(CheckState::Failed) {
                why.push("Pipeline failed".into());
            }
            if self.merge == Merge::Conflicts {
                why.push("Merge conflicts".into());
            }
        }
        why
    }

    /// Approved (or no approval required), checks passed, nothing blocking.
    pub fn ready(&self) -> bool {
        let checks_ok = matches!(self.pipeline, None | Some(CheckState::Success));
        // GitLab often reports "unchecked" until someone opens the MR: trust the parts.
        let mergeable = self.merge == Merge::Ready || (self.merge == Merge::Unknown && self.unresolved == 0);
        !self.draft && self.approved && !self.changes_requested && checks_ok && mergeable
    }

    pub fn section(&self) -> Section {
        if !self.needs_you().is_empty() {
            Section::NeedsYou
        } else if (self.mine || self.bot) && self.ready() {
            Section::Ready
        } else if self.mine {
            Section::Mine
        } else {
            Section::Others
        }
    }
}

/// The open MRs for the project's code host. Err: no host matches, it's not
/// connected through its CLI, or the CLI failed (the message says which).
pub fn list(project_id: &str, repo_path: &str) -> Result<(Provider, Vec<Mr>), String> {
    let (p, host, path, cli) = codehost::matched(project_id, repo_path).ok_or("No GitHub or GitLab integration matches this repo's remote — set one up in Settings → Integrations.")?;
    if !cli {
        return Err(format!("{} is connected with a token from the Electron app — switch it to {} in Settings → Integrations.", p.label(), p.cli()));
    }
    let mut mrs = match p {
        Provider::GitLab => gitlab(&host, &path)?,
        Provider::GitHub => github(&host, &path)?,
    };
    mrs.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok((p, mrs))
}

/// Merged MRs/PRs whose source branch is one of `branches`: branch → [(number,
/// head commit)] (a reused branch name can have several). One query.
pub fn merged(project_id: &str, repo_path: &str, branches: &[String]) -> Result<HashMap<String, Vec<(u64, String)>>, String> {
    if branches.is_empty() {
        return Ok(HashMap::new());
    }
    let (p, host, path, cli) = codehost::matched(project_id, repo_path).ok_or("no GitHub or GitLab integration for this repo")?;
    if !cli {
        return Err(format!("{} isn't connected through {}", p.label(), p.cli()));
    }
    let pairs = match p {
        Provider::GitLab => {
            let hostname = codehost::strip_scheme(&codehost::site_url(host.as_str())).to_string();
            // JSON strings are valid GraphQL string literals.
            let q = format!(
                "query={{ project(fullPath: {}) {{ mergeRequests(state: merged, sourceBranches: {}, first: 100) {{ nodes {{ iid sourceBranch diffHeadSha }} }} }} }}",
                Value::from(path.as_str()),
                Value::from(branches.to_vec()),
            );
            let out = codehost::run_cli("glab", &["api", "graphql", "--hostname", &hostname, "-f", &q]).map_err(|e| format!("GitLab via glab: {e}"))?;
            let v: Value = serde_json::from_str(&out).map_err(|_| "GitLab via glab: unexpected response".to_string())?;
            if let Some(e) = v["errors"].get(0) {
                return Err(format!("GitLab: {}", e["message"].as_str().unwrap_or("query failed")));
            }
            parse_merged(&v["data"]["project"]["mergeRequests"]["nodes"], "sourceBranch", "diffHeadSha", "iid")
        }
        Provider::GitHub => {
            let hostname = codehost::bare_host(&host);
            let repo = if hostname == "github.com" { path.clone() } else { format!("{hostname}/{path}") };
            // ponytail: last 500 merged PRs; older merged worktrees fall back to the git-only check.
            let out = codehost::run_cli("gh", &["pr", "list", "--repo", &repo, "--state", "merged", "--limit", "500", "--json", "number,headRefName,headRefOid"])
                .map_err(|e| format!("GitHub via gh: {e}"))?;
            let v: Value = serde_json::from_str(&out).map_err(|_| "GitHub via gh: unexpected response".to_string())?;
            parse_merged(&v, "headRefName", "headRefOid", "number")
        }
    };
    let mut by: HashMap<String, Vec<(u64, String)>> = HashMap::new();
    for (b, n, sha) in pairs.into_iter().filter(|(b, ..)| branches.contains(b)) {
        by.entry(b).or_default().push((n, sha));
    }
    Ok(by)
}

/// (branch, number, head sha) from either host's list; the number may be a string (GitLab iid).
fn parse_merged(list: &Value, branch: &str, sha: &str, number: &str) -> Vec<(String, u64, String)> {
    list.as_array()
        .into_iter()
        .flatten()
        .filter_map(|m| {
            let n = m[number].as_u64().or_else(|| m[number].as_str()?.parse().ok())?;
            Some((m[branch].as_str()?.to_string(), n, m[sha].as_str()?.to_string()))
        })
        .collect()
}

const GITLAB_QUERY: &str = "query($path: ID!) {
  currentUser { username }
  project(fullPath: $path) {
    mergeRequests(state: opened, first: 100, sort: UPDATED_DESC) {
      nodes {
        iid title webUrl draft sourceBranch diffHeadSha updatedAt approved detailedMergeStatus
        resolvableDiscussionsCount resolvedDiscussionsCount
        author { username bot }
        headPipeline { status }
        reviewers { nodes { username mergeRequestInteraction { reviewState } } }
      }
    }
  }
}";

fn gitlab(host: &str, path: &str) -> Result<Vec<Mr>, String> {
    let hostname = codehost::strip_scheme(&codehost::site_url(host)).to_string();
    let query = format!("query={GITLAB_QUERY}");
    let var = format!("path={path}");
    let out = codehost::run_cli("glab", &["api", "graphql", "--hostname", &hostname, "-f", &query, "-f", &var]).map_err(|e| format!("GitLab via glab: {e}"))?;
    let v: Value = serde_json::from_str(&out).map_err(|_| "GitLab via glab: unexpected response".to_string())?;
    if let Some(e) = v["errors"].get(0) {
        return Err(format!("GitLab: {}", e["message"].as_str().unwrap_or("query failed")));
    }
    Ok(parse_gitlab(&v["data"]))
}

fn parse_gitlab(data: &Value) -> Vec<Mr> {
    let me = data["currentUser"]["username"].as_str().unwrap_or_default();
    let s = |v: &Value, k: &str| v[k].as_str().unwrap_or_default().to_string();
    let nodes = data["project"]["mergeRequests"]["nodes"].as_array().cloned().unwrap_or_default();
    nodes
        .iter()
        .map(|m| {
            let reviewers = m["reviewers"]["nodes"].as_array().cloned().unwrap_or_default();
            let state = |r: &Value| r["mergeRequestInteraction"]["reviewState"].as_str().unwrap_or_default().to_string();
            let my_review = match reviewers.iter().find(|r| r["username"] == me).map(state).as_deref() {
                None => MyReview::NotRequested,
                Some("UNREVIEWED" | "REVIEW_STARTED" | "UNAPPROVED") => MyReview::Pending,
                Some(_) => MyReview::Done,
            };
            // Counts, not the threads themselves: fetching every thread made a busy
            // project's query take ~20s instead of ~2s.
            let count = |k: &str| m[k].as_u64().unwrap_or(0);
            let unresolved = count("resolvableDiscussionsCount").saturating_sub(count("resolvedDiscussionsCount")) as u32;
            let merge = match m["detailedMergeStatus"].as_str().unwrap_or_default() {
                "MERGEABLE" => Merge::Ready,
                "CONFLICT" => Merge::Conflicts,
                "NEED_REBASE" => Merge::Behind,
                "UNCHECKED" | "CHECKING" | "" => Merge::Unknown,
                _ => Merge::Blocked,
            };
            let pipeline = m["headPipeline"]["status"].as_str().map(|st| match st {
                "SUCCESS" => CheckState::Success,
                "FAILED" => CheckState::Failed,
                "RUNNING" | "PENDING" | "CREATED" | "PREPARING" | "WAITING_FOR_RESOURCE" | "SCHEDULED" => CheckState::Running,
                other => CheckState::Other(other.to_lowercase()),
            });
            Mr {
                number: m["iid"].as_str().and_then(|n| n.parse().ok()).unwrap_or(0),
                title: s(m, "title"),
                url: s(m, "webUrl"),
                author: s(&m["author"], "username"),
                branch: s(m, "sourceBranch"),
                draft: m["draft"] == true,
                mine: m["author"]["username"] == me,
                bot: m["author"]["bot"] == true,
                my_review,
                approved: m["approved"] == true,
                changes_requested: reviewers.iter().any(|r| state(r) == "REQUESTED_CHANGES"),
                unresolved,
                pipeline,
                merge,
                updated_at: s(m, "updatedAt"),
                head: s(m, "diffHeadSha"),
            }
        })
        .collect()
}

const GITHUB_FIELDS: &str =
    "number,title,url,author,headRefName,headRefOid,isDraft,reviewDecision,mergeStateStatus,statusCheckRollup,reviewRequests,updatedAt";

fn github(host: &str, slug: &str) -> Result<Vec<Mr>, String> {
    let hostname = codehost::bare_host(host);
    let err = |e: String| format!("GitHub via gh: {e}");
    let me: Value = serde_json::from_str(&codehost::run_cli("gh", &["api", "user", "--hostname", &hostname]).map_err(err)?)
        .map_err(|_| "GitHub via gh: unexpected response".to_string())?;
    let repo = if hostname == "github.com" { slug.to_string() } else { format!("{hostname}/{slug}") };
    let out = codehost::run_cli("gh", &["pr", "list", "--repo", &repo, "--state", "open", "--limit", "100", "--json", GITHUB_FIELDS]).map_err(err)?;
    let prs: Value = serde_json::from_str(&out).map_err(|_| "GitHub via gh: unexpected response".to_string())?;
    Ok(parse_github(&prs, me["login"].as_str().unwrap_or_default()))
}

fn parse_github(prs: &Value, me: &str) -> Vec<Mr> {
    let s = |v: &Value, k: &str| v[k].as_str().unwrap_or_default().to_string();
    prs.as_array()
        .into_iter()
        .flatten()
        .map(|p| {
            let author = s(&p["author"], "login");
            let requested = p["reviewRequests"].as_array().into_iter().flatten().any(|r| r["login"] == me);
            let decision = p["reviewDecision"].as_str().unwrap_or_default();
            let checks: Vec<&str> = p["statusCheckRollup"]
                .as_array()
                .into_iter()
                .flatten()
                .map(|c| c["conclusion"].as_str().filter(|s| !s.is_empty()).or(c["state"].as_str()).or(c["status"].as_str()).unwrap_or_default())
                .collect();
            let pipeline = if checks.is_empty() {
                None
            } else if checks.iter().any(|c| matches!(*c, "FAILURE" | "ERROR" | "TIMED_OUT" | "CANCELLED" | "ACTION_REQUIRED" | "STARTUP_FAILURE")) {
                Some(CheckState::Failed)
            } else if checks.iter().all(|c| matches!(*c, "SUCCESS" | "NEUTRAL" | "SKIPPED")) {
                Some(CheckState::Success)
            } else {
                Some(CheckState::Running)
            };
            let merge = match p["mergeStateStatus"].as_str().unwrap_or_default() {
                "CLEAN" | "HAS_HOOKS" => Merge::Ready,
                "DIRTY" => Merge::Conflicts,
                "BEHIND" => Merge::Behind,
                "UNKNOWN" | "" => Merge::Unknown,
                _ => Merge::Blocked,
            };
            Mr {
                number: p["number"].as_u64().unwrap_or(0),
                title: s(p, "title"),
                url: s(p, "url"),
                bot: author.starts_with("app/") || author.ends_with("[bot]") || p["author"]["is_bot"] == true,
                mine: author == me,
                author: author.strip_prefix("app/").unwrap_or(&author).to_string(),
                branch: s(p, "headRefName"),
                draft: p["isDraft"] == true,
                my_review: if requested { MyReview::Pending } else { MyReview::NotRequested },
                // "" = the repo requires no review.
                approved: matches!(decision, "APPROVED" | ""),
                changes_requested: decision == "CHANGES_REQUESTED",
                unresolved: 0,
                pipeline,
                merge,
                updated_at: s(p, "updatedAt"),
                head: s(p, "headRefOid"),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn mr() -> Mr {
        Mr {
            number: 1,
            title: "t".into(),
            url: String::new(),
            author: "me".into(),
            branch: "b".into(),
            draft: false,
            mine: true,
            bot: false,
            my_review: MyReview::NotRequested,
            approved: true,
            changes_requested: false,
            unresolved: 0,
            pipeline: Some(CheckState::Success),
            merge: Merge::Ready,
            updated_at: String::new(),
            head: String::new(),
        }
    }

    #[test]
    fn sections() {
        assert_eq!(mr().section(), Section::Ready);
        assert_eq!(Mr { unresolved: 2, ..mr() }.needs_you(), ["2 unresolved threads"]);
        assert_eq!(Mr { pipeline: Some(CheckState::Failed), ..mr() }.section(), Section::NeedsYou);
        assert_eq!(Mr { approved: false, ..mr() }.section(), Section::Mine);
        assert_eq!(Mr { draft: true, ..mr() }.section(), Section::Mine);
        assert_eq!(Mr { pipeline: Some(CheckState::Running), ..mr() }.section(), Section::Mine);
        // GitLab's lazy "unchecked" doesn't hide an otherwise-ready MR.
        assert_eq!(Mr { merge: Merge::Unknown, ..mr() }.section(), Section::Ready);
        let theirs = Mr { mine: false, author: "x".into(), ..mr() };
        assert_eq!(theirs.section(), Section::Others);
        assert_eq!(Mr { my_review: MyReview::Pending, ..theirs.clone() }.needs_you(), ["Review requested"]);
        assert_eq!(Mr { my_review: MyReview::Done, ..theirs.clone() }.section(), Section::Others);
        assert_eq!(Mr { my_review: MyReview::Pending, draft: true, ..theirs.clone() }.section(), Section::Others);
        // Their unresolved threads aren't yours to answer.
        assert_eq!(Mr { unresolved: 3, ..theirs.clone() }.section(), Section::Others);
        assert_eq!(Mr { bot: true, ..theirs }.section(), Section::Ready);
    }

    #[test]
    fn parses_merged() {
        let gl = serde_json::json!([{ "iid": "12", "sourceBranch": "fix/a", "diffHeadSha": "abc" }, { "iid": "13", "sourceBranch": null }]);
        assert_eq!(super::parse_merged(&gl, "sourceBranch", "diffHeadSha", "iid"), [("fix/a".to_string(), 12, "abc".to_string())]);
        let gh = serde_json::json!([{ "number": 7, "headRefName": "b", "headRefOid": "def" }]);
        assert_eq!(super::parse_merged(&gh, "headRefName", "headRefOid", "number"), [("b".to_string(), 7, "def".to_string())]);
    }

    #[test]
    fn parses_gitlab() {
        let data = json!({
            "currentUser": { "username": "me" },
            "project": { "mergeRequests": { "nodes": [{
                "iid": "7", "title": "T", "webUrl": "u", "draft": false, "sourceBranch": "b", "updatedAt": "2026",
                "approved": false, "detailedMergeStatus": "DISCUSSIONS_NOT_RESOLVED",
                "author": { "username": "them", "bot": false },
                "headPipeline": { "status": "FAILED" },
                "resolvableDiscussionsCount": 3, "resolvedDiscussionsCount": 2,
                "reviewers": { "nodes": [{ "username": "me", "mergeRequestInteraction": { "reviewState": "UNAPPROVED" } },
                                         { "username": "x", "mergeRequestInteraction": { "reviewState": "REQUESTED_CHANGES" } }] }
            }]}}
        });
        let m = &parse_gitlab(&data)[0];
        assert_eq!((m.number, m.mine, m.my_review, m.unresolved, m.changes_requested), (7, false, MyReview::Pending, 1, true));
        assert_eq!((m.merge, m.pipeline.clone()), (Merge::Blocked, Some(CheckState::Failed)));
        assert_eq!(m.section(), Section::NeedsYou);
    }

    #[test]
    fn parses_github() {
        let prs = json!([
            { "number": 5, "title": "Bump", "url": "u", "author": { "login": "app/dependabot", "is_bot": true }, "headRefName": "dep",
              "isDraft": false, "reviewDecision": "", "mergeStateStatus": "CLEAN", "updatedAt": "2026",
              "statusCheckRollup": [{ "conclusion": "SUCCESS" }], "reviewRequests": [] },
            { "number": 6, "title": "Mine", "url": "u", "author": { "login": "me" }, "headRefName": "f",
              "isDraft": false, "reviewDecision": "CHANGES_REQUESTED", "mergeStateStatus": "BLOCKED", "updatedAt": "2026",
              "statusCheckRollup": [{ "status": "IN_PROGRESS", "conclusion": "" }], "reviewRequests": [] }
        ]);
        let v = parse_github(&prs, "me");
        assert_eq!((v[0].bot, v[0].author.as_str(), v[0].section()), (true, "dependabot", Section::Ready));
        assert_eq!((v[1].pipeline.clone(), v[1].section()), (Some(CheckState::Running), Section::NeedsYou));
        assert_eq!(v[1].needs_you(), ["Changes requested"]);
    }
}
