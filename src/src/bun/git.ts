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

type GitResult = { ok: boolean; stdout: string; stderr: string; exitCode: number };

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
		return { ok: exitCode === 0, stdout, stderr, exitCode };
	} catch (err) {
		// git binary not found / not executable
		return { ok: false, stdout: "", stderr: String(err), exitCode: -1 };
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

export type GitStatusFile = { path: string; x: string; y: string };

export type GitStatus = {
	branch: string | null;
	upstream: string | null;
	ahead: number;
	behind: number;
	files: GitStatusFile[];
	/** path -> line stats vs HEAD (null for binary / unavailable). */
	numstat: Map<string, { insertions: number | null; deletions: number | null }>;
};

/** Working-tree status + branch tracking + per-file line stats for a worktree. */
export async function worktreeStatus(worktreePath: string): Promise<GitStatus> {
	const [statusRes, numstatRes] = await Promise.all([
		git(worktreePath, ["status", "--porcelain=v1", "-b"]),
		git(worktreePath, ["diff", "--numstat", "HEAD"]),
	]);

	let branch: string | null = null;
	let upstream: string | null = null;
	let ahead = 0;
	let behind = 0;
	const files: GitStatusFile[] = [];

	for (const raw of statusRes.stdout.split("\n")) {
		if (raw === "") continue;
		if (raw.startsWith("## ")) {
			const info = raw.slice(3);
			ahead = Number(info.match(/ahead (\d+)/)?.[1] ?? 0);
			behind = Number(info.match(/behind (\d+)/)?.[1] ?? 0);
			const names = info.replace(/\s*\[.*\]$/, "");
			const [head, up] = names.split("...");
			branch = head.trim() === "HEAD (no branch)" ? null : head.trim() || null;
			upstream = up?.trim() ?? null;
			continue;
		}
		const x = raw[0] ?? " ";
		const y = raw[1] ?? " ";
		let path = raw.slice(3);
		const arrow = path.indexOf(" -> "); // renames: "old -> new"
		if (arrow !== -1) path = path.slice(arrow + 4);
		path = path.replace(/^"|"$/g, "");
		files.push({ path, x, y });
	}

	const numstat = new Map<string, { insertions: number | null; deletions: number | null }>();
	if (numstatRes.ok) {
		for (const line of numstatRes.stdout.split("\n")) {
			if (line === "") continue;
			const [adds, dels, ...rest] = line.split("\t");
			const path = rest.join("\t");
			numstat.set(path, {
				insertions: adds === "-" ? null : Number(adds),
				deletions: dels === "-" ? null : Number(dels),
			});
		}
	}

	return { branch, upstream, ahead, behind, files, numstat };
}

/** Local branch names (short form). */
export async function localBranches(repoPath: string): Promise<string[]> {
	const res = await git(repoPath, [
		"branch",
		"--format=%(refname:short)",
	]);
	if (!res.ok) return [];
	return res.stdout
		.split("\n")
		.map((b) => b.trim())
		.filter((b) => b !== "");
}

/** Pick a base branch: the preferred one if it exists, else main/master. */
export async function resolveBaseBranch(
	repoPath: string,
	preferred?: string | null,
): Promise<string | null> {
	const branches = await localBranches(repoPath);
	if (preferred && branches.includes(preferred)) return preferred;
	for (const cand of ["main", "master"]) {
		if (branches.includes(cand)) return cand;
	}
	return null;
}

export type BaseChange = {
	path: string;
	letter: string; // name-status letter: A/M/D/R/C/T or ? (untracked)
	insertions: number | null;
	deletions: number | null;
};

export type WorktreeChanges = {
	base: string | null;
	ahead: number;
	behind: number;
	/** Committed branch work: HEAD vs the merge-base with `base`. */
	committed: BaseChange[];
	/** Working-tree edits vs HEAD, plus untracked files. */
	uncommitted: BaseChange[];
};

function parseChanges(nameStatus: string, numstat: string): BaseChange[] {
	const num = new Map<string, { ins: number | null; del: number | null }>();
	for (const line of numstat.split("\n")) {
		if (line.trim() === "") continue;
		const [a, d, ...rest] = line.split("\t");
		num.set(rest.join("\t"), {
			ins: a === "-" ? null : Number(a),
			del: d === "-" ? null : Number(d),
		});
	}
	const files: BaseChange[] = [];
	for (const line of nameStatus.split("\n")) {
		if (line.trim() === "") continue;
		const parts = line.split("\t");
		const letter = parts[0]?.[0] ?? "M";
		const path = parts[parts.length - 1] ?? "";
		files.push({
			path,
			letter,
			insertions: num.get(path)?.ins ?? null,
			deletions: num.get(path)?.del ?? null,
		});
	}
	return files;
}

/**
 * Two views of a worktree's changes: `uncommitted` (working tree vs HEAD, incl.
 * untracked) and `committed` (HEAD vs the merge-base with `base`). base is null
 * when no comparison branch is available (then `committed` is empty).
 */
export async function worktreeChanges(
	worktreePath: string,
	base: string | null,
): Promise<WorktreeChanges> {
	const [uncNS, uncNum, untracked] = await Promise.all([
		git(worktreePath, ["diff", "--name-status", "-M", "HEAD"]),
		git(worktreePath, ["diff", "--numstat", "-M", "HEAD"]),
		git(worktreePath, ["ls-files", "--others", "--exclude-standard"]),
	]);

	const uncommitted = parseChanges(uncNS.stdout, uncNum.stdout);
	const seen = new Set(uncommitted.map((f) => f.path));
	for (const p of untracked.stdout.split("\n")) {
		const path = p.trim();
		if (path === "" || seen.has(path)) continue;
		uncommitted.push({ path, letter: "?", insertions: null, deletions: null });
	}

	let resolvedBase: string | null = null;
	let ahead = 0;
	let behind = 0;
	let committed: BaseChange[] = [];

	if (base) {
		const mb = await git(worktreePath, ["merge-base", base, "HEAD"]);
		if (mb.ok && mb.stdout.trim() !== "") {
			const mergeBase = mb.stdout.trim();
			resolvedBase = base;
			const [cNS, cNum, counts] = await Promise.all([
				git(worktreePath, ["diff", "--name-status", "-M", mergeBase, "HEAD"]),
				git(worktreePath, ["diff", "--numstat", "-M", mergeBase, "HEAD"]),
				git(worktreePath, ["rev-list", "--count", "--left-right", `${base}...HEAD`]),
			]);
			committed = parseChanges(cNS.stdout, cNum.stdout);
			if (counts.ok) {
				const [b, a] = counts.stdout.trim().split(/\s+/);
				behind = Number(b) || 0;
				ahead = Number(a) || 0;
			}
		}
	}

	return { base: resolvedBase, ahead, behind, committed, uncommitted };
}

export type RawFileDiff = { binary: boolean; text: string };

function isBinaryDiff(text: string): boolean {
	return /^Binary files .* differ$/m.test(text) || text.includes("GIT binary patch");
}

/**
 * Raw unified diff for one file in a worktree (parsed/rendered by the view).
 * Uses `diff HEAD` for tracked changes; falls back to `--no-index` so untracked
 * files show as all-additions.
 */
export async function fileDiff(
	worktreePath: string,
	relPath: string,
	base?: string | null,
): Promise<RawFileDiff> {
	// Committed view (base given): HEAD vs the merge-base — committed branch work.
	if (base) {
		const mb = await git(worktreePath, ["merge-base", base, "HEAD"]);
		if (mb.ok && mb.stdout.trim() !== "") {
			const d = await git(worktreePath, [
				"diff",
				"-M",
				mb.stdout.trim(),
				"HEAD",
				"--",
				relPath,
			]);
			return { binary: isBinaryDiff(d.stdout), text: d.stdout };
		}
		return { binary: false, text: "" };
	}

	// Uncommitted view: working tree vs HEAD.
	const tracked = await git(worktreePath, ["diff", "-M", "HEAD", "--", relPath]);
	if (tracked.ok && tracked.stdout.trim() !== "") {
		return { binary: isBinaryDiff(tracked.stdout), text: tracked.stdout };
	}

	// Untracked file: diff against an empty file. `--no-index` exits 1 when the
	// files differ, which is the normal "there's a diff" case (not an error).
	const untracked = await git(worktreePath, [
		"diff",
		"--no-index",
		"--",
		"/dev/null",
		relPath,
	]);
	if (untracked.exitCode <= 1) {
		return { binary: isBinaryDiff(untracked.stdout), text: untracked.stdout };
	}

	return { binary: false, text: "" };
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
