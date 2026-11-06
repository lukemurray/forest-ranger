/** Minimal GitHub REST client for per-branch pull-request + checks status. */

import type { BranchIntegrations } from "../shared/types";
import { execFile } from "node:child_process";
import { AUGMENTED_PATH, parseRemote, remoteUrl } from "./git";

export type GitHubConfig = {
	host: string;
	token: string;
	/** Make calls through the `gh` CLI with its own login (no token here). */
	viaCli?: boolean;
	/** Per-project override: use this integration even if origin's host differs
	 *  (SSH alias, custom domain) — take the repo path from origin as-is. */
	forceHost?: boolean;
};

/** Bare host (no scheme) for matching remotes, e.g. "github.com". */
function bareHost(host: string): string {
	return host.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();
}

/** REST API base for github.com vs GitHub Enterprise. */
function apiBase(host: string): string {
	const h = bareHost(host);
	return h === "github.com" ? "https://api.github.com" : `https://${h}/api/v3`;
}

/**
 * Call the API through `gh api`, using the user's existing gh login — gh picks and
 * refreshes the token, so nothing is set up on GitHub and no token is stored here.
 */
function ghCli<T>(config: GitHubConfig, path: string, body?: unknown): Promise<T> {
	const args = ["api", path.replace(/^\//, ""), "--hostname", bareHost(config.host)];
	if (body) args.push("--method", "POST", "--input", "-");
	return new Promise<T>((resolve, reject) => {
		const proc = execFile(
			"gh",
			args,
			// Dock-launched apps don't get the shell's PATH (gh lives in /opt/homebrew/bin).
			{ env: { ...process.env, PATH: AUGMENTED_PATH, GH_PROMPT_DISABLED: "1" }, maxBuffer: 32 * 1024 * 1024, timeout: 30_000 },
			(err, stdout, stderr) => {
				if (err) {
					const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
					const why = missing
						? "gh isn't installed (brew install gh)"
						: (stderr || err.message).trim().split("\n").pop();
					reject(new Error(`GitHub via gh: ${why}`));
					return;
				}
				try {
					resolve(JSON.parse(stdout) as T);
				} catch {
					reject(new Error("GitHub via gh: unexpected response"));
				}
			},
		);
		proc.stdin?.end(body ? JSON.stringify(body) : undefined);
	});
}

async function gh<T>(config: GitHubConfig, path: string, body?: unknown): Promise<T> {
	if (config.viaCli) return ghCli<T>(config, path, body);
	const res = await fetch(`${apiBase(config.host)}${path}`, {
		method: body ? "POST" : "GET",
		headers: {
			Authorization: `Bearer ${config.token}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			...(body ? { "Content-Type": "application/json" } : {}),
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	if (!res.ok) {
		const raw = await res.text().catch(() => "");
		// GitHub errors are JSON {message, errors:[{message}]}; surface the useful bit.
		let msg = raw.slice(0, 160);
		try {
			const j = JSON.parse(raw);
			msg = j.errors?.[0]?.message || j.message || msg;
		} catch {
			// non-JSON body
		}
		throw new Error(`GitHub ${res.status}${msg ? `: ${msg}` : ""}`);
	}
	return res.json() as Promise<T>;
}

/** Verify the host + token by fetching the current user. */
export async function testConnection(
	config: GitHubConfig,
): Promise<{ ok: boolean; user?: string; error?: string }> {
	try {
		const u = await gh<{ login: string }>(config, "/user");
		return { ok: true, user: u.login };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/** owner/repo for a repo whose origin is on the configured GitHub host (or any host
 *  when forced by a project override), else null. */
async function repoSlug(repoPath: string, host: string, force = false): Promise<string | null> {
	const url = await remoteUrl(repoPath);
	if (!url) return null;
	const parsed = parseRemote(url);
	if (!parsed) return null;
	if (!force && parsed.host.toLowerCase() !== bareHost(host)) return null;
	return parsed.path; // "owner/repo"
}

const checkState = (s: string) =>
	s === "success" ? "success" : s === "failure" || s === "error" ? "failed" : s === "pending" ? "pending" : s;

type ApiPull = { number: number; title: string; state: string; html_url: string; merged_at: string | null };
type ApiStatus = { state: string; total_count: number };

/** Open a pull request from `branch` into `base`. Repo must be on this GitHub host. */
export async function createRequest(
	config: GitHubConfig,
	repoPath: string,
	branch: string,
	base: string,
	title: string,
): Promise<{ ok: boolean; url?: string; number?: number; error?: string } | null> {
	const slug = await repoSlug(repoPath, config.host, config.forceHost);
	if (!slug) return null;
	try {
		const pr = await gh<ApiPull>(config, `/repos/${slug}/pulls`, {
			title,
			head: branch,
			base,
		});
		return { ok: true, url: pr.html_url, number: pr.number };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/** PR + checks status for a branch, or null if the repo isn't on this GitHub host. */
export async function branchStatus(
	config: GitHubConfig,
	repoPath: string,
	branch: string,
): Promise<BranchIntegrations | null> {
	const slug = await repoSlug(repoPath, config.host, config.forceHost);
	if (!slug) return null;
	const [owner] = slug.split("/");
	const siteHost = bareHost(config.host);
	const projectUrl = `https://${siteHost}/${slug}`;
	try {
		const pulls = await gh<ApiPull[]>(
			config,
			`/repos/${slug}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=all&sort=updated&direction=desc&per_page=1`,
		);
		const pr = pulls[0] ?? null;
		// Combined commit status for the branch tip (empty total_count = no checks).
		let checks: BranchIntegrations["checks"] = null;
		try {
			const st = await gh<ApiStatus>(config, `/repos/${slug}/commits/${encodeURIComponent(branch)}/status`);
			if (st.total_count > 0) {
				checks = { status: checkState(st.state), url: pr?.html_url ?? projectUrl };
			}
		} catch {
			// checks are best-effort
		}
		return {
			provider: "github",
			projectUrl,
			request: pr
				? {
						number: pr.number,
						title: pr.title,
						state: pr.merged_at ? "merged" : pr.state,
						url: pr.html_url,
					}
				: null,
			checks,
		};
	} catch (err) {
		return {
			provider: "github",
			projectUrl,
			request: null,
			checks: null,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}
