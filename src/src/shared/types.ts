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

export type ChangeKind =
	| "modified"
	| "added"
	| "deleted"
	| "renamed"
	| "untracked"
	| "typechange"
	| "conflicted";

export type ChangedFile = {
	path: string;
	kind: ChangeKind;
	insertions: number | null;
	deletions: number | null;
};

/** A saved, runnable command for a project (e.g. "Run" → "npm run dev"). */
/** The global default for where a command/agent runs. */
export type RunTarget = "in-app" | "external";

/** A command's run target — "default" defers to the global setting. */
export type CommandRunTarget = "default" | "in-app" | "external";

export type ProjectCommand = {
	id: string;
	projectId: string;
	label: string;
	command: string;
	/** Subdirectory (relative to the worktree root) to run in; "" = root. */
	dir: string;
	runTarget: CommandRunTarget;
};

/** Everything the worktree detail view needs. */
export type WorktreeDetail = {
	worktree: Worktree;
	projectId: string;
	projectName: string;
	branch: string | null;
	/** The base branch changes are computed against (null if none available). */
	base: string | null;
	/** Local branches selectable as the base. */
	branches: string[];
	/** Commits ahead / behind the base. */
	ahead: number;
	behind: number;
	/** Committed branch work vs the base. */
	committed: ChangedFile[];
	/** Uncommitted working-tree edits (incl. untracked). */
	uncommitted: ChangedFile[];
	commands: ProjectCommand[];
};

/** Raw unified diff for a file; the view parses & renders it. */
export type FileDiff = { path: string; binary: boolean; diff: string };

/** Apps a worktree can be opened in. */
export type AppId =
	| "cursor"
	| "vscode"
	| "zed"
	| "ghostty"
	| "iterm"
	| "warp"
	| "terminal"
	| "finder";

/** An installed app the worktree can be opened with. */
export type OpenApp = {
	id: AppId;
	label: string;
	kind: "editor" | "terminal" | "system";
};

export type OpenResult = { ok: boolean; error?: string };

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
			/** Installed editors/terminals a worktree can be opened in. */
			detectApps: { params: Record<string, never>; response: OpenApp[] };
			/** Open a worktree path in the given app. */
			openWorktree: {
				params: { path: string; app: AppId };
				response: OpenResult;
			};
			/** Full detail (changes summary + files) for one worktree. */
			worktreeDetail: {
				params: { id: string; base: string | null };
				response: WorktreeDetail | null;
			};
			/** Unified diff for one changed file in a worktree (vs base if given). */
			fileDiff: {
				params: { id: string; path: string; base: string | null };
				response: FileDiff;
			};

			/** Pre-flight info for removing a worktree (safety check). */
			worktreeRemovalInfo: {
				params: { id: string };
				response: {
					branch: string | null;
					path: string;
					isPrimary: boolean;
					uncommitted: number;
					unmerged: number;
					base: string | null;
				} | null;
			};
			/** Remove a worktree; optionally force and delete its branch. */
			removeWorktree: {
				params: { id: string; force: boolean; deleteBranch: boolean };
				response: { ok: boolean; error?: string };
			};

			/** Whether the project's default branch is behind its remote. */
			branchStatus: {
				params: { projectId: string };
				response: {
					branch: string | null;
					ahead: number;
					behind: number;
					hasRemote: boolean;
				};
			};
			/** Fetch origin and fast-forward the default branch. */
			fetchProject: {
				params: { projectId: string };
				response: { ok: boolean; error?: string };
			};

			/** Local branches, default base, and where new worktrees will go. */
			projectBranches: {
				params: { projectId: string };
				response: {
					branches: string[];
					base: string | null;
					worktreeDir: string;
				};
			};
			/**
			 * Create a worktree (new branch off base). name="" auto-generates.
			 * `location` is the parent dir for the worktree (persisted as the
			 * project's default); null uses the project's stored/detected location.
			 */
			createWorktree: {
				params: {
					projectId: string;
					name: string;
					base: string | null;
					location: string | null;
				};
				response: {
					ok: boolean;
					worktreeId?: string;
					path?: string;
					error?: string;
				};
			};

			listCommands: {
				params: { projectId: string };
				response: ProjectCommand[];
			};
			addCommand: {
				params: {
					projectId: string;
					label: string;
					command: string;
					dir: string;
					runTarget: CommandRunTarget;
				};
				response: ProjectCommand;
			};
			updateCommand: {
				params: {
					id: string;
					label: string;
					command: string;
					dir: string;
					runTarget: CommandRunTarget;
				};
				response: void;
			};
			removeCommand: { params: { id: string }; response: void };
			/** Run a saved command in a worktree directory via the given app. */
			runCommand: {
				params: { id: string; cwd: string; app: AppId };
				response: OpenResult;
			};
			/** Run an arbitrary command (e.g. an agent) in an external terminal. */
			runExternal: {
				params: { cwd: string; command: string; app: AppId };
				response: OpenResult;
			};
			/** Start an in-app PTY session (view supplies the sessionId). */
			termStart: {
				params: {
					sessionId: string;
					worktreeId: string;
					/** Run a saved project command... */
					commandId: string | null;
					/** ...or an explicit command (e.g. an agent CLI). Takes precedence. */
					command: string | null;
					cols: number;
					rows: number;
				};
				response: OpenResult;
			};
		};
		messages: {
			/** Keystrokes/input for a PTY session (base64 or raw). */
			termInput: { sessionId: string; data: string };
			termResize: { sessionId: string; cols: number; rows: number };
			termKill: { sessionId: string };
		};
	}>;
	webview: RPCSchema<{
		requests: Record<string, never>;
		messages: {
			/** Bun tells the view that underlying data changed and to refetch. */
			dataChanged: { scope: "projects" | "worktrees" };
			/** PTY output (base64) for a session. */
			termData: { sessionId: string; data: string };
			termExit: { sessionId: string; exitCode: number };
		};
	}>;
};
