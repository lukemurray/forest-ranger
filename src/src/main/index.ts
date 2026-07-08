import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type {
	BranchIntegrations,
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
	cancel as agentChatCancel,
	restart as agentChatRestart,
	send as agentChatSend,
	setAgentChatCallback,
	startSession as agentChatStart,
	stop as agentChatStop,
} from "./agentChat";
import {
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
	type GitLabConfig,
} from "./gitlab";
import {
	addWorktree as gitAddWorktree,
	branchTracking,
	branchUpstream,
	deleteBranch as gitDeleteBranch,
	fetchProject as gitFetchProject,
	fileDiff as gitFileDiff,
	gitVersion,
	removeWorktree as gitRemoveWorktree,
	listWorktrees as gitListWorktrees,
	listBranches,
	stageFiles as gitStage,
	unstageFiles as gitUnstage,
	commit as gitCommit,
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


const KNOWN_INTEGRATIONS: IntegrationType[] = ["gitlab"];
const DEFAULT_HOST: Record<IntegrationType, string> = {
	gitlab: "https://gitlab.com",
};

function integrationConfig(type: IntegrationType): { host: string; token: string } {
	const row = integrationsRepo.get(type);
	const stored = row ? (JSON.parse(row.config) as Partial<GitLabConfig>) : {};
	return { host: stored.host || DEFAULT_HOST[type], token: stored.token || "" };
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

				const [activity, branches, changes, upstream] = await Promise.all([
					worktreeActivity(row.path),
					listBranches(project.path),
					worktreeChanges(row.path, usableBase),
					entry.branch ? branchUpstream(row.path, entry.branch) : Promise.resolve(null),
				]);

				const committed = changes.committed.map(toChangedFile);
				const uncommitted = changes.uncommitted.map(toChangedFile);

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
					branch: entry.branch,
					upstream,
					base: changes.base,
					branches,
					ahead: changes.ahead,
					behind: changes.behind,
					committed,
					uncommitted,
					commands: commandsRepo.forProject(project.id).map(toCommand),
				};
			},

			fileDiff: async ({ id, path, base }) => {
				const row = worktreesRepo.get(id);
				if (!row) return { path, binary: false, diff: "" };
				const { binary, text } = await gitFileDiff(row.path, path, base);
				return { path, binary, diff: text };
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
				return {
					branch: entry?.branch ?? null,
					path: row.path,
					isPrimary,
					uncommitted: changes.uncommitted.length,
					unmerged: changes.ahead,
					base: usableBase,
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
					await gitDeleteBranch(project.path, branch); // best-effort
				}
				return { ok: true };
			},

			branchStatus: async ({ projectId }) => {
				const project = projectsRepo.get(projectId);
				const base = project
					? await resolveBaseBranch(project.path, null)
					: null;
				if (!project || !base) {
					return { branch: base, ahead: 0, behind: 0, hasRemote: false };
				}
				const t = await branchTracking(project.path, base);
				return { branch: base, ...t };
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

			createWorktree: async ({ projectId, name, base, location }) => {
				const project = projectsRepo.get(projectId);
				if (!project) return { ok: false, error: "Project not found" };

				// No explicit name: if basing off a remote branch (origin/foo), check
				// out that branch (named `foo`) so the worktree reflects it; otherwise
				// fall back to a generated name.
				const remoteBase = base && /^origin\//.test(base) ? base.slice("origin/".length) : null;
				const branch =
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

				const resolvedBase = await resolveBaseBranch(project.path, base);
				const res = await gitAddWorktree(
					project.path,
					wtPath,
					branch,
					resolvedBase,
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

			listIntegrations: () => KNOWN_INTEGRATIONS.map(integrationStatus),

			setIntegration: ({ type, enabled, host, token }) => {
				const cfg = integrationConfig(type);
				cfg.host = host.trim() || DEFAULT_HOST[type];
				if (token !== null) cfg.token = token; // "" clears, null keeps
				integrationsRepo.upsert(type, enabled, JSON.stringify(cfg));
				return integrationStatus(type);
			},

			testIntegration: async ({ type, host, token }) => {
				const cfg = integrationConfig(type);
				const useHost = host.trim() || cfg.host;
				const useToken = token !== null ? token : cfg.token;
				if (!useToken) return { ok: false, error: "No token provided" };
				return gitlabTest({ host: useHost, token: useToken });
			},

			branchIntegrations: async ({ projectId, branch }) => {
				const out: BranchIntegrations = {};
				const project = projectsRepo.get(projectId);
				if (!project || !branch) return out;
				const row = integrationsRepo.get("gitlab");
				if (row?.enabled) {
					const cfg = integrationConfig("gitlab");
					if (cfg.token) {
						const status = await gitlabBranchStatus(cfg, project.path, branch);
						if (status) out.gitlab = status;
					}
				}
				return out;
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
				});
				return ok ? { ok: true } : { ok: false, error: "Session already running" };
			},

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
			agentChatRespond(msg.sessionId, msg.requestId, msg.allow);
			break;
		case "agentChatElicit":
			agentChatElicit(msg.sessionId, msg.id, msg.action, msg.content);
			break;
		case "agentChatSetMode":
			agentChatSetMode(msg.sessionId, msg.permissionMode);
			break;
		case "agentChatCancel":
			agentChatCancel(msg.sessionId);
			break;
		case "agentChatStop":
			agentChatStop(msg.sessionId);
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
	const handler = handlers[method] as (p: unknown) => unknown;
	return handler(params);
});
ipcMain.on("message", (_event, msg: ViewMessage) => dispatchMessage(msg));

// Stream PTY output / exit from the main process to the renderer.
setTerminalCallbacks({
	onData: (sessionId, data) => broadcast({ type: "termData", sessionId, data }),
	onExit: (sessionId, exitCode) =>
		broadcast({ type: "termExit", sessionId, exitCode }),
});

// Stream normalized chat-agent events from the main process to the renderer.
setAgentChatCallback((sessionId, event) =>
	broadcast({ type: "agentChatEvent", sessionId, event }),
);

function createWindow(): void {
	const win = new BrowserWindow({
		title: "Forest Ranger",
		width: 1100,
		height: 760,
		x: 200,
		y: 200,
		// Transparent titlebar with inset native traffic-light controls; we draw
		// our own dark titlebar strip and mark it as a drag region in the renderer.
		titleBarStyle: "hiddenInset",
		trafficLightPosition: { x: 12, y: 14 },
		webPreferences: {
			preload: join(__dirname, "../preload/index.js"),
		},
	});

	if (process.env.ELECTRON_RENDERER_URL) {
		win.loadURL(process.env.ELECTRON_RENDERER_URL);
	} else {
		win.loadFile(join(__dirname, "../renderer/index.html"));
	}
}

app.whenReady().then(() => {
	// Standard app/edit/window menus give us the native clipboard + selection
	// shortcuts (⌘A/⌘C/⌘X/⌘V/⌘Z) wired to whatever field has focus.
	Menu.setApplicationMenu(
		Menu.buildFromTemplate([
			{ role: "appMenu" },
			{ role: "editMenu" },
			{ role: "windowMenu" },
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
