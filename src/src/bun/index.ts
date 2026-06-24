import { BrowserView, BrowserWindow, Updater, Utils } from "electrobun/bun";
import { basename, join } from "node:path";
import type {
	AppRPC,
	ChangedFile,
	ChangeKind,
	Project,
	ProjectCommand,
	Worktree,
	WorktreeWithProject,
} from "../shared/types";
import { detectApps, openWorktree, runInTerminal } from "./apps";
import {
	kill as termKill,
	resize as termResize,
	setTerminalCallbacks,
	startSession as termStart,
	write as termWrite,
} from "./terminals";
import {
	commandsRepo,
	projectsRepo,
	worktreesRepo,
	type CommandRow,
	type ProjectRow,
} from "./db";
import {
	fileDiff as gitFileDiff,
	gitVersion,
	listWorktrees as gitListWorktrees,
	resolveRepoToplevel,
	worktreeActivity,
	worktreeStatus,
	type GitStatus,
	type GitStatusFile,
} from "./git";

const DEV_SERVER_PORT = 5178;
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;

const now = () => Date.now();

function worktreeId(projectId: string, path: string): string {
	return `${projectId}-${Bun.hash(path).toString(36)}`;
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
		runTarget: row.run_target === "external" ? "external" : "in-app",
	};
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

	return gitEntries
		.map((entry, i): Worktree => {
			const row = stored.get(entry.path);
			return {
				id: worktreeId(project.id, entry.path),
				projectId: project.id,
				path: entry.path,
				branch: entry.branch,
				head: entry.head,
				isPrimary: entry.path === project.path,
				isDetached: entry.isDetached,
				isLocked: entry.isLocked,
				lastOpenedAt: row?.last_opened_at ?? null,
				lastActivityAt: activities[i]!,
			};
		})
		.sort(recencyDesc);
}

function recencyDesc(a: Worktree, b: Worktree): number {
	return b.lastActivityAt - a.lastActivityAt;
}

const CONFLICT_CODES = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);

function changeKind(x: string, y: string): ChangeKind {
	if (x === "?" || y === "?") return "untracked";
	if (x === "U" || y === "U" || CONFLICT_CODES.has(x + y)) return "conflicted";
	const code = y !== " " ? y : x;
	switch (code) {
		case "A":
		case "C":
			return "added";
		case "D":
			return "deleted";
		case "R":
			return "renamed";
		case "T":
			return "typechange";
		default:
			return "modified";
	}
}

function toChangedFile(f: GitStatusFile, status: GitStatus): ChangedFile {
	const ns = status.numstat.get(f.path);
	return {
		path: f.path,
		kind: changeKind(f.x, f.y),
		staged: f.x !== " " && f.x !== "?",
		insertions: ns?.insertions ?? null,
		deletions: ns?.deletions ?? null,
	};
}

const rpc = BrowserView.defineRPC<AppRPC>({
	maxRequestTime: 15000,
	handlers: {
		requests: {
			listProjects: () => projectsRepo.list().map(toProject),

			addProject: async () => {
				const chosen = await Utils.openFileDialog({
					canChooseDirectory: true,
					canChooseFiles: false,
					allowsMultipleSelection: false,
				});
				const picked = (Array.isArray(chosen) ? chosen[0] : chosen)?.trim();
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
				Bun.spawn(["open", "-R", path]);
			},

			detectApps: () => detectApps(),

			openWorktree: ({ path, app }) => openWorktree(path, app),

			worktreeDetail: async ({ id }) => {
				const row = worktreesRepo.get(id);
				if (!row) return null;
				const project = projectsRepo.get(row.project_id);
				if (!project) return null;

				const entries = await gitListWorktrees(project.path);
				const entry = entries.find((e) => e.path === row.path);
				if (!entry) return null; // worktree no longer exists

				const [activity, status] = await Promise.all([
					worktreeActivity(row.path),
					worktreeStatus(row.path),
				]);

				const files = status.files.map((f) => toChangedFile(f, status));
				const totals = files.reduce(
					(acc, f) => ({
						files: acc.files + 1,
						insertions: acc.insertions + (f.insertions ?? 0),
						deletions: acc.deletions + (f.deletions ?? 0),
					}),
					{ files: 0, insertions: 0, deletions: 0 },
				);

				const worktree: Worktree = {
					id,
					projectId: project.id,
					path: row.path,
					branch: entry.branch,
					head: entry.head,
					isPrimary: entry.path === project.path,
					isDetached: entry.isDetached,
					isLocked: entry.isLocked,
					lastOpenedAt: row.last_opened_at,
					lastActivityAt: activity,
				};

				return {
					worktree,
					projectId: project.id,
					projectName: project.name,
					branch: status.branch ?? entry.branch,
					upstream: status.upstream,
					ahead: status.ahead,
					behind: status.behind,
					files,
					totals,
					commands: commandsRepo.forProject(project.id).map(toCommand),
				};
			},

			fileDiff: async ({ id, path }) => {
				const row = worktreesRepo.get(id);
				if (!row) return { path, binary: false, diff: "" };
				const { binary, text } = await gitFileDiff(row.path, path);
				return { path, binary, diff: text };
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

			termStart: ({ sessionId, worktreeId, commandId, cols, rows }) => {
				const row = worktreesRepo.get(worktreeId);
				if (!row) return { ok: false, error: "Worktree not found" };
				let cwd = row.path;
				let command: string | undefined;
				if (commandId) {
					const cmd = commandsRepo.get(commandId);
					if (cmd) {
						command = cmd.command;
						if (cmd.dir) cwd = join(cwd, cmd.dir);
					}
				}
				termStart({ sessionId, cwd, command, cols, rows });
				return { ok: true };
			},
		},
		messages: {
			termInput: ({ sessionId, data }) => termWrite(sessionId, data),
			termResize: ({ sessionId, cols, rows }) => termResize(sessionId, cols, rows),
			termKill: ({ sessionId }) => termKill(sessionId),
		},
	},
});

// Stream PTY output / exit from the bun process to the webview.
setTerminalCallbacks({
	onData: (sessionId, data) => rpc.send.termData({ sessionId, data }),
	onExit: (sessionId, exitCode) => rpc.send.termExit({ sessionId, exitCode }),
});

async function getMainViewUrl(): Promise<string> {
	const channel = await Updater.localInfo.channel();
	if (channel === "dev") {
		try {
			await fetch(DEV_SERVER_URL, { method: "HEAD" });
			console.log(`HMR enabled: Using Vite dev server at ${DEV_SERVER_URL}`);
			return DEV_SERVER_URL;
		} catch {
			console.log(
				"Vite dev server not running. Run 'bun run dev:hmr' for HMR support.",
			);
		}
	}
	return "views://mainview/index.html";
}

const url = await getMainViewUrl();

new BrowserWindow({
	title: "Forest Ranger",
	url,
	rpc,
	// Transparent titlebar with inset native traffic-light controls; we draw our
	// own dark titlebar strip in the webview and mark it as a drag region.
	titleBarStyle: "hiddenInset",
	trafficLightOffset: { x: 12, y: 14 },
	frame: {
		width: 1100,
		height: 760,
		x: 200,
		y: 200,
	},
});

console.log("Forest Ranger app started!");
