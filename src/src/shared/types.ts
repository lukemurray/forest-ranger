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
	/** Commits the local branch is ahead / behind its tracking branch. */
	upstreamAhead: number;
	upstreamBehind: number;
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

/** A one-line commit summary for the recent-activity list. */
export type CommitSummary = { hash: string; subject: string; author: string; relative: string };

/** A branch across the repo + origin, with any worktrees that have it checked out. */
export type BranchSummary = {
	/** Short branch name (e.g. "feature/foo"). */
	name: string;
	/** Exists as a local branch. */
	local: boolean;
	/** Exists on origin. */
	remote: boolean;
	/** Worktrees that currently have this branch checked out (0..n). */
	worktrees: { id: string; path: string }[];
	/** Most recent commit time (ms), for sorting; null if unknown. */
	lastCommitAt: number | null;
	/** Commits ahead / behind the base branch; null if not computable. */
	ahead: number | null;
	behind: number | null;
	/** The base branch ahead/behind are measured against (e.g. "master"). */
	base: string | null;
};

// --- native chat agents ---

/**
 * A normalized event from a native chat agent session. Each backend driver
 * (Claude Code first; others as adapters) maps its own protocol onto this so
 * the view renders one event model regardless of which CLI is driving.
 */
/** A file/image the user attaches to a chat message (data is base64, no prefix). */
export type ChatAttachment = { name: string; mediaType: string; data: string };

/** One field in a structured elicitation form (normalized from ACP's schema). */
export type ElicitationField = {
	key: string;
	label: string;
	description?: string;
	required: boolean;
	input: "text" | "number" | "integer" | "boolean" | "select" | "multiselect";
	/** For select/multiselect. */
	options?: { value: string; label: string }[];
	default?: string | number | boolean | string[];
};

/** A value the user provides for an elicitation field. */
export type ElicitationValue = string | number | boolean | string[];

/** Status of a plan entry (mirrors ACP). */
export type PlanEntryStatus = "pending" | "in_progress" | "completed";

/** A session mode the agent advertises (e.g. Claude's permission modes). */
export type AgentMode = { id: string; name: string; description?: string };

/** A live, agent-advertised session setting (model, mode, effort, …) — ACP config option. */
export type ConfigOption = {
	id: string;
	name: string;
	/** UX grouping hint from the agent (e.g. "model", "mode", "thought_level"). */
	category?: string;
	currentValue: string;
	options: { value: string; label: string; description?: string }[];
};

/** One choice offered for a tool-permission request (mirrors ACP option kinds). */
export type PermissionOption = {
	id: string;
	label: string;
	kind: "allow_once" | "allow_always" | "reject_once" | "reject_always";
};

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
	/** The agent needs permission to run a tool; the user picks one of the options. */
	| {
			type: "permission";
			id: string;
			toolName: string;
			input: unknown;
			options: PermissionOption[];
	  }
	/** A pending permission request was answered (for replay/UI state). */
	| { type: "permission_resolved"; id: string; label: string }
	/** The agent is asking the user for structured input (a form) or to visit a URL. */
	| {
			type: "elicitation";
			id: string;
			mode: "form" | "url";
			message: string;
			fields: ElicitationField[];
			url?: string;
	  }
	/** A pending elicitation was answered/dismissed (for replay/UI state). */
	| { type: "elicitation_resolved"; id: string }
	/** The agent's current task plan (replaces any prior plan). */
	| { type: "plan"; entries: { content: string; status: PlanEntryStatus }[] }
	/** Slash commands the agent currently supports. */
	| { type: "commands"; commands: { name: string; description: string }[] }
	/** The agent's session modes (advertised) + which is current. */
	| { type: "modes"; current: string | null; available: AgentMode[] }
	/** Live agent-advertised settings (model/mode/effort/…); full set each time. */
	| { type: "configOptions"; options: ConfigOption[] }
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

/** Which agent backend drives a chat (each maps to an ACP adapter). */
export type AgentProvider = "claude" | "codex";

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
/**
 * RPC contract between the renderer and the Electron main process.
 * `RpcRequests` = request/response calls (`ipcRenderer.invoke`).
 * `ViewMessage` = fire-and-forget renderer→main. `MainEvent` = main→renderer push.
 */
export type RpcRequests = {
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
					/** Commits that exist only locally (ahead of upstream, or of base if no remote). */
					unpushed: number;
					/** Whether the branch has an upstream/tracking branch. */
					hasUpstream: boolean;
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
					/** The most recent commits on the base branch (newest first). */
					recent: CommitSummary[];
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
			/** All branches (local + origin) with worktree linkage, for the project view. */
			projectBranchGraph: {
				params: { projectId: string };
				response: BranchSummary[];
			};
			/** Rename a local branch (git branch -m). Leaves the worktree path alone. */
			renameBranch: {
				params: { projectId: string; from: string; to: string };
				response: { ok: boolean; error?: string };
			};
			/** Delete a local branch (force = discard unmerged work). */
			deleteBranch: {
				params: { projectId: string; branch: string; force: boolean };
				response: { ok: boolean; error?: string };
			};
			/** Delete several local branches; reports which succeeded and which were skipped. */
			deleteBranches: {
				params: { projectId: string; branches: string[]; force: boolean };
				response: { deleted: string[]; failed: { branch: string; error: string }[] };
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
					/** Which agent backend drives this chat. */
					provider: AgentProvider;
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
					provider: AgentProvider;
					permissionMode: AgentPermissionMode;
					model: string | null;
				};
				response: OpenResult;
			};
};

/** Fire-and-forget messages from the renderer to the main process. */
export type ViewMessage =
	/** Keystrokes/input for a PTY session (base64 or raw). */
	| { type: "termInput"; sessionId: string; data: string }
	| { type: "termResize"; sessionId: string; cols: number; rows: number }
	| { type: "termKill"; sessionId: string }
	/** Send a user turn to a chat agent session, with optional attachments. */
	| { type: "agentChatSend"; sessionId: string; text: string; attachments?: ChatAttachment[] }
	/** Answer a pending tool-permission request with the chosen option. */
	| { type: "agentChatPermission"; sessionId: string; requestId: string; optionId: string }
	/** Answer a pending elicitation (submit form values, decline, or cancel). */
	| {
			type: "agentChatElicit";
			sessionId: string;
			id: string;
			action: "accept" | "decline" | "cancel";
			content?: Record<string, ElicitationValue>;
	  }
	/** Change a live session's permission mode without relaunching the agent. */
	| { type: "agentChatSetMode"; sessionId: string; permissionMode: AgentPermissionMode }
	/** Switch the agent's advertised session mode (ACP session/set_mode). */
	| { type: "agentChatSetSessionMode"; sessionId: string; modeId: string }
	/** Set a live agent config option (model/mode/effort/…) via ACP. */
	| { type: "agentChatSetConfigOption"; sessionId: string; configId: string; value: string }
	/** Cancel the in-flight turn but keep the session alive (the Stop button). */
	| { type: "agentChatCancel"; sessionId: string }
	/** Stop (kill) a chat agent session. History on disk is preserved for reopen. */
	| { type: "agentChatStop"; sessionId: string };

/** Push events from the main process to the renderer. */
export type MainEvent =
	/** Underlying data changed; the view should refetch. */
	| { type: "dataChanged"; scope: "projects" | "worktrees" }
	/** PTY output (base64) for a session. */
	| { type: "termData"; sessionId: string; data: string }
	| { type: "termExit"; sessionId: string; exitCode: number }
	/** A normalized event from a native chat agent session. */
	| { type: "agentChatEvent"; sessionId: string; event: AgentChatEvent };

/** The bridge the preload exposes on `window` for the renderer. */
export type ForestRangerBridge = {
	invoke: <M extends keyof RpcRequests>(
		method: M,
		params: RpcRequests[M]["params"],
	) => Promise<RpcRequests[M]["response"]>;
	send: (message: ViewMessage) => void;
	onEvent: (handler: (event: MainEvent) => void) => () => void;
};
