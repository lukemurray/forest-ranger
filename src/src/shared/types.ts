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
	/** uncommitted only: the file currently has staged changes in the index. */
	staged: boolean;
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
	/** The upstream/tracking branch (e.g. `origin/foo`), or null if not tracking. */
	upstream: string | null;
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

// --- native chat agents ---

/**
 * A normalized event from a native chat agent session. Each backend driver
 * (Claude Code first; others as adapters) maps its own protocol onto this so
 * the view renders one event model regardless of which CLI is driving.
 */
/** A file/image the user attaches to a chat message (data is base64, no prefix). */
export type ChatAttachment = { name: string; mediaType: string; data: string };

export type AgentChatEvent =
	/** Session is up; carries the agent's own session id (for resume) + model. */
	| { type: "system"; sessionId: string | null; model: string | null }
	/** The user's own turn, echoed so it's buffered/replayed on reattach. */
	| { type: "user_text"; text: string; attachments?: { name: string; isImage: boolean }[] }
	/** A chunk of assistant prose. */
	| { type: "assistant_text"; text: string }
	/** A chunk of the agent's thinking. */
	| { type: "thinking"; text: string }
	/** The agent invoked a tool. */
	| { type: "tool_use"; id: string; name: string; input: unknown }
	/** A tool returned. `summary` is a short, display-ready result string. */
	| { type: "tool_result"; id: string; ok: boolean; summary: string }
	/** The turn finished (agent is idle, awaiting the next user message). */
	| { type: "result"; ok: boolean; durationMs: number | null }
	/** The agent needs permission to run a tool; the user must allow or deny. */
	| { type: "permission"; id: string; toolName: string; input: unknown }
	/** A pending permission request was answered (for replay/UI state). */
	| { type: "permission_resolved"; id: string; allow: boolean }
	/** Something went wrong (spawn failure, bad output, process died). */
	| { type: "error"; message: string }
	/** The underlying process exited; the session is no longer running. */
	| { type: "exited"; code: number };

/** How a chat agent handles tool-permission prompts (mirrors Claude Code modes). */
export type AgentPermissionMode =
	| "default"
	| "acceptEdits"
	| "plan"
	| "bypassPermissions";

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

// --- integrations ---

/** A connectable external service. GitLab is the first; more can follow. */
export type IntegrationType = "gitlab";

/** Settings-facing status of an integration (never ships the token itself). */
export type IntegrationStatus = {
	type: IntegrationType;
	enabled: boolean;
	host: string;
	hasToken: boolean;
};

/** GitLab MR + pipeline status for one branch. */
export type GitLabBranchStatus = {
	/** Web URL of the GitLab project this repo maps to. */
	projectUrl: string | null;
	mr: { iid: number; title: string; state: string; url: string } | null;
	pipeline: { status: string; url: string } | null;
	/** Set when the lookup failed (e.g. bad token); UI can show it quietly. */
	error?: string;
};

/** Per-branch status gathered from all enabled integrations. */
export type BranchIntegrations = { gitlab?: GitLabBranchStatus };

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
			/** Open a URL in the user's default browser. */
			openUrl: { params: { url: string }; response: OpenResult };

			/** Stage paths in a worktree (empty paths = stage all). */
			stageFiles: { params: { id: string; paths: string[] }; response: OpenResult };
			/** Unstage paths in a worktree (empty paths = unstage all). */
			unstageFiles: { params: { id: string; paths: string[] }; response: OpenResult };
			/** Commit the staged index in a worktree. */
			commitChanges: {
				params: { id: string; message: string };
				response: { ok: boolean; error?: string };
			};

			/** Configured integrations (GitLab, …) with enable + token state. */
			listIntegrations: {
				params: Record<string, never>;
				response: IntegrationStatus[];
			};
			/** Save an integration. token=null keeps the stored token; "" clears it. */
			setIntegration: {
				params: {
					type: IntegrationType;
					enabled: boolean;
					host: string;
					token: string | null;
				};
				response: IntegrationStatus;
			};
			/** Test an integration's credentials. token=null uses the stored token. */
			testIntegration: {
				params: { type: IntegrationType; host: string; token: string | null };
				response: { ok: boolean; user?: string; error?: string };
			};
			/** MR/pipeline status for a branch from every enabled integration. */
			branchIntegrations: {
				params: { projectId: string; branch: string };
				response: BranchIntegrations;
			};

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

			/**
			 * Start a native chat agent session (Claude Code, driven via stream-json).
			 * The view supplies `sessionId` (also used as the agent's session id, so
			 * the same conversation can be resumed). Events stream back via
			 * `agentChatEvent`.
			 */
			agentChatStart: {
				params: {
					sessionId: string;
					worktreeId: string;
					/** Resume the prior conversation under this session id. */
					resume: boolean;
					permissionMode: AgentPermissionMode;
					/** Model alias/name, or null for the agent's default. */
					model: string | null;
				};
				response: OpenResult;
			};
			/**
			 * Switch a live chat's model/permission mode without losing context:
			 * stops and relaunches the agent with `--resume`.
			 */
			agentChatRestart: {
				params: {
					sessionId: string;
					worktreeId: string;
					permissionMode: AgentPermissionMode;
					model: string | null;
				};
				response: OpenResult;
			};
		};
		messages: {
			/** Keystrokes/input for a PTY session (base64 or raw). */
			termInput: { sessionId: string; data: string };
			termResize: { sessionId: string; cols: number; rows: number };
			termKill: { sessionId: string };

			/** Send a user turn to a chat agent session, with optional attachments. */
			agentChatSend: { sessionId: string; text: string; attachments?: ChatAttachment[] };
			/** Answer a pending tool-permission request (allow or deny). */
			agentChatPermission: { sessionId: string; requestId: string; allow: boolean };
			/** Stop (kill) a chat agent session. */
			agentChatStop: { sessionId: string };
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
			/** A normalized event from a native chat agent session. */
			agentChatEvent: { sessionId: string; event: AgentChatEvent };
		};
	}>;
};
