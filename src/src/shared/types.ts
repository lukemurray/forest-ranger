import type { RPCSchema } from "electrobun/bun";

/** A git repository the user has added to Forest Ranger. */
export type Project = {
	id: string;
	name: string;
	/** Absolute path to the primary working tree (repo toplevel). */
	path: string;
	addedAt: number;
	lastOpenedAt: number | null;
};

/** A single git worktree belonging to a project. */
export type Worktree = {
	id: string;
	projectId: string;
	/** Absolute path to the worktree directory. */
	path: string;
	/** Short branch name, or null when detached. */
	branch: string | null;
	/** Current HEAD commit sha. */
	head: string | null;
	isPrimary: boolean;
	isDetached: boolean;
	isLocked: boolean;
	/** When the user last opened this worktree from within Forest Ranger. */
	lastOpenedAt: number | null;
	/**
	 * Last real change in the worktree (committed or uncommitted), as a ms
	 * timestamp. This is what drives recency ordering.
	 */
	lastActivityAt: number;
};

/** A worktree flattened with its owning project, for the "recent" view. */
export type WorktreeWithProject = Worktree & {
	projectName: string;
	projectPath: string;
};

/** Outcome of an "add project" attempt, so the UI can give clear feedback. */
export type AddProjectResult =
	| { status: "added"; project: Project }
	| { status: "exists"; project: Project }
	| { status: "cancelled" }
	| { status: "not-a-repo"; path: string }
	| { status: "git-missing" };

/**
 * RPC contract between the Bun main process and the webview.
 * `bun` = handlers that live in the main process (called from the view).
 * `webview` = handlers that live in the view (called from the main process).
 */
export type AppRPC = {
	bun: RPCSchema<{
		requests: {
			listProjects: { params: Record<string, never>; response: Project[] };
			/** Opens a folder picker; validates it's a git repo and stores it. */
			addProject: { params: Record<string, never>; response: AddProjectResult };
			removeProject: { params: { id: string }; response: void };
			/** Live `git worktree list` for one project, merged with stored recency. */
			listWorktrees: {
				params: { projectId: string };
				response: Worktree[];
			};
			recentWorktrees: {
				params: { limit: number };
				response: WorktreeWithProject[];
			};
			/** Mark a worktree (and its project) as just opened. */
			touchWorktree: { params: { id: string }; response: void };
			/** Reveal a path in the OS file manager. */
			revealInFinder: { params: { path: string }; response: void };
		};
		messages: Record<string, never>;
	}>;
	webview: RPCSchema<{
		requests: Record<string, never>;
		messages: {
			/** Bun tells the view that underlying data changed and to refetch. */
			dataChanged: { scope: "projects" | "worktrees" };
		};
	}>;
};
