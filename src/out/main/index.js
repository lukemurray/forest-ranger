//#region \0rolldown/runtime.js
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));
//#endregion
let electron = require("electron");
let node_crypto = require("node:crypto");
let node_fs = require("node:fs");
let node_os = require("node:os");
let node_path = require("node:path");
let node_child_process = require("node:child_process");
let node_pty = require("node-pty");
node_pty = __toESM(node_pty);
let better_sqlite3 = require("better-sqlite3");
better_sqlite3 = __toESM(better_sqlite3);
//#region src/main/apps.ts
/** Detect installed editors/terminals and open worktrees in them (macOS). */
var SEARCH_DIRS = [
	"/Applications",
	(0, node_path.join)((0, node_os.homedir)(), "Applications"),
	"/System/Applications",
	"/System/Applications/Utilities"
];
var CATALOG = [
	{
		id: "cursor",
		label: "Cursor",
		bundle: "Cursor",
		kind: "editor"
	},
	{
		id: "vscode",
		label: "VS Code",
		bundle: "Visual Studio Code",
		kind: "editor"
	},
	{
		id: "zed",
		label: "Zed",
		bundle: "Zed",
		kind: "editor"
	},
	{
		id: "ghostty",
		label: "Ghostty",
		bundle: "Ghostty",
		kind: "terminal"
	},
	{
		id: "iterm",
		label: "iTerm",
		bundle: "iTerm",
		kind: "terminal"
	},
	{
		id: "warp",
		label: "Warp",
		bundle: "Warp",
		kind: "terminal"
	},
	{
		id: "terminal",
		label: "Terminal",
		bundle: "Terminal",
		kind: "terminal"
	}
];
var BUNDLE_BY_ID = new Map(CATALOG.map((a) => [a.id, a.bundle]));
function isInstalled(bundle) {
	return SEARCH_DIRS.some((dir) => (0, node_fs.existsSync)((0, node_path.join)(dir, `${bundle}.app`)));
}
var cached = null;
/** Installed editors/terminals, plus Finder (always available). Cached per run. */
function detectApps() {
	if (cached) return cached;
	const apps = CATALOG.filter((a) => isInstalled(a.bundle)).map(({ id, label, kind }) => ({
		id,
		label,
		kind
	}));
	apps.push({
		id: "finder",
		label: "Finder",
		kind: "system"
	});
	cached = apps;
	return apps;
}
function shQuote(s) {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}
function appleScriptStr(s) {
	return `"${s.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}
/**
* Write a self-contained launcher script that cd's into `cwd`, runs `command`,
* then drops into an interactive shell so output (and dev servers) stay visible.
* Handing terminals a single executable file avoids all the per-terminal arg
* quoting/`-e` fragility. Returns the script path (a `.command` so a bare `open`
* routes it to the default terminal handler).
*/
function writeRunScript(cwd, command) {
	const shell = process.env.SHELL || "/bin/zsh";
	const file = (0, node_path.join)((0, node_fs.mkdtempSync)((0, node_path.join)((0, node_os.tmpdir)(), "forest-ranger-run-")), "run.command");
	const launch = `${command}; exec ${shell} -i`;
	(0, node_fs.writeFileSync)(file, `#!/bin/sh\ncd ${shQuote(cwd)} || exit 1\nexec ${shell} -l -c ${shQuote(launch)}\n`, { mode: 493 });
	return file;
}
/**
* Build the argv that launches `scriptPath` in a terminal app. Pure (testable).
* Terminal/iTerm via AppleScript; Ghostty runs the script as its `-e` target;
* anything else (incl. Warp) falls back to the default `.command` handler.
*/
function terminalArgv(app, scriptPath) {
	if (app === "ghostty") return [
		"open",
		"-na",
		"Ghostty",
		"--args",
		"-e",
		scriptPath
	];
	if (app === "iterm") return [
		"osascript",
		"-e",
		[
			"tell application \"iTerm\"",
			"activate",
			"set w to (create window with default profile)",
			`tell current session of w to write text ${appleScriptStr(shQuote(scriptPath))}`,
			"end tell"
		].join("\n")
	];
	if (app === "terminal") return [
		"osascript",
		"-e",
		[
			"tell application \"Terminal\"",
			"activate",
			`do script ${appleScriptStr(shQuote(scriptPath))}`,
			"end tell"
		].join("\n")
	];
	return ["open", scriptPath];
}
/** Run a shell command in a worktree directory via the chosen terminal app. */
function runInTerminal(app, cwd, command) {
	try {
		const [cmd, ...args] = terminalArgv(app, writeRunScript(cwd, command));
		const proc = (0, node_child_process.spawnSync)(cmd, args, { stdio: [
			"ignore",
			"ignore",
			"pipe"
		] });
		if (proc.status !== 0) return {
			ok: false,
			error: proc.stderr?.toString().trim() || "Failed to launch terminal"
		};
		return { ok: true };
	} catch (err) {
		return {
			ok: false,
			error: String(err)
		};
	}
}
function openWorktree(path, app) {
	try {
		const argv = app === "finder" ? ["open", path] : [
			"open",
			"-a",
			BUNDLE_BY_ID.get(app) ?? "",
			path
		];
		if (app !== "finder" && !BUNDLE_BY_ID.has(app)) return {
			ok: false,
			error: `Unknown app: ${app}`
		};
		const [cmd, ...args] = argv;
		const proc = (0, node_child_process.spawnSync)(cmd, args, { stdio: [
			"ignore",
			"ignore",
			"pipe"
		] });
		if (proc.status !== 0) return {
			ok: false,
			error: proc.stderr?.toString().trim() || `Couldn't open ${app}`
		};
		return { ok: true };
	} catch (err) {
		return {
			ok: false,
			error: String(err)
		};
	}
}
//#endregion
//#region src/main/terminals.ts
/** PTY-backed terminal sessions using node-pty. */
var BUFFER_CAP = 256 * 1024;
var sessions$1 = /* @__PURE__ */ new Map();
var cb = null;
/** Wire the main->renderer push callbacks (set once at startup). */
function setTerminalCallbacks(callbacks) {
	cb = callbacks;
}
/**
* Start a login+interactive shell in `cwd` with a real PTY. If `command` is
* given, it's typed into the shell so it runs immediately and the shell stays
* open afterward (so output/dev servers persist and stay interactive).
*/
function startSession$1(opts) {
	const { sessionId, cwd, command, cols, rows } = opts;
	const existing = sessions$1.get(sessionId);
	if (existing) {
		if (existing.chunks.length > 0) cb?.onData(sessionId, Buffer.concat(existing.chunks).toString("base64"));
		return;
	}
	const shell = process.env.SHELL || "/bin/zsh";
	const proc = node_pty.spawn(shell, ["-il"], {
		name: "xterm-256color",
		cols,
		rows,
		cwd,
		env: {
			...process.env,
			TERM: "xterm-256color"
		}
	});
	const session = {
		proc,
		chunks: [],
		size: 0
	};
	sessions$1.set(sessionId, session);
	proc.onData((data) => {
		const b = Buffer.from(data, "utf8");
		session.chunks.push(b);
		session.size += b.length;
		while (session.size > BUFFER_CAP && session.chunks.length > 1) session.size -= session.chunks.shift().length;
		cb?.onData(sessionId, b.toString("base64"));
	});
	proc.onExit(({ exitCode }) => {
		sessions$1.delete(sessionId);
		cb?.onExit(sessionId, exitCode);
	});
	if (command) setTimeout(() => write(sessionId, `${command}\n`), 60);
}
function write(sessionId, data) {
	sessions$1.get(sessionId)?.proc.write(data);
}
function resize(sessionId, cols, rows) {
	try {
		sessions$1.get(sessionId)?.proc.resize(cols, rows);
	} catch {}
}
function kill(sessionId) {
	const s = sessions$1.get(sessionId);
	if (!s) return;
	closeProc(s.proc);
	sessions$1.delete(sessionId);
}
/** Kill every live session — used when the app is quitting. */
function killAll$1() {
	for (const s of sessions$1.values()) closeProc(s.proc);
	sessions$1.clear();
}
function closeProc(proc) {
	try {
		proc.kill();
	} catch {}
}
//#endregion
//#region src/main/agentChat.ts
/**
* Native chat agent sessions. Unlike the PTY terminals, these drive a CLI agent
* in a structured, headless mode (Claude Code's stream-json protocol) and emit a
* normalized {@link AgentChatEvent} stream the view renders as a chat UI.
*
* Sessions live in the main process so they survive renderer reloads/HMR. Only
* Claude Code is implemented today; other agents slot in behind {@link AgentDriver}.
*/
var CHAT_DIR = (0, node_path.join)(process.env.FOREST_RANGER_DATA_DIR || (0, node_path.join)((0, node_os.homedir)(), ".forest-ranger"), "chats");
function chatFile(sessionId) {
	return (0, node_path.join)(CHAT_DIR, `${sessionId}.json`);
}
var persistTimers = /* @__PURE__ */ new Map();
function schedulePersist(sessionId) {
	const existing = persistTimers.get(sessionId);
	if (existing) clearTimeout(existing);
	persistTimers.set(sessionId, setTimeout(() => {
		persistTimers.delete(sessionId);
		const buf = buffers.get(sessionId);
		if (!buf) return;
		try {
			(0, node_fs.mkdirSync)(CHAT_DIR, { recursive: true });
			(0, node_fs.writeFileSync)(chatFile(sessionId), JSON.stringify(buf));
		} catch {}
	}, 400));
}
/** Load a persisted log, dropping process-lifecycle events that shouldn't replay. */
function loadPersisted(sessionId) {
	try {
		const raw = (0, node_fs.readFileSync)(chatFile(sessionId), "utf8");
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return null;
		return parsed.filter((e) => e.type !== "exited");
	} catch {
		return null;
	}
}
function deletePersisted(sessionId) {
	const timer = persistTimers.get(sessionId);
	if (timer) clearTimeout(timer);
	persistTimers.delete(sessionId);
	try {
		(0, node_fs.rmSync)(chatFile(sessionId), { force: true });
	} catch {}
}
var AUGMENTED_PATH$1 = [
	process.env.PATH ?? "",
	`${(0, node_os.homedir)()}/.local/bin`,
	`${(0, node_os.homedir)()}/.claude/local`,
	"/opt/homebrew/bin",
	"/usr/local/bin",
	"/usr/bin",
	"/bin"
].filter(Boolean).join(":");
var sessions = /* @__PURE__ */ new Map();
/**
* Per-session event log, retained while the session is alive so a webview that
* remounts/reloads (worktree nav, HMR, full reload) can replay the conversation
* from the still-running main process. Mirrors the terminal scrollback buffer.
*/
var buffers = /* @__PURE__ */ new Map();
var MAX_BUFFER = 5e3;
/** Active process per session — used to ignore a superseded process's exit
* (e.g. after a model/mode switch restarts the agent with `--resume`). */
var procs = /* @__PURE__ */ new Map();
var emitGlobal = null;
/** An emitter that records events to the session's buffer, then pushes them out. */
function emitterFor(sessionId) {
	return (event) => {
		const buf = buffers.get(sessionId);
		if (buf) {
			buf.push(event);
			if (buf.length > MAX_BUFFER) buf.shift();
			schedulePersist(sessionId);
		}
		emitGlobal?.(sessionId, event);
	};
}
/** Re-push a live session's buffered events to the (re)subscribed view. */
function replay(sessionId) {
	const buf = buffers.get(sessionId);
	if (!buf) return;
	for (const event of buf) emitGlobal?.(sessionId, event);
}
/** Wire the bun->webview push callback (set once at startup). */
function setAgentChatCallback(fn) {
	emitGlobal = fn;
}
/**
* Start a Claude Code chat session, or reattach to a live one. If the session is
* already running in this process (e.g. the webview reloaded), we replay its
* buffered history instead of spawning a second process. Always returns true.
*/
function startSession(opts) {
	if (sessions.has(opts.sessionId)) {
		replay(opts.sessionId);
		return true;
	}
	const persisted = opts.resume ? loadPersisted(opts.sessionId) : null;
	buffers.set(opts.sessionId, persisted ?? []);
	if (persisted && persisted.length > 0) replay(opts.sessionId);
	const driver = startClaudeCode(opts, emitterFor(opts.sessionId));
	sessions.set(opts.sessionId, driver);
	return true;
}
/**
* Switch model/permission mode mid-conversation: stop the current process and
* relaunch with `--resume` so the conversation continues. The buffered history
* is kept, and the superseded process's exit is ignored (see {@link procs}).
*/
function restart(opts) {
	sessions.get(opts.sessionId)?.stop();
	if (!buffers.has(opts.sessionId)) buffers.set(opts.sessionId, []);
	const emit = emitterFor(opts.sessionId);
	const driver = startClaudeCode({
		...opts,
		resume: true
	}, emit);
	sessions.set(opts.sessionId, driver);
}
function send(sessionId, text, attachments) {
	const driver = sessions.get(sessionId);
	if (!driver) return;
	emitterFor(sessionId)({
		type: "user_text",
		text,
		attachments: attachments?.length ? attachments.map((a) => ({
			name: a.name,
			isImage: a.mediaType.startsWith("image/")
		})) : void 0
	});
	driver.send(text, attachments);
}
/** Answer a pending tool-permission request for a session. */
function respondPermission(sessionId, requestId, allow) {
	sessions.get(sessionId)?.respond(requestId, allow);
}
function stop(sessionId) {
	sessions.get(sessionId)?.stop();
	sessions.delete(sessionId);
	procs.delete(sessionId);
	buffers.delete(sessionId);
	deletePersisted(sessionId);
}
/** Kill every live chat session — used when the app is quitting. */
function killAll() {
	try {
		(0, node_fs.mkdirSync)(CHAT_DIR, { recursive: true });
		for (const [sessionId, buf] of buffers) (0, node_fs.writeFileSync)(chatFile(sessionId), JSON.stringify(buf));
	} catch {}
	for (const t of persistTimers.values()) clearTimeout(t);
	persistTimers.clear();
	for (const d of sessions.values()) d.stop();
	sessions.clear();
	procs.clear();
	buffers.clear();
}
/** A user turn in Claude Code's stream-json input format (text + attachments). */
function userMessageLine(text, attachments = []) {
	const content = [];
	if (text) content.push({
		type: "text",
		text
	});
	for (const a of attachments) if (a.mediaType.startsWith("image/")) content.push({
		type: "image",
		source: {
			type: "base64",
			media_type: a.mediaType,
			data: a.data
		}
	});
	else {
		const decoded = decodeTextFile(a.data);
		content.push({
			type: "text",
			text: decoded != null ? `Attached file \`${a.name}\`:\n\`\`\`\n${decoded}\n\`\`\`` : `Attached file \`${a.name}\` (binary, not included).`
		});
	}
	if (content.length === 0) content.push({
		type: "text",
		text: ""
	});
	return `${JSON.stringify({
		type: "user",
		message: {
			role: "user",
			content
		}
	})}\n`;
}
/** Decode a base64 file to UTF-8 text, or null if it looks binary. */
function decodeTextFile(b64) {
	try {
		const s = Buffer.from(b64, "base64").toString("utf8");
		return s.includes("�") ? null : s;
	} catch {
		return null;
	}
}
function startClaudeCode(opts, emit) {
	const args = [
		"--print",
		"--input-format",
		"stream-json",
		"--output-format",
		"stream-json",
		"--verbose",
		"--include-partial-messages",
		"--permission-mode",
		opts.permissionMode,
		"--permission-prompt-tool",
		"stdio"
	];
	if (opts.resume) args.push("--resume", opts.sessionId);
	else args.push("--session-id", opts.sessionId);
	if (opts.model) args.push("--model", opts.model);
	let proc;
	try {
		proc = (0, node_child_process.spawn)("claude", args, {
			cwd: opts.cwd,
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			],
			env: {
				...process.env,
				PATH: AUGMENTED_PATH$1
			}
		});
	} catch (err) {
		emit({
			type: "error",
			message: `Failed to launch claude: ${err}`
		});
		return {
			send() {},
			respond() {},
			stop() {}
		};
	}
	proc.on("error", (err) => {
		if (procs.get(opts.sessionId) !== proc) return;
		emit({
			type: "error",
			message: `Failed to launch claude: ${err.message}`
		});
	});
	procs.set(opts.sessionId, proc);
	const pending = /* @__PURE__ */ new Map();
	const writeLine = (obj) => {
		try {
			proc.stdin?.write(`${JSON.stringify(obj)}\n`);
		} catch {}
	};
	writeLine({
		type: "control_request",
		request_id: `init-${crypto.randomUUID()}`,
		request: {
			subtype: "initialize",
			hooks: null
		}
	});
	pumpStdout(proc.stdout, emit, pending);
	captureStderr(proc.stderr);
	proc.on("exit", (code) => {
		if (procs.get(opts.sessionId) !== proc) return;
		procs.delete(opts.sessionId);
		sessions.delete(opts.sessionId);
		const exitCode = code ?? 0;
		if (code != null && code !== 0) emit({
			type: "error",
			message: `claude exited with code ${code}`
		});
		emit({
			type: "exited",
			code: exitCode
		});
	});
	return {
		send(text, attachments = []) {
			try {
				proc.stdin?.write(userMessageLine(text, attachments));
			} catch (err) {
				emit({
					type: "error",
					message: `Failed to send: ${err}`
				});
			}
		},
		respond(requestId, allow) {
			const input = pending.get(requestId) ?? {};
			pending.delete(requestId);
			writeLine({
				type: "control_response",
				response: {
					subtype: "success",
					request_id: requestId,
					response: allow ? {
						behavior: "allow",
						updatedInput: input
					} : {
						behavior: "deny",
						message: "Denied by the user."
					}
				}
			});
			emit({
				type: "permission_resolved",
				id: requestId,
				allow
			});
		},
		stop() {
			try {
				proc.stdin?.end();
			} catch {}
			try {
				proc.kill();
			} catch {}
		}
	};
}
/** Read stdout line-by-line, parse each NDJSON record, and emit normalized events. */
function pumpStdout(stream, emit, pending) {
	if (!stream) return;
	let buf = "";
	stream.setEncoding("utf8");
	stream.on("data", (chunk) => {
		buf += chunk;
		let nl;
		while ((nl = buf.indexOf("\n")) !== -1) {
			const line = buf.slice(0, nl).trim();
			buf = buf.slice(nl + 1);
			if (line) handleLine(line, emit, pending);
		}
	});
	stream.on("error", (err) => {
		emit({
			type: "error",
			message: `Stream read error: ${err}`
		});
	});
}
/** Keep recent stderr so a spawn/auth failure surfaces a useful message. */
function captureStderr(stream) {
	if (!stream) return;
	stream.setEncoding("utf8");
	stream.on("data", (chunk) => {
		const text = chunk.trim();
		if (text) console.error(`[agentChat] ${text}`);
	});
	stream.on("error", () => {});
}
/** Map one Claude Code stream-json record onto our normalized events. */
function handleLine(line, emit, pending) {
	let msg;
	try {
		msg = JSON.parse(line);
	} catch {
		return;
	}
	switch (msg.type) {
		case "control_request": {
			const req = msg.request;
			if (req?.subtype === "can_use_tool") {
				const id = String(msg.request_id);
				pending.set(id, req.input);
				emit({
					type: "permission",
					id,
					toolName: String(req.tool_name ?? "tool"),
					input: req.input
				});
			}
			return;
		}
		case "control_response": return;
		case "system":
			if (msg.subtype === "init") emit({
				type: "system",
				sessionId: msg.session_id ?? null,
				model: msg.model ?? null
			});
			return;
		case "assistant": {
			const content = blocksOf(msg);
			for (const b of content) if (b.type === "text" && typeof b.text === "string") emit({
				type: "assistant_text",
				text: b.text
			});
			else if (b.type === "thinking" && typeof b.thinking === "string") emit({
				type: "thinking",
				text: b.thinking
			});
			else if (b.type === "tool_use") emit({
				type: "tool_use",
				id: String(b.id),
				name: String(b.name),
				input: b.input
			});
			return;
		}
		case "user":
			for (const b of blocksOf(msg)) if (b.type === "tool_result") emit({
				type: "tool_result",
				id: String(b.tool_use_id),
				ok: !b.is_error,
				summary: summarize(b.content)
			});
			return;
		case "result":
			emit({
				type: "result",
				ok: !msg.is_error,
				durationMs: typeof msg.duration_ms === "number" ? msg.duration_ms : null
			});
			return;
		default: return;
	}
}
function blocksOf(msg) {
	const content = msg.message?.content;
	return Array.isArray(content) ? content : [];
}
/** Turn arbitrary tool-result content into a short, display-ready string. */
function summarize(content) {
	let text;
	if (typeof content === "string") text = content;
	else if (Array.isArray(content)) text = content.map((b) => b && typeof b === "object" && "text" in b ? String(b.text) : "").join("");
	else text = JSON.stringify(content);
	text = text.replace(/\s+/g, " ").trim();
	return text.length > 200 ? text.slice(0, 200) + "…" : text;
}
//#endregion
//#region src/main/db.ts
var DATA_DIR = process.env.FOREST_RANGER_DATA_DIR || (0, node_path.join)((0, node_os.homedir)(), ".forest-ranger");
(0, node_fs.mkdirSync)(DATA_DIR, { recursive: true });
var db = new better_sqlite3.default((0, node_path.join)(DATA_DIR, "forest-ranger.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.exec(`
	CREATE TABLE IF NOT EXISTS projects (
		id             TEXT PRIMARY KEY,
		name           TEXT NOT NULL,
		path           TEXT NOT NULL UNIQUE,
		added_at       INTEGER NOT NULL,
		last_opened_at INTEGER,
		worktree_dir   TEXT
	);

	CREATE TABLE IF NOT EXISTS worktrees (
		id             TEXT PRIMARY KEY,
		project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
		path           TEXT NOT NULL,
		last_opened_at INTEGER,
		created_at     INTEGER NOT NULL,
		UNIQUE(project_id, path)
	);

	CREATE TABLE IF NOT EXISTS project_commands (
		id         TEXT PRIMARY KEY,
		project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
		label      TEXT NOT NULL,
		command    TEXT NOT NULL,
		dir        TEXT NOT NULL DEFAULT '',
		run_target TEXT NOT NULL DEFAULT 'in-app',
		sort       INTEGER NOT NULL DEFAULT 0,
		created_at INTEGER NOT NULL
	);

	CREATE TABLE IF NOT EXISTS integrations (
		type    TEXT PRIMARY KEY,
		enabled INTEGER NOT NULL DEFAULT 0,
		config  TEXT NOT NULL DEFAULT '{}'
	);
`);
{
	const cmdCols = db.prepare("PRAGMA table_info(project_commands)").all().map((c) => c.name);
	if (!cmdCols.includes("dir")) db.exec("ALTER TABLE project_commands ADD COLUMN dir TEXT NOT NULL DEFAULT ''");
	if (!cmdCols.includes("run_target")) db.exec("ALTER TABLE project_commands ADD COLUMN run_target TEXT NOT NULL DEFAULT 'in-app'");
	if (!db.prepare("PRAGMA table_info(projects)").all().map((c) => c.name).includes("worktree_dir")) db.exec("ALTER TABLE projects ADD COLUMN worktree_dir TEXT");
}
var stmts = {
	listProjects: db.prepare("SELECT * FROM projects ORDER BY COALESCE(last_opened_at, added_at) DESC"),
	getProject: db.prepare("SELECT * FROM projects WHERE id = ?"),
	getProjectByPath: db.prepare("SELECT * FROM projects WHERE path = ?"),
	insertProject: db.prepare("INSERT INTO projects (id, name, path, added_at, last_opened_at) VALUES ($id, $name, $path, $addedAt, NULL)"),
	deleteProject: db.prepare("DELETE FROM projects WHERE id = $id"),
	touchProject: db.prepare("UPDATE projects SET last_opened_at = $now WHERE id = $id"),
	setWorktreeDir: db.prepare("UPDATE projects SET worktree_dir = $dir WHERE id = $id"),
	getWorktree: db.prepare("SELECT * FROM worktrees WHERE id = ?"),
	worktreesForProject: db.prepare("SELECT * FROM worktrees WHERE project_id = ?"),
	upsertWorktree: db.prepare(`INSERT INTO worktrees (id, project_id, path, last_opened_at, created_at)
		 VALUES ($id, $projectId, $path, NULL, $createdAt)
		 ON CONFLICT(project_id, path) DO UPDATE SET id = excluded.id`),
	touchWorktree: db.prepare("UPDATE worktrees SET last_opened_at = $now WHERE id = $id"),
	pruneWorktrees: db.prepare("DELETE FROM worktrees WHERE project_id = $projectId AND path NOT IN (SELECT value FROM json_each($keepPaths))"),
	getCommand: db.prepare("SELECT * FROM project_commands WHERE id = ?"),
	commandsForProject: db.prepare("SELECT * FROM project_commands WHERE project_id = ? ORDER BY sort, created_at"),
	maxCommandSort: db.prepare("SELECT MAX(sort) AS max FROM project_commands WHERE project_id = ?"),
	insertCommand: db.prepare(`INSERT INTO project_commands (id, project_id, label, command, dir, run_target, sort, created_at)
		 VALUES ($id, $projectId, $label, $command, $dir, $runTarget, $sort, $createdAt)`),
	updateCommand: db.prepare("UPDATE project_commands SET label = $label, command = $command, dir = $dir, run_target = $runTarget WHERE id = $id"),
	deleteCommand: db.prepare("DELETE FROM project_commands WHERE id = $id"),
	listIntegrations: db.prepare("SELECT * FROM integrations"),
	getIntegration: db.prepare("SELECT * FROM integrations WHERE type = ?"),
	upsertIntegration: db.prepare(`INSERT INTO integrations (type, enabled, config) VALUES ($type, $enabled, $config)
		 ON CONFLICT(type) DO UPDATE SET enabled = $enabled, config = $config`)
};
var projectsRepo = {
	list: () => stmts.listProjects.all(),
	get: (id) => stmts.getProject.get(id) ?? null,
	getByPath: (path) => stmts.getProjectByPath.get(path) ?? null,
	insert: (row) => stmts.insertProject.run({
		id: row.id,
		name: row.name,
		path: row.path,
		addedAt: row.addedAt
	}),
	remove: (id) => stmts.deleteProject.run({ id }),
	touch: (id, now) => stmts.touchProject.run({
		id,
		now
	}),
	setWorktreeDir: (id, dir) => stmts.setWorktreeDir.run({
		id,
		dir
	})
};
var worktreesRepo = {
	get: (id) => stmts.getWorktree.get(id) ?? null,
	forProject: (projectId) => stmts.worktreesForProject.all(projectId),
	upsert: (row) => stmts.upsertWorktree.run({
		id: row.id,
		projectId: row.projectId,
		path: row.path,
		createdAt: row.createdAt
	}),
	touch: (id, now) => stmts.touchWorktree.run({
		id,
		now
	}),
	/** Remove db rows for worktrees that no longer exist in git. */
	prune: (projectId, keepPaths) => stmts.pruneWorktrees.run({
		projectId,
		keepPaths: JSON.stringify(keepPaths)
	})
};
var commandsRepo = {
	get: (id) => stmts.getCommand.get(id) ?? null,
	forProject: (projectId) => stmts.commandsForProject.all(projectId),
	insert: (row) => {
		const sort = (stmts.maxCommandSort.get(row.projectId)?.max ?? -1) + 1;
		stmts.insertCommand.run({
			id: row.id,
			projectId: row.projectId,
			label: row.label,
			command: row.command,
			dir: row.dir,
			runTarget: row.runTarget,
			sort,
			createdAt: row.createdAt
		});
	},
	update: (id, label, command, dir, runTarget) => stmts.updateCommand.run({
		id,
		label,
		command,
		dir,
		runTarget
	}),
	remove: (id) => stmts.deleteCommand.run({ id })
};
var integrationsRepo = {
	list: () => stmts.listIntegrations.all(),
	get: (type) => stmts.getIntegration.get(type) ?? null,
	upsert: (type, enabled, config) => stmts.upsertIntegration.run({
		type,
		enabled: enabled ? 1 : 0,
		config
	})
};
//#endregion
//#region src/main/git.ts
/** Thin wrapper around the `git` CLI for worktree discovery. */
var AUGMENTED_PATH = [
	process.env.PATH ?? "",
	"/usr/bin",
	"/bin",
	"/usr/local/bin",
	"/opt/homebrew/bin"
].filter(Boolean).join(":");
var GIT_ENV = {
	...process.env,
	PATH: AUGMENTED_PATH,
	GIT_TERMINAL_PROMPT: "0",
	GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=10"
};
function git(cwd, args, opts) {
	return new Promise((resolve) => {
		let proc;
		try {
			proc = (0, node_child_process.spawn)("git", args, {
				cwd,
				env: GIT_ENV
			});
		} catch (err) {
			resolve({
				ok: false,
				stdout: "",
				stderr: String(err),
				exitCode: -1
			});
			return;
		}
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;
		proc.stdout?.on("data", (d) => {
			stdout += d.toString();
		});
		proc.stderr?.on("data", (d) => {
			stderr += d.toString();
		});
		const timer = opts?.timeoutMs ? setTimeout(() => {
			timedOut = true;
			try {
				proc.kill();
			} catch {}
		}, opts.timeoutMs) : void 0;
		proc.on("error", (err) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			resolve({
				ok: false,
				stdout: "",
				stderr: String(err),
				exitCode: -1
			});
		});
		proc.on("close", (code) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			if (timedOut) {
				resolve({
					ok: false,
					stdout,
					stderr: "timed out",
					exitCode: -1
				});
				return;
			}
			const exitCode = code ?? -1;
			resolve({
				ok: exitCode === 0,
				stdout,
				stderr,
				exitCode
			});
		});
	});
}
/** Returns the git version string, or null if the git binary can't be run. */
async function gitVersion() {
	const res = await git(process.cwd(), ["--version"]);
	return res.ok ? res.stdout.trim() : null;
}
/**
* Resolve a chosen folder to its repo toplevel.
* Returns null when the path is not inside a git repository.
*/
async function resolveRepoToplevel(path) {
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
var ACTIVITY_TTL_MS = 3e4;
var activityCache = /* @__PURE__ */ new Map();
/**
* Last time real work happened in a worktree, as a ms timestamp: the most recent
* of HEAD's commit time and the mtime of any uncommitted/untracked change.
* Cached for {@link ACTIVITY_TTL_MS}. Returns 0 when it can't be determined.
*/
function worktreeActivity(worktreePath) {
	const cached = activityCache.get(worktreePath);
	const nowMs = Date.now();
	if (cached && cached.expires > nowMs) return cached.value;
	const value = computeWorktreeActivity(worktreePath);
	activityCache.set(worktreePath, {
		value,
		expires: nowMs + ACTIVITY_TTL_MS
	});
	value.catch(() => activityCache.delete(worktreePath));
	return value;
}
async function computeWorktreeActivity(worktreePath) {
	const [log, status] = await Promise.all([git(worktreePath, [
		"log",
		"-1",
		"--format=%ct"
	]), git(worktreePath, ["status", "--porcelain"])]);
	let latest = 0;
	if (log.ok) {
		const sec = Number.parseInt(log.stdout.trim(), 10);
		if (!Number.isNaN(sec)) latest = sec * 1e3;
	}
	if (status.ok) for (const line of status.stdout.split("\n")) {
		if (line.trim() === "") continue;
		let rel = line.slice(3).trim();
		const arrow = rel.indexOf(" -> ");
		if (arrow !== -1) rel = rel.slice(arrow + 4);
		rel = rel.replace(/^"|"$/g, "");
		try {
			const m = (0, node_fs.statSync)((0, node_path.join)(worktreePath, rel)).mtimeMs;
			if (m > latest) latest = m;
		} catch {}
	}
	return latest;
}
/** Local branch names (short form). */
async function localBranches(repoPath) {
	const res = await git(repoPath, ["branch", "--format=%(refname:short)"]);
	if (!res.ok) return [];
	return res.stdout.split("\n").map((b) => b.trim()).filter((b) => b !== "");
}
/**
* Local branches plus remote-only branches (as `origin/foo`), for base-branch
* pickers. Remote branches that already have a local counterpart are dropped so
* the local name wins; this is how new origin branches become selectable.
*/
async function listBranches(repoPath) {
	const [localRes, remoteRes] = await Promise.all([git(repoPath, ["branch", "--format=%(refname:short)"]), git(repoPath, [
		"branch",
		"-r",
		"--format=%(refname:short)"
	])]);
	const local = (localRes.ok ? localRes.stdout : "").split("\n").map((b) => b.trim()).filter(Boolean);
	const localSet = new Set(local);
	const remoteOnly = (remoteRes.ok ? remoteRes.stdout : "").split("\n").map((b) => b.trim()).filter((b) => b && !b.includes("->") && b.startsWith("origin/")).filter((b) => !localSet.has(b.slice(7)));
	return [...local, ...remoteOnly];
}
/** Pick a base branch: the preferred one if it's a real ref, else main/master. */
async function resolveBaseBranch(repoPath, preferred) {
	if (preferred) {
		const ok = await git(repoPath, [
			"rev-parse",
			"--verify",
			"--quiet",
			preferred
		]);
		if (ok.ok && ok.stdout.trim() !== "") return preferred;
	}
	const branches = await localBranches(repoPath);
	for (const cand of ["main", "master"]) if (branches.includes(cand)) return cand;
	return null;
}
function parseChanges(nameStatus, numstat) {
	const num = /* @__PURE__ */ new Map();
	for (const line of numstat.split("\n")) {
		if (line.trim() === "") continue;
		const [a, d, ...rest] = line.split("	");
		num.set(rest.join("	"), {
			ins: a === "-" ? null : Number(a),
			del: d === "-" ? null : Number(d)
		});
	}
	const files = [];
	for (const line of nameStatus.split("\n")) {
		if (line.trim() === "") continue;
		const parts = line.split("	");
		const letter = parts[0]?.[0] ?? "M";
		const path = parts[parts.length - 1] ?? "";
		files.push({
			path,
			letter,
			insertions: num.get(path)?.ins ?? null,
			deletions: num.get(path)?.del ?? null
		});
	}
	return files;
}
/**
* Two views of a worktree's changes: `uncommitted` (working tree vs HEAD, incl.
* untracked) and `committed` (HEAD vs the merge-base with `base`). base is null
* when no comparison branch is available (then `committed` is empty).
*/
async function worktreeChanges(worktreePath, base) {
	const [uncNS, uncNum, untracked, stagedNames] = await Promise.all([
		git(worktreePath, [
			"diff",
			"--name-status",
			"-M",
			"HEAD"
		]),
		git(worktreePath, [
			"diff",
			"--numstat",
			"-M",
			"HEAD"
		]),
		git(worktreePath, [
			"ls-files",
			"--others",
			"--exclude-standard"
		]),
		git(worktreePath, [
			"diff",
			"--cached",
			"--name-only",
			"HEAD"
		])
	]);
	const stagedSet = new Set(stagedNames.stdout.split("\n").map((p) => p.trim()).filter(Boolean));
	const uncommitted = parseChanges(uncNS.stdout, uncNum.stdout);
	for (const f of uncommitted) f.staged = stagedSet.has(f.path);
	const seen = new Set(uncommitted.map((f) => f.path));
	for (const p of untracked.stdout.split("\n")) {
		const path = p.trim();
		if (path === "" || seen.has(path)) continue;
		uncommitted.push({
			path,
			letter: "?",
			insertions: null,
			deletions: null,
			staged: false
		});
	}
	let resolvedBase = null;
	let ahead = 0;
	let behind = 0;
	let committed = [];
	if (base) {
		const mb = await git(worktreePath, [
			"merge-base",
			base,
			"HEAD"
		]);
		if (mb.ok && mb.stdout.trim() !== "") {
			const mergeBase = mb.stdout.trim();
			resolvedBase = base;
			const [cNS, cNum, counts] = await Promise.all([
				git(worktreePath, [
					"diff",
					"--name-status",
					"-M",
					mergeBase,
					"HEAD"
				]),
				git(worktreePath, [
					"diff",
					"--numstat",
					"-M",
					mergeBase,
					"HEAD"
				]),
				git(worktreePath, [
					"rev-list",
					"--count",
					"--left-right",
					`${base}...HEAD`
				])
			]);
			committed = parseChanges(cNS.stdout, cNum.stdout);
			if (counts.ok) {
				const [b, a] = counts.stdout.trim().split(/\s+/);
				behind = Number(b) || 0;
				ahead = Number(a) || 0;
			}
		}
	}
	return {
		base: resolvedBase,
		ahead,
		behind,
		committed,
		uncommitted
	};
}
/** Stage the given paths (git add), or everything when `paths` is empty. */
async function stageFiles(worktreePath, paths) {
	const r = await git(worktreePath, paths.length ? [
		"add",
		"--",
		...paths
	] : ["add", "-A"]);
	return r.ok ? { ok: true } : {
		ok: false,
		error: r.stderr.trim() || "stage failed"
	};
}
/** Unstage the given paths, or everything when `paths` is empty. */
async function unstageFiles(worktreePath, paths) {
	const r = await git(worktreePath, paths.length ? [
		"restore",
		"--staged",
		"--",
		...paths
	] : [
		"reset",
		"--quiet",
		"HEAD",
		"--"
	]);
	return r.ok ? { ok: true } : {
		ok: false,
		error: r.stderr.trim() || "unstage failed"
	};
}
/** Commit the staged index with `message`. */
async function commit(worktreePath, message) {
	const r = await git(worktreePath, [
		"commit",
		"-m",
		message
	]);
	return r.ok ? { ok: true } : {
		ok: false,
		error: r.stderr.trim() || "commit failed"
	};
}
function isBinaryDiff(text) {
	return /^Binary files .* differ$/m.test(text) || text.includes("GIT binary patch");
}
/**
* Raw unified diff for one file in a worktree (parsed/rendered by the view).
* Uses `diff HEAD` for tracked changes; falls back to `--no-index` so untracked
* files show as all-additions.
*/
async function fileDiff(worktreePath, relPath, base) {
	if (base) {
		const mb = await git(worktreePath, [
			"merge-base",
			base,
			"HEAD"
		]);
		if (mb.ok && mb.stdout.trim() !== "") {
			const d = await git(worktreePath, [
				"diff",
				"-M",
				mb.stdout.trim(),
				"HEAD",
				"--",
				relPath
			]);
			return {
				binary: isBinaryDiff(d.stdout),
				text: d.stdout
			};
		}
		return {
			binary: false,
			text: ""
		};
	}
	const tracked = await git(worktreePath, [
		"diff",
		"-M",
		"HEAD",
		"--",
		relPath
	]);
	if (tracked.ok && tracked.stdout.trim() !== "") return {
		binary: isBinaryDiff(tracked.stdout),
		text: tracked.stdout
	};
	const untracked = await git(worktreePath, [
		"diff",
		"--no-index",
		"--",
		"/dev/null",
		relPath
	]);
	if (untracked.exitCode <= 1) return {
		binary: isBinaryDiff(untracked.stdout),
		text: untracked.stdout
	};
	return {
		binary: false,
		text: ""
	};
}
/** How far a local branch is ahead/behind its `origin/<branch>` (no fetch). */
async function branchTracking(repoPath, branch) {
	const remote = `origin/${branch}`;
	const exists = await git(repoPath, [
		"rev-parse",
		"--verify",
		"--quiet",
		remote
	]);
	if (!exists.ok || exists.stdout.trim() === "") return {
		ahead: 0,
		behind: 0,
		hasRemote: false
	};
	const res = await git(repoPath, [
		"rev-list",
		"--count",
		"--left-right",
		`${branch}...${remote}`
	]);
	let ahead = 0;
	let behind = 0;
	if (res.ok) {
		const [a, b] = res.stdout.trim().split(/\s+/);
		ahead = Number(a) || 0;
		behind = Number(b) || 0;
	}
	return {
		ahead,
		behind,
		hasRemote: true
	};
}
/**
* Fetch from origin and fast-forward the local `branch` to `origin/branch`.
* Uses a refspec so the branch updates without being checked out; if it's
* currently checked out (or non-FF), falls back to a plain fetch so the
* remote-tracking ref is still current for the behind count.
*/
async function fetchProject(repoPath, branch) {
	const t0 = Date.now();
	console.log(`[fetch] start ${repoPath} (branch=${branch ?? "—"})`);
	const fetched = await git(repoPath, [
		"fetch",
		"origin",
		"--prune"
	], { timeoutMs: 3e4 });
	console.log(`[fetch] origin --prune: ok=${fetched.ok} exit=${fetched.exitCode} ${Date.now() - t0}ms` + (fetched.stderr.trim() ? ` stderr=${fetched.stderr.trim().slice(0, 300)}` : ""));
	if (!fetched.ok) {
		const err = fetched.stderr.trim();
		return {
			ok: false,
			error: err === "timed out" ? "Fetch timed out — check your network or credentials." : err || "fetch failed"
		};
	}
	if (branch) {
		const ff = await git(repoPath, [
			"fetch",
			"origin",
			`${branch}:${branch}`
		], { timeoutMs: 2e4 });
		console.log(`[fetch] ff ${branch}: ok=${ff.ok} exit=${ff.exitCode}` + (ff.stderr.trim() ? ` stderr=${ff.stderr.trim().slice(0, 200)}` : ""));
	}
	console.log(`[fetch] done ${Date.now() - t0}ms`);
	return { ok: true };
}
/** Remove a worktree (`--force` discards uncommitted/untracked changes). */
async function removeWorktree(repoPath, worktreePath, force) {
	const args = ["worktree", "remove"];
	if (force) args.push("--force");
	args.push(worktreePath);
	const r = await git(repoPath, args);
	if (r.ok) return { ok: true };
	const r2 = await git(repoPath, [
		"worktree",
		"remove",
		"--force",
		"--force",
		worktreePath
	]);
	if (r2.ok) return { ok: true };
	await git(repoPath, ["worktree", "prune"]);
	if ((await git(repoPath, [
		"worktree",
		"list",
		"--porcelain"
	])).stdout.split("\n").some((line) => line.trim() === `worktree ${worktreePath}`)) return {
		ok: false,
		error: r.stderr.trim() || r2.stderr.trim() || "git worktree remove failed"
	};
	try {
		if (worktreePath !== repoPath && (0, node_fs.existsSync)(worktreePath)) (0, node_fs.rmSync)(worktreePath, {
			recursive: true,
			force: true
		});
	} catch {}
	return { ok: true };
}
/** The upstream/tracking branch for a local branch (e.g. `origin/foo`), or null. */
async function branchUpstream(repoPath, branch) {
	const r = await git(repoPath, [
		"rev-parse",
		"--abbrev-ref",
		`${branch}@{upstream}`
	]);
	return r.ok && r.stdout.trim() ? r.stdout.trim() : null;
}
/** The `origin` remote URL (or the first remote's), or null if none. */
async function remoteUrl(repoPath) {
	const origin = await git(repoPath, [
		"remote",
		"get-url",
		"origin"
	]);
	if (origin.ok && origin.stdout.trim()) return origin.stdout.trim();
	const first = (await git(repoPath, ["remote"])).stdout.split("\n").map((s) => s.trim()).filter(Boolean)[0];
	if (!first) return null;
	const url = await git(repoPath, [
		"remote",
		"get-url",
		first
	]);
	return url.ok ? url.stdout.trim() || null : null;
}
/** Parse a git remote URL into host + project path (handles scp-like and URL forms). */
function parseRemote(url) {
	const u = url.trim();
	const strip = (p) => p.replace(/\.git$/, "").replace(/^\//, "");
	const scp = u.match(/^[\w.+-]+@([^:]+):(.+)$/);
	if (scp) return {
		host: scp[1],
		path: strip(scp[2])
	};
	const m = u.match(/^[a-z][\w+.-]*:\/\/(?:[^@/]+@)?([^/]+)\/(.+)$/i);
	if (m) return {
		host: m[1].replace(/:\d+$/, ""),
		path: strip(m[2])
	};
	return null;
}
/** Force-delete a local branch. */
async function deleteBranch(repoPath, branch) {
	const r = await git(repoPath, [
		"branch",
		"-D",
		branch
	]);
	return r.ok ? { ok: true } : {
		ok: false,
		error: r.stderr.trim()
	};
}
/** Create a new worktree at `worktreePath` on a new `branch` off `base`. */
async function addWorktree(repoPath, worktreePath, branch, base) {
	const existing = await git(repoPath, [
		"rev-parse",
		"--verify",
		"--quiet",
		`refs/heads/${branch}`
	]);
	const res = await git(repoPath, existing.ok && existing.stdout.trim() !== "" ? [
		"worktree",
		"add",
		worktreePath,
		branch
	] : base ? [
		"worktree",
		"add",
		worktreePath,
		"-b",
		branch,
		base
	] : [
		"worktree",
		"add",
		worktreePath,
		"-b",
		branch
	]);
	return res.ok ? { ok: true } : {
		ok: false,
		error: res.stderr.trim() || "git worktree add failed"
	};
}
/**
* Parse `git worktree list --porcelain` into structured entries.
* Porcelain output is newline-delimited records separated by blank lines:
*   worktree /abs/path
*   HEAD <sha>
*   branch refs/heads/<name>   (or `detached`)
*   locked / bare              (optional flags)
*/
async function listWorktrees(repoPath) {
	const res = await git(repoPath, [
		"worktree",
		"list",
		"--porcelain"
	]);
	if (!res.ok) return [];
	const entries = [];
	let current = null;
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
				path: line.slice(9),
				head: null,
				branch: null,
				isDetached: false,
				isLocked: false,
				isBare: false
			};
		} else if (!current) continue;
		else if (line.startsWith("HEAD ")) current.head = line.slice(5);
		else if (line.startsWith("branch ")) current.branch = line.slice(7).replace(/^refs\/heads\//, "");
		else if (line === "detached") current.isDetached = true;
		else if (line === "bare") current.isBare = true;
		else if (line === "locked" || line.startsWith("locked ")) current.isLocked = true;
	}
	flush();
	return entries;
}
//#endregion
//#region src/main/gitlab.ts
/** Normalize a host into a scheme-qualified site URL with no trailing slash. */
function siteUrl(host) {
	let h = host.trim().replace(/\/+$/, "");
	if (!/^https?:\/\//i.test(h)) h = `https://${h}`;
	return h;
}
async function gl(config, path) {
	const res = await fetch(`${siteUrl(config.host)}/api/v4${path}`, { headers: { "PRIVATE-TOKEN": config.token } });
	if (!res.ok) {
		const body = await res.text().catch(() => "");
		throw new Error(`GitLab ${res.status}${body ? `: ${body.slice(0, 120)}` : ""}`);
	}
	return res.json();
}
/** Verify the host + token by fetching the current user. */
async function testConnection(config) {
	try {
		return {
			ok: true,
			user: (await gl(config, "/user")).username
		};
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err)
		};
	}
}
/** The GitLab project path (namespace/project) for a repo, if its origin matches the configured host. */
async function projectPathFor(repoPath, host) {
	const url = await remoteUrl(repoPath);
	if (!url) return null;
	const parsed = parseRemote(url);
	if (!parsed) return null;
	const cfgHost = host.replace(/^https?:\/\//i, "").replace(/\/+$/, "");
	if (parsed.host.toLowerCase() !== cfgHost.toLowerCase()) return null;
	return parsed.path;
}
/** MR + pipeline status for a branch, or null if the repo isn't on this GitLab host. */
async function branchStatus(config, repoPath, branch) {
	const path = await projectPathFor(repoPath, config.host);
	if (!path) return null;
	const id = encodeURIComponent(path);
	const projectUrl = `${siteUrl(config.host)}/${path}`;
	try {
		const mr = (await gl(config, `/projects/${id}/merge_requests?source_branch=${encodeURIComponent(branch)}&order_by=updated_at&sort=desc&per_page=1`))[0] ?? null;
		let pipeline = mr?.head_pipeline ?? null;
		if (!pipeline) pipeline = (await gl(config, `/projects/${id}/pipelines?ref=${encodeURIComponent(branch)}&per_page=1`))[0] ?? null;
		return {
			projectUrl,
			mr: mr ? {
				iid: mr.iid,
				title: mr.title,
				state: mr.state,
				url: mr.web_url
			} : null,
			pipeline: pipeline ? {
				status: pipeline.status,
				url: pipeline.web_url
			} : null
		};
	} catch (err) {
		return {
			projectUrl,
			mr: null,
			pipeline: null,
			error: err instanceof Error ? err.message : String(err)
		};
	}
}
//#endregion
//#region src/main/index.ts
var now = () => Date.now();
function worktreeId(projectId, path) {
	return `${projectId}-${(0, node_crypto.createHash)("sha1").update(path).digest("hex").slice(0, 12)}`;
}
function toProject(row) {
	return {
		id: row.id,
		name: row.name,
		path: row.path,
		addedAt: row.added_at,
		lastOpenedAt: row.last_opened_at
	};
}
function toCommand(row) {
	return {
		id: row.id,
		projectId: row.project_id,
		label: row.label,
		command: row.command,
		dir: row.dir,
		runTarget: row.run_target === "external" || row.run_target === "default" ? row.run_target : "in-app"
	};
}
var KNOWN_INTEGRATIONS = ["gitlab"];
var DEFAULT_HOST = { gitlab: "https://gitlab.com" };
function integrationConfig(type) {
	const row = integrationsRepo.get(type);
	const stored = row ? JSON.parse(row.config) : {};
	return {
		host: stored.host || DEFAULT_HOST[type],
		token: stored.token || ""
	};
}
function integrationStatus(type) {
	const row = integrationsRepo.get(type);
	const cfg = integrationConfig(type);
	return {
		type,
		enabled: !!row?.enabled,
		host: cfg.host,
		hasToken: !!cfg.token
	};
}
/** Scan git for a project's worktrees, sync the db, and return merged rows. */
async function syncWorktrees(project) {
	const gitEntries = (await listWorktrees(project.path)).filter((w) => !w.isBare);
	const createdAt = now();
	for (const entry of gitEntries) worktreesRepo.upsert({
		id: worktreeId(project.id, entry.path),
		projectId: project.id,
		path: entry.path,
		createdAt
	});
	worktreesRepo.prune(project.id, gitEntries.map((e) => e.path));
	const stored = new Map(worktreesRepo.forProject(project.id).map((r) => [r.path, r]));
	const activities = await Promise.all(gitEntries.map((e) => worktreeActivity(e.path)));
	return gitEntries.map((entry, i) => {
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
			lastActivityAt: activities[i]
		};
	}).sort(recencyDesc);
}
function recencyDesc(a, b) {
	return b.lastActivityAt - a.lastActivityAt;
}
function expandTilde(p) {
	return p.startsWith("~") ? (0, node_path.join)((0, node_os.homedir)(), p.slice(1)) : p;
}
/**
* Where new worktrees for a project go: the explicit per-project setting if set,
* else the conventional `<repo>.worktrees`, else the most common existing
* location (so a stray worktree from another tool doesn't hijack the default).
*/
async function worktreeParentFor(project) {
	if (project.worktree_dir) return project.worktree_dir;
	const conventional = `${project.path}.worktrees`;
	const parents = (await listWorktrees(project.path)).filter((e) => e.path !== project.path && !e.isBare).map((e) => (0, node_path.dirname)(e.path));
	if (parents.includes(conventional) || (0, node_fs.existsSync)(conventional)) return conventional;
	if (parents.length > 0) {
		const counts = /* @__PURE__ */ new Map();
		for (const p of parents) counts.set(p, (counts.get(p) ?? 0) + 1);
		return [...counts].sort((a, b) => b[1] - a[1])[0][0];
	}
	return conventional;
}
function letterKind(letter) {
	switch (letter) {
		case "A":
		case "C": return "added";
		case "D": return "deleted";
		case "R": return "renamed";
		case "T": return "typechange";
		case "U": return "conflicted";
		case "?": return "untracked";
		default: return "modified";
	}
}
function toChangedFile(c) {
	return {
		path: c.path,
		kind: letterKind(c.letter),
		insertions: c.insertions,
		deletions: c.deletions,
		staged: c.staged ?? false
	};
}
var handlers = {
	listProjects: () => projectsRepo.list().map(toProject),
	addProject: async () => {
		const result = await electron.dialog.showOpenDialog({ properties: ["openDirectory"] });
		const picked = result.canceled ? void 0 : result.filePaths[0]?.trim();
		console.log(`[addProject] picked: ${JSON.stringify(picked)}`);
		if (!picked) return { status: "cancelled" };
		if (!await gitVersion()) {
			console.log("[addProject] git binary not found on PATH");
			return { status: "git-missing" };
		}
		const toplevel = await resolveRepoToplevel(picked);
		if (!toplevel) return {
			status: "not-a-repo",
			path: picked
		};
		const existing = projectsRepo.getByPath(toplevel);
		if (existing) return {
			status: "exists",
			project: toProject(existing)
		};
		const row = {
			id: crypto.randomUUID(),
			name: (0, node_path.basename)(toplevel),
			path: toplevel,
			addedAt: now()
		};
		projectsRepo.insert(row);
		console.log(`[addProject] added ${row.name} (${toplevel})`);
		return {
			status: "added",
			project: {
				...row,
				lastOpenedAt: null
			}
		};
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
		const all = (await Promise.all(projects.map(async (project) => (await syncWorktrees(project)).map((wt) => ({
			...wt,
			projectName: project.name,
			projectPath: project.path
		}))))).flat();
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
		electron.shell.showItemInFolder(path);
	},
	detectApps: () => detectApps(),
	openWorktree: ({ path, app }) => openWorktree(path, app),
	worktreeDetail: async ({ id, base }) => {
		const row = worktreesRepo.get(id);
		if (!row) return null;
		const project = projectsRepo.get(row.project_id);
		if (!project) return null;
		const entry = (await listWorktrees(project.path)).find((e) => e.path === row.path);
		if (!entry) return null;
		const preferred = base && base !== entry.branch ? base : null;
		const resolvedBase = await resolveBaseBranch(project.path, preferred);
		const usableBase = resolvedBase === entry.branch ? null : resolvedBase;
		const [activity, branches, changes, upstream] = await Promise.all([
			worktreeActivity(row.path),
			listBranches(project.path),
			worktreeChanges(row.path, usableBase),
			entry.branch ? branchUpstream(row.path, entry.branch) : Promise.resolve(null)
		]);
		const committed = changes.committed.map(toChangedFile);
		const uncommitted = changes.uncommitted.map(toChangedFile);
		return {
			worktree: {
				id,
				projectId: project.id,
				path: row.path,
				branch: entry.branch,
				head: entry.head,
				isPrimary: entry.path === project.path,
				isDetached: entry.isDetached,
				isLocked: entry.isLocked,
				lastOpenedAt: row.last_opened_at,
				lastActivityAt: activity
			},
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
			commands: commandsRepo.forProject(project.id).map(toCommand)
		};
	},
	fileDiff: async ({ id, path, base }) => {
		const row = worktreesRepo.get(id);
		if (!row) return {
			path,
			binary: false,
			diff: ""
		};
		const { binary, text } = await fileDiff(row.path, path, base);
		return {
			path,
			binary,
			diff: text
		};
	},
	worktreeRemovalInfo: async ({ id }) => {
		const row = worktreesRepo.get(id);
		if (!row) return null;
		const project = projectsRepo.get(row.project_id);
		if (!project) return null;
		const entry = (await listWorktrees(project.path)).find((e) => e.path === row.path);
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
			base: usableBase
		};
	},
	removeWorktree: async ({ id, force, deleteBranch: deleteBranch$1 }) => {
		const row = worktreesRepo.get(id);
		if (!row) return {
			ok: false,
			error: "Worktree not found"
		};
		const project = projectsRepo.get(row.project_id);
		if (!project) return {
			ok: false,
			error: "Project not found"
		};
		if (row.path === project.path) return {
			ok: false,
			error: "Can't remove the primary worktree"
		};
		const branch = (await listWorktrees(project.path)).find((e) => e.path === row.path)?.branch;
		const rem = await removeWorktree(project.path, row.path, force);
		if (!rem.ok) return rem;
		if (deleteBranch$1 && branch) await deleteBranch(project.path, branch);
		return { ok: true };
	},
	branchStatus: async ({ projectId }) => {
		const project = projectsRepo.get(projectId);
		const base = project ? await resolveBaseBranch(project.path, null) : null;
		if (!project || !base) return {
			branch: base,
			ahead: 0,
			behind: 0,
			hasRemote: false
		};
		return {
			branch: base,
			...await branchTracking(project.path, base)
		};
	},
	fetchProject: async ({ projectId }) => {
		const project = projectsRepo.get(projectId);
		if (!project) return {
			ok: false,
			error: "Project not found"
		};
		console.log(`[fetch] request for project ${project.name} (${project.path})`);
		const base = await resolveBaseBranch(project.path, null);
		return fetchProject(project.path, base);
	},
	projectBranches: async ({ projectId }) => {
		const project = projectsRepo.get(projectId);
		if (!project) return {
			branches: [],
			base: null,
			worktreeDir: ""
		};
		const [branches, base, worktreeDir] = await Promise.all([
			listBranches(project.path),
			resolveBaseBranch(project.path, null),
			worktreeParentFor(project)
		]);
		return {
			branches,
			base,
			worktreeDir
		};
	},
	createWorktree: async ({ projectId, name, base, location }) => {
		const project = projectsRepo.get(projectId);
		if (!project) return {
			ok: false,
			error: "Project not found"
		};
		const remoteBase = base && /^origin\//.test(base) ? base.slice(7) : null;
		const branch = name.trim() || remoteBase || `worktree-${Math.random().toString(36).slice(2, 8)}`;
		const parent = location?.trim() ? expandTilde(location.trim()) : await worktreeParentFor(project);
		projectsRepo.setWorktreeDir(projectId, parent);
		(0, node_fs.mkdirSync)(parent, { recursive: true });
		const dirName = branch.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "worktree";
		let wtPath = (0, node_path.join)(parent, dirName);
		for (let n = 2; (0, node_fs.existsSync)(wtPath); n++) wtPath = (0, node_path.join)(parent, `${dirName}-${n}`);
		const resolvedBase = await resolveBaseBranch(project.path, base);
		const res = await addWorktree(project.path, wtPath, branch, resolvedBase);
		if (!res.ok) return {
			ok: false,
			error: res.error
		};
		const id = worktreeId(projectId, wtPath);
		worktreesRepo.upsert({
			id,
			projectId,
			path: wtPath,
			createdAt: now()
		});
		console.log(`[createWorktree] ${branch} -> ${wtPath}`);
		return {
			ok: true,
			worktreeId: id,
			path: wtPath
		};
	},
	listCommands: ({ projectId }) => commandsRepo.forProject(projectId).map(toCommand),
	addCommand: ({ projectId, label, command, dir, runTarget }) => {
		const row = {
			id: crypto.randomUUID(),
			projectId,
			label,
			command,
			dir,
			runTarget,
			createdAt: now()
		};
		commandsRepo.insert(row);
		return {
			id: row.id,
			projectId,
			label,
			command,
			dir,
			runTarget
		};
	},
	updateCommand: ({ id, label, command, dir, runTarget }) => {
		commandsRepo.update(id, label, command, dir, runTarget);
	},
	removeCommand: ({ id }) => {
		commandsRepo.remove(id);
	},
	runCommand: ({ id, cwd, app }) => {
		const cmd = commandsRepo.get(id);
		if (!cmd) return {
			ok: false,
			error: "Command not found"
		};
		return runInTerminal(app, cmd.dir ? (0, node_path.join)(cwd, cmd.dir) : cwd, cmd.command);
	},
	runExternal: ({ cwd, command, app }) => runInTerminal(app, cwd, command),
	openUrl: ({ url }) => {
		try {
			electron.shell.openExternal(url);
			return { ok: true };
		} catch (err) {
			return {
				ok: false,
				error: String(err)
			};
		}
	},
	stageFiles: ({ id, paths }) => {
		const row = worktreesRepo.get(id);
		if (!row) return {
			ok: false,
			error: "Worktree not found"
		};
		return stageFiles(row.path, paths);
	},
	unstageFiles: ({ id, paths }) => {
		const row = worktreesRepo.get(id);
		if (!row) return {
			ok: false,
			error: "Worktree not found"
		};
		return unstageFiles(row.path, paths);
	},
	commitChanges: ({ id, message }) => {
		const row = worktreesRepo.get(id);
		if (!row) return {
			ok: false,
			error: "Worktree not found"
		};
		return commit(row.path, message);
	},
	listIntegrations: () => KNOWN_INTEGRATIONS.map(integrationStatus),
	setIntegration: ({ type, enabled, host, token }) => {
		const cfg = integrationConfig(type);
		cfg.host = host.trim() || DEFAULT_HOST[type];
		if (token !== null) cfg.token = token;
		integrationsRepo.upsert(type, enabled, JSON.stringify(cfg));
		return integrationStatus(type);
	},
	testIntegration: async ({ type, host, token }) => {
		const cfg = integrationConfig(type);
		const useHost = host.trim() || cfg.host;
		const useToken = token !== null ? token : cfg.token;
		if (!useToken) return {
			ok: false,
			error: "No token provided"
		};
		return testConnection({
			host: useHost,
			token: useToken
		});
	},
	branchIntegrations: async ({ projectId, branch }) => {
		const out = {};
		const project = projectsRepo.get(projectId);
		if (!project || !branch) return out;
		if (integrationsRepo.get("gitlab")?.enabled) {
			const cfg = integrationConfig("gitlab");
			if (cfg.token) {
				const status = await branchStatus(cfg, project.path, branch);
				if (status) out.gitlab = status;
			}
		}
		return out;
	},
	termStart: ({ sessionId, worktreeId, commandId, command, cols, rows }) => {
		const row = worktreesRepo.get(worktreeId);
		if (!row) return {
			ok: false,
			error: "Worktree not found"
		};
		let cwd = row.path;
		let toRun = command ?? void 0;
		if (!toRun && commandId) {
			const cmd = commandsRepo.get(commandId);
			if (cmd) {
				toRun = cmd.command;
				if (cmd.dir) cwd = (0, node_path.join)(cwd, cmd.dir);
			}
		}
		startSession$1({
			sessionId,
			cwd,
			command: toRun,
			cols,
			rows
		});
		return { ok: true };
	},
	agentChatStart: ({ sessionId, worktreeId, resume, permissionMode, model }) => {
		const row = worktreesRepo.get(worktreeId);
		if (!row) return {
			ok: false,
			error: "Worktree not found"
		};
		return startSession({
			sessionId,
			cwd: row.path,
			resume,
			permissionMode,
			model
		}) ? { ok: true } : {
			ok: false,
			error: "Session already running"
		};
	},
	agentChatRestart: ({ sessionId, worktreeId, permissionMode, model }) => {
		const row = worktreesRepo.get(worktreeId);
		if (!row) return {
			ok: false,
			error: "Worktree not found"
		};
		restart({
			sessionId,
			cwd: row.path,
			resume: true,
			permissionMode,
			model
		});
		return { ok: true };
	}
};
function dispatchMessage(msg) {
	switch (msg.type) {
		case "termInput":
			write(msg.sessionId, msg.data);
			break;
		case "termResize":
			resize(msg.sessionId, msg.cols, msg.rows);
			break;
		case "termKill":
			kill(msg.sessionId);
			break;
		case "agentChatSend":
			send(msg.sessionId, msg.text, msg.attachments);
			break;
		case "agentChatPermission":
			respondPermission(msg.sessionId, msg.requestId, msg.allow);
			break;
		case "agentChatStop":
			stop(msg.sessionId);
			break;
	}
}
function broadcast(event) {
	for (const win of electron.BrowserWindow.getAllWindows()) win.webContents.send("event", event);
}
electron.ipcMain.handle("rpc", (_event, method, params) => {
	const handler = handlers[method];
	return handler(params);
});
electron.ipcMain.on("message", (_event, msg) => dispatchMessage(msg));
setTerminalCallbacks({
	onData: (sessionId, data) => broadcast({
		type: "termData",
		sessionId,
		data
	}),
	onExit: (sessionId, exitCode) => broadcast({
		type: "termExit",
		sessionId,
		exitCode
	})
});
setAgentChatCallback((sessionId, event) => broadcast({
	type: "agentChatEvent",
	sessionId,
	event
}));
function createWindow() {
	const win = new electron.BrowserWindow({
		title: "Forest Ranger",
		width: 1100,
		height: 760,
		x: 200,
		y: 200,
		titleBarStyle: "hiddenInset",
		trafficLightPosition: {
			x: 12,
			y: 14
		},
		webPreferences: { preload: (0, node_path.join)(__dirname, "../preload/index.js") }
	});
	if (process.env.ELECTRON_RENDERER_URL) win.loadURL(process.env.ELECTRON_RENDERER_URL);
	else win.loadFile((0, node_path.join)(__dirname, "../renderer/index.html"));
}
electron.app.whenReady().then(() => {
	electron.Menu.setApplicationMenu(electron.Menu.buildFromTemplate([
		{ role: "appMenu" },
		{ role: "editMenu" },
		{ role: "windowMenu" }
	]));
	createWindow();
	electron.app.on("activate", () => {
		if (electron.BrowserWindow.getAllWindows().length === 0) createWindow();
	});
	console.log("Forest Ranger app started!");
});
electron.app.on("window-all-closed", () => {
	if (process.platform !== "darwin") electron.app.quit();
});
electron.app.on("before-quit", () => {
	killAll$1();
	killAll();
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => {
	killAll$1();
	killAll();
	process.exit(0);
});
process.on("exit", () => {
	killAll$1();
	killAll();
});
//#endregion
