/** Thin wrapper around the `git` CLI for worktree discovery. */

import { statSync } from "node:fs";
import { join } from "node:path";

// A macOS GUI app inherits the minimal launchd PATH, which can omit the user's
// git. Augment it with the usual locations so `git` resolves when launched as a
// bundled app (not just from a dev terminal).
const AUGMENTED_PATH = [
	process.env.PATH ?? "",
	"/usr/bin",
	"/bin",
	"/usr/local/bin",
	"/opt/homebrew/bin",
]
	.filter(Boolean)
	.join(":");

type GitResult = { ok: boolean; stdout: string; stderr: string };

// Async (not spawnSync) so independent git invocations can run concurrently —
// scanning N worktrees fans out instead of blocking the bun thread one at a time.
async function git(cwd: string, args: string[]): Promise<GitResult> {
	try {
		const proc = Bun.spawn(["git", ...args], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, PATH: AUGMENTED_PATH },
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { ok: exitCode === 0, stdout, stderr };
	} catch (err) {
		// git binary not found / not executable
		return { ok: false, stdout: "", stderr: String(err) };
	}
}

/** Returns the git version string, or null if the git binary can't be run. */
export async function gitVersion(): Promise<string | null> {
	const res = await git(process.cwd(), ["--version"]);
	return res.ok ? res.stdout.trim() : null;
}

/**
 * Resolve a chosen folder to its repo toplevel.
 * Returns null when the path is not inside a git repository.
 */
export async function resolveRepoToplevel(path: string): Promise<string | null> {
	const res = await git(path, ["rev-parse", "--show-toplevel"]);
	if (!res.ok) {
		console.log(`[git] rev-parse failed for ${path}: ${res.stderr.trim()}`);
		return null;
	}
	const top = res.stdout.trim();
	return top.length > 0 ? top : null;
}

/**
 * Short-lived cache for worktree activity. A single UI action can trigger several
 * loader refetches in quick succession; without this each one would re-run
 * `git log` + `git status` for every worktree. Caches the in-flight promise so
 * concurrent callers share one computation.
 */
const ACTIVITY_TTL_MS = 30_000;
const activityCache = new Map<string, { value: Promise<number>; expires: number }>();

/**
 * Last time real work happened in a worktree, as a ms timestamp: the most recent
 * of HEAD's commit time and the mtime of any uncommitted/untracked change.
 * Cached for {@link ACTIVITY_TTL_MS}. Returns 0 when it can't be determined.
 */
export function worktreeActivity(worktreePath: string): Promise<number> {
	const cached = activityCache.get(worktreePath);
	const nowMs = Date.now();
	if (cached && cached.expires > nowMs) return cached.value;

	const value = computeWorktreeActivity(worktreePath);
	activityCache.set(worktreePath, { value, expires: nowMs + ACTIVITY_TTL_MS });
	// If the computation fails, don't poison the cache with a rejected promise.
	value.catch(() => activityCache.delete(worktreePath));
	return value;
}

async function computeWorktreeActivity(worktreePath: string): Promise<number> {
	// HEAD commit time and working-tree status are independent — fetch in parallel.
	const [log, status] = await Promise.all([
		git(worktreePath, ["log", "-1", "--format=%ct"]),
		git(worktreePath, ["status", "--porcelain"]),
	]);

	let latest = 0;
	if (log.ok) {
		const sec = Number.parseInt(log.stdout.trim(), 10);
		if (!Number.isNaN(sec)) latest = sec * 1000;
	}

	// Uncommitted/untracked changes (git status respects .gitignore, so the file
	// list stays bounded). Take the newest mtime among them.
	if (status.ok) {
		for (const line of status.stdout.split("\n")) {
			if (line.trim() === "") continue;
			let rel = line.slice(3).trim();
			const arrow = rel.indexOf(" -> "); // renames: "old -> new"
			if (arrow !== -1) rel = rel.slice(arrow + 4);
			rel = rel.replace(/^"|"$/g, ""); // git quotes paths with special chars
			try {
				const m = statSync(join(worktreePath, rel)).mtimeMs;
				if (m > latest) latest = m;
			} catch {
				// deleted file or unreadable — ignore
			}
		}
	}

	return latest;
}

export type GitWorktree = {
	path: string;
	head: string | null;
	branch: string | null;
	isDetached: boolean;
	isLocked: boolean;
	isBare: boolean;
};

/**
 * Parse `git worktree list --porcelain` into structured entries.
 * Porcelain output is newline-delimited records separated by blank lines:
 *   worktree /abs/path
 *   HEAD <sha>
 *   branch refs/heads/<name>   (or `detached`)
 *   locked / bare              (optional flags)
 */
export async function listWorktrees(repoPath: string): Promise<GitWorktree[]> {
	const res = await git(repoPath, ["worktree", "list", "--porcelain"]);
	if (!res.ok) return [];

	const entries: GitWorktree[] = [];
	let current: GitWorktree | null = null;

	const flush = () => {
		if (current) entries.push(current);
		current = null;
	};

	for (const rawLine of res.stdout.split("\n")) {
		const line = rawLine.trimEnd();
		if (line === "") {
			flush();
			continue;
		}
		if (line.startsWith("worktree ")) {
			flush();
			current = {
				path: line.slice("worktree ".length),
				head: null,
				branch: null,
				isDetached: false,
				isLocked: false,
				isBare: false,
			};
		} else if (!current) {
			continue;
		} else if (line.startsWith("HEAD ")) {
			current.head = line.slice("HEAD ".length);
		} else if (line.startsWith("branch ")) {
			current.branch = line
				.slice("branch ".length)
				.replace(/^refs\/heads\//, "");
		} else if (line === "detached") {
			current.isDetached = true;
		} else if (line === "bare") {
			current.isBare = true;
		} else if (line === "locked" || line.startsWith("locked ")) {
			current.isLocked = true;
		}
	}
	flush();

	return entries;
}
