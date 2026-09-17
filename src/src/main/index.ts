import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, safeStorage, screen, shell } from "electron";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type {
	AgentChatEvent,
	ChangedFile,
	ChangeKind,
	IntegrationStatus,
	IntegrationType,
	MainEvent,
	Project,
	ProjectCommand,
	RpcRequests,
	ViewMessage,
	Worktree,
	WorktreeWithProject,
} from "../shared/types";
import { detectApps, openWorktree, runInTerminal } from "./apps";
import {
	kill as termKill,
	killAll as termKillAll,
	resize as termResize,
	setTerminalCallbacks,
	startSession as termStart,
	write as termWrite,
} from "./terminals";
import {
	killAll as agentChatKillAll,
	respondPermission as agentChatRespond,
	resolveElicit as agentChatElicit,
	setPermissionMode as agentChatSetMode,
	setSessionMode as agentChatSetSessionMode,
	setConfigOption as agentChatSetConfigOption,
	cancel as agentChatCancel,
	listChatLogs,
	restart as agentChatRestart,
	send as agentChatSend,
	setAgentChatCallback,
	setAgentStatusCallback,
	startSession as agentChatStart,
	stop as agentChatStop,
} from "./agentChat";
import {
	DATA_DIR,
	commandsRepo,
	integrationsRepo,
	projectsRepo,
	worktreesRepo,
	type CommandRow,
	type ProjectRow,
} from "./db";
import {
	branchStatus as gitlabBranchStatus,
	testConnection as gitlabTest,
} from "./gitlab";
import {
	branchStatus as githubBranchStatus,
	createRequest as githubCreateRequest,
	testConnection as githubTest,
} from "./github";
import { createRequest as gitlabCreateRequest } from "./gitlab";
import {
	addWorktree as gitAddWorktree,
	branchGraph,
	branchTracking,
	branchUpstream,
	deleteBranch as gitDeleteBranch,
	renameBranch as gitRenameBranch,
	updateFromBase as gitUpdateFromBase,
	fetchProject as gitFetchProject,
	fileDiff as gitFileDiff,
	fileContents as gitFileContents,
	listFiles as gitListFiles,
	searchText as gitSearchText,
	readWorkingFile,
	writeWorkingFile,
	commitsVsBase,
	commitFiles as gitCommitFiles,
	recentCommits,
	gitVersion,
	removeWorktree as gitRemoveWorktree,
	listWorktrees as gitListWorktrees,
	listBranches,
	stageFiles as gitStage,
	unstageFiles as gitUnstage,
	commit as gitCommit,
	pushBranch as gitPushBranch,
	worktreeStatus as gitWorktreeStatus,
	resolveBaseBranch,
	resolveRepoToplevel,
	worktreeActivity,
	worktreeChanges,
	type BaseChange,
} from "./git";

const now = () => Date.now();

function worktreeId(projectId: string, path: string): string {
	const hash = createHash("sha1").update(path).digest("hex").slice(0, 12);
	return `${projectId}-${hash}`;
}

function toProject(row: ProjectRow): Project {
	return {
		id: row.id,
		name: row.name,
		path: row.path,
		addedAt: row.added_at,
		lastOpenedAt: row.last_opened_at,
	};
}

function toCommand(row: CommandRow): ProjectCommand {
	return {
		id: row.id,
		projectId: row.project_id,
		label: row.label,
		command: row.command,
		dir: row.dir,
		runTarget:
			row.run_target === "external" || row.run_target === "default"
				? row.run_target
				: "in-app",
	};
}


const KNOWN_INTEGRATIONS: IntegrationType[] = ["github", "gitlab"];
const DEFAULT_HOST: Record<IntegrationType, string> = {
	gitlab: "https://gitlab.com",
	github: "github.com",
};

/** Stored integration config. The token is encrypted at rest via the OS keychain
 * (`tokenEnc`); `tokenPlain` is a fallback when the keychain is unavailable (some
 * Linux setups); `token` is the pre-encryption legacy field, still read for migration. */
type StoredIntegration = {
	host?: string;
	tokenEnc?: string;
	tokenPlain?: string;
	token?: string;
};

/** Encrypt a token for storage via the OS keychain, falling back to plaintext only
 *  when encryption isn't available on this machine. Empty token stores nothing. */
function encryptToken(token: string): Pick<StoredIntegration, "tokenEnc" | "tokenPlain"> {
	if (!token) return {};
	if (safeStorage.isEncryptionAvailable()) {
		return { tokenEnc: safeStorage.encryptString(token).toString("base64") };
	}
	return { tokenPlain: token };
}

function decryptToken(stored: StoredIntegration): string {
	if (stored.tokenEnc) {
		try {
			return safeStorage.decryptString(Buffer.from(stored.tokenEnc, "base64"));
		} catch {
			return ""; // keychain changed/unavailable — treat as no token
		}
	}
	return stored.tokenPlain ?? stored.token ?? "";
}

function integrationConfig(type: IntegrationType): { host: string; token: string } {
	const row = integrationsRepo.get(type);
	const stored = row ? (JSON.parse(row.config) as StoredIntegration) : {};
	return { host: stored.host || DEFAULT_HOST[type], token: decryptToken(stored) };
}

function integrationStatus(type: IntegrationType): IntegrationStatus {
	const row = integrationsRepo.get(type);
	const cfg = integrationConfig(type);
	return { type, enabled: !!row?.enabled, host: cfg.host, hasToken: !!cfg.token };
}

/** Scan git for a project's worktrees, sync the db, and return merged rows. */
async function syncWorktrees(project: ProjectRow): Promise<Worktree[]> {
	const gitEntries = (await gitListWorktrees(project.path)).filter(
		(w) => !w.isBare,
	);
	const createdAt = now();

	for (const entry of gitEntries) {
		worktreesRepo.upsert({
			id: worktreeId(project.id, entry.path),
			projectId: project.id,
			path: entry.path,
			createdAt,
		});
	}
	worktreesRepo.prune(
		project.id,
		gitEntries.map((e) => e.path),
	);

	const stored = new Map(
		worktreesRepo.forProject(project.id).map((r) => [r.path, r]),
	);

	// Compute activity for every worktree concurrently rather than one-by-one.
	const activities = await Promise.all(
		gitEntries.map((e) => worktreeActivity(e.path)),
	);
	const chatActivity = latestChatByWorktree();

	return gitEntries
		.map((entry, i): Worktree => {
			const row = stored.get(entry.path);
			const id = worktreeId(project.id, entry.path);
			return {
				id,
				projectId: project.id,
				path: entry.path,
				branch: entry.branch,
				name: row?.name ?? null,
				head: entry.head,
				isPrimary: entry.path === project.path,
				isDetached: entry.isDetached,
				isLocked: entry.isLocked,
				lastOpenedAt: row?.last_opened_at ?? null,
				// Recency = the most recent of commit, uncommitted edit, or chat here.
				lastActivityAt: Math.max(activities[i]!, chatActivity.get(id) ?? 0),
			};
		})
		.sort(recencyDesc);
}

/** Newest chat `updatedAt` per worktree, so recency reflects agent work too. */
function latestChatByWorktree(): Map<string, number> {
	const m = new Map<string, number>();
	for (const meta of listChatLogs()) {
		if (!meta.worktreeId) continue;
		const cur = m.get(meta.worktreeId) ?? 0;
		if (meta.updatedAt > cur) m.set(meta.worktreeId, meta.updatedAt);
	}
	return m;
}

function recencyDesc(a: Worktree, b: Worktree): number {
	return b.lastActivityAt - a.lastActivityAt;
}

function expandTilde(p: string): string {
	return p.startsWith("~") ? join(homedir(), p.slice(1)) : p;
}

/**
 * Where new worktrees for a project go: the explicit per-project setting if set,
 * else the conventional `<repo>.worktrees`, else the most common existing
 * location (so a stray worktree from another tool doesn't hijack the default).
 */
async function worktreeParentFor(project: ProjectRow): Promise<string> {
	if (project.worktree_dir) return project.worktree_dir;

	const conventional = `${project.path}.worktrees`;
	const parents = (await gitListWorktrees(project.path))
		.filter((e) => e.path !== project.path && !e.isBare)
		.map((e) => dirname(e.path));

	if (parents.includes(conventional) || existsSync(conventional)) {
		return conventional;
	}
	if (parents.length > 0) {
		const counts = new Map<string, number>();
		for (const p of parents) counts.set(p, (counts.get(p) ?? 0) + 1);
		return [...counts].sort((a, b) => b[1] - a[1])[0][0];
	}
	return conventional;
}

function letterKind(letter: string): ChangeKind {
	switch (letter) {
		case "A":
		case "C":
			return "added";
		case "D":
			return "deleted";
		case "R":
			return "renamed";
		case "T":
			return "typechange";
		case "U":
			return "conflicted";
		case "?":
			return "untracked";
		default:
			return "modified";
	}
}

function toChangedFile(c: BaseChange): ChangedFile {
	return {
		path: c.path,
		kind: letterKind(c.letter),
		insertions: c.insertions,
		deletions: c.deletions,
		staged: c.staged ?? false,
	};
}

type RpcHandlers = {
	[M in keyof RpcRequests]: (
		params: RpcRequests[M]["params"],
	) => RpcRequests[M]["response"] | Promise<RpcRequests[M]["response"]>;
};

const handlers: RpcHandlers = {
	listProjects: () => projectsRepo.list().map(toProject),

			addProject: async () => {
				const result = await dialog.showOpenDialog({
					properties: ["openDirectory"],
				});
				const picked = result.canceled ? undefined : result.filePaths[0]?.trim();
				console.log(`[addProject] picked: ${JSON.stringify(picked)}`);
				if (!picked) return { status: "cancelled" } as const;

				const version = await gitVersion();
				if (!version) {
					console.log("[addProject] git binary not found on PATH");
					return { status: "git-missing" } as const;
				}

				const toplevel = await resolveRepoToplevel(picked);
				if (!toplevel) {
					return { status: "not-a-repo", path: picked } as const;
				}

				const existing = projectsRepo.getByPath(toplevel);
				if (existing) {
					return { status: "exists", project: toProject(existing) } as const;
				}

				const row = {
					id: crypto.randomUUID(),
					name: basename(toplevel),
					path: toplevel,
					addedAt: now(),
				};
				projectsRepo.insert(row);
				console.log(`[addProject] added ${row.name} (${toplevel})`);
				return {
					status: "added",
					project: { ...row, lastOpenedAt: null },
				} as const;
			},

			removeProject: ({ id }) => {
				projectsRepo.remove(id);
			},

			listWorktrees: async ({ projectId }) => {
				const project = projectsRepo.get(projectId);
				if (!project) return [];
				return syncWorktrees(project);
			},

			recentWorktrees: async ({ limit }) => {
				const projects = projectsRepo.list();
				// Scan all projects concurrently.
				const perProject = await Promise.all(
					projects.map(async (project) =>
						(await syncWorktrees(project)).map(
							(wt): WorktreeWithProject => ({
								...wt,
								projectName: project.name,
								projectPath: project.path,
							}),
						),
					),
				);
				const all = perProject.flat();
				all.sort(recencyDesc);
				return all.slice(0, limit);
			},

			touchWorktree: ({ id }) => {
				const wt = worktreesRepo.get(id);
				if (!wt) return;
				const ts = now();
				worktreesRepo.touch(id, ts);
				projectsRepo.touch(wt.project_id, ts);
			},

			revealInFinder: ({ path }) => {
				shell.showItemInFolder(path);
			},

			detectApps: () => detectApps(),

			openWorktree: ({ path, app }) => openWorktree(path, app),

			worktreeDetail: async ({ id, base }) => {
				const row = worktreesRepo.get(id);
				if (!row) return null;
				const project = projectsRepo.get(row.project_id);
				if (!project) return null;

				const entries = await gitListWorktrees(project.path);
				const entry = entries.find((e) => e.path === row.path);
				if (!entry) return null; // worktree no longer exists

				// Don't compare a branch against itself.
				const preferred = base && base !== entry.branch ? base : null;
				const resolvedBase = await resolveBaseBranch(project.path, preferred);
				const usableBase = resolvedBase === entry.branch ? null : resolvedBase;

				const [activity, branches, changes, upstream, tracking] = await Promise.all([
					worktreeActivity(row.path),
					listBranches(project.path),
					worktreeChanges(row.path, usableBase),
					entry.branch ? branchUpstream(row.path, entry.branch) : Promise.resolve(null),
					// ponytail: compares vs origin/<branch>; wrong only for a non-origin
					// upstream (rare). Upgrade to compare vs the actual upstream ref if needed.
					entry.branch
						? branchTracking(row.path, entry.branch)
						: Promise.resolve({ ahead: 0, behind: 0, hasRemote: false }),
				]);

				const committed = changes.committed.map(toChangedFile);
				const uncommitted = changes.uncommitted.map(toChangedFile);

				const worktree: Worktree = {
					id,
					projectId: project.id,
					path: row.path,
					branch: entry.branch,
					name: row.name ?? null,
					head: entry.head,
					isPrimary: entry.path === project.path,
					isDetached: entry.isDetached,
					isLocked: entry.isLocked,
					lastOpenedAt: row.last_opened_at,
					lastActivityAt: Math.max(activity, latestChatByWorktree().get(id) ?? 0),
				};

				return {
					worktree,
					projectId: project.id,
					projectName: project.name,
					branch: entry.branch,
					upstream,
					upstreamAhead: tracking.ahead,
					upstreamBehind: tracking.behind,
					base: changes.base,
					branches,
					ahead: changes.ahead,
					behind: changes.behind,
					committed,
					uncommitted,
					commands: commandsRepo.forProject(project.id).map(toCommand),
				};
			},

			fileDiff: async ({ id, path, base, commit }) => {
				const row = worktreesRepo.get(id);
				if (!row) return { path, binary: false, diff: "" };
				const { binary, text } = await gitFileDiff(row.path, path, base, commit);
				return { path, binary, diff: text };
			},

			fileContents: async ({ id, path, base, commit }) => {
				const row = worktreesRepo.get(id);
				if (!row) return { before: "", after: "", binary: false };
				return gitFileContents(row.path, path, base, commit);
			},

			listFiles: async ({ id }) => {
				const row = worktreesRepo.get(id);
				return row ? gitListFiles(row.path) : [];
			},

			searchText: async ({ id, query }) => {
				const row = worktreesRepo.get(id);
				return row ? gitSearchText(row.path, query) : [];
			},

			readFile: async ({ id, path }) => {
				const row = worktreesRepo.get(id);
				if (!row) return { content: "", binary: false };
				return readWorkingFile(row.path, path);
			},

			writeFile: async ({ id, path, content }) => {
				const row = worktreesRepo.get(id);
				if (!row) return { ok: false, error: "worktree not found" };
				return writeWorkingFile(row.path, path, content);
			},

			listCommits: async ({ id, base }) => {
				const row = worktreesRepo.get(id);
				if (!row || !base) return [];
				return commitsVsBase(row.path, base);
			},

			commitFiles: async ({ id, hash }) => {
				const row = worktreesRepo.get(id);
				if (!row) return [];
				return (await gitCommitFiles(row.path, hash)).map(toChangedFile);
			},

			worktreeRemovalInfo: async ({ id }) => {
				const row = worktreesRepo.get(id);
				if (!row) return null;
				const project = projectsRepo.get(row.project_id);
				if (!project) return null;
				const entries = await gitListWorktrees(project.path);
				const entry = entries.find((e) => e.path === row.path);
				const isPrimary = row.path === project.path;
				const base = await resolveBaseBranch(project.path, null);
				const usableBase = base && base !== entry?.branch ? base : null;
				const changes = await worktreeChanges(row.path, usableBase);
				// "Unpushed" = commits that would actually be lost if the branch were
				// deleted: ahead of the tracking branch, or (with no remote) ahead of base.
				const upstream = entry?.branch ? await branchUpstream(row.path, entry.branch) : null;
				const unpushed =
					upstream && entry?.branch
						? (await branchTracking(row.path, entry.branch)).ahead
						: changes.ahead;
				return {
					branch: entry?.branch ?? null,
					path: row.path,
					isPrimary,
					uncommitted: changes.uncommitted.length,
					unpushed,
					hasUpstream: !!upstream,
				};
			},

			removeWorktree: async ({ id, force, deleteBranch }) => {
				const row = worktreesRepo.get(id);
				if (!row) return { ok: false, error: "Worktree not found" };
				const project = projectsRepo.get(row.project_id);
				if (!project) return { ok: false, error: "Project not found" };
				if (row.path === project.path) {
					return { ok: false, error: "Can't remove the primary worktree" };
				}
				const entries = await gitListWorktrees(project.path);
				const branch = entries.find((e) => e.path === row.path)?.branch;

				const rem = await gitRemoveWorktree(project.path, row.path, force);
				if (!rem.ok) return rem;
				if (deleteBranch && branch) {
					await gitDeleteBranch(project.path, branch, true); // best-effort, force
				}
				return { ok: true };
			},

			branchStatus: async ({ projectId }) => {
				const project = projectsRepo.get(projectId);
				const base = project
					? await resolveBaseBranch(project.path, null)
					: null;
				if (!project || !base) {
					return { branch: base, ahead: 0, behind: 0, hasRemote: false, recent: [] };
				}
				const [t, recent] = await Promise.all([
					branchTracking(project.path, base),
					recentCommits(project.path, base, 20),
				]);
				return { branch: base, ...t, recent };
			},

			fetchProject: async ({ projectId }) => {
				const project = projectsRepo.get(projectId);
				if (!project) return { ok: false, error: "Project not found" };
				console.log(`[fetch] request for project ${project.name} (${project.path})`);
				const base = await resolveBaseBranch(project.path, null);
				return gitFetchProject(project.path, base);
			},

			projectBranches: async ({ projectId }) => {
				const project = projectsRepo.get(projectId);
				if (!project) return { branches: [], base: null, worktreeDir: "" };
				const [branches, base, worktreeDir] = await Promise.all([
					listBranches(project.path),
					resolveBaseBranch(project.path, null),
					worktreeParentFor(project),
				]);
				return { branches, base, worktreeDir };
			},

			projectBranchGraph: async ({ projectId }) => {
				const project = projectsRepo.get(projectId);
				if (!project) return [];
				const [graph, worktrees] = await Promise.all([
					branchGraph(project.path),
					gitListWorktrees(project.path),
				]);
				// branch (short name) -> worktrees that have it checked out.
				const byBranch = new Map<string, { id: string; path: string }[]>();
				for (const w of worktrees) {
					if (w.isBare || !w.branch) continue;
					const list = byBranch.get(w.branch) ?? [];
					list.push({ id: worktreeId(projectId, w.path), path: w.path });
					byBranch.set(w.branch, list);
				}
				return graph.map((b) => ({
					name: b.name,
					local: b.local,
					remote: b.remote,
					worktrees: byBranch.get(b.name) ?? [],
					lastCommitAt: b.lastCommitAt,
					ahead: b.ahead,
					behind: b.behind,
					base: b.base,
				}));
			},

			updateWorktree: async ({ id, base, mode }) => {
				const row = worktreesRepo.get(id);
				if (!row) return { ok: false, error: "Worktree not found" };
				return gitUpdateFromBase(row.path, base, mode);
			},

			renameBranch: async ({ projectId, from, to }) => {
				const project = projectsRepo.get(projectId);
				if (!project) return { ok: false, error: "Project not found" };
				return gitRenameBranch(project.path, from, to);
			},

			renameWorktree: ({ id, name }) => {
				worktreesRepo.setName(id, name);
				return { ok: true };
			},

			deleteBranch: async ({ projectId, branch, force }) => {
				const project = projectsRepo.get(projectId);
				if (!project) return { ok: false, error: "Project not found" };
				return gitDeleteBranch(project.path, branch, force);
			},

			deleteBranches: async ({ projectId, branches, force }) => {
				const project = projectsRepo.get(projectId);
				if (!project) {
					return { deleted: [], failed: branches.map((branch) => ({ branch, error: "Project not found" })) };
				}
				const deleted: string[] = [];
				const failed: { branch: string; error: string }[] = [];
				// Sequential: `git branch -d` is fast and avoids index-lock contention.
				for (const branch of branches) {
					const r = await gitDeleteBranch(project.path, branch, force);
					if (r.ok) deleted.push(branch);
					else failed.push({ branch, error: r.error ?? "delete failed" });
				}
				return { deleted, failed };
			},

			createWorktree: async ({ projectId, name, base, location, detach }) => {
				const project = projectsRepo.get(projectId);
				if (!project) return { ok: false, error: "Project not found" };

				// No explicit name: if basing off a remote branch (origin/foo), check
				// out that branch (named `foo`) so the worktree reflects it; otherwise
				// fall back to a generated name.
				const remoteBase = base && /^origin\//.test(base) ? base.slice("origin/".length) : null;
				// Review checks out the *actual* branch (so edits land on it). `detach`
				// from the dialog now means "review mode": the target branch is `base`
				// (its local name when remote).
				const reviewBranch = detach && base ? (remoteBase ?? base) : null;
				const branch =
					reviewBranch ||
					name.trim() ||
					remoteBase ||
					`worktree-${Math.random().toString(36).slice(2, 8)}`;

				// Explicit location (from the dialog) wins and becomes the project's
				// remembered default; otherwise use the stored/detected location.
				const parent = location?.trim()
					? expandTilde(location.trim())
					: await worktreeParentFor(project);
				projectsRepo.setWorktreeDir(projectId, parent);
				mkdirSync(parent, { recursive: true });

				// Slugify the whole branch so the folder keeps its context
				// (feature/foo -> feature-foo) and leaf names don't collide.
				const dirName =
					branch.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "worktree";
				let wtPath = join(parent, dirName);
				for (let n = 2; existsSync(wtPath); n++) {
					wtPath = join(parent, `${dirName}-${n}`);
				}

				// Review mode: if the branch already has a worktree (usually your own),
				// reuse it — you review there with a fresh chat, no second checkout (git
				// forbids checking a branch out twice). Otherwise (the common case: some-
				// one else's branch) check it out on its real branch so edits land on it.
				if (reviewBranch) {
					const entries = await gitListWorktrees(project.path);
					const existing = entries.find((e) => e.branch === reviewBranch);
					if (existing) {
						return { ok: true, worktreeId: worktreeId(projectId, existing.path), path: existing.path };
					}
				}
				const res = await gitAddWorktree(
					project.path,
					wtPath,
					branch,
					reviewBranch ? base : await resolveBaseBranch(project.path, base),
					false,
				);
				if (!res.ok) return { ok: false, error: res.error };

				const id = worktreeId(projectId, wtPath);
				worktreesRepo.upsert({
					id,
					projectId,
					path: wtPath,
					createdAt: now(),
				});
				console.log(`[createWorktree] ${branch} -> ${wtPath}`);
				return { ok: true, worktreeId: id, path: wtPath };
			},

			listCommands: ({ projectId }) =>
				commandsRepo.forProject(projectId).map(toCommand),

			addCommand: ({ projectId, label, command, dir, runTarget }) => {
				const row = {
					id: crypto.randomUUID(),
					projectId,
					label,
					command,
					dir,
					runTarget,
					createdAt: now(),
				};
				commandsRepo.insert(row);
				return { id: row.id, projectId, label, command, dir, runTarget };
			},

			updateCommand: ({ id, label, command, dir, runTarget }) => {
				commandsRepo.update(id, label, command, dir, runTarget);
			},

			removeCommand: ({ id }) => {
				commandsRepo.remove(id);
			},

			runCommand: ({ id, cwd, app }) => {
				const cmd = commandsRepo.get(id);
				if (!cmd) return { ok: false, error: "Command not found" };
				// `dir` is relative to the worktree root; join keeps "" at the root.
				const runCwd = cmd.dir ? join(cwd, cmd.dir) : cwd;
				return runInTerminal(app, runCwd, cmd.command);
			},

			runExternal: ({ cwd, command, app }) => runInTerminal(app, cwd, command),

			openUrl: ({ url }) => {
				try {
					void shell.openExternal(url);
					return { ok: true };
				} catch (err) {
					return { ok: false, error: String(err) };
				}
			},

			stageFiles: ({ id, paths }) => {
				const row = worktreesRepo.get(id);
				if (!row) return { ok: false, error: "Worktree not found" };
				return gitStage(row.path, paths);
			},
			unstageFiles: ({ id, paths }) => {
				const row = worktreesRepo.get(id);
				if (!row) return { ok: false, error: "Worktree not found" };
				return gitUnstage(row.path, paths);
			},
			commitChanges: ({ id, message }) => {
				const row = worktreesRepo.get(id);
				if (!row) return { ok: false, error: "Worktree not found" };
				return gitCommit(row.path, message);
			},
			pushBranch: ({ id }) => {
				const row = worktreesRepo.get(id);
				if (!row) return { ok: false, error: "Worktree not found" };
				return gitPushBranch(row.path);
			},
			createReviewRequest: async ({ id, base, title }) => {
				const row = worktreesRepo.get(id);
				if (!row) return { ok: false, error: "Worktree not found" };
				const project = projectsRepo.get(row.project_id);
				if (!project) return { ok: false, error: "Project not found" };
				const { branch } = await gitWorktreeStatus(row.path);
				if (!branch) return { ok: false, error: "Worktree has no branch (detached HEAD)" };
				// The remote branch must exist first; push before opening the request.
				const pushed = await gitPushBranch(row.path);
				if (!pushed.ok) return { ok: false, error: `Push failed: ${pushed.error}` };
				for (const type of KNOWN_INTEGRATIONS) {
					const intRow = integrationsRepo.get(type);
					if (!intRow?.enabled) continue;
					const cfg = integrationConfig(type);
					if (!cfg.token) continue;
					const res =
						type === "github"
							? await githubCreateRequest(cfg, project.path, branch, base, title)
							: await gitlabCreateRequest(cfg, project.path, branch, base, title);
					if (res) return res; // null = repo not on this host; keep looking
				}
				return { ok: false, error: "No integration matches this repo's remote" };
			},

			listIntegrations: () => KNOWN_INTEGRATIONS.map(integrationStatus),

			setIntegration: ({ type, enabled, host, token }) => {
				const current = integrationConfig(type);
				const finalHost = host.trim() || DEFAULT_HOST[type];
				const finalToken = token !== null ? token : current.token; // "" clears, null keeps
				// Encrypt on every save — this also migrates any legacy plaintext token.
				integrationsRepo.upsert(
					type,
					enabled,
					JSON.stringify({ host: finalHost, ...encryptToken(finalToken) }),
				);
				return integrationStatus(type);
			},

			testIntegration: async ({ type, host, token }) => {
				const cfg = integrationConfig(type);
				const useHost = host.trim() || cfg.host;
				const useToken = token !== null ? token : cfg.token;
				if (!useToken) return { ok: false, error: "No token provided" };
				const conn = { host: useHost, token: useToken };
				return type === "github" ? githubTest(conn) : gitlabTest(conn);
			},

			branchIntegrations: async ({ projectId, branch }) => {
				const project = projectsRepo.get(projectId);
				if (!project || !branch) return null;
				// Try each enabled integration; the repo's remote host picks the match.
				for (const type of KNOWN_INTEGRATIONS) {
					const row = integrationsRepo.get(type);
					if (!row?.enabled) continue;
					const cfg = integrationConfig(type);
					if (!cfg.token) continue;
					const status =
						type === "github"
							? await githubBranchStatus(cfg, project.path, branch)
							: await gitlabBranchStatus(cfg, project.path, branch);
					if (status) return status;
				}
				return null;
			},

			termStart: ({ sessionId, worktreeId, commandId, command, cols, rows }) => {
				const row = worktreesRepo.get(worktreeId);
				if (!row) return { ok: false, error: "Worktree not found" };
				let cwd = row.path;
				let toRun: string | undefined = command ?? undefined;
				if (!toRun && commandId) {
					const cmd = commandsRepo.get(commandId);
					if (cmd) {
						toRun = cmd.command;
						if (cmd.dir) cwd = join(cwd, cmd.dir);
					}
				}
				termStart({ sessionId, cwd, command: toRun, cols, rows });
				return { ok: true };
			},

			agentChatStart: ({ sessionId, worktreeId, provider, resume, permissionMode, model }) => {
				const row = worktreesRepo.get(worktreeId);
				if (!row) return { ok: false, error: "Worktree not found" };
				const ok = agentChatStart({
					sessionId,
					cwd: row.path,
					provider,
					resume,
					permissionMode,
					model,
					worktreeId,
					projectId: row.project_id,
				});
				return ok ? { ok: true } : { ok: false, error: "Session already running" };
			},

			listChats: ({ worktreeId }) =>
				listChatLogs().filter((m) => m.worktreeId === worktreeId),

			agentChatRestart: ({ sessionId, worktreeId, provider, permissionMode, model }) => {
				const row = worktreesRepo.get(worktreeId);
				if (!row) return { ok: false, error: "Worktree not found" };
				agentChatRestart({
					sessionId,
					cwd: row.path,
					provider,
					resume: true,
					permissionMode,
					model,
				});
				return { ok: true };
			},
};

// Fire-and-forget renderer→main messages (no response expected).
function dispatchMessage(msg: ViewMessage): void {
	switch (msg.type) {
		case "termInput":
			termWrite(msg.sessionId, msg.data);
			break;
		case "termResize":
			termResize(msg.sessionId, msg.cols, msg.rows);
			break;
		case "termKill":
			termKill(msg.sessionId);
			break;
		case "agentChatSend":
			agentChatSend(msg.sessionId, msg.text, msg.attachments);
			break;
		case "agentChatPermission":
			agentChatRespond(msg.sessionId, msg.requestId, msg.optionId);
			break;
		case "agentChatElicit":
			agentChatElicit(msg.sessionId, msg.id, msg.action, msg.content);
			break;
		case "agentChatSetMode":
			agentChatSetMode(msg.sessionId, msg.permissionMode);
			break;
		case "agentChatSetSessionMode":
			agentChatSetSessionMode(msg.sessionId, msg.modeId);
			break;
		case "agentChatSetConfigOption":
			agentChatSetConfigOption(msg.sessionId, msg.configId, msg.value);
			break;
		case "agentChatCancel":
			agentChatCancel(msg.sessionId);
			break;
		case "agentChatStop":
			agentChatStop(msg.sessionId);
			break;
		case "chatRead":
			markChatRead(msg.sessionId);
			break;
	}
}

// Push an event to every open window's renderer.
function broadcast(event: MainEvent): void {
	for (const win of BrowserWindow.getAllWindows()) {
		win.webContents.send("event", event);
	}
}

// One request channel (invoke→response) and one message channel (fire-and-forget).
ipcMain.handle("rpc", (_event, method: keyof RpcRequests, params: unknown) => {
	const handler = handlers[method] as ((p: unknown) => unknown) | undefined;
	if (typeof handler !== "function") {
		// Usually a stale main process in dev (renderer hot-reloaded with a new RPC
		// call, but main didn't restart) — surface it clearly instead of crashing.
		throw new Error(`No RPC handler for "${String(method)}" (restart the app if this is dev).`);
	}
	return handler(params);
});
ipcMain.on("message", (_event, msg: ViewMessage) => dispatchMessage(msg));

// Stream PTY output / exit from the main process to the renderer.
setTerminalCallbacks({
	onData: (sessionId, data) => broadcast({ type: "termData", sessionId, data }),
	onExit: (sessionId, exitCode) =>
		broadcast({ type: "termExit", sessionId, exitCode }),
});

// Chat status routing: a dock badge + OS notification when an agent needs input or
// finishes in the background, plus in-app dots (which chat/worktree is working,
// awaiting an answer, or has unread output) — so parallel agents don't need babysitting.
const attention = new Map<string, Set<string>>(); // sessionId -> unanswered request keys
const working = new Set<string>(); // sessionId currently processing a turn
const unread = new Set<string>(); // sessionId finished a turn you haven't read
let readSession: string | null = null; // the chat the user is currently viewing (focused)

function focused(): boolean {
	return BrowserWindow.getAllWindows().some((w) => w.isFocused());
}
function addAttention(sessionId: string, key: string): void {
	const set = attention.get(sessionId) ?? new Set<string>();
	set.add(key);
	attention.set(sessionId, set);
}
function clearAttention(sessionId: string, key?: string): void {
	if (key === undefined) {
		attention.delete(sessionId);
		return;
	}
	const set = attention.get(sessionId);
	if (!set) return;
	set.delete(key);
	if (set.size === 0) attention.delete(sessionId);
}
/** Expand a session-id list to the worktrees/projects it touches (from chat meta). */
function statusSets(sessions: string[]): { sessions: string[]; worktrees: string[]; projects: string[] } {
	const worktrees = new Set<string>();
	const projects = new Set<string>();
	for (const s of sessions) {
		const t = sessionTarget(s);
		if (t) {
			worktrees.add(t.worktreeId);
			projects.add(t.projectId);
		}
	}
	return { sessions, worktrees: [...worktrees], projects: [...projects] };
}
/** Push the current chat status (badge + working/attention/unread) to the renderer. */
function broadcastStatus(): void {
	const count = [...attention.values()].reduce((n, s) => n + s.size, 0);
	app.setBadgeCount(count);
	broadcast({
		type: "chatStatus",
		attention: statusSets([...attention.keys()]),
		working: statusSets([...working]),
		unread: statusSets([...unread]),
	});
}
/** The renderer tells us which chat the user is looking at, so its finished turns
 *  read immediately and don't pile up as "unread". */
function markChatRead(sessionId: string | null): void {
	readSession = sessionId;
	if (sessionId && unread.delete(sessionId)) broadcastStatus();
}
/** The worktree a chat session belongs to, plus a label, from its persisted meta. */
function sessionTarget(sessionId: string): { projectId: string; worktreeId: string; label: string } | null {
	const meta = listChatLogs().find((m) => m.sessionId === sessionId);
	if (!meta || !meta.worktreeId || !meta.projectId) return null;
	return { projectId: meta.projectId, worktreeId: meta.worktreeId, label: meta.name || "a chat" };
}
function notifyUser(
	title: string,
	body: string,
	target: { projectId: string; worktreeId: string } | null,
): void {
	if (!Notification.isSupported()) return;
	const n = new Notification({ title, body });
	n.on("click", () => {
		const win = BrowserWindow.getAllWindows()[0];
		if (win) {
			if (win.isMinimized()) win.restore();
			win.show();
			win.focus();
		}
		if (target) broadcast({ type: "navigate", ...target }); // jump to that worktree
	});
	n.show();
}
function handleChatStatus(sessionId: string, event: AgentChatEvent): void {
	switch (event.type) {
		case "user_text":
			// A new turn started (user sent, or an auto/initial prompt) — the user is
			// engaged with this chat, so it's working and not unread.
			working.add(sessionId);
			unread.delete(sessionId);
			broadcastStatus();
			break;
		case "assistant_text":
		case "thinking":
		case "tool_use":
		case "tool_result":
		case "plan":
			if (!working.has(sessionId)) {
				working.add(sessionId);
				broadcastStatus();
			}
			break;
		case "permission": {
			addAttention(sessionId, `p:${event.id}`);
			broadcastStatus();
			const t = sessionTarget(sessionId);
			if (!focused()) notifyUser("Permission needed", `${t?.label ?? "A chat"}: allow ${event.toolName}?`, t);
			break;
		}
		case "elicitation": {
			addAttention(sessionId, `e:${event.id}`);
			broadcastStatus();
			const t = sessionTarget(sessionId);
			if (!focused()) notifyUser("Input needed", `${t?.label ?? "A chat"}: ${event.message}`, t);
			break;
		}
		case "permission_resolved":
			clearAttention(sessionId, `p:${event.id}`);
			broadcastStatus();
			break;
		case "elicitation_resolved":
			clearAttention(sessionId, `e:${event.id}`);
			broadcastStatus();
			break;
		case "result": {
			working.delete(sessionId);
			// Finished — unread unless the user is looking at this chat right now.
			if (!(focused() && readSession === sessionId)) unread.add(sessionId);
			broadcastStatus();
			const t = sessionTarget(sessionId);
			if (!focused()) notifyUser("Chat finished", `${t?.label ?? "The agent"} finished its turn.`, t);
			break;
		}
		case "error":
		case "exited":
			working.delete(sessionId);
			if (event.type === "exited") clearAttention(sessionId);
			broadcastStatus();
			break;
	}
}

// Stream normalized chat-agent events from the main process to the renderer.
setAgentChatCallback((sessionId, event) => {
	broadcast({ type: "agentChatEvent", sessionId, event });
});
// Status (attention/working/unread) is driven by live events only (never replay).
setAgentStatusCallback(handleChatStatus);

// Persisted window size + position, so the app reopens where you left it.
const WINDOW_STATE_FILE = join(DATA_DIR, "window-state.json");
type WindowState = { width: number; height: number; x?: number; y?: number };

function readWindowState(): WindowState | null {
	try {
		const s = JSON.parse(readFileSync(WINDOW_STATE_FILE, "utf8")) as WindowState;
		if (typeof s.width === "number" && typeof s.height === "number") return s;
	} catch {
		// no saved state yet / unreadable
	}
	return null;
}

/** A saved position is only usable if it still lands on a connected display. */
function positionOnScreen(x: number, y: number, w: number, h: number): boolean {
	return screen.getAllDisplays().some(({ workArea: a }) => {
		return x < a.x + a.width && x + w > a.x && y < a.y + a.height && y + h > a.y;
	});
}

function saveWindowState(win: BrowserWindow): void {
	if (win.isDestroyed()) return;
	// Normal bounds ignore the maximized/fullscreen frame, so we restore the real size.
	const b = win.getNormalBounds();
	try {
		writeFileSync(WINDOW_STATE_FILE, JSON.stringify({ width: b.width, height: b.height, x: b.x, y: b.y }));
	} catch {
		// non-fatal
	}
}

function createWindow(): void {
	const saved = readWindowState();
	const width = saved?.width ?? 1100;
	const height = saved?.height ?? 760;
	// Only reuse a saved position if it's still on-screen (display unplugged, etc.).
	const usePos =
		saved && saved.x != null && saved.y != null && positionOnScreen(saved.x, saved.y, width, height);

	const win = new BrowserWindow({
		title: "Forest Ranger",
		width,
		height,
		x: usePos ? saved.x : undefined,
		y: usePos ? saved.y : undefined,
		// Transparent titlebar with inset native traffic-light controls; we draw
		// our own dark titlebar strip and mark it as a drag region in the renderer.
		titleBarStyle: "hiddenInset",
		trafficLightPosition: { x: 12, y: 14 },
		webPreferences: {
			preload: join(__dirname, "../preload/index.js"),
		},
	});

	// Remember size/position across restarts (debounced during drags/resizes).
	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	const scheduleSave = () => {
		clearTimeout(saveTimer);
		saveTimer = setTimeout(() => saveWindowState(win), 400);
	};
	win.on("resize", scheduleSave);
	win.on("move", scheduleSave);
	win.on("close", () => saveWindowState(win));

	// Flag fullscreen on the document so the renderer can drop the traffic-light
	// spacer (no traffic lights in native fullscreen → no gap above the brand).
	const syncFullscreen = () => {
		win.webContents
			.executeJavaScript(
				`document.documentElement.toggleAttribute("data-fullscreen", ${win.isFullScreen()})`,
			)
			.catch(() => {});
	};
	win.on("enter-full-screen", syncFullscreen);
	win.on("leave-full-screen", syncFullscreen);
	win.webContents.on("did-finish-load", syncFullscreen);

	if (process.env.ELECTRON_RENDERER_URL) {
		win.loadURL(process.env.ELECTRON_RENDERER_URL);
	} else {
		win.loadFile(join(__dirname, "../renderer/index.html"));
	}
}

// Unpackaged, Electron reports its own binary's name ("Electron") in the menu
// bar, About panel, and notifications. A packaged build gets the name from
// `productName`; set it here so dev matches.
app.setName("Forest Ranger");
app.setAboutPanelOptions({
	applicationName: "Forest Ranger",
	applicationVersion: app.getVersion(),
});

app.whenReady().then(() => {
	// In dev the dock shows the default Electron icon (the app bundle's icon only
	// applies to the packaged build) — set ours so dev matches.
	if (!app.isPackaged && process.platform === "darwin") {
		try {
			app.dock?.setIcon(join(__dirname, "../../build/icon.png"));
		} catch {
			// non-fatal
		}
	}

	// Standard app/edit/window menus give us the native clipboard + selection
	// shortcuts (⌘A/⌘C/⌘X/⌘V/⌘Z) wired to whatever field has focus.
	Menu.setApplicationMenu(
		Menu.buildFromTemplate([
			{ role: "appMenu" },
			{ role: "editMenu" },
			{
				// Custom window menu so ⌘W is free for "close the focused tab" (handled in
				// the renderer); window-close moves to ⇧⌘W.
				label: "Window",
				submenu: [
					{ role: "minimize" },
					{ role: "zoom" },
					{ type: "separator" },
					{ role: "close", accelerator: "Shift+CmdOrCtrl+W", label: "Close Window" },
				],
			},
		]),
	);

	createWindow();

	app.on("activate", () => {
		if (BrowserWindow.getAllWindows().length === 0) createWindow();
	});

	console.log("Forest Ranger app started!");
});

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});

// Don't leave PTYs (dev servers, etc.) orphaned when the app quits.
app.on("before-quit", () => {
	termKillAll();
	agentChatKillAll();
});
for (const sig of ["SIGINT", "SIGTERM"] as const) {
	process.on(sig, () => {
		termKillAll();
		agentChatKillAll();
		process.exit(0);
	});
}
process.on("exit", () => {
	termKillAll();
	agentChatKillAll();
});
