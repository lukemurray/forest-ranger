import { BrowserView, BrowserWindow, Updater, Utils } from "electrobun/bun";
import { basename } from "node:path";
import type { AppRPC, Project, Worktree, WorktreeWithProject } from "../shared/types";
import { projectsRepo, worktreesRepo, type ProjectRow } from "./db";
import {
	gitVersion,
	listWorktrees as gitListWorktrees,
	resolveRepoToplevel,
	worktreeActivity,
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
		},
		messages: {},
	},
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
