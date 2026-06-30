/** Minimal GitLab REST client for per-branch MR + pipeline status. */

import type { GitLabBranchStatus } from "../shared/types";
import { parseRemote, remoteUrl } from "./git";

export type GitLabConfig = { host: string; token: string };

/** Normalize a host into a scheme-qualified site URL with no trailing slash. */
function siteUrl(host: string): string {
	let h = host.trim().replace(/\/+$/, "");
	if (!/^https?:\/\//i.test(h)) h = `https://${h}`;
	return h;
}

async function gl<T>(config: GitLabConfig, path: string): Promise<T> {
	const res = await fetch(`${siteUrl(config.host)}/api/v4${path}`, {
		headers: { "PRIVATE-TOKEN": config.token },
	});
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`GitLab ${res.status}${body ? `: ${body.slice(0, 120)}` : ""}`);
	}
	return res.json() as Promise<T>;
}

/** Verify the host + token by fetching the current user. */
export async function testConnection(
	config: GitLabConfig,
): Promise<{ ok: boolean; user?: string; error?: string }> {
	try {
		const u = await gl<{ username: string }>(config, "/user");
		return { ok: true, user: u.username };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/** The GitLab project path (namespace/project) for a repo, if its origin matches the configured host. */
async function projectPathFor(repoPath: string, host: string): Promise<string | null> {
	const url = await remoteUrl(repoPath);
	if (!url) return null;
	const parsed = parseRemote(url);
	if (!parsed) return null;
	const cfgHost = host.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
	if (parsed.host.toLowerCase() !== cfgHost.toLowerCase()) return null;
	return parsed.path;
}

type ApiPipeline = { status: string; web_url: string };
type ApiMR = {
	iid: number;
	title: string;
	state: string;
	web_url: string;
	head_pipeline?: ApiPipeline | null;
};

/** MR + pipeline status for a branch, or null if the repo isn't on this GitLab host. */
export async function branchStatus(
	config: GitLabConfig,
	repoPath: string,
	branch: string,
): Promise<GitLabBranchStatus | null> {
	const path = await projectPathFor(repoPath, config.host);
	if (!path) return null;
	const id = encodeURIComponent(path);
	const projectUrl = `${siteUrl(config.host)}/${path}`;
	try {
		const mrs = await gl<ApiMR[]>(
			config,
			`/projects/${id}/merge_requests?source_branch=${encodeURIComponent(
				branch,
			)}&order_by=updated_at&sort=desc&per_page=1`,
		);
		const mr = mrs[0] ?? null;
		let pipeline = mr?.head_pipeline ?? null;
		if (!pipeline) {
			const pls = await gl<ApiPipeline[]>(
				config,
				`/projects/${id}/pipelines?ref=${encodeURIComponent(branch)}&per_page=1`,
			);
			pipeline = pls[0] ?? null;
		}
		return {
			projectUrl,
			mr: mr ? { iid: mr.iid, title: mr.title, state: mr.state, url: mr.web_url } : null,
			pipeline: pipeline ? { status: pipeline.status, url: pipeline.web_url } : null,
		};
	} catch (err) {
		return {
			projectUrl,
			mr: null,
			pipeline: null,
			error: err instanceof Error ? err.message : String(err),
		};
	}
}
