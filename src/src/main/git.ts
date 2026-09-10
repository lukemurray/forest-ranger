/** Thin wrapper around the `git` CLI for worktree discovery. */

import { spawn } from "node:child_process";
import { existsSync, rmSync, statSync } from "node:fs";
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
// Never let a network git op (fetch) block on an interactive prompt — a GUI
// process has no TTY, so a credential/passphrase/host-key prompt would hang
// forever. These make git fail fast instead. SSH keys in the agent and the
// macOS keychain credential helper still work (those aren't terminal prompts).
const GIT_ENV: Record<string, string> = {
	...(process.env as Record<string, string>),
	PATH: AUGMENTED_PATH,
	GIT_TERMINAL_PROMPT: "0",
	GIT_SSH_COMMAND:
		process.env.GIT_SSH_COMMAND ??
		"ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10",
};

function git(
	cwd: string,
	args: string[],
	opts?: { timeoutMs?: number },
): Promise<GitResult> {
	return new Promise((resolve) => {
		let proc: ReturnType<typeof spawn>;
		try {
			proc = spawn("git", args, { cwd, env: GIT_ENV });
		} catch (err) {
			// git binary not found / not executable
			resolve({ ok: false, stdout: "", stderr: String(err), exitCode: -1 });
			return;
		}

		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;

		proc.stdout?.on("data", (d: Buffer) => {
			stdout += d.toString();
		});
		proc.stderr?.on("data", (d: Buffer) => {
			stderr += d.toString();
		});

		const timer = opts?.timeoutMs
			? setTimeout(() => {
					timedOut = true;
					try {
						proc.kill();
					} catch {
						// already exited
					}
				}, opts.timeoutMs)
			: undefined;

		proc.on("error", (err) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve({ ok: false, stdout: "", stderr: String(err), exitCode: -1 });
		});

		proc.on("close", (code) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			if (timedOut) {
				resolve({ ok: false, stdout, stderr: "timed out", exitCode: -1 });
				return;
			}
			const exitCode = code ?? -1;
			resolve({ ok: exitCode === 0, stdout, stderr, exitCode });
		});
	});
}

/** The most recent commits on `ref` (newest first): short hash, subject, relative time. */
export async function recentCommits(
	repoPath: string,
	ref: string,
	limit: number,
): Promise<{ hash: string; subject: string; author: string; relative: string }[]> {
	const res = await git(repoPath, [
		"log",
		`-n${limit}`,
		"--format=%h%x00%s%x00%an%x00%cr",
		ref,
	]);
	if (!res.ok) return [];
	return res.stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [hash, subject, author, relative] = line.split("\0");
			return { hash, subject, author, relative };
		});
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

/**
 * Local branches plus remote-only branches (as `origin/foo`), for base-branch
 * pickers. Remote branches that already have a local counterpart are dropped so
 * the local name wins; this is how new origin branches become selectable.
 */
export async function listBranches(repoPath: string): Promise<string[]> {
	const [localRes, remoteRes] = await Promise.all([
		git(repoPath, ["branch", "--format=%(refname:short)"]),
		git(repoPath, ["branch", "-r", "--format=%(refname:short)"]),
	]);
	const local = (localRes.ok ? localRes.stdout : "")
		.split("\n")
		.map((b) => b.trim())
		.filter(Boolean);
	const localSet = new Set(local);
	const remoteOnly = (remoteRes.ok ? remoteRes.stdout : "")
		.split("\n")
		.map((b) => b.trim())
		.filter((b) => b && !b.includes("->") && b.startsWith("origin/"))
		.filter((b) => !localSet.has(b.slice("origin/".length)));
	return [...local, ...remoteOnly];
}

/**
 * Every branch across local refs and origin, with whether it exists in each and
 * its most recent commit time. One `for-each-ref` covers both; a branch present
 * in both places is merged into a single entry.
 */
export type BranchGraphEntry = {
	name: string;
	local: boolean;
	remote: boolean;
	lastCommitAt: number | null;
	/** Commits ahead / behind the base branch (master/main); null if unknown. */
	ahead: number | null;
	behind: number | null;
	/** The base branch these counts are measured against. */
	base: string | null;
};

export async function branchGraph(repoPath: string): Promise<BranchGraphEntry[]> {
	const base = await resolveBaseBranch(repoPath, null);
	// git 2.41+ computes ahead/behind per-ref in one pass; `|`-delimited so a
	// missing/older ahead-behind field just parses as empty.
	const abField = base ? `%(ahead-behind:${base})` : "";
	const res = await git(repoPath, [
		"for-each-ref",
		`--format=%(refname)|%(committerdate:unix)|${abField}`,
		"refs/heads/",
		"refs/remotes/origin/",
	]);
	if (!res.ok) return [];
	type Acc = {
		local: boolean;
		remote: boolean;
		lastCommitAt: number | null;
		ahead: number | null;
		behind: number | null;
	};
	const map = new Map<string, Acc>();
	for (const raw of res.stdout.split("\n")) {
		const line = raw.trimEnd();
		if (!line) continue;
		const [refname, dateStr, abStr] = line.split("|");
		let name: string;
		let isLocal: boolean;
		if (refname.startsWith("refs/heads/")) {
			name = refname.slice("refs/heads/".length);
			isLocal = true;
		} else if (refname.startsWith("refs/remotes/origin/")) {
			name = refname.slice("refs/remotes/origin/".length);
			if (name === "HEAD") continue; // origin/HEAD is a symref, not a branch
			isLocal = false;
		} else {
			continue;
		}
		const cur = map.get(name) ?? {
			local: false,
			remote: false,
			lastCommitAt: null,
			ahead: null,
			behind: null,
		};
		if (isLocal) cur.local = true;
		else cur.remote = true;
		const ts = Number(dateStr);
		const ms = Number.isFinite(ts) ? ts * 1000 : null;
		if (ms != null && (cur.lastCommitAt == null || ms > cur.lastCommitAt)) {
			cur.lastCommitAt = ms;
		}
		// Prefer the local ref's divergence; fall back to origin's if local-absent.
		const ab = (abStr ?? "").trim().split(/\s+/);
		const a = Number(ab[0]);
		const b = Number(ab[1]);
		if ((isLocal || cur.ahead == null) && Number.isFinite(a) && Number.isFinite(b)) {
			cur.ahead = a;
			cur.behind = b;
		}
		map.set(name, cur);
	}
	return [...map.entries()].map(([name, v]) => ({ name, ...v, base }));
}

/** Pick a base branch: the preferred one if it's a real ref, else main/master. */
export async function resolveBaseBranch(
	repoPath: string,
	preferred?: string | null,
): Promise<string | null> {
	if (preferred) {
		// Accept any resolvable ref so remote branches (origin/foo) work too.
		const ok = await git(repoPath, ["rev-parse", "--verify", "--quiet", preferred]);
		if (ok.ok && ok.stdout.trim() !== "") return preferred;
	}
	const branches = await localBranches(repoPath);
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
	/** uncommitted only: whether the file has staged changes in the index. */
	staged?: boolean;
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
	const [uncNS, uncNum, untracked, stagedNames] = await Promise.all([
		git(worktreePath, ["diff", "--name-status", "-M", "HEAD"]),
		git(worktreePath, ["diff", "--numstat", "-M", "HEAD"]),
		git(worktreePath, ["ls-files", "--others", "--exclude-standard"]),
		git(worktreePath, ["diff", "--cached", "--name-only", "HEAD"]),
	]);

	const stagedSet = new Set(
		stagedNames.stdout.split("\n").map((p) => p.trim()).filter(Boolean),
	);
	const uncommitted = parseChanges(uncNS.stdout, uncNum.stdout);
	for (const f of uncommitted) f.staged = stagedSet.has(f.path);
	const seen = new Set(uncommitted.map((f) => f.path));
	for (const p of untracked.stdout.split("\n")) {
		const path = p.trim();
		if (path === "" || seen.has(path)) continue;
		uncommitted.push({ path, letter: "?", insertions: null, deletions: null, staged: false });
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

/** Stage the given paths (git add), or everything when `paths` is empty. */
export async function stageFiles(
	worktreePath: string,
	paths: string[],
): Promise<{ ok: boolean; error?: string }> {
	const args = paths.length ? ["add", "--", ...paths] : ["add", "-A"];
	const r = await git(worktreePath, args);
	return r.ok ? { ok: true } : { ok: false, error: r.stderr.trim() || "stage failed" };
}

/** Unstage the given paths, or everything when `paths` is empty. */
export async function unstageFiles(
	worktreePath: string,
	paths: string[],
): Promise<{ ok: boolean; error?: string }> {
	const args = paths.length
		? ["restore", "--staged", "--", ...paths]
		: ["reset", "--quiet", "HEAD", "--"];
	const r = await git(worktreePath, args);
	return r.ok ? { ok: true } : { ok: false, error: r.stderr.trim() || "unstage failed" };
}

/** Commit the staged index with `message`. */
export async function commit(
	worktreePath: string,
	message: string,
): Promise<{ ok: boolean; error?: string }> {
	const r = await git(worktreePath, ["commit", "-m", message]);
	return r.ok ? { ok: true } : { ok: false, error: r.stderr.trim() || "commit failed" };
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

/** How far a local branch is ahead/behind its `origin/<branch>` (no fetch). */
export async function branchTracking(
	repoPath: string,
	branch: string,
): Promise<{ ahead: number; behind: number; hasRemote: boolean }> {
	const remote = `origin/${branch}`;
	const exists = await git(repoPath, ["rev-parse", "--verify", "--quiet", remote]);
	if (!exists.ok || exists.stdout.trim() === "") {
		return { ahead: 0, behind: 0, hasRemote: false };
	}
	const res = await git(repoPath, [
		"rev-list",
		"--count",
		"--left-right",
		`${branch}...${remote}`,
	]);
	let ahead = 0;
	let behind = 0;
	if (res.ok) {
		const [a, b] = res.stdout.trim().split(/\s+/);
		ahead = Number(a) || 0;
		behind = Number(b) || 0;
	}
	return { ahead, behind, hasRemote: true };
}

/**
 * Fetch from origin and fast-forward the local `branch` to `origin/branch`.
 * Uses a refspec so the branch updates without being checked out; if it's
 * currently checked out (or non-FF), falls back to a plain fetch so the
 * remote-tracking ref is still current for the behind count.
 */
export async function fetchProject(
	repoPath: string,
	branch: string | null,
): Promise<{ ok: boolean; error?: string }> {
	// Update all remote-tracking refs and prune deleted ones — this is what makes
	// the behind count accurate and surfaces new/removed origin branches. Bounded
	// so a stalled connection can't hang the action.
	const t0 = Date.now();
	console.log(`[fetch] start ${repoPath} (branch=${branch ?? "—"})`);
	const fetched = await git(repoPath, ["fetch", "origin", "--prune"], { timeoutMs: 30_000 });
	console.log(
		`[fetch] origin --prune: ok=${fetched.ok} exit=${fetched.exitCode} ${Date.now() - t0}ms` +
			(fetched.stderr.trim() ? ` stderr=${fetched.stderr.trim().slice(0, 300)}` : ""),
	);
	if (!fetched.ok) {
		const err = fetched.stderr.trim();
		return {
			ok: false,
			error: err === "timed out" ? "Fetch timed out — check your network or credentials." : err || "fetch failed",
		};
	}
	// Best-effort fast-forward the local default branch to match origin. How depends
	// on whether it's checked out: `git fetch origin b:b` refuses to write a ref that's
	// checked out in a worktree, so for that case we fast-forward *through* the worktree
	// with `merge --ff-only`. A diverged branch (not fast-forwardable) is left alone.
	if (branch) {
		const worktrees = await listWorktrees(repoPath);
		const checkedOut = worktrees.find((w) => w.branch === branch);
		const ff = checkedOut
			? await git(checkedOut.path, ["merge", "--ff-only", `origin/${branch}`], { timeoutMs: 20_000 })
			: await git(repoPath, ["fetch", "origin", `${branch}:${branch}`], { timeoutMs: 20_000 });
		console.log(
			`[fetch] ff ${branch} (${checkedOut ? "worktree" : "ref"}): ok=${ff.ok} exit=${ff.exitCode}` +
				(ff.stderr.trim() ? ` stderr=${ff.stderr.trim().slice(0, 200)}` : ""),
		);
	}
	console.log(`[fetch] done ${Date.now() - t0}ms`);
	return { ok: true };
}

/** Remove a worktree (`--force` discards uncommitted/untracked changes). */
export async function removeWorktree(
	repoPath: string,
	worktreePath: string,
	force: boolean,
): Promise<{ ok: boolean; error?: string }> {
	const args = ["worktree", "remove"];
	if (force) args.push("--force");
	args.push(worktreePath);
	const r = await git(repoPath, args);
	if (r.ok) return { ok: true };

	// The worktree may be broken (e.g. its `.git` link is missing) or locked, in
	// which case `git worktree remove` refuses to validate it. Retry with a
	// double `--force` to override locks/validation, then fall back to pruning
	// the stale registration and clearing any leftover directory.
	const r2 = await git(repoPath, ["worktree", "remove", "--force", "--force", worktreePath]);
	if (r2.ok) return { ok: true };

	await git(repoPath, ["worktree", "prune"]);
	const list = await git(repoPath, ["worktree", "list", "--porcelain"]);
	const stillRegistered = list.stdout
		.split("\n")
		.some((line) => line.trim() === `worktree ${worktreePath}`);
	if (stillRegistered) {
		return { ok: false, error: r.stderr.trim() || r2.stderr.trim() || "git worktree remove failed" };
	}

	// Registration is gone; remove the leftover directory if it's still on disk.
	try {
		if (worktreePath !== repoPath && existsSync(worktreePath)) {
			rmSync(worktreePath, { recursive: true, force: true });
		}
	} catch {
		// best effort — the registration is already cleared
	}
	return { ok: true };
}

/** The upstream/tracking branch for a local branch (e.g. `origin/foo`), or null. */
export async function branchUpstream(
	repoPath: string,
	branch: string,
): Promise<string | null> {
	const r = await git(repoPath, ["rev-parse", "--abbrev-ref", `${branch}@{upstream}`]);
	return r.ok && r.stdout.trim() ? r.stdout.trim() : null;
}

/** The `origin` remote URL (or the first remote's), or null if none. */
export async function remoteUrl(repoPath: string): Promise<string | null> {
	const origin = await git(repoPath, ["remote", "get-url", "origin"]);
	if (origin.ok && origin.stdout.trim()) return origin.stdout.trim();
	const remotes = await git(repoPath, ["remote"]);
	const first = remotes.stdout.split("\n").map((s) => s.trim()).filter(Boolean)[0];
	if (!first) return null;
	const url = await git(repoPath, ["remote", "get-url", first]);
	return url.ok ? url.stdout.trim() || null : null;
}

/** Parse a git remote URL into host + project path (handles scp-like and URL forms). */
export function parseRemote(url: string): { host: string; path: string } | null {
	const u = url.trim();
	const strip = (p: string) => p.replace(/\.git$/, "").replace(/^\//, "");
	// scp-like: git@host:group/project.git
	const scp = u.match(/^[\w.+-]+@([^:]+):(.+)$/);
	if (scp) return { host: scp[1], path: strip(scp[2]) };
	// scheme://[user@]host[:port]/group/project(.git)
	const m = u.match(/^[a-z][\w+.-]*:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/i);
	if (m) return { host: m[1].replace(/:\d+$/, ""), path: strip(m[2]) };
	return null;
}

/** Force-delete a local branch. */
/** Bring a worktree's branch up to date with `base` by rebasing or merging it in. */
export async function updateFromBase(
	worktreePath: string,
	base: string,
	mode: "rebase" | "merge",
): Promise<{ ok: boolean; error?: string }> {
	const args =
		mode === "rebase" ? ["rebase", base] : ["merge", "--no-edit", base];
	const res = await git(worktreePath, args, { timeoutMs: 120_000 });
	if (res.ok) return { ok: true };
	// A conflicted rebase/merge leaves the worktree mid-operation; surface it so the
	// user can resolve in their editor/terminal (we don't try to auto-resolve).
	return { ok: false, error: res.stderr.trim() || `${mode} failed` };
}

/** Push the current branch to origin, setting upstream if it has none. */
export async function pushBranch(
	worktreePath: string,
): Promise<{ ok: boolean; error?: string }> {
	// `HEAD` resolves to the current branch; -u makes origin/<branch> its upstream.
	const res = await git(worktreePath, ["push", "-u", "origin", "HEAD"], {
		timeoutMs: 120_000,
	});
	return res.ok ? { ok: true } : { ok: false, error: res.stderr.trim() || "push failed" };
}

export async function renameBranch(
	repoPath: string,
	from: string,
	to: string,
): Promise<{ ok: boolean; error?: string }> {
	const r = await git(repoPath, ["branch", "-m", from, to]);
	return r.ok ? { ok: true } : { ok: false, error: r.stderr.trim() || "rename failed" };
}

export async function deleteBranch(
	repoPath: string,
	branch: string,
	force = false,
): Promise<{ ok: boolean; error?: string }> {
	// -d refuses to delete a branch not merged into its upstream/HEAD; -D forces.
	const r = await git(repoPath, ["branch", force ? "-D" : "-d", branch]);
	return r.ok ? { ok: true } : { ok: false, error: r.stderr.trim() };
}

/** Create a new worktree at `worktreePath` on a new `branch` off `base`. */
export async function addWorktree(
	repoPath: string,
	worktreePath: string,
	branch: string,
	base: string | null,
	detach = false,
): Promise<{ ok: boolean; error?: string }> {
	// Detached checkout at `branch` (a ref): read-only review of any branch, even
	// one already checked out elsewhere or existing only on origin — no conflict.
	if (detach) {
		const res = await git(repoPath, ["worktree", "add", "--detach", worktreePath, branch]);
		return res.ok
			? { ok: true }
			: { ok: false, error: res.stderr.trim() || "git worktree add failed" };
	}
	// If the branch already exists locally, check it out; otherwise create it off
	// `base` (e.g. `-b foo <path> origin/foo` makes a local `foo` tracking origin).
	const existing = await git(repoPath, [
		"rev-parse",
		"--verify",
		"--quiet",
		`refs/heads/${branch}`,
	]);
	const args =
		existing.ok && existing.stdout.trim() !== ""
			? ["worktree", "add", worktreePath, branch]
			: base
				? ["worktree", "add", worktreePath, "-b", branch, base]
				: ["worktree", "add", worktreePath, "-b", branch];
	const res = await git(repoPath, args);
	return res.ok
		? { ok: true }
		: { ok: false, error: res.stderr.trim() || "git worktree add failed" };
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
