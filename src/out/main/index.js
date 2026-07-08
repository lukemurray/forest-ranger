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
let node_stream = require("node:stream");
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
var cached$1 = null;
/** Installed editors/terminals, plus Finder (always available). Cached per run. */
function detectApps() {
	if (cached$1) return cached$1;
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
	cached$1 = apps;
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
//#region node_modules/@agentclientprotocol/sdk/dist/schema/index.js
var AGENT_METHODS = {
	initialize: "initialize",
	authenticate: "authenticate",
	providers_list: "providers/list",
	providers_set: "providers/set",
	providers_disable: "providers/disable",
	session_new: "session/new",
	session_load: "session/load",
	session_set_mode: "session/set_mode",
	session_set_config_option: "session/set_config_option",
	session_prompt: "session/prompt",
	session_cancel: "session/cancel",
	mcp_message: "mcp/message",
	session_list: "session/list",
	session_delete: "session/delete",
	session_fork: "session/fork",
	session_resume: "session/resume",
	session_close: "session/close",
	logout: "logout",
	nes_start: "nes/start",
	nes_suggest: "nes/suggest",
	nes_accept: "nes/accept",
	nes_reject: "nes/reject",
	nes_close: "nes/close",
	document_did_open: "document/didOpen",
	document_did_change: "document/didChange",
	document_did_close: "document/didClose",
	document_did_save: "document/didSave",
	document_did_focus: "document/didFocus"
};
var CLIENT_METHODS = {
	session_request_permission: "session/request_permission",
	session_update: "session/update",
	fs_write_text_file: "fs/write_text_file",
	fs_read_text_file: "fs/read_text_file",
	terminal_create: "terminal/create",
	terminal_output: "terminal/output",
	terminal_release: "terminal/release",
	terminal_wait_for_exit: "terminal/wait_for_exit",
	terminal_kill: "terminal/kill",
	mcp_connect: "mcp/connect",
	mcp_message: "mcp/message",
	mcp_disconnect: "mcp/disconnect",
	elicitation_create: "elicitation/create",
	elicitation_complete: "elicitation/complete"
};
var PROTOCOL_METHODS = { cancel_request: "$/cancel_request" };
//#endregion
//#region node_modules/zod/v4/core/core.js
var _a$1;
/** A special constant with type `never` */
var NEVER = /*@__PURE__*/ Object.freeze({ status: "aborted" });
function $constructor(name, initializer, params) {
	function init(inst, def) {
		if (!inst._zod) Object.defineProperty(inst, "_zod", {
			value: {
				def,
				constr: _,
				traits: /* @__PURE__ */ new Set()
			},
			enumerable: false
		});
		if (inst._zod.traits.has(name)) return;
		inst._zod.traits.add(name);
		initializer(inst, def);
		const proto = _.prototype;
		const keys = Object.keys(proto);
		for (let i = 0; i < keys.length; i++) {
			const k = keys[i];
			if (!(k in inst)) inst[k] = proto[k].bind(inst);
		}
	}
	const Parent = params?.Parent ?? Object;
	class Definition extends Parent {}
	Object.defineProperty(Definition, "name", { value: name });
	function _(def) {
		var _a;
		const inst = params?.Parent ? new Definition() : this;
		init(inst, def);
		(_a = inst._zod).deferred ?? (_a.deferred = []);
		for (const fn of inst._zod.deferred) fn();
		return inst;
	}
	Object.defineProperty(_, "init", { value: init });
	Object.defineProperty(_, Symbol.hasInstance, { value: (inst) => {
		if (params?.Parent && inst instanceof params.Parent) return true;
		return inst?._zod?.traits?.has(name);
	} });
	Object.defineProperty(_, "name", { value: name });
	return _;
}
var $ZodAsyncError = class extends Error {
	constructor() {
		super(`Encountered Promise during synchronous parse. Use .parseAsync() instead.`);
	}
};
var $ZodEncodeError = class extends Error {
	constructor(name) {
		super(`Encountered unidirectional transform during encode: ${name}`);
		this.name = "ZodEncodeError";
	}
};
(_a$1 = globalThis).__zod_globalConfig ?? (_a$1.__zod_globalConfig = {});
var globalConfig = globalThis.__zod_globalConfig;
function config(newConfig) {
	if (newConfig) Object.assign(globalConfig, newConfig);
	return globalConfig;
}
//#endregion
//#region node_modules/zod/v4/core/util.js
function getEnumValues(entries) {
	const numericValues = Object.values(entries).filter((v) => typeof v === "number");
	return Object.entries(entries).filter(([k, _]) => numericValues.indexOf(+k) === -1).map(([_, v]) => v);
}
function jsonStringifyReplacer(_, value) {
	if (typeof value === "bigint") return value.toString();
	return value;
}
function cached(getter) {
	return { get value() {
		{
			const value = getter();
			Object.defineProperty(this, "value", { value });
			return value;
		}
		throw new Error("cached value already set");
	} };
}
function nullish(input) {
	return input === null || input === void 0;
}
function cleanRegex(source) {
	const start = source.startsWith("^") ? 1 : 0;
	const end = source.endsWith("$") ? source.length - 1 : source.length;
	return source.slice(start, end);
}
function floatSafeRemainder(val, step) {
	const ratio = val / step;
	const roundedRatio = Math.round(ratio);
	const tolerance = Number.EPSILON * Math.max(Math.abs(ratio), 1);
	if (Math.abs(ratio - roundedRatio) < tolerance) return 0;
	return ratio - roundedRatio;
}
var EVALUATING = /* @__PURE__*/ Symbol("evaluating");
function defineLazy(object, key, getter) {
	let value = void 0;
	Object.defineProperty(object, key, {
		get() {
			if (value === EVALUATING) return;
			if (value === void 0) {
				value = EVALUATING;
				value = getter();
			}
			return value;
		},
		set(v) {
			Object.defineProperty(object, key, { value: v });
		},
		configurable: true
	});
}
function assignProp(target, prop, value) {
	Object.defineProperty(target, prop, {
		value,
		writable: true,
		enumerable: true,
		configurable: true
	});
}
function mergeDefs(...defs) {
	const mergedDescriptors = {};
	for (const def of defs) {
		const descriptors = Object.getOwnPropertyDescriptors(def);
		Object.assign(mergedDescriptors, descriptors);
	}
	return Object.defineProperties({}, mergedDescriptors);
}
function esc(str) {
	return JSON.stringify(str);
}
function slugify(input) {
	return input.toLowerCase().trim().replace(/[^\w\s-]/g, "").replace(/[\s_-]+/g, "-").replace(/^-+|-+$/g, "");
}
var captureStackTrace = "captureStackTrace" in Error ? Error.captureStackTrace : (..._args) => {};
function isObject(data) {
	return typeof data === "object" && data !== null && !Array.isArray(data);
}
var allowsEval = /* @__PURE__*/ cached(() => {
	if (globalConfig.jitless) return false;
	if (typeof navigator !== "undefined" && navigator?.userAgent?.includes("Cloudflare")) return false;
	try {
		new Function("");
		return true;
	} catch (_) {
		return false;
	}
});
function isPlainObject(o) {
	if (isObject(o) === false) return false;
	const ctor = o.constructor;
	if (ctor === void 0) return true;
	if (typeof ctor !== "function") return true;
	const prot = ctor.prototype;
	if (isObject(prot) === false) return false;
	if (Object.prototype.hasOwnProperty.call(prot, "isPrototypeOf") === false) return false;
	return true;
}
function shallowClone(o) {
	if (isPlainObject(o)) return { ...o };
	if (Array.isArray(o)) return [...o];
	if (o instanceof Map) return new Map(o);
	if (o instanceof Set) return new Set(o);
	return o;
}
var propertyKeyTypes = /* @__PURE__*/ new Set([
	"string",
	"number",
	"symbol"
]);
function escapeRegex(str) {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function clone(inst, def, params) {
	const cl = new inst._zod.constr(def ?? inst._zod.def);
	if (!def || params?.parent) cl._zod.parent = inst;
	return cl;
}
function normalizeParams(_params) {
	const params = _params;
	if (!params) return {};
	if (typeof params === "string") return { error: () => params };
	if (params?.message !== void 0) {
		if (params?.error !== void 0) throw new Error("Cannot specify both `message` and `error` params");
		params.error = params.message;
	}
	delete params.message;
	if (typeof params.error === "string") return {
		...params,
		error: () => params.error
	};
	return params;
}
function optionalKeys(shape) {
	return Object.keys(shape).filter((k) => {
		return shape[k]._zod.optin === "optional" && shape[k]._zod.optout === "optional";
	});
}
var NUMBER_FORMAT_RANGES = {
	safeint: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
	int32: [-2147483648, 2147483647],
	uint32: [0, 4294967295],
	float32: [-34028234663852886e22, 34028234663852886e22],
	float64: [-Number.MAX_VALUE, Number.MAX_VALUE]
};
function pick(schema, mask) {
	const currDef = schema._zod.def;
	const checks = currDef.checks;
	if (checks && checks.length > 0) throw new Error(".pick() cannot be used on object schemas containing refinements");
	return clone(schema, mergeDefs(schema._zod.def, {
		get shape() {
			const newShape = {};
			for (const key in mask) {
				if (!(key in currDef.shape)) throw new Error(`Unrecognized key: "${key}"`);
				if (!mask[key]) continue;
				newShape[key] = currDef.shape[key];
			}
			assignProp(this, "shape", newShape);
			return newShape;
		},
		checks: []
	}));
}
function omit(schema, mask) {
	const currDef = schema._zod.def;
	const checks = currDef.checks;
	if (checks && checks.length > 0) throw new Error(".omit() cannot be used on object schemas containing refinements");
	return clone(schema, mergeDefs(schema._zod.def, {
		get shape() {
			const newShape = { ...schema._zod.def.shape };
			for (const key in mask) {
				if (!(key in currDef.shape)) throw new Error(`Unrecognized key: "${key}"`);
				if (!mask[key]) continue;
				delete newShape[key];
			}
			assignProp(this, "shape", newShape);
			return newShape;
		},
		checks: []
	}));
}
function extend(schema, shape) {
	if (!isPlainObject(shape)) throw new Error("Invalid input to extend: expected a plain object");
	const checks = schema._zod.def.checks;
	if (checks && checks.length > 0) {
		const existingShape = schema._zod.def.shape;
		for (const key in shape) if (Object.getOwnPropertyDescriptor(existingShape, key) !== void 0) throw new Error("Cannot overwrite keys on object schemas containing refinements. Use `.safeExtend()` instead.");
	}
	return clone(schema, mergeDefs(schema._zod.def, { get shape() {
		const _shape = {
			...schema._zod.def.shape,
			...shape
		};
		assignProp(this, "shape", _shape);
		return _shape;
	} }));
}
function safeExtend(schema, shape) {
	if (!isPlainObject(shape)) throw new Error("Invalid input to safeExtend: expected a plain object");
	return clone(schema, mergeDefs(schema._zod.def, { get shape() {
		const _shape = {
			...schema._zod.def.shape,
			...shape
		};
		assignProp(this, "shape", _shape);
		return _shape;
	} }));
}
function merge(a, b) {
	if (a._zod.def.checks?.length) throw new Error(".merge() cannot be used on object schemas containing refinements. Use .safeExtend() instead.");
	return clone(a, mergeDefs(a._zod.def, {
		get shape() {
			const _shape = {
				...a._zod.def.shape,
				...b._zod.def.shape
			};
			assignProp(this, "shape", _shape);
			return _shape;
		},
		get catchall() {
			return b._zod.def.catchall;
		},
		checks: b._zod.def.checks ?? []
	}));
}
function partial(Class, schema, mask) {
	const checks = schema._zod.def.checks;
	if (checks && checks.length > 0) throw new Error(".partial() cannot be used on object schemas containing refinements");
	return clone(schema, mergeDefs(schema._zod.def, {
		get shape() {
			const oldShape = schema._zod.def.shape;
			const shape = { ...oldShape };
			if (mask) for (const key in mask) {
				if (!(key in oldShape)) throw new Error(`Unrecognized key: "${key}"`);
				if (!mask[key]) continue;
				shape[key] = Class ? new Class({
					type: "optional",
					innerType: oldShape[key]
				}) : oldShape[key];
			}
			else for (const key in oldShape) shape[key] = Class ? new Class({
				type: "optional",
				innerType: oldShape[key]
			}) : oldShape[key];
			assignProp(this, "shape", shape);
			return shape;
		},
		checks: []
	}));
}
function required(Class, schema, mask) {
	return clone(schema, mergeDefs(schema._zod.def, { get shape() {
		const oldShape = schema._zod.def.shape;
		const shape = { ...oldShape };
		if (mask) for (const key in mask) {
			if (!(key in shape)) throw new Error(`Unrecognized key: "${key}"`);
			if (!mask[key]) continue;
			shape[key] = new Class({
				type: "nonoptional",
				innerType: oldShape[key]
			});
		}
		else for (const key in oldShape) shape[key] = new Class({
			type: "nonoptional",
			innerType: oldShape[key]
		});
		assignProp(this, "shape", shape);
		return shape;
	} }));
}
function aborted(x, startIndex = 0) {
	if (x.aborted === true) return true;
	for (let i = startIndex; i < x.issues.length; i++) if (x.issues[i]?.continue !== true) return true;
	return false;
}
function explicitlyAborted(x, startIndex = 0) {
	if (x.aborted === true) return true;
	for (let i = startIndex; i < x.issues.length; i++) if (x.issues[i]?.continue === false) return true;
	return false;
}
function prefixIssues(path, issues) {
	return issues.map((iss) => {
		var _a;
		(_a = iss).path ?? (_a.path = []);
		iss.path.unshift(path);
		return iss;
	});
}
function unwrapMessage(message) {
	return typeof message === "string" ? message : message?.message;
}
function finalizeIssue(iss, ctx, config) {
	const message = iss.message ? iss.message : unwrapMessage(iss.inst?._zod.def?.error?.(iss)) ?? unwrapMessage(ctx?.error?.(iss)) ?? unwrapMessage(config.customError?.(iss)) ?? unwrapMessage(config.localeError?.(iss)) ?? "Invalid input";
	const { inst: _inst, continue: _continue, input: _input, ...rest } = iss;
	rest.path ?? (rest.path = []);
	rest.message = message;
	if (ctx?.reportInput) rest.input = _input;
	return rest;
}
function getLengthableOrigin(input) {
	if (Array.isArray(input)) return "array";
	if (typeof input === "string") return "string";
	return "unknown";
}
function issue(...args) {
	const [iss, input, inst] = args;
	if (typeof iss === "string") return {
		message: iss,
		code: "custom",
		input,
		inst
	};
	return { ...iss };
}
//#endregion
//#region node_modules/zod/v4/core/errors.js
var initializer$1 = (inst, def) => {
	inst.name = "$ZodError";
	Object.defineProperty(inst, "_zod", {
		value: inst._zod,
		enumerable: false
	});
	Object.defineProperty(inst, "issues", {
		value: def,
		enumerable: false
	});
	inst.message = JSON.stringify(def, jsonStringifyReplacer, 2);
	Object.defineProperty(inst, "toString", {
		value: () => inst.message,
		enumerable: false
	});
};
var $ZodError = $constructor("$ZodError", initializer$1);
var $ZodRealError = $constructor("$ZodError", initializer$1, { Parent: Error });
function flattenError(error, mapper = (issue) => issue.message) {
	const fieldErrors = {};
	const formErrors = [];
	for (const sub of error.issues) if (sub.path.length > 0) {
		fieldErrors[sub.path[0]] = fieldErrors[sub.path[0]] || [];
		fieldErrors[sub.path[0]].push(mapper(sub));
	} else formErrors.push(mapper(sub));
	return {
		formErrors,
		fieldErrors
	};
}
function formatError(error, mapper = (issue) => issue.message) {
	const fieldErrors = { _errors: [] };
	const processError = (error, path = []) => {
		for (const issue of error.issues) if (issue.code === "invalid_union" && issue.errors.length) issue.errors.map((issues) => processError({ issues }, [...path, ...issue.path]));
		else if (issue.code === "invalid_key") processError({ issues: issue.issues }, [...path, ...issue.path]);
		else if (issue.code === "invalid_element") processError({ issues: issue.issues }, [...path, ...issue.path]);
		else {
			const fullpath = [...path, ...issue.path];
			if (fullpath.length === 0) fieldErrors._errors.push(mapper(issue));
			else {
				let curr = fieldErrors;
				let i = 0;
				while (i < fullpath.length) {
					const el = fullpath[i];
					if (!(i === fullpath.length - 1)) curr[el] = curr[el] || { _errors: [] };
					else {
						curr[el] = curr[el] || { _errors: [] };
						curr[el]._errors.push(mapper(issue));
					}
					curr = curr[el];
					i++;
				}
			}
		}
	};
	processError(error);
	return fieldErrors;
}
//#endregion
//#region node_modules/zod/v4/core/parse.js
var _parse = (_Err) => (schema, value, _ctx, _params) => {
	const ctx = _ctx ? {
		..._ctx,
		async: false
	} : { async: false };
	const result = schema._zod.run({
		value,
		issues: []
	}, ctx);
	if (result instanceof Promise) throw new $ZodAsyncError();
	if (result.issues.length) {
		const e = new ((_params?.Err) ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
		captureStackTrace(e, _params?.callee);
		throw e;
	}
	return result.value;
};
var _parseAsync = (_Err) => async (schema, value, _ctx, params) => {
	const ctx = _ctx ? {
		..._ctx,
		async: true
	} : { async: true };
	let result = schema._zod.run({
		value,
		issues: []
	}, ctx);
	if (result instanceof Promise) result = await result;
	if (result.issues.length) {
		const e = new ((params?.Err) ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
		captureStackTrace(e, params?.callee);
		throw e;
	}
	return result.value;
};
var _safeParse = (_Err) => (schema, value, _ctx) => {
	const ctx = _ctx ? {
		..._ctx,
		async: false
	} : { async: false };
	const result = schema._zod.run({
		value,
		issues: []
	}, ctx);
	if (result instanceof Promise) throw new $ZodAsyncError();
	return result.issues.length ? {
		success: false,
		error: new (_Err ?? $ZodError)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
	} : {
		success: true,
		data: result.value
	};
};
var safeParse$1 = /* @__PURE__*/ _safeParse($ZodRealError);
var _safeParseAsync = (_Err) => async (schema, value, _ctx) => {
	const ctx = _ctx ? {
		..._ctx,
		async: true
	} : { async: true };
	let result = schema._zod.run({
		value,
		issues: []
	}, ctx);
	if (result instanceof Promise) result = await result;
	return result.issues.length ? {
		success: false,
		error: new _Err(result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
	} : {
		success: true,
		data: result.value
	};
};
var safeParseAsync$1 = /* @__PURE__*/ _safeParseAsync($ZodRealError);
var _encode = (_Err) => (schema, value, _ctx) => {
	const ctx = _ctx ? {
		..._ctx,
		direction: "backward"
	} : { direction: "backward" };
	return _parse(_Err)(schema, value, ctx);
};
var _decode = (_Err) => (schema, value, _ctx) => {
	return _parse(_Err)(schema, value, _ctx);
};
var _encodeAsync = (_Err) => async (schema, value, _ctx) => {
	const ctx = _ctx ? {
		..._ctx,
		direction: "backward"
	} : { direction: "backward" };
	return _parseAsync(_Err)(schema, value, ctx);
};
var _decodeAsync = (_Err) => async (schema, value, _ctx) => {
	return _parseAsync(_Err)(schema, value, _ctx);
};
var _safeEncode = (_Err) => (schema, value, _ctx) => {
	const ctx = _ctx ? {
		..._ctx,
		direction: "backward"
	} : { direction: "backward" };
	return _safeParse(_Err)(schema, value, ctx);
};
var _safeDecode = (_Err) => (schema, value, _ctx) => {
	return _safeParse(_Err)(schema, value, _ctx);
};
var _safeEncodeAsync = (_Err) => async (schema, value, _ctx) => {
	const ctx = _ctx ? {
		..._ctx,
		direction: "backward"
	} : { direction: "backward" };
	return _safeParseAsync(_Err)(schema, value, ctx);
};
var _safeDecodeAsync = (_Err) => async (schema, value, _ctx) => {
	return _safeParseAsync(_Err)(schema, value, _ctx);
};
//#endregion
//#region node_modules/zod/v4/core/regexes.js
/**
* @deprecated CUID v1 is deprecated by its authors due to information leakage
* (timestamps embedded in the id). Use {@link cuid2} instead.
* See https://github.com/paralleldrive/cuid.
*/
var cuid = /^[cC][0-9a-z]{6,}$/;
var cuid2 = /^[0-9a-z]+$/;
var ulid = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/;
var xid = /^[0-9a-vA-V]{20}$/;
var ksuid = /^[A-Za-z0-9]{27}$/;
var nanoid = /^[a-zA-Z0-9_-]{21}$/;
/** ISO 8601-1 duration regex. Does not support the 8601-2 extensions like negative durations or fractional/negative components. */
var duration$1 = /^P(?:(\d+W)|(?!.*W)(?=\d|T\d)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+([.,]\d+)?S)?)?)$/;
/** A regex for any UUID-like identifier: 8-4-4-4-12 hex pattern */
var guid = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
/** Returns a regex for validating an RFC 9562/4122 UUID.
*
* @param version Optionally specify a version 1-8. If no version is specified, all versions are supported. */
var uuid = (version) => {
	if (!version) return /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
	return new RegExp(`^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-${version}[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$`);
};
/** Practical email validation */
var email = /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;
var _emoji$1 = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
function emoji() {
	return new RegExp(_emoji$1, "u");
}
var ipv4 = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var ipv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/;
var cidrv4 = /^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/([0-9]|[1-2][0-9]|3[0-2])$/;
var cidrv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|::|([0-9a-fA-F]{1,4})?::([0-9a-fA-F]{1,4}:?){0,6})\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
var base64 = /^$|^(?:[0-9a-zA-Z+/]{4})*(?:(?:[0-9a-zA-Z+/]{2}==)|(?:[0-9a-zA-Z+/]{3}=))?$/;
var base64url = /^[A-Za-z0-9_-]*$/;
var httpProtocol = /^https?$/;
var e164 = /^\+[1-9]\d{6,14}$/;
var dateSource = `(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))`;
var date$1 = /*@__PURE__*/ new RegExp(`^${dateSource}$`);
function timeSource(args) {
	const hhmm = `(?:[01]\\d|2[0-3]):[0-5]\\d`;
	return typeof args.precision === "number" ? args.precision === -1 ? `${hhmm}` : args.precision === 0 ? `${hhmm}:[0-5]\\d` : `${hhmm}:[0-5]\\d\\.\\d{${args.precision}}` : `${hhmm}(?::[0-5]\\d(?:\\.\\d+)?)?`;
}
function time$1(args) {
	return new RegExp(`^${timeSource(args)}$`);
}
function datetime$1(args) {
	const time = timeSource({ precision: args.precision });
	const opts = ["Z"];
	if (args.local) opts.push("");
	if (args.offset) opts.push(`([+-](?:[01]\\d|2[0-3]):[0-5]\\d)`);
	const timeRegex = `${time}(?:${opts.join("|")})`;
	return new RegExp(`^${dateSource}T(?:${timeRegex})$`);
}
var string$1 = (params) => {
	const regex = params ? `[\\s\\S]{${params?.minimum ?? 0},${params?.maximum ?? ""}}` : `[\\s\\S]*`;
	return new RegExp(`^${regex}$`);
};
var integer = /^-?\d+$/;
var number$1 = /^-?\d+(?:\.\d+)?$/;
var boolean$1 = /^(?:true|false)$/i;
var lowercase = /^[^A-Z]*$/;
var uppercase = /^[^a-z]*$/;
//#endregion
//#region node_modules/zod/v4/core/checks.js
var $ZodCheck = /*@__PURE__*/ $constructor("$ZodCheck", (inst, def) => {
	var _a;
	inst._zod ?? (inst._zod = {});
	inst._zod.def = def;
	(_a = inst._zod).onattach ?? (_a.onattach = []);
});
var numericOriginMap = {
	number: "number",
	bigint: "bigint",
	object: "date"
};
var $ZodCheckLessThan = /*@__PURE__*/ $constructor("$ZodCheckLessThan", (inst, def) => {
	$ZodCheck.init(inst, def);
	const origin = numericOriginMap[typeof def.value];
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		const curr = (def.inclusive ? bag.maximum : bag.exclusiveMaximum) ?? Number.POSITIVE_INFINITY;
		if (def.value < curr) if (def.inclusive) bag.maximum = def.value;
		else bag.exclusiveMaximum = def.value;
	});
	inst._zod.check = (payload) => {
		if (def.inclusive ? payload.value <= def.value : payload.value < def.value) return;
		payload.issues.push({
			origin,
			code: "too_big",
			maximum: typeof def.value === "object" ? def.value.getTime() : def.value,
			input: payload.value,
			inclusive: def.inclusive,
			inst,
			continue: !def.abort
		});
	};
});
var $ZodCheckGreaterThan = /*@__PURE__*/ $constructor("$ZodCheckGreaterThan", (inst, def) => {
	$ZodCheck.init(inst, def);
	const origin = numericOriginMap[typeof def.value];
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		const curr = (def.inclusive ? bag.minimum : bag.exclusiveMinimum) ?? Number.NEGATIVE_INFINITY;
		if (def.value > curr) if (def.inclusive) bag.minimum = def.value;
		else bag.exclusiveMinimum = def.value;
	});
	inst._zod.check = (payload) => {
		if (def.inclusive ? payload.value >= def.value : payload.value > def.value) return;
		payload.issues.push({
			origin,
			code: "too_small",
			minimum: typeof def.value === "object" ? def.value.getTime() : def.value,
			input: payload.value,
			inclusive: def.inclusive,
			inst,
			continue: !def.abort
		});
	};
});
var $ZodCheckMultipleOf = /*@__PURE__*/ $constructor("$ZodCheckMultipleOf", (inst, def) => {
	$ZodCheck.init(inst, def);
	inst._zod.onattach.push((inst) => {
		var _a;
		(_a = inst._zod.bag).multipleOf ?? (_a.multipleOf = def.value);
	});
	inst._zod.check = (payload) => {
		if (typeof payload.value !== typeof def.value) throw new Error("Cannot mix number and bigint in multiple_of check.");
		if (typeof payload.value === "bigint" ? payload.value % def.value === BigInt(0) : floatSafeRemainder(payload.value, def.value) === 0) return;
		payload.issues.push({
			origin: typeof payload.value,
			code: "not_multiple_of",
			divisor: def.value,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
var $ZodCheckNumberFormat = /*@__PURE__*/ $constructor("$ZodCheckNumberFormat", (inst, def) => {
	$ZodCheck.init(inst, def);
	def.format = def.format || "float64";
	const isInt = def.format?.includes("int");
	const origin = isInt ? "int" : "number";
	const [minimum, maximum] = NUMBER_FORMAT_RANGES[def.format];
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		bag.format = def.format;
		bag.minimum = minimum;
		bag.maximum = maximum;
		if (isInt) bag.pattern = integer;
	});
	inst._zod.check = (payload) => {
		const input = payload.value;
		if (isInt) {
			if (!Number.isInteger(input)) {
				payload.issues.push({
					expected: origin,
					format: def.format,
					code: "invalid_type",
					continue: false,
					input,
					inst
				});
				return;
			}
			if (!Number.isSafeInteger(input)) {
				if (input > 0) payload.issues.push({
					input,
					code: "too_big",
					maximum: Number.MAX_SAFE_INTEGER,
					note: "Integers must be within the safe integer range.",
					inst,
					origin,
					inclusive: true,
					continue: !def.abort
				});
				else payload.issues.push({
					input,
					code: "too_small",
					minimum: Number.MIN_SAFE_INTEGER,
					note: "Integers must be within the safe integer range.",
					inst,
					origin,
					inclusive: true,
					continue: !def.abort
				});
				return;
			}
		}
		if (input < minimum) payload.issues.push({
			origin: "number",
			input,
			code: "too_small",
			minimum,
			inclusive: true,
			inst,
			continue: !def.abort
		});
		if (input > maximum) payload.issues.push({
			origin: "number",
			input,
			code: "too_big",
			maximum,
			inclusive: true,
			inst,
			continue: !def.abort
		});
	};
});
var $ZodCheckMaxLength = /*@__PURE__*/ $constructor("$ZodCheckMaxLength", (inst, def) => {
	var _a;
	$ZodCheck.init(inst, def);
	(_a = inst._zod.def).when ?? (_a.when = (payload) => {
		const val = payload.value;
		return !nullish(val) && val.length !== void 0;
	});
	inst._zod.onattach.push((inst) => {
		const curr = inst._zod.bag.maximum ?? Number.POSITIVE_INFINITY;
		if (def.maximum < curr) inst._zod.bag.maximum = def.maximum;
	});
	inst._zod.check = (payload) => {
		const input = payload.value;
		if (input.length <= def.maximum) return;
		const origin = getLengthableOrigin(input);
		payload.issues.push({
			origin,
			code: "too_big",
			maximum: def.maximum,
			inclusive: true,
			input,
			inst,
			continue: !def.abort
		});
	};
});
var $ZodCheckMinLength = /*@__PURE__*/ $constructor("$ZodCheckMinLength", (inst, def) => {
	var _a;
	$ZodCheck.init(inst, def);
	(_a = inst._zod.def).when ?? (_a.when = (payload) => {
		const val = payload.value;
		return !nullish(val) && val.length !== void 0;
	});
	inst._zod.onattach.push((inst) => {
		const curr = inst._zod.bag.minimum ?? Number.NEGATIVE_INFINITY;
		if (def.minimum > curr) inst._zod.bag.minimum = def.minimum;
	});
	inst._zod.check = (payload) => {
		const input = payload.value;
		if (input.length >= def.minimum) return;
		const origin = getLengthableOrigin(input);
		payload.issues.push({
			origin,
			code: "too_small",
			minimum: def.minimum,
			inclusive: true,
			input,
			inst,
			continue: !def.abort
		});
	};
});
var $ZodCheckLengthEquals = /*@__PURE__*/ $constructor("$ZodCheckLengthEquals", (inst, def) => {
	var _a;
	$ZodCheck.init(inst, def);
	(_a = inst._zod.def).when ?? (_a.when = (payload) => {
		const val = payload.value;
		return !nullish(val) && val.length !== void 0;
	});
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		bag.minimum = def.length;
		bag.maximum = def.length;
		bag.length = def.length;
	});
	inst._zod.check = (payload) => {
		const input = payload.value;
		const length = input.length;
		if (length === def.length) return;
		const origin = getLengthableOrigin(input);
		const tooBig = length > def.length;
		payload.issues.push({
			origin,
			...tooBig ? {
				code: "too_big",
				maximum: def.length
			} : {
				code: "too_small",
				minimum: def.length
			},
			inclusive: true,
			exact: true,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
var $ZodCheckStringFormat = /*@__PURE__*/ $constructor("$ZodCheckStringFormat", (inst, def) => {
	var _a, _b;
	$ZodCheck.init(inst, def);
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		bag.format = def.format;
		if (def.pattern) {
			bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
			bag.patterns.add(def.pattern);
		}
	});
	if (def.pattern) (_a = inst._zod).check ?? (_a.check = (payload) => {
		def.pattern.lastIndex = 0;
		if (def.pattern.test(payload.value)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: def.format,
			input: payload.value,
			...def.pattern ? { pattern: def.pattern.toString() } : {},
			inst,
			continue: !def.abort
		});
	});
	else (_b = inst._zod).check ?? (_b.check = () => {});
});
var $ZodCheckRegex = /*@__PURE__*/ $constructor("$ZodCheckRegex", (inst, def) => {
	$ZodCheckStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		def.pattern.lastIndex = 0;
		if (def.pattern.test(payload.value)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: "regex",
			input: payload.value,
			pattern: def.pattern.toString(),
			inst,
			continue: !def.abort
		});
	};
});
var $ZodCheckLowerCase = /*@__PURE__*/ $constructor("$ZodCheckLowerCase", (inst, def) => {
	def.pattern ?? (def.pattern = lowercase);
	$ZodCheckStringFormat.init(inst, def);
});
var $ZodCheckUpperCase = /*@__PURE__*/ $constructor("$ZodCheckUpperCase", (inst, def) => {
	def.pattern ?? (def.pattern = uppercase);
	$ZodCheckStringFormat.init(inst, def);
});
var $ZodCheckIncludes = /*@__PURE__*/ $constructor("$ZodCheckIncludes", (inst, def) => {
	$ZodCheck.init(inst, def);
	const escapedRegex = escapeRegex(def.includes);
	const pattern = new RegExp(typeof def.position === "number" ? `^.{${def.position}}${escapedRegex}` : escapedRegex);
	def.pattern = pattern;
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
		bag.patterns.add(pattern);
	});
	inst._zod.check = (payload) => {
		if (payload.value.includes(def.includes, def.position)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: "includes",
			includes: def.includes,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
var $ZodCheckStartsWith = /*@__PURE__*/ $constructor("$ZodCheckStartsWith", (inst, def) => {
	$ZodCheck.init(inst, def);
	const pattern = new RegExp(`^${escapeRegex(def.prefix)}.*`);
	def.pattern ?? (def.pattern = pattern);
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
		bag.patterns.add(pattern);
	});
	inst._zod.check = (payload) => {
		if (payload.value.startsWith(def.prefix)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: "starts_with",
			prefix: def.prefix,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
var $ZodCheckEndsWith = /*@__PURE__*/ $constructor("$ZodCheckEndsWith", (inst, def) => {
	$ZodCheck.init(inst, def);
	const pattern = new RegExp(`.*${escapeRegex(def.suffix)}$`);
	def.pattern ?? (def.pattern = pattern);
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
		bag.patterns.add(pattern);
	});
	inst._zod.check = (payload) => {
		if (payload.value.endsWith(def.suffix)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: "ends_with",
			suffix: def.suffix,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
var $ZodCheckOverwrite = /*@__PURE__*/ $constructor("$ZodCheckOverwrite", (inst, def) => {
	$ZodCheck.init(inst, def);
	inst._zod.check = (payload) => {
		payload.value = def.tx(payload.value);
	};
});
//#endregion
//#region node_modules/zod/v4/core/doc.js
var Doc = class {
	constructor(args = []) {
		this.content = [];
		this.indent = 0;
		if (this) this.args = args;
	}
	indented(fn) {
		this.indent += 1;
		fn(this);
		this.indent -= 1;
	}
	write(arg) {
		if (typeof arg === "function") {
			arg(this, { execution: "sync" });
			arg(this, { execution: "async" });
			return;
		}
		const lines = arg.split("\n").filter((x) => x);
		const minIndent = Math.min(...lines.map((x) => x.length - x.trimStart().length));
		const dedented = lines.map((x) => x.slice(minIndent)).map((x) => " ".repeat(this.indent * 2) + x);
		for (const line of dedented) this.content.push(line);
	}
	compile() {
		const F = Function;
		const args = this?.args;
		const lines = [...(this?.content ?? [``]).map((x) => `  ${x}`)];
		return new F(...args, lines.join("\n"));
	}
};
//#endregion
//#region node_modules/zod/v4/core/versions.js
var version = {
	major: 4,
	minor: 4,
	patch: 3
};
//#endregion
//#region node_modules/zod/v4/core/schemas.js
var $ZodType = /*@__PURE__*/ $constructor("$ZodType", (inst, def) => {
	var _a;
	inst ?? (inst = {});
	inst._zod.def = def;
	inst._zod.bag = inst._zod.bag || {};
	inst._zod.version = version;
	const checks = [...inst._zod.def.checks ?? []];
	if (inst._zod.traits.has("$ZodCheck")) checks.unshift(inst);
	for (const ch of checks) for (const fn of ch._zod.onattach) fn(inst);
	if (checks.length === 0) {
		(_a = inst._zod).deferred ?? (_a.deferred = []);
		inst._zod.deferred?.push(() => {
			inst._zod.run = inst._zod.parse;
		});
	} else {
		const runChecks = (payload, checks, ctx) => {
			let isAborted = aborted(payload);
			let asyncResult;
			for (const ch of checks) {
				if (ch._zod.def.when) {
					if (explicitlyAborted(payload)) continue;
					if (!ch._zod.def.when(payload)) continue;
				} else if (isAborted) continue;
				const currLen = payload.issues.length;
				const _ = ch._zod.check(payload);
				if (_ instanceof Promise && ctx?.async === false) throw new $ZodAsyncError();
				if (asyncResult || _ instanceof Promise) asyncResult = (asyncResult ?? Promise.resolve()).then(async () => {
					await _;
					if (payload.issues.length === currLen) return;
					if (!isAborted) isAborted = aborted(payload, currLen);
				});
				else {
					if (payload.issues.length === currLen) continue;
					if (!isAborted) isAborted = aborted(payload, currLen);
				}
			}
			if (asyncResult) return asyncResult.then(() => {
				return payload;
			});
			return payload;
		};
		const handleCanaryResult = (canary, payload, ctx) => {
			if (aborted(canary)) {
				canary.aborted = true;
				return canary;
			}
			const checkResult = runChecks(payload, checks, ctx);
			if (checkResult instanceof Promise) {
				if (ctx.async === false) throw new $ZodAsyncError();
				return checkResult.then((checkResult) => inst._zod.parse(checkResult, ctx));
			}
			return inst._zod.parse(checkResult, ctx);
		};
		inst._zod.run = (payload, ctx) => {
			if (ctx.skipChecks) return inst._zod.parse(payload, ctx);
			if (ctx.direction === "backward") {
				const canary = inst._zod.parse({
					value: payload.value,
					issues: []
				}, {
					...ctx,
					skipChecks: true
				});
				if (canary instanceof Promise) return canary.then((canary) => {
					return handleCanaryResult(canary, payload, ctx);
				});
				return handleCanaryResult(canary, payload, ctx);
			}
			const result = inst._zod.parse(payload, ctx);
			if (result instanceof Promise) {
				if (ctx.async === false) throw new $ZodAsyncError();
				return result.then((result) => runChecks(result, checks, ctx));
			}
			return runChecks(result, checks, ctx);
		};
	}
	defineLazy(inst, "~standard", () => ({
		validate: (value) => {
			try {
				const r = safeParse$1(inst, value);
				return r.success ? { value: r.data } : { issues: r.error?.issues };
			} catch (_) {
				return safeParseAsync$1(inst, value).then((r) => r.success ? { value: r.data } : { issues: r.error?.issues });
			}
		},
		vendor: "zod",
		version: 1
	}));
});
var $ZodString = /*@__PURE__*/ $constructor("$ZodString", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.pattern = [...inst?._zod.bag?.patterns ?? []].pop() ?? string$1(inst._zod.bag);
	inst._zod.parse = (payload, _) => {
		if (def.coerce) try {
			payload.value = String(payload.value);
		} catch (_) {}
		if (typeof payload.value === "string") return payload;
		payload.issues.push({
			expected: "string",
			code: "invalid_type",
			input: payload.value,
			inst
		});
		return payload;
	};
});
var $ZodStringFormat = /*@__PURE__*/ $constructor("$ZodStringFormat", (inst, def) => {
	$ZodCheckStringFormat.init(inst, def);
	$ZodString.init(inst, def);
});
var $ZodGUID = /*@__PURE__*/ $constructor("$ZodGUID", (inst, def) => {
	def.pattern ?? (def.pattern = guid);
	$ZodStringFormat.init(inst, def);
});
var $ZodUUID = /*@__PURE__*/ $constructor("$ZodUUID", (inst, def) => {
	if (def.version) {
		const v = {
			v1: 1,
			v2: 2,
			v3: 3,
			v4: 4,
			v5: 5,
			v6: 6,
			v7: 7,
			v8: 8
		}[def.version];
		if (v === void 0) throw new Error(`Invalid UUID version: "${def.version}"`);
		def.pattern ?? (def.pattern = uuid(v));
	} else def.pattern ?? (def.pattern = uuid());
	$ZodStringFormat.init(inst, def);
});
var $ZodEmail = /*@__PURE__*/ $constructor("$ZodEmail", (inst, def) => {
	def.pattern ?? (def.pattern = email);
	$ZodStringFormat.init(inst, def);
});
var $ZodURL = /*@__PURE__*/ $constructor("$ZodURL", (inst, def) => {
	$ZodStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		try {
			const trimmed = payload.value.trim();
			if (!def.normalize && def.protocol?.source === httpProtocol.source) {
				if (!/^https?:\/\//i.test(trimmed)) {
					payload.issues.push({
						code: "invalid_format",
						format: "url",
						note: "Invalid URL format",
						input: payload.value,
						inst,
						continue: !def.abort
					});
					return;
				}
			}
			const url = new URL(trimmed);
			if (def.hostname) {
				def.hostname.lastIndex = 0;
				if (!def.hostname.test(url.hostname)) payload.issues.push({
					code: "invalid_format",
					format: "url",
					note: "Invalid hostname",
					pattern: def.hostname.source,
					input: payload.value,
					inst,
					continue: !def.abort
				});
			}
			if (def.protocol) {
				def.protocol.lastIndex = 0;
				if (!def.protocol.test(url.protocol.endsWith(":") ? url.protocol.slice(0, -1) : url.protocol)) payload.issues.push({
					code: "invalid_format",
					format: "url",
					note: "Invalid protocol",
					pattern: def.protocol.source,
					input: payload.value,
					inst,
					continue: !def.abort
				});
			}
			if (def.normalize) payload.value = url.href;
			else payload.value = trimmed;
			return;
		} catch (_) {
			payload.issues.push({
				code: "invalid_format",
				format: "url",
				input: payload.value,
				inst,
				continue: !def.abort
			});
		}
	};
});
var $ZodEmoji = /*@__PURE__*/ $constructor("$ZodEmoji", (inst, def) => {
	def.pattern ?? (def.pattern = emoji());
	$ZodStringFormat.init(inst, def);
});
var $ZodNanoID = /*@__PURE__*/ $constructor("$ZodNanoID", (inst, def) => {
	def.pattern ?? (def.pattern = nanoid);
	$ZodStringFormat.init(inst, def);
});
/**
* @deprecated CUID v1 is deprecated by its authors due to information leakage
* (timestamps embedded in the id). Use {@link $ZodCUID2} instead.
* See https://github.com/paralleldrive/cuid.
*/
var $ZodCUID = /*@__PURE__*/ $constructor("$ZodCUID", (inst, def) => {
	def.pattern ?? (def.pattern = cuid);
	$ZodStringFormat.init(inst, def);
});
var $ZodCUID2 = /*@__PURE__*/ $constructor("$ZodCUID2", (inst, def) => {
	def.pattern ?? (def.pattern = cuid2);
	$ZodStringFormat.init(inst, def);
});
var $ZodULID = /*@__PURE__*/ $constructor("$ZodULID", (inst, def) => {
	def.pattern ?? (def.pattern = ulid);
	$ZodStringFormat.init(inst, def);
});
var $ZodXID = /*@__PURE__*/ $constructor("$ZodXID", (inst, def) => {
	def.pattern ?? (def.pattern = xid);
	$ZodStringFormat.init(inst, def);
});
var $ZodKSUID = /*@__PURE__*/ $constructor("$ZodKSUID", (inst, def) => {
	def.pattern ?? (def.pattern = ksuid);
	$ZodStringFormat.init(inst, def);
});
var $ZodISODateTime = /*@__PURE__*/ $constructor("$ZodISODateTime", (inst, def) => {
	def.pattern ?? (def.pattern = datetime$1(def));
	$ZodStringFormat.init(inst, def);
});
var $ZodISODate = /*@__PURE__*/ $constructor("$ZodISODate", (inst, def) => {
	def.pattern ?? (def.pattern = date$1);
	$ZodStringFormat.init(inst, def);
});
var $ZodISOTime = /*@__PURE__*/ $constructor("$ZodISOTime", (inst, def) => {
	def.pattern ?? (def.pattern = time$1(def));
	$ZodStringFormat.init(inst, def);
});
var $ZodISODuration = /*@__PURE__*/ $constructor("$ZodISODuration", (inst, def) => {
	def.pattern ?? (def.pattern = duration$1);
	$ZodStringFormat.init(inst, def);
});
var $ZodIPv4 = /*@__PURE__*/ $constructor("$ZodIPv4", (inst, def) => {
	def.pattern ?? (def.pattern = ipv4);
	$ZodStringFormat.init(inst, def);
	inst._zod.bag.format = `ipv4`;
});
var $ZodIPv6 = /*@__PURE__*/ $constructor("$ZodIPv6", (inst, def) => {
	def.pattern ?? (def.pattern = ipv6);
	$ZodStringFormat.init(inst, def);
	inst._zod.bag.format = `ipv6`;
	inst._zod.check = (payload) => {
		try {
			new URL(`http://[${payload.value}]`);
		} catch {
			payload.issues.push({
				code: "invalid_format",
				format: "ipv6",
				input: payload.value,
				inst,
				continue: !def.abort
			});
		}
	};
});
var $ZodCIDRv4 = /*@__PURE__*/ $constructor("$ZodCIDRv4", (inst, def) => {
	def.pattern ?? (def.pattern = cidrv4);
	$ZodStringFormat.init(inst, def);
});
var $ZodCIDRv6 = /*@__PURE__*/ $constructor("$ZodCIDRv6", (inst, def) => {
	def.pattern ?? (def.pattern = cidrv6);
	$ZodStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		const parts = payload.value.split("/");
		try {
			if (parts.length !== 2) throw new Error();
			const [address, prefix] = parts;
			if (!prefix) throw new Error();
			const prefixNum = Number(prefix);
			if (`${prefixNum}` !== prefix) throw new Error();
			if (prefixNum < 0 || prefixNum > 128) throw new Error();
			new URL(`http://[${address}]`);
		} catch {
			payload.issues.push({
				code: "invalid_format",
				format: "cidrv6",
				input: payload.value,
				inst,
				continue: !def.abort
			});
		}
	};
});
function isValidBase64(data) {
	if (data === "") return true;
	if (/\s/.test(data)) return false;
	if (data.length % 4 !== 0) return false;
	try {
		atob(data);
		return true;
	} catch {
		return false;
	}
}
var $ZodBase64 = /*@__PURE__*/ $constructor("$ZodBase64", (inst, def) => {
	def.pattern ?? (def.pattern = base64);
	$ZodStringFormat.init(inst, def);
	inst._zod.bag.contentEncoding = "base64";
	inst._zod.check = (payload) => {
		if (isValidBase64(payload.value)) return;
		payload.issues.push({
			code: "invalid_format",
			format: "base64",
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
function isValidBase64URL(data) {
	if (!base64url.test(data)) return false;
	const base64 = data.replace(/[-_]/g, (c) => c === "-" ? "+" : "/");
	return isValidBase64(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
}
var $ZodBase64URL = /*@__PURE__*/ $constructor("$ZodBase64URL", (inst, def) => {
	def.pattern ?? (def.pattern = base64url);
	$ZodStringFormat.init(inst, def);
	inst._zod.bag.contentEncoding = "base64url";
	inst._zod.check = (payload) => {
		if (isValidBase64URL(payload.value)) return;
		payload.issues.push({
			code: "invalid_format",
			format: "base64url",
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
var $ZodE164 = /*@__PURE__*/ $constructor("$ZodE164", (inst, def) => {
	def.pattern ?? (def.pattern = e164);
	$ZodStringFormat.init(inst, def);
});
function isValidJWT(token, algorithm = null) {
	try {
		const tokensParts = token.split(".");
		if (tokensParts.length !== 3) return false;
		const [header] = tokensParts;
		if (!header) return false;
		const parsedHeader = JSON.parse(atob(header));
		if ("typ" in parsedHeader && parsedHeader?.typ !== "JWT") return false;
		if (!parsedHeader.alg) return false;
		if (algorithm && (!("alg" in parsedHeader) || parsedHeader.alg !== algorithm)) return false;
		return true;
	} catch {
		return false;
	}
}
var $ZodJWT = /*@__PURE__*/ $constructor("$ZodJWT", (inst, def) => {
	$ZodStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		if (isValidJWT(payload.value, def.alg)) return;
		payload.issues.push({
			code: "invalid_format",
			format: "jwt",
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
var $ZodNumber = /*@__PURE__*/ $constructor("$ZodNumber", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.pattern = inst._zod.bag.pattern ?? number$1;
	inst._zod.parse = (payload, _ctx) => {
		if (def.coerce) try {
			payload.value = Number(payload.value);
		} catch (_) {}
		const input = payload.value;
		if (typeof input === "number" && !Number.isNaN(input) && Number.isFinite(input)) return payload;
		const received = typeof input === "number" ? Number.isNaN(input) ? "NaN" : !Number.isFinite(input) ? "Infinity" : void 0 : void 0;
		payload.issues.push({
			expected: "number",
			code: "invalid_type",
			input,
			inst,
			...received ? { received } : {}
		});
		return payload;
	};
});
var $ZodNumberFormat = /*@__PURE__*/ $constructor("$ZodNumberFormat", (inst, def) => {
	$ZodCheckNumberFormat.init(inst, def);
	$ZodNumber.init(inst, def);
});
var $ZodBoolean = /*@__PURE__*/ $constructor("$ZodBoolean", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.pattern = boolean$1;
	inst._zod.parse = (payload, _ctx) => {
		if (def.coerce) try {
			payload.value = Boolean(payload.value);
		} catch (_) {}
		const input = payload.value;
		if (typeof input === "boolean") return payload;
		payload.issues.push({
			expected: "boolean",
			code: "invalid_type",
			input,
			inst
		});
		return payload;
	};
});
var $ZodUnknown = /*@__PURE__*/ $constructor("$ZodUnknown", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.parse = (payload) => payload;
});
var $ZodNever = /*@__PURE__*/ $constructor("$ZodNever", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.parse = (payload, _ctx) => {
		payload.issues.push({
			expected: "never",
			code: "invalid_type",
			input: payload.value,
			inst
		});
		return payload;
	};
});
function handleArrayResult(result, final, index) {
	if (result.issues.length) final.issues.push(...prefixIssues(index, result.issues));
	final.value[index] = result.value;
}
var $ZodArray = /*@__PURE__*/ $constructor("$ZodArray", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.parse = (payload, ctx) => {
		const input = payload.value;
		if (!Array.isArray(input)) {
			payload.issues.push({
				expected: "array",
				code: "invalid_type",
				input,
				inst
			});
			return payload;
		}
		payload.value = Array(input.length);
		const proms = [];
		for (let i = 0; i < input.length; i++) {
			const item = input[i];
			const result = def.element._zod.run({
				value: item,
				issues: []
			}, ctx);
			if (result instanceof Promise) proms.push(result.then((result) => handleArrayResult(result, payload, i)));
			else handleArrayResult(result, payload, i);
		}
		if (proms.length) return Promise.all(proms).then(() => payload);
		return payload;
	};
});
function handlePropertyResult(result, final, key, input, isOptionalIn, isOptionalOut) {
	const isPresent = key in input;
	if (result.issues.length) {
		if (isOptionalIn && isOptionalOut && !isPresent) return;
		final.issues.push(...prefixIssues(key, result.issues));
	}
	if (!isPresent && !isOptionalIn) {
		if (!result.issues.length) final.issues.push({
			code: "invalid_type",
			expected: "nonoptional",
			input: void 0,
			path: [key]
		});
		return;
	}
	if (result.value === void 0) {
		if (isPresent) final.value[key] = void 0;
	} else final.value[key] = result.value;
}
function normalizeDef(def) {
	const keys = Object.keys(def.shape);
	for (const k of keys) if (!def.shape?.[k]?._zod?.traits?.has("$ZodType")) throw new Error(`Invalid element at key "${k}": expected a Zod schema`);
	const okeys = optionalKeys(def.shape);
	return {
		...def,
		keys,
		keySet: new Set(keys),
		numKeys: keys.length,
		optionalKeys: new Set(okeys)
	};
}
function handleCatchall(proms, input, payload, ctx, def, inst) {
	const unrecognized = [];
	const keySet = def.keySet;
	const _catchall = def.catchall._zod;
	const t = _catchall.def.type;
	const isOptionalIn = _catchall.optin === "optional";
	const isOptionalOut = _catchall.optout === "optional";
	for (const key in input) {
		if (key === "__proto__") continue;
		if (keySet.has(key)) continue;
		if (t === "never") {
			unrecognized.push(key);
			continue;
		}
		const r = _catchall.run({
			value: input[key],
			issues: []
		}, ctx);
		if (r instanceof Promise) proms.push(r.then((r) => handlePropertyResult(r, payload, key, input, isOptionalIn, isOptionalOut)));
		else handlePropertyResult(r, payload, key, input, isOptionalIn, isOptionalOut);
	}
	if (unrecognized.length) payload.issues.push({
		code: "unrecognized_keys",
		keys: unrecognized,
		input,
		inst
	});
	if (!proms.length) return payload;
	return Promise.all(proms).then(() => {
		return payload;
	});
}
var $ZodObject = /*@__PURE__*/ $constructor("$ZodObject", (inst, def) => {
	$ZodType.init(inst, def);
	if (!Object.getOwnPropertyDescriptor(def, "shape")?.get) {
		const sh = def.shape;
		Object.defineProperty(def, "shape", { get: () => {
			const newSh = { ...sh };
			Object.defineProperty(def, "shape", { value: newSh });
			return newSh;
		} });
	}
	const _normalized = cached(() => normalizeDef(def));
	defineLazy(inst._zod, "propValues", () => {
		const shape = def.shape;
		const propValues = {};
		for (const key in shape) {
			const field = shape[key]._zod;
			if (field.values) {
				propValues[key] ?? (propValues[key] = /* @__PURE__ */ new Set());
				for (const v of field.values) propValues[key].add(v);
			}
		}
		return propValues;
	});
	const isObject$2 = isObject;
	const catchall = def.catchall;
	let value;
	inst._zod.parse = (payload, ctx) => {
		value ?? (value = _normalized.value);
		const input = payload.value;
		if (!isObject$2(input)) {
			payload.issues.push({
				expected: "object",
				code: "invalid_type",
				input,
				inst
			});
			return payload;
		}
		payload.value = {};
		const proms = [];
		const shape = value.shape;
		for (const key of value.keys) {
			const el = shape[key];
			const isOptionalIn = el._zod.optin === "optional";
			const isOptionalOut = el._zod.optout === "optional";
			const r = el._zod.run({
				value: input[key],
				issues: []
			}, ctx);
			if (r instanceof Promise) proms.push(r.then((r) => handlePropertyResult(r, payload, key, input, isOptionalIn, isOptionalOut)));
			else handlePropertyResult(r, payload, key, input, isOptionalIn, isOptionalOut);
		}
		if (!catchall) return proms.length ? Promise.all(proms).then(() => payload) : payload;
		return handleCatchall(proms, input, payload, ctx, _normalized.value, inst);
	};
});
var $ZodObjectJIT = /*@__PURE__*/ $constructor("$ZodObjectJIT", (inst, def) => {
	$ZodObject.init(inst, def);
	const superParse = inst._zod.parse;
	const _normalized = cached(() => normalizeDef(def));
	const generateFastpass = (shape) => {
		const doc = new Doc([
			"shape",
			"payload",
			"ctx"
		]);
		const normalized = _normalized.value;
		const parseStr = (key) => {
			const k = esc(key);
			return `shape[${k}]._zod.run({ value: input[${k}], issues: [] }, ctx)`;
		};
		doc.write(`const input = payload.value;`);
		const ids = Object.create(null);
		let counter = 0;
		for (const key of normalized.keys) ids[key] = `key_${counter++}`;
		doc.write(`const newResult = {};`);
		for (const key of normalized.keys) {
			const id = ids[key];
			const k = esc(key);
			const schema = shape[key];
			const isOptionalIn = schema?._zod?.optin === "optional";
			const isOptionalOut = schema?._zod?.optout === "optional";
			doc.write(`const ${id} = ${parseStr(key)};`);
			if (isOptionalIn && isOptionalOut) doc.write(`
        if (${id}.issues.length) {
          if (${k} in input) {
            payload.issues = payload.issues.concat(${id}.issues.map(iss => ({
              ...iss,
              path: iss.path ? [${k}, ...iss.path] : [${k}]
            })));
          }
        }
        
        if (${id}.value === undefined) {
          if (${k} in input) {
            newResult[${k}] = undefined;
          }
        } else {
          newResult[${k}] = ${id}.value;
        }
        
      `);
			else if (!isOptionalIn) doc.write(`
        const ${id}_present = ${k} in input;
        if (${id}.issues.length) {
          payload.issues = payload.issues.concat(${id}.issues.map(iss => ({
            ...iss,
            path: iss.path ? [${k}, ...iss.path] : [${k}]
          })));
        }
        if (!${id}_present && !${id}.issues.length) {
          payload.issues.push({
            code: "invalid_type",
            expected: "nonoptional",
            input: undefined,
            path: [${k}]
          });
        }

        if (${id}_present) {
          if (${id}.value === undefined) {
            newResult[${k}] = undefined;
          } else {
            newResult[${k}] = ${id}.value;
          }
        }

      `);
			else doc.write(`
        if (${id}.issues.length) {
          payload.issues = payload.issues.concat(${id}.issues.map(iss => ({
            ...iss,
            path: iss.path ? [${k}, ...iss.path] : [${k}]
          })));
        }
        
        if (${id}.value === undefined) {
          if (${k} in input) {
            newResult[${k}] = undefined;
          }
        } else {
          newResult[${k}] = ${id}.value;
        }
        
      `);
		}
		doc.write(`payload.value = newResult;`);
		doc.write(`return payload;`);
		const fn = doc.compile();
		return (payload, ctx) => fn(shape, payload, ctx);
	};
	let fastpass;
	const isObject$1 = isObject;
	const jit = !globalConfig.jitless;
	const fastEnabled = jit && allowsEval.value;
	const catchall = def.catchall;
	let value;
	inst._zod.parse = (payload, ctx) => {
		value ?? (value = _normalized.value);
		const input = payload.value;
		if (!isObject$1(input)) {
			payload.issues.push({
				expected: "object",
				code: "invalid_type",
				input,
				inst
			});
			return payload;
		}
		if (jit && fastEnabled && ctx?.async === false && ctx.jitless !== true) {
			if (!fastpass) fastpass = generateFastpass(def.shape);
			payload = fastpass(payload, ctx);
			if (!catchall) return payload;
			return handleCatchall([], input, payload, ctx, value, inst);
		}
		return superParse(payload, ctx);
	};
});
function handleUnionResults(results, final, inst, ctx) {
	for (const result of results) if (result.issues.length === 0) {
		final.value = result.value;
		return final;
	}
	const nonaborted = results.filter((r) => !aborted(r));
	if (nonaborted.length === 1) {
		final.value = nonaborted[0].value;
		return nonaborted[0];
	}
	final.issues.push({
		code: "invalid_union",
		input: final.value,
		inst,
		errors: results.map((result) => result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
	});
	return final;
}
var $ZodUnion = /*@__PURE__*/ $constructor("$ZodUnion", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazy(inst._zod, "optin", () => def.options.some((o) => o._zod.optin === "optional") ? "optional" : void 0);
	defineLazy(inst._zod, "optout", () => def.options.some((o) => o._zod.optout === "optional") ? "optional" : void 0);
	defineLazy(inst._zod, "values", () => {
		if (def.options.every((o) => o._zod.values)) return new Set(def.options.flatMap((option) => Array.from(option._zod.values)));
	});
	defineLazy(inst._zod, "pattern", () => {
		if (def.options.every((o) => o._zod.pattern)) {
			const patterns = def.options.map((o) => o._zod.pattern);
			return new RegExp(`^(${patterns.map((p) => cleanRegex(p.source)).join("|")})$`);
		}
	});
	const first = def.options.length === 1 ? def.options[0]._zod.run : null;
	inst._zod.parse = (payload, ctx) => {
		if (first) return first(payload, ctx);
		let async = false;
		const results = [];
		for (const option of def.options) {
			const result = option._zod.run({
				value: payload.value,
				issues: []
			}, ctx);
			if (result instanceof Promise) {
				results.push(result);
				async = true;
			} else {
				if (result.issues.length === 0) return result;
				results.push(result);
			}
		}
		if (!async) return handleUnionResults(results, payload, inst, ctx);
		return Promise.all(results).then((results) => {
			return handleUnionResults(results, payload, inst, ctx);
		});
	};
});
var $ZodIntersection = /*@__PURE__*/ $constructor("$ZodIntersection", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.parse = (payload, ctx) => {
		const input = payload.value;
		const left = def.left._zod.run({
			value: input,
			issues: []
		}, ctx);
		const right = def.right._zod.run({
			value: input,
			issues: []
		}, ctx);
		if (left instanceof Promise || right instanceof Promise) return Promise.all([left, right]).then(([left, right]) => {
			return handleIntersectionResults(payload, left, right);
		});
		return handleIntersectionResults(payload, left, right);
	};
});
function mergeValues(a, b) {
	if (a === b) return {
		valid: true,
		data: a
	};
	if (a instanceof Date && b instanceof Date && +a === +b) return {
		valid: true,
		data: a
	};
	if (isPlainObject(a) && isPlainObject(b)) {
		const bKeys = Object.keys(b);
		const sharedKeys = Object.keys(a).filter((key) => bKeys.indexOf(key) !== -1);
		const newObj = {
			...a,
			...b
		};
		for (const key of sharedKeys) {
			const sharedValue = mergeValues(a[key], b[key]);
			if (!sharedValue.valid) return {
				valid: false,
				mergeErrorPath: [key, ...sharedValue.mergeErrorPath]
			};
			newObj[key] = sharedValue.data;
		}
		return {
			valid: true,
			data: newObj
		};
	}
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return {
			valid: false,
			mergeErrorPath: []
		};
		const newArray = [];
		for (let index = 0; index < a.length; index++) {
			const itemA = a[index];
			const itemB = b[index];
			const sharedValue = mergeValues(itemA, itemB);
			if (!sharedValue.valid) return {
				valid: false,
				mergeErrorPath: [index, ...sharedValue.mergeErrorPath]
			};
			newArray.push(sharedValue.data);
		}
		return {
			valid: true,
			data: newArray
		};
	}
	return {
		valid: false,
		mergeErrorPath: []
	};
}
function handleIntersectionResults(result, left, right) {
	const unrecKeys = /* @__PURE__ */ new Map();
	let unrecIssue;
	for (const iss of left.issues) if (iss.code === "unrecognized_keys") {
		unrecIssue ?? (unrecIssue = iss);
		for (const k of iss.keys) {
			if (!unrecKeys.has(k)) unrecKeys.set(k, {});
			unrecKeys.get(k).l = true;
		}
	} else result.issues.push(iss);
	for (const iss of right.issues) if (iss.code === "unrecognized_keys") for (const k of iss.keys) {
		if (!unrecKeys.has(k)) unrecKeys.set(k, {});
		unrecKeys.get(k).r = true;
	}
	else result.issues.push(iss);
	const bothKeys = [...unrecKeys].filter(([, f]) => f.l && f.r).map(([k]) => k);
	if (bothKeys.length && unrecIssue) result.issues.push({
		...unrecIssue,
		keys: bothKeys
	});
	if (aborted(result)) return result;
	const merged = mergeValues(left.value, right.value);
	if (!merged.valid) throw new Error(`Unmergable intersection. Error path: ${JSON.stringify(merged.mergeErrorPath)}`);
	result.value = merged.data;
	return result;
}
var $ZodRecord = /*@__PURE__*/ $constructor("$ZodRecord", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.parse = (payload, ctx) => {
		const input = payload.value;
		if (!isPlainObject(input)) {
			payload.issues.push({
				expected: "record",
				code: "invalid_type",
				input,
				inst
			});
			return payload;
		}
		const proms = [];
		const values = def.keyType._zod.values;
		if (values) {
			payload.value = {};
			const recordKeys = /* @__PURE__ */ new Set();
			for (const key of values) if (typeof key === "string" || typeof key === "number" || typeof key === "symbol") {
				recordKeys.add(typeof key === "number" ? key.toString() : key);
				const keyResult = def.keyType._zod.run({
					value: key,
					issues: []
				}, ctx);
				if (keyResult instanceof Promise) throw new Error("Async schemas not supported in object keys currently");
				if (keyResult.issues.length) {
					payload.issues.push({
						code: "invalid_key",
						origin: "record",
						issues: keyResult.issues.map((iss) => finalizeIssue(iss, ctx, config())),
						input: key,
						path: [key],
						inst
					});
					continue;
				}
				const outKey = keyResult.value;
				const result = def.valueType._zod.run({
					value: input[key],
					issues: []
				}, ctx);
				if (result instanceof Promise) proms.push(result.then((result) => {
					if (result.issues.length) payload.issues.push(...prefixIssues(key, result.issues));
					payload.value[outKey] = result.value;
				}));
				else {
					if (result.issues.length) payload.issues.push(...prefixIssues(key, result.issues));
					payload.value[outKey] = result.value;
				}
			}
			let unrecognized;
			for (const key in input) if (!recordKeys.has(key)) {
				unrecognized = unrecognized ?? [];
				unrecognized.push(key);
			}
			if (unrecognized && unrecognized.length > 0) payload.issues.push({
				code: "unrecognized_keys",
				input,
				inst,
				keys: unrecognized
			});
		} else {
			payload.value = {};
			for (const key of Reflect.ownKeys(input)) {
				if (key === "__proto__") continue;
				if (!Object.prototype.propertyIsEnumerable.call(input, key)) continue;
				let keyResult = def.keyType._zod.run({
					value: key,
					issues: []
				}, ctx);
				if (keyResult instanceof Promise) throw new Error("Async schemas not supported in object keys currently");
				if (typeof key === "string" && number$1.test(key) && keyResult.issues.length) {
					const retryResult = def.keyType._zod.run({
						value: Number(key),
						issues: []
					}, ctx);
					if (retryResult instanceof Promise) throw new Error("Async schemas not supported in object keys currently");
					if (retryResult.issues.length === 0) keyResult = retryResult;
				}
				if (keyResult.issues.length) {
					if (def.mode === "loose") payload.value[key] = input[key];
					else payload.issues.push({
						code: "invalid_key",
						origin: "record",
						issues: keyResult.issues.map((iss) => finalizeIssue(iss, ctx, config())),
						input: key,
						path: [key],
						inst
					});
					continue;
				}
				const result = def.valueType._zod.run({
					value: input[key],
					issues: []
				}, ctx);
				if (result instanceof Promise) proms.push(result.then((result) => {
					if (result.issues.length) payload.issues.push(...prefixIssues(key, result.issues));
					payload.value[keyResult.value] = result.value;
				}));
				else {
					if (result.issues.length) payload.issues.push(...prefixIssues(key, result.issues));
					payload.value[keyResult.value] = result.value;
				}
			}
		}
		if (proms.length) return Promise.all(proms).then(() => payload);
		return payload;
	};
});
var $ZodEnum = /*@__PURE__*/ $constructor("$ZodEnum", (inst, def) => {
	$ZodType.init(inst, def);
	const values = getEnumValues(def.entries);
	const valuesSet = new Set(values);
	inst._zod.values = valuesSet;
	inst._zod.pattern = new RegExp(`^(${values.filter((k) => propertyKeyTypes.has(typeof k)).map((o) => typeof o === "string" ? escapeRegex(o) : o.toString()).join("|")})$`);
	inst._zod.parse = (payload, _ctx) => {
		const input = payload.value;
		if (valuesSet.has(input)) return payload;
		payload.issues.push({
			code: "invalid_value",
			values,
			input,
			inst
		});
		return payload;
	};
});
var $ZodLiteral = /*@__PURE__*/ $constructor("$ZodLiteral", (inst, def) => {
	$ZodType.init(inst, def);
	if (def.values.length === 0) throw new Error("Cannot create literal schema with no valid values");
	const values = new Set(def.values);
	inst._zod.values = values;
	inst._zod.pattern = new RegExp(`^(${def.values.map((o) => typeof o === "string" ? escapeRegex(o) : o ? escapeRegex(o.toString()) : String(o)).join("|")})$`);
	inst._zod.parse = (payload, _ctx) => {
		const input = payload.value;
		if (values.has(input)) return payload;
		payload.issues.push({
			code: "invalid_value",
			values: def.values,
			input,
			inst
		});
		return payload;
	};
});
var $ZodTransform = /*@__PURE__*/ $constructor("$ZodTransform", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.optin = "optional";
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") throw new $ZodEncodeError(inst.constructor.name);
		const _out = def.transform(payload.value, payload);
		if (ctx.async) return (_out instanceof Promise ? _out : Promise.resolve(_out)).then((output) => {
			payload.value = output;
			payload.fallback = true;
			return payload;
		});
		if (_out instanceof Promise) throw new $ZodAsyncError();
		payload.value = _out;
		payload.fallback = true;
		return payload;
	};
});
function handleOptionalResult(result, input) {
	if (input === void 0 && (result.issues.length || result.fallback)) return {
		issues: [],
		value: void 0
	};
	return result;
}
var $ZodOptional = /*@__PURE__*/ $constructor("$ZodOptional", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.optin = "optional";
	inst._zod.optout = "optional";
	defineLazy(inst._zod, "values", () => {
		return def.innerType._zod.values ? /* @__PURE__ */ new Set([...def.innerType._zod.values, void 0]) : void 0;
	});
	defineLazy(inst._zod, "pattern", () => {
		const pattern = def.innerType._zod.pattern;
		return pattern ? new RegExp(`^(${cleanRegex(pattern.source)})?$`) : void 0;
	});
	inst._zod.parse = (payload, ctx) => {
		if (def.innerType._zod.optin === "optional") {
			const input = payload.value;
			const result = def.innerType._zod.run(payload, ctx);
			if (result instanceof Promise) return result.then((r) => handleOptionalResult(r, input));
			return handleOptionalResult(result, input);
		}
		if (payload.value === void 0) return payload;
		return def.innerType._zod.run(payload, ctx);
	};
});
var $ZodExactOptional = /*@__PURE__*/ $constructor("$ZodExactOptional", (inst, def) => {
	$ZodOptional.init(inst, def);
	defineLazy(inst._zod, "values", () => def.innerType._zod.values);
	defineLazy(inst._zod, "pattern", () => def.innerType._zod.pattern);
	inst._zod.parse = (payload, ctx) => {
		return def.innerType._zod.run(payload, ctx);
	};
});
var $ZodNullable = /*@__PURE__*/ $constructor("$ZodNullable", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazy(inst._zod, "optin", () => def.innerType._zod.optin);
	defineLazy(inst._zod, "optout", () => def.innerType._zod.optout);
	defineLazy(inst._zod, "pattern", () => {
		const pattern = def.innerType._zod.pattern;
		return pattern ? new RegExp(`^(${cleanRegex(pattern.source)}|null)$`) : void 0;
	});
	defineLazy(inst._zod, "values", () => {
		return def.innerType._zod.values ? /* @__PURE__ */ new Set([...def.innerType._zod.values, null]) : void 0;
	});
	inst._zod.parse = (payload, ctx) => {
		if (payload.value === null) return payload;
		return def.innerType._zod.run(payload, ctx);
	};
});
var $ZodDefault = /*@__PURE__*/ $constructor("$ZodDefault", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.optin = "optional";
	defineLazy(inst._zod, "values", () => def.innerType._zod.values);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") return def.innerType._zod.run(payload, ctx);
		if (payload.value === void 0) {
			payload.value = def.defaultValue;
			/**
			* $ZodDefault returns the default value immediately in forward direction.
			* It doesn't pass the default value into the validator ("prefault"). There's no reason to pass the default value through validation. The validity of the default is enforced by TypeScript statically. Otherwise, it's the responsibility of the user to ensure the default is valid. In the case of pipes with divergent in/out types, you can specify the default on the `in` schema of your ZodPipe to set a "prefault" for the pipe.   */
			return payload;
		}
		const result = def.innerType._zod.run(payload, ctx);
		if (result instanceof Promise) return result.then((result) => handleDefaultResult(result, def));
		return handleDefaultResult(result, def);
	};
});
function handleDefaultResult(payload, def) {
	if (payload.value === void 0) payload.value = def.defaultValue;
	return payload;
}
var $ZodPrefault = /*@__PURE__*/ $constructor("$ZodPrefault", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.optin = "optional";
	defineLazy(inst._zod, "values", () => def.innerType._zod.values);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") return def.innerType._zod.run(payload, ctx);
		if (payload.value === void 0) payload.value = def.defaultValue;
		return def.innerType._zod.run(payload, ctx);
	};
});
var $ZodNonOptional = /*@__PURE__*/ $constructor("$ZodNonOptional", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazy(inst._zod, "values", () => {
		const v = def.innerType._zod.values;
		return v ? new Set([...v].filter((x) => x !== void 0)) : void 0;
	});
	inst._zod.parse = (payload, ctx) => {
		const result = def.innerType._zod.run(payload, ctx);
		if (result instanceof Promise) return result.then((result) => handleNonOptionalResult(result, inst));
		return handleNonOptionalResult(result, inst);
	};
});
function handleNonOptionalResult(payload, inst) {
	if (!payload.issues.length && payload.value === void 0) payload.issues.push({
		code: "invalid_type",
		expected: "nonoptional",
		input: payload.value,
		inst
	});
	return payload;
}
var $ZodCatch = /*@__PURE__*/ $constructor("$ZodCatch", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.optin = "optional";
	defineLazy(inst._zod, "optout", () => def.innerType._zod.optout);
	defineLazy(inst._zod, "values", () => def.innerType._zod.values);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") return def.innerType._zod.run(payload, ctx);
		const result = def.innerType._zod.run(payload, ctx);
		if (result instanceof Promise) return result.then((result) => {
			payload.value = result.value;
			if (result.issues.length) {
				payload.value = def.catchValue({
					...payload,
					error: { issues: result.issues.map((iss) => finalizeIssue(iss, ctx, config())) },
					input: payload.value
				});
				payload.issues = [];
				payload.fallback = true;
			}
			return payload;
		});
		payload.value = result.value;
		if (result.issues.length) {
			payload.value = def.catchValue({
				...payload,
				error: { issues: result.issues.map((iss) => finalizeIssue(iss, ctx, config())) },
				input: payload.value
			});
			payload.issues = [];
			payload.fallback = true;
		}
		return payload;
	};
});
var $ZodPipe = /*@__PURE__*/ $constructor("$ZodPipe", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazy(inst._zod, "values", () => def.in._zod.values);
	defineLazy(inst._zod, "optin", () => def.in._zod.optin);
	defineLazy(inst._zod, "optout", () => def.out._zod.optout);
	defineLazy(inst._zod, "propValues", () => def.in._zod.propValues);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") {
			const right = def.out._zod.run(payload, ctx);
			if (right instanceof Promise) return right.then((right) => handlePipeResult(right, def.in, ctx));
			return handlePipeResult(right, def.in, ctx);
		}
		const left = def.in._zod.run(payload, ctx);
		if (left instanceof Promise) return left.then((left) => handlePipeResult(left, def.out, ctx));
		return handlePipeResult(left, def.out, ctx);
	};
});
function handlePipeResult(left, next, ctx) {
	if (left.issues.length) {
		left.aborted = true;
		return left;
	}
	return next._zod.run({
		value: left.value,
		issues: left.issues,
		fallback: left.fallback
	}, ctx);
}
var $ZodReadonly = /*@__PURE__*/ $constructor("$ZodReadonly", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazy(inst._zod, "propValues", () => def.innerType._zod.propValues);
	defineLazy(inst._zod, "values", () => def.innerType._zod.values);
	defineLazy(inst._zod, "optin", () => def.innerType?._zod?.optin);
	defineLazy(inst._zod, "optout", () => def.innerType?._zod?.optout);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") return def.innerType._zod.run(payload, ctx);
		const result = def.innerType._zod.run(payload, ctx);
		if (result instanceof Promise) return result.then(handleReadonlyResult);
		return handleReadonlyResult(result);
	};
});
function handleReadonlyResult(payload) {
	payload.value = Object.freeze(payload.value);
	return payload;
}
var $ZodCustom = /*@__PURE__*/ $constructor("$ZodCustom", (inst, def) => {
	$ZodCheck.init(inst, def);
	$ZodType.init(inst, def);
	inst._zod.parse = (payload, _) => {
		return payload;
	};
	inst._zod.check = (payload) => {
		const input = payload.value;
		const r = def.fn(input);
		if (r instanceof Promise) return r.then((r) => handleRefineResult(r, payload, input, inst));
		handleRefineResult(r, payload, input, inst);
	};
});
function handleRefineResult(result, payload, input, inst) {
	if (!result) {
		const _iss = {
			code: "custom",
			input,
			inst,
			path: [...inst._zod.def.path ?? []],
			continue: !inst._zod.def.abort
		};
		if (inst._zod.def.params) _iss.params = inst._zod.def.params;
		payload.issues.push(issue(_iss));
	}
}
//#endregion
//#region node_modules/zod/v4/core/registries.js
var _a;
var $ZodRegistry = class {
	constructor() {
		this._map = /* @__PURE__ */ new WeakMap();
		this._idmap = /* @__PURE__ */ new Map();
	}
	add(schema, ..._meta) {
		const meta = _meta[0];
		this._map.set(schema, meta);
		if (meta && typeof meta === "object" && "id" in meta) this._idmap.set(meta.id, schema);
		return this;
	}
	clear() {
		this._map = /* @__PURE__ */ new WeakMap();
		this._idmap = /* @__PURE__ */ new Map();
		return this;
	}
	remove(schema) {
		const meta = this._map.get(schema);
		if (meta && typeof meta === "object" && "id" in meta) this._idmap.delete(meta.id);
		this._map.delete(schema);
		return this;
	}
	get(schema) {
		const p = schema._zod.parent;
		if (p) {
			const pm = { ...this.get(p) ?? {} };
			delete pm.id;
			const f = {
				...pm,
				...this._map.get(schema)
			};
			return Object.keys(f).length ? f : void 0;
		}
		return this._map.get(schema);
	}
	has(schema) {
		return this._map.has(schema);
	}
};
function registry() {
	return new $ZodRegistry();
}
(_a = globalThis).__zod_globalRegistry ?? (_a.__zod_globalRegistry = registry());
var globalRegistry = globalThis.__zod_globalRegistry;
//#endregion
//#region node_modules/zod/v4/core/api.js
// @__NO_SIDE_EFFECTS__
function _string(Class, params) {
	return new Class({
		type: "string",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _email(Class, params) {
	return new Class({
		type: "string",
		format: "email",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _guid(Class, params) {
	return new Class({
		type: "string",
		format: "guid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _uuid(Class, params) {
	return new Class({
		type: "string",
		format: "uuid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _uuidv4(Class, params) {
	return new Class({
		type: "string",
		format: "uuid",
		check: "string_format",
		abort: false,
		version: "v4",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _uuidv6(Class, params) {
	return new Class({
		type: "string",
		format: "uuid",
		check: "string_format",
		abort: false,
		version: "v6",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _uuidv7(Class, params) {
	return new Class({
		type: "string",
		format: "uuid",
		check: "string_format",
		abort: false,
		version: "v7",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _url(Class, params) {
	return new Class({
		type: "string",
		format: "url",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _emoji(Class, params) {
	return new Class({
		type: "string",
		format: "emoji",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _nanoid(Class, params) {
	return new Class({
		type: "string",
		format: "nanoid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
/**
* @deprecated CUID v1 is deprecated by its authors due to information leakage
* (timestamps embedded in the id). Use {@link _cuid2} instead.
* See https://github.com/paralleldrive/cuid.
*/
// @__NO_SIDE_EFFECTS__
function _cuid(Class, params) {
	return new Class({
		type: "string",
		format: "cuid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _cuid2(Class, params) {
	return new Class({
		type: "string",
		format: "cuid2",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _ulid(Class, params) {
	return new Class({
		type: "string",
		format: "ulid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _xid(Class, params) {
	return new Class({
		type: "string",
		format: "xid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _ksuid(Class, params) {
	return new Class({
		type: "string",
		format: "ksuid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _ipv4(Class, params) {
	return new Class({
		type: "string",
		format: "ipv4",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _ipv6(Class, params) {
	return new Class({
		type: "string",
		format: "ipv6",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _cidrv4(Class, params) {
	return new Class({
		type: "string",
		format: "cidrv4",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _cidrv6(Class, params) {
	return new Class({
		type: "string",
		format: "cidrv6",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _base64(Class, params) {
	return new Class({
		type: "string",
		format: "base64",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _base64url(Class, params) {
	return new Class({
		type: "string",
		format: "base64url",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _e164(Class, params) {
	return new Class({
		type: "string",
		format: "e164",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _jwt(Class, params) {
	return new Class({
		type: "string",
		format: "jwt",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _isoDateTime(Class, params) {
	return new Class({
		type: "string",
		format: "datetime",
		check: "string_format",
		offset: false,
		local: false,
		precision: null,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _isoDate(Class, params) {
	return new Class({
		type: "string",
		format: "date",
		check: "string_format",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _isoTime(Class, params) {
	return new Class({
		type: "string",
		format: "time",
		check: "string_format",
		precision: null,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _isoDuration(Class, params) {
	return new Class({
		type: "string",
		format: "duration",
		check: "string_format",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _number(Class, params) {
	return new Class({
		type: "number",
		checks: [],
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _int(Class, params) {
	return new Class({
		type: "number",
		check: "number_format",
		abort: false,
		format: "safeint",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _boolean(Class, params) {
	return new Class({
		type: "boolean",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _unknown(Class) {
	return new Class({ type: "unknown" });
}
// @__NO_SIDE_EFFECTS__
function _never(Class, params) {
	return new Class({
		type: "never",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _lt(value, params) {
	return new $ZodCheckLessThan({
		check: "less_than",
		...normalizeParams(params),
		value,
		inclusive: false
	});
}
// @__NO_SIDE_EFFECTS__
function _lte(value, params) {
	return new $ZodCheckLessThan({
		check: "less_than",
		...normalizeParams(params),
		value,
		inclusive: true
	});
}
// @__NO_SIDE_EFFECTS__
function _gt(value, params) {
	return new $ZodCheckGreaterThan({
		check: "greater_than",
		...normalizeParams(params),
		value,
		inclusive: false
	});
}
// @__NO_SIDE_EFFECTS__
function _gte(value, params) {
	return new $ZodCheckGreaterThan({
		check: "greater_than",
		...normalizeParams(params),
		value,
		inclusive: true
	});
}
// @__NO_SIDE_EFFECTS__
function _multipleOf(value, params) {
	return new $ZodCheckMultipleOf({
		check: "multiple_of",
		...normalizeParams(params),
		value
	});
}
// @__NO_SIDE_EFFECTS__
function _maxLength(maximum, params) {
	return new $ZodCheckMaxLength({
		check: "max_length",
		...normalizeParams(params),
		maximum
	});
}
// @__NO_SIDE_EFFECTS__
function _minLength(minimum, params) {
	return new $ZodCheckMinLength({
		check: "min_length",
		...normalizeParams(params),
		minimum
	});
}
// @__NO_SIDE_EFFECTS__
function _length(length, params) {
	return new $ZodCheckLengthEquals({
		check: "length_equals",
		...normalizeParams(params),
		length
	});
}
// @__NO_SIDE_EFFECTS__
function _regex(pattern, params) {
	return new $ZodCheckRegex({
		check: "string_format",
		format: "regex",
		...normalizeParams(params),
		pattern
	});
}
// @__NO_SIDE_EFFECTS__
function _lowercase(params) {
	return new $ZodCheckLowerCase({
		check: "string_format",
		format: "lowercase",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _uppercase(params) {
	return new $ZodCheckUpperCase({
		check: "string_format",
		format: "uppercase",
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _includes(includes, params) {
	return new $ZodCheckIncludes({
		check: "string_format",
		format: "includes",
		...normalizeParams(params),
		includes
	});
}
// @__NO_SIDE_EFFECTS__
function _startsWith(prefix, params) {
	return new $ZodCheckStartsWith({
		check: "string_format",
		format: "starts_with",
		...normalizeParams(params),
		prefix
	});
}
// @__NO_SIDE_EFFECTS__
function _endsWith(suffix, params) {
	return new $ZodCheckEndsWith({
		check: "string_format",
		format: "ends_with",
		...normalizeParams(params),
		suffix
	});
}
// @__NO_SIDE_EFFECTS__
function _overwrite(tx) {
	return new $ZodCheckOverwrite({
		check: "overwrite",
		tx
	});
}
// @__NO_SIDE_EFFECTS__
function _normalize(form) {
	return /* @__PURE__ */ _overwrite((input) => input.normalize(form));
}
// @__NO_SIDE_EFFECTS__
function _trim() {
	return /* @__PURE__ */ _overwrite((input) => input.trim());
}
// @__NO_SIDE_EFFECTS__
function _toLowerCase() {
	return /* @__PURE__ */ _overwrite((input) => input.toLowerCase());
}
// @__NO_SIDE_EFFECTS__
function _toUpperCase() {
	return /* @__PURE__ */ _overwrite((input) => input.toUpperCase());
}
// @__NO_SIDE_EFFECTS__
function _slugify() {
	return /* @__PURE__ */ _overwrite((input) => slugify(input));
}
// @__NO_SIDE_EFFECTS__
function _array(Class, element, params) {
	return new Class({
		type: "array",
		element,
		...normalizeParams(params)
	});
}
// @__NO_SIDE_EFFECTS__
function _refine(Class, fn, _params) {
	return new Class({
		type: "custom",
		check: "custom",
		fn,
		...normalizeParams(_params)
	});
}
// @__NO_SIDE_EFFECTS__
function _superRefine(fn, params) {
	const ch = /* @__PURE__ */ _check((payload) => {
		payload.addIssue = (issue$2) => {
			if (typeof issue$2 === "string") payload.issues.push(issue(issue$2, payload.value, ch._zod.def));
			else {
				const _issue = issue$2;
				if (_issue.fatal) _issue.continue = false;
				_issue.code ?? (_issue.code = "custom");
				_issue.input ?? (_issue.input = payload.value);
				_issue.inst ?? (_issue.inst = ch);
				_issue.continue ?? (_issue.continue = !ch._zod.def.abort);
				payload.issues.push(issue(_issue));
			}
		};
		return fn(payload.value, payload);
	}, params);
	return ch;
}
// @__NO_SIDE_EFFECTS__
function _check(fn, params) {
	const ch = new $ZodCheck({
		check: "custom",
		...normalizeParams(params)
	});
	ch._zod.check = fn;
	return ch;
}
//#endregion
//#region node_modules/zod/v4/core/to-json-schema.js
function initializeContext(params) {
	let target = params?.target ?? "draft-2020-12";
	if (target === "draft-4") target = "draft-04";
	if (target === "draft-7") target = "draft-07";
	return {
		processors: params.processors ?? {},
		metadataRegistry: params?.metadata ?? globalRegistry,
		target,
		unrepresentable: params?.unrepresentable ?? "throw",
		override: params?.override ?? (() => {}),
		io: params?.io ?? "output",
		counter: 0,
		seen: /* @__PURE__ */ new Map(),
		cycles: params?.cycles ?? "ref",
		reused: params?.reused ?? "inline",
		external: params?.external ?? void 0
	};
}
function process$1(schema, ctx, _params = {
	path: [],
	schemaPath: []
}) {
	var _a;
	const def = schema._zod.def;
	const seen = ctx.seen.get(schema);
	if (seen) {
		seen.count++;
		if (_params.schemaPath.includes(schema)) seen.cycle = _params.path;
		return seen.schema;
	}
	const result = {
		schema: {},
		count: 1,
		cycle: void 0,
		path: _params.path
	};
	ctx.seen.set(schema, result);
	const overrideSchema = schema._zod.toJSONSchema?.();
	if (overrideSchema) result.schema = overrideSchema;
	else {
		const params = {
			..._params,
			schemaPath: [..._params.schemaPath, schema],
			path: _params.path
		};
		if (schema._zod.processJSONSchema) schema._zod.processJSONSchema(ctx, result.schema, params);
		else {
			const _json = result.schema;
			const processor = ctx.processors[def.type];
			if (!processor) throw new Error(`[toJSONSchema]: Non-representable type encountered: ${def.type}`);
			processor(schema, ctx, _json, params);
		}
		const parent = schema._zod.parent;
		if (parent) {
			if (!result.ref) result.ref = parent;
			process$1(parent, ctx, params);
			ctx.seen.get(parent).isParent = true;
		}
	}
	const meta = ctx.metadataRegistry.get(schema);
	if (meta) Object.assign(result.schema, meta);
	if (ctx.io === "input" && isTransforming(schema)) {
		delete result.schema.examples;
		delete result.schema.default;
	}
	if (ctx.io === "input" && "_prefault" in result.schema) (_a = result.schema).default ?? (_a.default = result.schema._prefault);
	delete result.schema._prefault;
	return ctx.seen.get(schema).schema;
}
function extractDefs(ctx, schema) {
	const root = ctx.seen.get(schema);
	if (!root) throw new Error("Unprocessed schema. This is a bug in Zod.");
	const idToSchema = /* @__PURE__ */ new Map();
	for (const entry of ctx.seen.entries()) {
		const id = ctx.metadataRegistry.get(entry[0])?.id;
		if (id) {
			const existing = idToSchema.get(id);
			if (existing && existing !== entry[0]) throw new Error(`Duplicate schema id "${id}" detected during JSON Schema conversion. Two different schemas cannot share the same id when converted together.`);
			idToSchema.set(id, entry[0]);
		}
	}
	const makeURI = (entry) => {
		const defsSegment = ctx.target === "draft-2020-12" ? "$defs" : "definitions";
		if (ctx.external) {
			const externalId = ctx.external.registry.get(entry[0])?.id;
			const uriGenerator = ctx.external.uri ?? ((id) => id);
			if (externalId) return { ref: uriGenerator(externalId) };
			const id = entry[1].defId ?? entry[1].schema.id ?? `schema${ctx.counter++}`;
			entry[1].defId = id;
			return {
				defId: id,
				ref: `${uriGenerator("__shared")}#/${defsSegment}/${id}`
			};
		}
		if (entry[1] === root) return { ref: "#" };
		const defUriPrefix = `#/${defsSegment}/`;
		const defId = entry[1].schema.id ?? `__schema${ctx.counter++}`;
		return {
			defId,
			ref: defUriPrefix + defId
		};
	};
	const extractToDef = (entry) => {
		if (entry[1].schema.$ref) return;
		const seen = entry[1];
		const { ref, defId } = makeURI(entry);
		seen.def = { ...seen.schema };
		if (defId) seen.defId = defId;
		const schema = seen.schema;
		for (const key in schema) delete schema[key];
		schema.$ref = ref;
	};
	if (ctx.cycles === "throw") for (const entry of ctx.seen.entries()) {
		const seen = entry[1];
		if (seen.cycle) throw new Error(`Cycle detected: #/${seen.cycle?.join("/")}/<root>

Set the \`cycles\` parameter to \`"ref"\` to resolve cyclical schemas with defs.`);
	}
	for (const entry of ctx.seen.entries()) {
		const seen = entry[1];
		if (schema === entry[0]) {
			extractToDef(entry);
			continue;
		}
		if (ctx.external) {
			const ext = ctx.external.registry.get(entry[0])?.id;
			if (schema !== entry[0] && ext) {
				extractToDef(entry);
				continue;
			}
		}
		if (ctx.metadataRegistry.get(entry[0])?.id) {
			extractToDef(entry);
			continue;
		}
		if (seen.cycle) {
			extractToDef(entry);
			continue;
		}
		if (seen.count > 1) {
			if (ctx.reused === "ref") {
				extractToDef(entry);
				continue;
			}
		}
	}
}
function finalize(ctx, schema) {
	const root = ctx.seen.get(schema);
	if (!root) throw new Error("Unprocessed schema. This is a bug in Zod.");
	const flattenRef = (zodSchema) => {
		const seen = ctx.seen.get(zodSchema);
		if (seen.ref === null) return;
		const schema = seen.def ?? seen.schema;
		const _cached = { ...schema };
		const ref = seen.ref;
		seen.ref = null;
		if (ref) {
			flattenRef(ref);
			const refSeen = ctx.seen.get(ref);
			const refSchema = refSeen.schema;
			if (refSchema.$ref && (ctx.target === "draft-07" || ctx.target === "draft-04" || ctx.target === "openapi-3.0")) {
				schema.allOf = schema.allOf ?? [];
				schema.allOf.push(refSchema);
			} else Object.assign(schema, refSchema);
			Object.assign(schema, _cached);
			if (zodSchema._zod.parent === ref) for (const key in schema) {
				if (key === "$ref" || key === "allOf") continue;
				if (!(key in _cached)) delete schema[key];
			}
			if (refSchema.$ref && refSeen.def) for (const key in schema) {
				if (key === "$ref" || key === "allOf") continue;
				if (key in refSeen.def && JSON.stringify(schema[key]) === JSON.stringify(refSeen.def[key])) delete schema[key];
			}
		}
		const parent = zodSchema._zod.parent;
		if (parent && parent !== ref) {
			flattenRef(parent);
			const parentSeen = ctx.seen.get(parent);
			if (parentSeen?.schema.$ref) {
				schema.$ref = parentSeen.schema.$ref;
				if (parentSeen.def) for (const key in schema) {
					if (key === "$ref" || key === "allOf") continue;
					if (key in parentSeen.def && JSON.stringify(schema[key]) === JSON.stringify(parentSeen.def[key])) delete schema[key];
				}
			}
		}
		ctx.override({
			zodSchema,
			jsonSchema: schema,
			path: seen.path ?? []
		});
	};
	for (const entry of [...ctx.seen.entries()].reverse()) flattenRef(entry[0]);
	const result = {};
	if (ctx.target === "draft-2020-12") result.$schema = "https://json-schema.org/draft/2020-12/schema";
	else if (ctx.target === "draft-07") result.$schema = "http://json-schema.org/draft-07/schema#";
	else if (ctx.target === "draft-04") result.$schema = "http://json-schema.org/draft-04/schema#";
	else if (ctx.target === "openapi-3.0") {}
	if (ctx.external?.uri) {
		const id = ctx.external.registry.get(schema)?.id;
		if (!id) throw new Error("Schema is missing an `id` property");
		result.$id = ctx.external.uri(id);
	}
	Object.assign(result, root.def ?? root.schema);
	const rootMetaId = ctx.metadataRegistry.get(schema)?.id;
	if (rootMetaId !== void 0 && result.id === rootMetaId) delete result.id;
	const defs = ctx.external?.defs ?? {};
	for (const entry of ctx.seen.entries()) {
		const seen = entry[1];
		if (seen.def && seen.defId) {
			if (seen.def.id === seen.defId) delete seen.def.id;
			defs[seen.defId] = seen.def;
		}
	}
	if (ctx.external) {} else if (Object.keys(defs).length > 0) if (ctx.target === "draft-2020-12") result.$defs = defs;
	else result.definitions = defs;
	try {
		const finalized = JSON.parse(JSON.stringify(result));
		Object.defineProperty(finalized, "~standard", {
			value: {
				...schema["~standard"],
				jsonSchema: {
					input: createStandardJSONSchemaMethod(schema, "input", ctx.processors),
					output: createStandardJSONSchemaMethod(schema, "output", ctx.processors)
				}
			},
			enumerable: false,
			writable: false
		});
		return finalized;
	} catch (_err) {
		throw new Error("Error converting schema to JSON.");
	}
}
function isTransforming(_schema, _ctx) {
	const ctx = _ctx ?? { seen: /* @__PURE__ */ new Set() };
	if (ctx.seen.has(_schema)) return false;
	ctx.seen.add(_schema);
	const def = _schema._zod.def;
	if (def.type === "transform") return true;
	if (def.type === "array") return isTransforming(def.element, ctx);
	if (def.type === "set") return isTransforming(def.valueType, ctx);
	if (def.type === "lazy") return isTransforming(def.getter(), ctx);
	if (def.type === "promise" || def.type === "optional" || def.type === "nonoptional" || def.type === "nullable" || def.type === "readonly" || def.type === "default" || def.type === "prefault") return isTransforming(def.innerType, ctx);
	if (def.type === "intersection") return isTransforming(def.left, ctx) || isTransforming(def.right, ctx);
	if (def.type === "record" || def.type === "map") return isTransforming(def.keyType, ctx) || isTransforming(def.valueType, ctx);
	if (def.type === "pipe") {
		if (_schema._zod.traits.has("$ZodCodec")) return true;
		return isTransforming(def.in, ctx) || isTransforming(def.out, ctx);
	}
	if (def.type === "object") {
		for (const key in def.shape) if (isTransforming(def.shape[key], ctx)) return true;
		return false;
	}
	if (def.type === "union") {
		for (const option of def.options) if (isTransforming(option, ctx)) return true;
		return false;
	}
	if (def.type === "tuple") {
		for (const item of def.items) if (isTransforming(item, ctx)) return true;
		if (def.rest && isTransforming(def.rest, ctx)) return true;
		return false;
	}
	return false;
}
/**
* Creates a toJSONSchema method for a schema instance.
* This encapsulates the logic of initializing context, processing, extracting defs, and finalizing.
*/
var createToJSONSchemaMethod = (schema, processors = {}) => (params) => {
	const ctx = initializeContext({
		...params,
		processors
	});
	process$1(schema, ctx);
	extractDefs(ctx, schema);
	return finalize(ctx, schema);
};
var createStandardJSONSchemaMethod = (schema, io, processors = {}) => (params) => {
	const { libraryOptions, target } = params ?? {};
	const ctx = initializeContext({
		...libraryOptions ?? {},
		target,
		io,
		processors
	});
	process$1(schema, ctx);
	extractDefs(ctx, schema);
	return finalize(ctx, schema);
};
//#endregion
//#region node_modules/zod/v4/core/json-schema-processors.js
var formatMap = {
	guid: "uuid",
	url: "uri",
	datetime: "date-time",
	json_string: "json-string",
	regex: ""
};
var stringProcessor = (schema, ctx, _json, _params) => {
	const json = _json;
	json.type = "string";
	const { minimum, maximum, format, patterns, contentEncoding } = schema._zod.bag;
	if (typeof minimum === "number") json.minLength = minimum;
	if (typeof maximum === "number") json.maxLength = maximum;
	if (format) {
		json.format = formatMap[format] ?? format;
		if (json.format === "") delete json.format;
		if (format === "time") delete json.format;
	}
	if (contentEncoding) json.contentEncoding = contentEncoding;
	if (patterns && patterns.size > 0) {
		const regexes = [...patterns];
		if (regexes.length === 1) json.pattern = regexes[0].source;
		else if (regexes.length > 1) json.allOf = [...regexes.map((regex) => ({
			...ctx.target === "draft-07" || ctx.target === "draft-04" || ctx.target === "openapi-3.0" ? { type: "string" } : {},
			pattern: regex.source
		}))];
	}
};
var numberProcessor = (schema, ctx, _json, _params) => {
	const json = _json;
	const { minimum, maximum, format, multipleOf, exclusiveMaximum, exclusiveMinimum } = schema._zod.bag;
	if (typeof format === "string" && format.includes("int")) json.type = "integer";
	else json.type = "number";
	const exMin = typeof exclusiveMinimum === "number" && exclusiveMinimum >= (minimum ?? Number.NEGATIVE_INFINITY);
	const exMax = typeof exclusiveMaximum === "number" && exclusiveMaximum <= (maximum ?? Number.POSITIVE_INFINITY);
	const legacy = ctx.target === "draft-04" || ctx.target === "openapi-3.0";
	if (exMin) if (legacy) {
		json.minimum = exclusiveMinimum;
		json.exclusiveMinimum = true;
	} else json.exclusiveMinimum = exclusiveMinimum;
	else if (typeof minimum === "number") json.minimum = minimum;
	if (exMax) if (legacy) {
		json.maximum = exclusiveMaximum;
		json.exclusiveMaximum = true;
	} else json.exclusiveMaximum = exclusiveMaximum;
	else if (typeof maximum === "number") json.maximum = maximum;
	if (typeof multipleOf === "number") json.multipleOf = multipleOf;
};
var booleanProcessor = (_schema, _ctx, json, _params) => {
	json.type = "boolean";
};
var neverProcessor = (_schema, _ctx, json, _params) => {
	json.not = {};
};
var enumProcessor = (schema, _ctx, json, _params) => {
	const def = schema._zod.def;
	const values = getEnumValues(def.entries);
	if (values.every((v) => typeof v === "number")) json.type = "number";
	if (values.every((v) => typeof v === "string")) json.type = "string";
	json.enum = values;
};
var literalProcessor = (schema, ctx, json, _params) => {
	const def = schema._zod.def;
	const vals = [];
	for (const val of def.values) if (val === void 0) {
		if (ctx.unrepresentable === "throw") throw new Error("Literal `undefined` cannot be represented in JSON Schema");
	} else if (typeof val === "bigint") if (ctx.unrepresentable === "throw") throw new Error("BigInt literals cannot be represented in JSON Schema");
	else vals.push(Number(val));
	else vals.push(val);
	if (vals.length === 0) {} else if (vals.length === 1) {
		const val = vals[0];
		json.type = val === null ? "null" : typeof val;
		if (ctx.target === "draft-04" || ctx.target === "openapi-3.0") json.enum = [val];
		else json.const = val;
	} else {
		if (vals.every((v) => typeof v === "number")) json.type = "number";
		if (vals.every((v) => typeof v === "string")) json.type = "string";
		if (vals.every((v) => typeof v === "boolean")) json.type = "boolean";
		if (vals.every((v) => v === null)) json.type = "null";
		json.enum = vals;
	}
};
var customProcessor = (_schema, ctx, _json, _params) => {
	if (ctx.unrepresentable === "throw") throw new Error("Custom types cannot be represented in JSON Schema");
};
var transformProcessor = (_schema, ctx, _json, _params) => {
	if (ctx.unrepresentable === "throw") throw new Error("Transforms cannot be represented in JSON Schema");
};
var arrayProcessor = (schema, ctx, _json, params) => {
	const json = _json;
	const def = schema._zod.def;
	const { minimum, maximum } = schema._zod.bag;
	if (typeof minimum === "number") json.minItems = minimum;
	if (typeof maximum === "number") json.maxItems = maximum;
	json.type = "array";
	json.items = process$1(def.element, ctx, {
		...params,
		path: [...params.path, "items"]
	});
};
var objectProcessor = (schema, ctx, _json, params) => {
	const json = _json;
	const def = schema._zod.def;
	json.type = "object";
	json.properties = {};
	const shape = def.shape;
	for (const key in shape) json.properties[key] = process$1(shape[key], ctx, {
		...params,
		path: [
			...params.path,
			"properties",
			key
		]
	});
	const allKeys = new Set(Object.keys(shape));
	const requiredKeys = new Set([...allKeys].filter((key) => {
		const v = def.shape[key]._zod;
		if (ctx.io === "input") return v.optin === void 0;
		else return v.optout === void 0;
	}));
	if (requiredKeys.size > 0) json.required = Array.from(requiredKeys);
	if (def.catchall?._zod.def.type === "never") json.additionalProperties = false;
	else if (!def.catchall) {
		if (ctx.io === "output") json.additionalProperties = false;
	} else if (def.catchall) json.additionalProperties = process$1(def.catchall, ctx, {
		...params,
		path: [...params.path, "additionalProperties"]
	});
};
var unionProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	const isExclusive = def.inclusive === false;
	const options = def.options.map((x, i) => process$1(x, ctx, {
		...params,
		path: [
			...params.path,
			isExclusive ? "oneOf" : "anyOf",
			i
		]
	}));
	if (isExclusive) json.oneOf = options;
	else json.anyOf = options;
};
var intersectionProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	const a = process$1(def.left, ctx, {
		...params,
		path: [
			...params.path,
			"allOf",
			0
		]
	});
	const b = process$1(def.right, ctx, {
		...params,
		path: [
			...params.path,
			"allOf",
			1
		]
	});
	const isSimpleIntersection = (val) => "allOf" in val && Object.keys(val).length === 1;
	json.allOf = [...isSimpleIntersection(a) ? a.allOf : [a], ...isSimpleIntersection(b) ? b.allOf : [b]];
};
var recordProcessor = (schema, ctx, _json, params) => {
	const json = _json;
	const def = schema._zod.def;
	json.type = "object";
	const keyType = def.keyType;
	const patterns = keyType._zod.bag?.patterns;
	if (def.mode === "loose" && patterns && patterns.size > 0) {
		const valueSchema = process$1(def.valueType, ctx, {
			...params,
			path: [
				...params.path,
				"patternProperties",
				"*"
			]
		});
		json.patternProperties = {};
		for (const pattern of patterns) json.patternProperties[pattern.source] = valueSchema;
	} else {
		if (ctx.target === "draft-07" || ctx.target === "draft-2020-12") json.propertyNames = process$1(def.keyType, ctx, {
			...params,
			path: [...params.path, "propertyNames"]
		});
		json.additionalProperties = process$1(def.valueType, ctx, {
			...params,
			path: [...params.path, "additionalProperties"]
		});
	}
	const keyValues = keyType._zod.values;
	if (keyValues) {
		const validKeyValues = [...keyValues].filter((v) => typeof v === "string" || typeof v === "number");
		if (validKeyValues.length > 0) json.required = validKeyValues;
	}
};
var nullableProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	const inner = process$1(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	if (ctx.target === "openapi-3.0") {
		seen.ref = def.innerType;
		json.nullable = true;
	} else json.anyOf = [inner, { type: "null" }];
};
var nonoptionalProcessor = (schema, ctx, _json, params) => {
	const def = schema._zod.def;
	process$1(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
};
var defaultProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	process$1(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
	json.default = JSON.parse(JSON.stringify(def.defaultValue));
};
var prefaultProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	process$1(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
	if (ctx.io === "input") json._prefault = JSON.parse(JSON.stringify(def.defaultValue));
};
var catchProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	process$1(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
	let catchValue;
	try {
		catchValue = def.catchValue(void 0);
	} catch {
		throw new Error("Dynamic catch values are not supported in JSON Schema");
	}
	json.default = catchValue;
};
var pipeProcessor = (schema, ctx, _json, params) => {
	const def = schema._zod.def;
	const inIsTransform = def.in._zod.traits.has("$ZodTransform");
	const innerType = ctx.io === "input" ? inIsTransform ? def.out : def.in : def.out;
	process$1(innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = innerType;
};
var readonlyProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	process$1(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
	json.readOnly = true;
};
var optionalProcessor = (schema, ctx, _json, params) => {
	const def = schema._zod.def;
	process$1(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
};
//#endregion
//#region node_modules/zod/v4/classic/iso.js
var ZodISODateTime = /*@__PURE__*/ $constructor("ZodISODateTime", (inst, def) => {
	$ZodISODateTime.init(inst, def);
	ZodStringFormat.init(inst, def);
});
function datetime(params) {
	return /* @__PURE__ */ _isoDateTime(ZodISODateTime, params);
}
var ZodISODate = /*@__PURE__*/ $constructor("ZodISODate", (inst, def) => {
	$ZodISODate.init(inst, def);
	ZodStringFormat.init(inst, def);
});
function date(params) {
	return /* @__PURE__ */ _isoDate(ZodISODate, params);
}
var ZodISOTime = /*@__PURE__*/ $constructor("ZodISOTime", (inst, def) => {
	$ZodISOTime.init(inst, def);
	ZodStringFormat.init(inst, def);
});
function time(params) {
	return /* @__PURE__ */ _isoTime(ZodISOTime, params);
}
var ZodISODuration = /*@__PURE__*/ $constructor("ZodISODuration", (inst, def) => {
	$ZodISODuration.init(inst, def);
	ZodStringFormat.init(inst, def);
});
function duration(params) {
	return /* @__PURE__ */ _isoDuration(ZodISODuration, params);
}
//#endregion
//#region node_modules/zod/v4/classic/errors.js
var initializer = (inst, issues) => {
	$ZodError.init(inst, issues);
	inst.name = "ZodError";
	Object.defineProperties(inst, {
		format: { value: (mapper) => formatError(inst, mapper) },
		flatten: { value: (mapper) => flattenError(inst, mapper) },
		addIssue: { value: (issue) => {
			inst.issues.push(issue);
			inst.message = JSON.stringify(inst.issues, jsonStringifyReplacer, 2);
		} },
		addIssues: { value: (issues) => {
			inst.issues.push(...issues);
			inst.message = JSON.stringify(inst.issues, jsonStringifyReplacer, 2);
		} },
		isEmpty: { get() {
			return inst.issues.length === 0;
		} }
	});
};
var ZodRealError = /*@__PURE__*/ $constructor("ZodError", initializer, { Parent: Error });
//#endregion
//#region node_modules/zod/v4/classic/parse.js
var parse = /* @__PURE__ */ _parse(ZodRealError);
var parseAsync = /* @__PURE__ */ _parseAsync(ZodRealError);
var safeParse = /* @__PURE__ */ _safeParse(ZodRealError);
var safeParseAsync = /* @__PURE__ */ _safeParseAsync(ZodRealError);
var encode = /* @__PURE__ */ _encode(ZodRealError);
var decode = /* @__PURE__ */ _decode(ZodRealError);
var encodeAsync = /* @__PURE__ */ _encodeAsync(ZodRealError);
var decodeAsync = /* @__PURE__ */ _decodeAsync(ZodRealError);
var safeEncode = /* @__PURE__ */ _safeEncode(ZodRealError);
var safeDecode = /* @__PURE__ */ _safeDecode(ZodRealError);
var safeEncodeAsync = /* @__PURE__ */ _safeEncodeAsync(ZodRealError);
var safeDecodeAsync = /* @__PURE__ */ _safeDecodeAsync(ZodRealError);
//#endregion
//#region node_modules/zod/v4/classic/schemas.js
var _installedGroups = /* @__PURE__ */ new WeakMap();
function _installLazyMethods(inst, group, methods) {
	const proto = Object.getPrototypeOf(inst);
	let installed = _installedGroups.get(proto);
	if (!installed) {
		installed = /* @__PURE__ */ new Set();
		_installedGroups.set(proto, installed);
	}
	if (installed.has(group)) return;
	installed.add(group);
	for (const key in methods) {
		const fn = methods[key];
		Object.defineProperty(proto, key, {
			configurable: true,
			enumerable: false,
			get() {
				const bound = fn.bind(this);
				Object.defineProperty(this, key, {
					configurable: true,
					writable: true,
					enumerable: true,
					value: bound
				});
				return bound;
			},
			set(v) {
				Object.defineProperty(this, key, {
					configurable: true,
					writable: true,
					enumerable: true,
					value: v
				});
			}
		});
	}
}
var ZodType = /*@__PURE__*/ $constructor("ZodType", (inst, def) => {
	$ZodType.init(inst, def);
	Object.assign(inst["~standard"], { jsonSchema: {
		input: createStandardJSONSchemaMethod(inst, "input"),
		output: createStandardJSONSchemaMethod(inst, "output")
	} });
	inst.toJSONSchema = createToJSONSchemaMethod(inst, {});
	inst.def = def;
	inst.type = def.type;
	Object.defineProperty(inst, "_def", { value: def });
	inst.parse = (data, params) => parse(inst, data, params, { callee: inst.parse });
	inst.safeParse = (data, params) => safeParse(inst, data, params);
	inst.parseAsync = async (data, params) => parseAsync(inst, data, params, { callee: inst.parseAsync });
	inst.safeParseAsync = async (data, params) => safeParseAsync(inst, data, params);
	inst.spa = inst.safeParseAsync;
	inst.encode = (data, params) => encode(inst, data, params);
	inst.decode = (data, params) => decode(inst, data, params);
	inst.encodeAsync = async (data, params) => encodeAsync(inst, data, params);
	inst.decodeAsync = async (data, params) => decodeAsync(inst, data, params);
	inst.safeEncode = (data, params) => safeEncode(inst, data, params);
	inst.safeDecode = (data, params) => safeDecode(inst, data, params);
	inst.safeEncodeAsync = async (data, params) => safeEncodeAsync(inst, data, params);
	inst.safeDecodeAsync = async (data, params) => safeDecodeAsync(inst, data, params);
	_installLazyMethods(inst, "ZodType", {
		check(...chks) {
			const def = this.def;
			return this.clone(mergeDefs(def, { checks: [...def.checks ?? [], ...chks.map((ch) => typeof ch === "function" ? { _zod: {
				check: ch,
				def: { check: "custom" },
				onattach: []
			} } : ch)] }), { parent: true });
		},
		with(...chks) {
			return this.check(...chks);
		},
		clone(def, params) {
			return clone(this, def, params);
		},
		brand() {
			return this;
		},
		register(reg, meta) {
			reg.add(this, meta);
			return this;
		},
		refine(check, params) {
			return this.check(refine(check, params));
		},
		superRefine(refinement, params) {
			return this.check(superRefine(refinement, params));
		},
		overwrite(fn) {
			return this.check(/* @__PURE__ */ _overwrite(fn));
		},
		optional() {
			return optional(this);
		},
		exactOptional() {
			return exactOptional(this);
		},
		nullable() {
			return nullable(this);
		},
		nullish() {
			return optional(nullable(this));
		},
		nonoptional(params) {
			return nonoptional(this, params);
		},
		array() {
			return array(this);
		},
		or(arg) {
			return union([this, arg]);
		},
		and(arg) {
			return intersection(this, arg);
		},
		transform(tx) {
			return pipe(this, transform(tx));
		},
		default(d) {
			return _default(this, d);
		},
		prefault(d) {
			return prefault(this, d);
		},
		catch(params) {
			return _catch(this, params);
		},
		pipe(target) {
			return pipe(this, target);
		},
		readonly() {
			return readonly(this);
		},
		describe(description) {
			const cl = this.clone();
			globalRegistry.add(cl, { description });
			return cl;
		},
		meta(...args) {
			if (args.length === 0) return globalRegistry.get(this);
			const cl = this.clone();
			globalRegistry.add(cl, args[0]);
			return cl;
		},
		isOptional() {
			return this.safeParse(void 0).success;
		},
		isNullable() {
			return this.safeParse(null).success;
		},
		apply(fn) {
			return fn(this);
		}
	});
	Object.defineProperty(inst, "description", {
		get() {
			return globalRegistry.get(inst)?.description;
		},
		configurable: true
	});
	return inst;
});
/** @internal */
var _ZodString = /*@__PURE__*/ $constructor("_ZodString", (inst, def) => {
	$ZodString.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => stringProcessor(inst, ctx, json, params);
	const bag = inst._zod.bag;
	inst.format = bag.format ?? null;
	inst.minLength = bag.minimum ?? null;
	inst.maxLength = bag.maximum ?? null;
	_installLazyMethods(inst, "_ZodString", {
		regex(...args) {
			return this.check(/* @__PURE__ */ _regex(...args));
		},
		includes(...args) {
			return this.check(/* @__PURE__ */ _includes(...args));
		},
		startsWith(...args) {
			return this.check(/* @__PURE__ */ _startsWith(...args));
		},
		endsWith(...args) {
			return this.check(/* @__PURE__ */ _endsWith(...args));
		},
		min(...args) {
			return this.check(/* @__PURE__ */ _minLength(...args));
		},
		max(...args) {
			return this.check(/* @__PURE__ */ _maxLength(...args));
		},
		length(...args) {
			return this.check(/* @__PURE__ */ _length(...args));
		},
		nonempty(...args) {
			return this.check(/* @__PURE__ */ _minLength(1, ...args));
		},
		lowercase(params) {
			return this.check(/* @__PURE__ */ _lowercase(params));
		},
		uppercase(params) {
			return this.check(/* @__PURE__ */ _uppercase(params));
		},
		trim() {
			return this.check(/* @__PURE__ */ _trim());
		},
		normalize(...args) {
			return this.check(/* @__PURE__ */ _normalize(...args));
		},
		toLowerCase() {
			return this.check(/* @__PURE__ */ _toLowerCase());
		},
		toUpperCase() {
			return this.check(/* @__PURE__ */ _toUpperCase());
		},
		slugify() {
			return this.check(/* @__PURE__ */ _slugify());
		}
	});
});
var ZodString = /*@__PURE__*/ $constructor("ZodString", (inst, def) => {
	$ZodString.init(inst, def);
	_ZodString.init(inst, def);
	inst.email = (params) => inst.check(/* @__PURE__ */ _email(ZodEmail, params));
	inst.url = (params) => inst.check(/* @__PURE__ */ _url(ZodURL, params));
	inst.jwt = (params) => inst.check(/* @__PURE__ */ _jwt(ZodJWT, params));
	inst.emoji = (params) => inst.check(/* @__PURE__ */ _emoji(ZodEmoji, params));
	inst.guid = (params) => inst.check(/* @__PURE__ */ _guid(ZodGUID, params));
	inst.uuid = (params) => inst.check(/* @__PURE__ */ _uuid(ZodUUID, params));
	inst.uuidv4 = (params) => inst.check(/* @__PURE__ */ _uuidv4(ZodUUID, params));
	inst.uuidv6 = (params) => inst.check(/* @__PURE__ */ _uuidv6(ZodUUID, params));
	inst.uuidv7 = (params) => inst.check(/* @__PURE__ */ _uuidv7(ZodUUID, params));
	inst.nanoid = (params) => inst.check(/* @__PURE__ */ _nanoid(ZodNanoID, params));
	inst.guid = (params) => inst.check(/* @__PURE__ */ _guid(ZodGUID, params));
	inst.cuid = (params) => inst.check(/* @__PURE__ */ _cuid(ZodCUID, params));
	inst.cuid2 = (params) => inst.check(/* @__PURE__ */ _cuid2(ZodCUID2, params));
	inst.ulid = (params) => inst.check(/* @__PURE__ */ _ulid(ZodULID, params));
	inst.base64 = (params) => inst.check(/* @__PURE__ */ _base64(ZodBase64, params));
	inst.base64url = (params) => inst.check(/* @__PURE__ */ _base64url(ZodBase64URL, params));
	inst.xid = (params) => inst.check(/* @__PURE__ */ _xid(ZodXID, params));
	inst.ksuid = (params) => inst.check(/* @__PURE__ */ _ksuid(ZodKSUID, params));
	inst.ipv4 = (params) => inst.check(/* @__PURE__ */ _ipv4(ZodIPv4, params));
	inst.ipv6 = (params) => inst.check(/* @__PURE__ */ _ipv6(ZodIPv6, params));
	inst.cidrv4 = (params) => inst.check(/* @__PURE__ */ _cidrv4(ZodCIDRv4, params));
	inst.cidrv6 = (params) => inst.check(/* @__PURE__ */ _cidrv6(ZodCIDRv6, params));
	inst.e164 = (params) => inst.check(/* @__PURE__ */ _e164(ZodE164, params));
	inst.datetime = (params) => inst.check(datetime(params));
	inst.date = (params) => inst.check(date(params));
	inst.time = (params) => inst.check(time(params));
	inst.duration = (params) => inst.check(duration(params));
});
function string(params) {
	return /* @__PURE__ */ _string(ZodString, params);
}
var ZodStringFormat = /*@__PURE__*/ $constructor("ZodStringFormat", (inst, def) => {
	$ZodStringFormat.init(inst, def);
	_ZodString.init(inst, def);
});
var ZodEmail = /*@__PURE__*/ $constructor("ZodEmail", (inst, def) => {
	$ZodEmail.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodGUID = /*@__PURE__*/ $constructor("ZodGUID", (inst, def) => {
	$ZodGUID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodUUID = /*@__PURE__*/ $constructor("ZodUUID", (inst, def) => {
	$ZodUUID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodURL = /*@__PURE__*/ $constructor("ZodURL", (inst, def) => {
	$ZodURL.init(inst, def);
	ZodStringFormat.init(inst, def);
});
function url(params) {
	return /* @__PURE__ */ _url(ZodURL, params);
}
var ZodEmoji = /*@__PURE__*/ $constructor("ZodEmoji", (inst, def) => {
	$ZodEmoji.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodNanoID = /*@__PURE__*/ $constructor("ZodNanoID", (inst, def) => {
	$ZodNanoID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
/**
* @deprecated CUID v1 is deprecated by its authors due to information leakage
* (timestamps embedded in the id). Use {@link ZodCUID2} instead.
* See https://github.com/paralleldrive/cuid.
*/
var ZodCUID = /*@__PURE__*/ $constructor("ZodCUID", (inst, def) => {
	$ZodCUID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodCUID2 = /*@__PURE__*/ $constructor("ZodCUID2", (inst, def) => {
	$ZodCUID2.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodULID = /*@__PURE__*/ $constructor("ZodULID", (inst, def) => {
	$ZodULID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodXID = /*@__PURE__*/ $constructor("ZodXID", (inst, def) => {
	$ZodXID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodKSUID = /*@__PURE__*/ $constructor("ZodKSUID", (inst, def) => {
	$ZodKSUID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodIPv4 = /*@__PURE__*/ $constructor("ZodIPv4", (inst, def) => {
	$ZodIPv4.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodIPv6 = /*@__PURE__*/ $constructor("ZodIPv6", (inst, def) => {
	$ZodIPv6.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodCIDRv4 = /*@__PURE__*/ $constructor("ZodCIDRv4", (inst, def) => {
	$ZodCIDRv4.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodCIDRv6 = /*@__PURE__*/ $constructor("ZodCIDRv6", (inst, def) => {
	$ZodCIDRv6.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodBase64 = /*@__PURE__*/ $constructor("ZodBase64", (inst, def) => {
	$ZodBase64.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodBase64URL = /*@__PURE__*/ $constructor("ZodBase64URL", (inst, def) => {
	$ZodBase64URL.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodE164 = /*@__PURE__*/ $constructor("ZodE164", (inst, def) => {
	$ZodE164.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodJWT = /*@__PURE__*/ $constructor("ZodJWT", (inst, def) => {
	$ZodJWT.init(inst, def);
	ZodStringFormat.init(inst, def);
});
var ZodNumber = /*@__PURE__*/ $constructor("ZodNumber", (inst, def) => {
	$ZodNumber.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => numberProcessor(inst, ctx, json, params);
	_installLazyMethods(inst, "ZodNumber", {
		gt(value, params) {
			return this.check(/* @__PURE__ */ _gt(value, params));
		},
		gte(value, params) {
			return this.check(/* @__PURE__ */ _gte(value, params));
		},
		min(value, params) {
			return this.check(/* @__PURE__ */ _gte(value, params));
		},
		lt(value, params) {
			return this.check(/* @__PURE__ */ _lt(value, params));
		},
		lte(value, params) {
			return this.check(/* @__PURE__ */ _lte(value, params));
		},
		max(value, params) {
			return this.check(/* @__PURE__ */ _lte(value, params));
		},
		int(params) {
			return this.check(int(params));
		},
		safe(params) {
			return this.check(int(params));
		},
		positive(params) {
			return this.check(/* @__PURE__ */ _gt(0, params));
		},
		nonnegative(params) {
			return this.check(/* @__PURE__ */ _gte(0, params));
		},
		negative(params) {
			return this.check(/* @__PURE__ */ _lt(0, params));
		},
		nonpositive(params) {
			return this.check(/* @__PURE__ */ _lte(0, params));
		},
		multipleOf(value, params) {
			return this.check(/* @__PURE__ */ _multipleOf(value, params));
		},
		step(value, params) {
			return this.check(/* @__PURE__ */ _multipleOf(value, params));
		},
		finite() {
			return this;
		}
	});
	const bag = inst._zod.bag;
	inst.minValue = Math.max(bag.minimum ?? Number.NEGATIVE_INFINITY, bag.exclusiveMinimum ?? Number.NEGATIVE_INFINITY) ?? null;
	inst.maxValue = Math.min(bag.maximum ?? Number.POSITIVE_INFINITY, bag.exclusiveMaximum ?? Number.POSITIVE_INFINITY) ?? null;
	inst.isInt = (bag.format ?? "").includes("int") || Number.isSafeInteger(bag.multipleOf ?? .5);
	inst.isFinite = true;
	inst.format = bag.format ?? null;
});
function number(params) {
	return /* @__PURE__ */ _number(ZodNumber, params);
}
var ZodNumberFormat = /*@__PURE__*/ $constructor("ZodNumberFormat", (inst, def) => {
	$ZodNumberFormat.init(inst, def);
	ZodNumber.init(inst, def);
});
function int(params) {
	return /* @__PURE__ */ _int(ZodNumberFormat, params);
}
var ZodBoolean = /*@__PURE__*/ $constructor("ZodBoolean", (inst, def) => {
	$ZodBoolean.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => booleanProcessor(inst, ctx, json, params);
});
function boolean(params) {
	return /* @__PURE__ */ _boolean(ZodBoolean, params);
}
var ZodUnknown = /*@__PURE__*/ $constructor("ZodUnknown", (inst, def) => {
	$ZodUnknown.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => void 0;
});
function unknown() {
	return /* @__PURE__ */ _unknown(ZodUnknown);
}
var ZodNever = /*@__PURE__*/ $constructor("ZodNever", (inst, def) => {
	$ZodNever.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => neverProcessor(inst, ctx, json, params);
});
function never(params) {
	return /* @__PURE__ */ _never(ZodNever, params);
}
var ZodArray = /*@__PURE__*/ $constructor("ZodArray", (inst, def) => {
	$ZodArray.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => arrayProcessor(inst, ctx, json, params);
	inst.element = def.element;
	_installLazyMethods(inst, "ZodArray", {
		min(n, params) {
			return this.check(/* @__PURE__ */ _minLength(n, params));
		},
		nonempty(params) {
			return this.check(/* @__PURE__ */ _minLength(1, params));
		},
		max(n, params) {
			return this.check(/* @__PURE__ */ _maxLength(n, params));
		},
		length(n, params) {
			return this.check(/* @__PURE__ */ _length(n, params));
		},
		unwrap() {
			return this.element;
		}
	});
});
function array(element, params) {
	return /* @__PURE__ */ _array(ZodArray, element, params);
}
var ZodObject = /*@__PURE__*/ $constructor("ZodObject", (inst, def) => {
	$ZodObjectJIT.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => objectProcessor(inst, ctx, json, params);
	defineLazy(inst, "shape", () => {
		return def.shape;
	});
	_installLazyMethods(inst, "ZodObject", {
		keyof() {
			return _enum(Object.keys(this._zod.def.shape));
		},
		catchall(catchall) {
			return this.clone({
				...this._zod.def,
				catchall
			});
		},
		passthrough() {
			return this.clone({
				...this._zod.def,
				catchall: unknown()
			});
		},
		loose() {
			return this.clone({
				...this._zod.def,
				catchall: unknown()
			});
		},
		strict() {
			return this.clone({
				...this._zod.def,
				catchall: never()
			});
		},
		strip() {
			return this.clone({
				...this._zod.def,
				catchall: void 0
			});
		},
		extend(incoming) {
			return extend(this, incoming);
		},
		safeExtend(incoming) {
			return safeExtend(this, incoming);
		},
		merge(other) {
			return merge(this, other);
		},
		pick(mask) {
			return pick(this, mask);
		},
		omit(mask) {
			return omit(this, mask);
		},
		partial(...args) {
			return partial(ZodOptional, this, args[0]);
		},
		required(...args) {
			return required(ZodNonOptional, this, args[0]);
		}
	});
});
function object(shape, params) {
	return new ZodObject({
		type: "object",
		shape: shape ?? {},
		...normalizeParams(params)
	});
}
var ZodUnion = /*@__PURE__*/ $constructor("ZodUnion", (inst, def) => {
	$ZodUnion.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => unionProcessor(inst, ctx, json, params);
	inst.options = def.options;
});
function union(options, params) {
	return new ZodUnion({
		type: "union",
		options,
		...normalizeParams(params)
	});
}
var ZodIntersection = /*@__PURE__*/ $constructor("ZodIntersection", (inst, def) => {
	$ZodIntersection.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => intersectionProcessor(inst, ctx, json, params);
});
function intersection(left, right) {
	return new ZodIntersection({
		type: "intersection",
		left,
		right
	});
}
var ZodRecord = /*@__PURE__*/ $constructor("ZodRecord", (inst, def) => {
	$ZodRecord.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => recordProcessor(inst, ctx, json, params);
	inst.keyType = def.keyType;
	inst.valueType = def.valueType;
});
function record(keyType, valueType, params) {
	if (!valueType || !valueType._zod) return new ZodRecord({
		type: "record",
		keyType: string(),
		valueType: keyType,
		...normalizeParams(valueType)
	});
	return new ZodRecord({
		type: "record",
		keyType,
		valueType,
		...normalizeParams(params)
	});
}
var ZodEnum = /*@__PURE__*/ $constructor("ZodEnum", (inst, def) => {
	$ZodEnum.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => enumProcessor(inst, ctx, json, params);
	inst.enum = def.entries;
	inst.options = Object.values(def.entries);
	const keys = new Set(Object.keys(def.entries));
	inst.extract = (values, params) => {
		const newEntries = {};
		for (const value of values) if (keys.has(value)) newEntries[value] = def.entries[value];
		else throw new Error(`Key ${value} not found in enum`);
		return new ZodEnum({
			...def,
			checks: [],
			...normalizeParams(params),
			entries: newEntries
		});
	};
	inst.exclude = (values, params) => {
		const newEntries = { ...def.entries };
		for (const value of values) if (keys.has(value)) delete newEntries[value];
		else throw new Error(`Key ${value} not found in enum`);
		return new ZodEnum({
			...def,
			checks: [],
			...normalizeParams(params),
			entries: newEntries
		});
	};
});
function _enum(values, params) {
	return new ZodEnum({
		type: "enum",
		entries: Array.isArray(values) ? Object.fromEntries(values.map((v) => [v, v])) : values,
		...normalizeParams(params)
	});
}
var ZodLiteral = /*@__PURE__*/ $constructor("ZodLiteral", (inst, def) => {
	$ZodLiteral.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => literalProcessor(inst, ctx, json, params);
	inst.values = new Set(def.values);
	Object.defineProperty(inst, "value", { get() {
		if (def.values.length > 1) throw new Error("This schema contains multiple valid literal values. Use `.values` instead.");
		return def.values[0];
	} });
});
function literal(value, params) {
	return new ZodLiteral({
		type: "literal",
		values: Array.isArray(value) ? value : [value],
		...normalizeParams(params)
	});
}
var ZodTransform = /*@__PURE__*/ $constructor("ZodTransform", (inst, def) => {
	$ZodTransform.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => transformProcessor(inst, ctx, json, params);
	inst._zod.parse = (payload, _ctx) => {
		if (_ctx.direction === "backward") throw new $ZodEncodeError(inst.constructor.name);
		payload.addIssue = (issue$1) => {
			if (typeof issue$1 === "string") payload.issues.push(issue(issue$1, payload.value, def));
			else {
				const _issue = issue$1;
				if (_issue.fatal) _issue.continue = false;
				_issue.code ?? (_issue.code = "custom");
				_issue.input ?? (_issue.input = payload.value);
				_issue.inst ?? (_issue.inst = inst);
				payload.issues.push(issue(_issue));
			}
		};
		const output = def.transform(payload.value, payload);
		if (output instanceof Promise) return output.then((output) => {
			payload.value = output;
			payload.fallback = true;
			return payload;
		});
		payload.value = output;
		payload.fallback = true;
		return payload;
	};
});
function transform(fn) {
	return new ZodTransform({
		type: "transform",
		transform: fn
	});
}
var ZodOptional = /*@__PURE__*/ $constructor("ZodOptional", (inst, def) => {
	$ZodOptional.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => optionalProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function optional(innerType) {
	return new ZodOptional({
		type: "optional",
		innerType
	});
}
var ZodExactOptional = /*@__PURE__*/ $constructor("ZodExactOptional", (inst, def) => {
	$ZodExactOptional.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => optionalProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function exactOptional(innerType) {
	return new ZodExactOptional({
		type: "optional",
		innerType
	});
}
var ZodNullable = /*@__PURE__*/ $constructor("ZodNullable", (inst, def) => {
	$ZodNullable.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => nullableProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function nullable(innerType) {
	return new ZodNullable({
		type: "nullable",
		innerType
	});
}
var ZodDefault = /*@__PURE__*/ $constructor("ZodDefault", (inst, def) => {
	$ZodDefault.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => defaultProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
	inst.removeDefault = inst.unwrap;
});
function _default(innerType, defaultValue) {
	return new ZodDefault({
		type: "default",
		innerType,
		get defaultValue() {
			return typeof defaultValue === "function" ? defaultValue() : shallowClone(defaultValue);
		}
	});
}
var ZodPrefault = /*@__PURE__*/ $constructor("ZodPrefault", (inst, def) => {
	$ZodPrefault.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => prefaultProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function prefault(innerType, defaultValue) {
	return new ZodPrefault({
		type: "prefault",
		innerType,
		get defaultValue() {
			return typeof defaultValue === "function" ? defaultValue() : shallowClone(defaultValue);
		}
	});
}
var ZodNonOptional = /*@__PURE__*/ $constructor("ZodNonOptional", (inst, def) => {
	$ZodNonOptional.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => nonoptionalProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function nonoptional(innerType, params) {
	return new ZodNonOptional({
		type: "nonoptional",
		innerType,
		...normalizeParams(params)
	});
}
var ZodCatch = /*@__PURE__*/ $constructor("ZodCatch", (inst, def) => {
	$ZodCatch.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => catchProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
	inst.removeCatch = inst.unwrap;
});
function _catch(innerType, catchValue) {
	return new ZodCatch({
		type: "catch",
		innerType,
		catchValue: typeof catchValue === "function" ? catchValue : () => catchValue
	});
}
var ZodPipe = /*@__PURE__*/ $constructor("ZodPipe", (inst, def) => {
	$ZodPipe.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => pipeProcessor(inst, ctx, json, params);
	inst.in = def.in;
	inst.out = def.out;
});
function pipe(in_, out) {
	return new ZodPipe({
		type: "pipe",
		in: in_,
		out
	});
}
var ZodReadonly = /*@__PURE__*/ $constructor("ZodReadonly", (inst, def) => {
	$ZodReadonly.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => readonlyProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function readonly(innerType) {
	return new ZodReadonly({
		type: "readonly",
		innerType
	});
}
var ZodCustom = /*@__PURE__*/ $constructor("ZodCustom", (inst, def) => {
	$ZodCustom.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => customProcessor(inst, ctx, json, params);
});
function refine(fn, _params = {}) {
	return /* @__PURE__ */ _refine(ZodCustom, fn, _params);
}
function superRefine(fn, params) {
	return /* @__PURE__ */ _superRefine(fn, params);
}
//#endregion
//#region node_modules/@agentclientprotocol/sdk/dist/schema-deserialize.js
var skippedItem = Symbol("skippedItem");
function defaultOnError(schema, fallback) {
	return schema.catch(fallback);
}
function requiredDefaultOnError(schema, fallback) {
	const schemaWithCatch = schema.catch(fallback);
	return unknown().transform((value, context) => {
		if (value !== void 0) return schemaWithCatch.parse(value);
		context.addIssue({
			code: "custom",
			message: "Required value is missing"
		});
		return NEVER;
	});
}
function vecSkipError(itemSchema) {
	return array(itemSchema.catch(skippedItem)).transform((items) => items.filter((item) => item !== skippedItem));
}
//#endregion
//#region node_modules/@agentclientprotocol/sdk/dist/schema/zod.gen.js
/**
* JSON RPC Request Id
*
* An identifier established by the Client that MUST contain a String, Number, or NULL value if included. If it is not included it is assumed to be a notification. The value SHOULD normally not be Null \[1\] and Numbers SHOULD NOT contain fractional parts \[2\]
*
* The Server MUST reply with the same value in the Response object if included. This member is used to correlate the context between the two objects.
*
* \[1\] The use of Null as a value for the id member in a Request object is discouraged, because this specification uses a value of Null for Responses with an unknown id. Also, because JSON-RPC 1.0 uses an id value of Null for Notifications this could cause confusion in handling.
*
* \[2\] Fractional parts may be problematic, since many decimal fractions cannot be represented exactly as binary fractions.
*/
var zRequestId = union([number(), string()]).nullable();
/**
* A unique identifier for a conversation session between a client and agent.
*
* Sessions maintain their own context, conversation history, and state,
* allowing multiple independent interactions with the same agent.
*
* See protocol docs: [Session ID](https://agentclientprotocol.com/protocol/session-setup#session-id)
*/
var zSessionId = string();
/**
* Request to write content to a text file.
*
* Only available if the client supports the `fs.writeTextFile` capability.
*/
var zWriteTextFileRequest = object({
	sessionId: zSessionId,
	path: string(),
	content: string(),
	_meta: record(string(), unknown()).nullish()
});
/**
* Request to read content from a text file.
*
* Only available if the client supports the `fs.readTextFile` capability.
*/
var zReadTextFileRequest = object({
	sessionId: zSessionId,
	path: string(),
	line: int().gte(0).max(4294967295, { error: "Invalid value: Expected uint32 to be <= 4294967295" }).nullish(),
	limit: int().gte(0).max(4294967295, { error: "Invalid value: Expected uint32 to be <= 4294967295" }).nullish(),
	_meta: record(string(), unknown()).nullish()
});
/**
* Unique identifier for a tool call within a session.
*/
var zToolCallId = string();
/**
* Categories of tools that can be invoked.
*
* Tool kinds help clients choose appropriate icons and optimize how they
* display tool execution progress.
*
* See protocol docs: [Creating](https://agentclientprotocol.com/protocol/tool-calls#creating)
*/
var zToolKind = union([
	literal("read"),
	literal("edit"),
	literal("delete"),
	literal("move"),
	literal("search"),
	literal("execute"),
	literal("think"),
	literal("fetch"),
	literal("switch_mode"),
	literal("other")
]);
/**
* Execution status of a tool call.
*
* Tool calls progress through different statuses during their lifecycle.
*
* See protocol docs: [Status](https://agentclientprotocol.com/protocol/tool-calls#status)
*/
var zToolCallStatus = union([
	literal("pending"),
	literal("in_progress"),
	literal("completed"),
	literal("failed")
]);
/**
* Optional annotations for the client. The client can use annotations to inform how objects are used or displayed
*/
var zAnnotations = object({
	audience: defaultOnError(vecSkipError(union([literal("assistant"), literal("user")])).nullish(), () => void 0),
	lastModified: string().nullish(),
	priority: number().nullish(),
	_meta: record(string(), unknown()).nullish()
});
/**
* Text provided to or from an LLM.
*/
var zTextContent = object({
	annotations: defaultOnError(zAnnotations.nullish(), () => void 0),
	text: string(),
	_meta: record(string(), unknown()).nullish()
});
/**
* An image provided to or from an LLM.
*/
var zImageContent = object({
	annotations: defaultOnError(zAnnotations.nullish(), () => void 0),
	data: string(),
	mimeType: string(),
	uri: string().nullish(),
	_meta: record(string(), unknown()).nullish()
});
/**
* Audio provided to or from an LLM.
*/
var zAudioContent = object({
	annotations: defaultOnError(zAnnotations.nullish(), () => void 0),
	data: string(),
	mimeType: string(),
	_meta: record(string(), unknown()).nullish()
});
/**
* A resource that the server is capable of reading, included in a prompt or tool call result.
*/
var zResourceLink = object({
	annotations: defaultOnError(zAnnotations.nullish(), () => void 0),
	description: string().nullish(),
	mimeType: string().nullish(),
	name: string(),
	size: number().nullish(),
	title: string().nullish(),
	uri: string(),
	_meta: record(string(), unknown()).nullish()
});
/**
* Resource content that can be embedded in a message.
*/
var zEmbeddedResourceResource = union([object({
	mimeType: string().nullish(),
	text: string(),
	uri: string(),
	_meta: record(string(), unknown()).nullish()
}), object({
	blob: string(),
	mimeType: string().nullish(),
	uri: string(),
	_meta: record(string(), unknown()).nullish()
})]);
/**
* The contents of a resource, embedded into a prompt or tool call result.
*/
var zEmbeddedResource = object({
	annotations: defaultOnError(zAnnotations.nullish(), () => void 0),
	resource: zEmbeddedResourceResource,
	_meta: record(string(), unknown()).nullish()
});
/**
* Content blocks represent displayable information in the Agent Client Protocol.
*
* They provide a structured way to handle various types of user-facing content—whether
* it's text from language models, images for analysis, or embedded resources for context.
*
* Content blocks appear in:
* - User prompts sent via `session/prompt`
* - Language model output streamed through `session/update` notifications
* - Progress updates and results from tool calls
*
* This structure is compatible with the Model Context Protocol (MCP), enabling
* agents to seamlessly forward content from MCP tool outputs without transformation.
*
* See protocol docs: [Content](https://agentclientprotocol.com/protocol/content)
*/
var zContentBlock = union([
	zTextContent.and(object({ type: literal("text") })),
	zImageContent.and(object({ type: literal("image") })),
	zAudioContent.and(object({ type: literal("audio") })),
	zResourceLink.and(object({ type: literal("resource_link") })),
	zEmbeddedResource.and(object({ type: literal("resource") }))
]);
/**
* Standard content block (text, images, resources).
*/
var zContent = object({
	content: zContentBlock,
	_meta: record(string(), unknown()).nullish()
});
/**
* A diff representing file modifications.
*
* Shows changes to files in a format suitable for display in the client UI.
*
* See protocol docs: [Content](https://agentclientprotocol.com/protocol/tool-calls#content)
*/
var zDiff = object({
	path: string(),
	oldText: string().nullish(),
	newText: string(),
	_meta: record(string(), unknown()).nullish()
});
/**
* Typed identifier used for terminal values on the wire.
*/
var zTerminalId = string();
/**
* Embed a terminal created with `terminal/create` by its id.
*
* The terminal must be added before calling `terminal/release`.
*
* See protocol docs: [Terminal](https://agentclientprotocol.com/protocol/terminals)
*/
var zTerminal = object({
	terminalId: zTerminalId,
	_meta: record(string(), unknown()).nullish()
});
/**
* Content produced by a tool call.
*
* Tool calls can produce different types of content including
* standard content blocks (text, images) or file diffs.
*
* See protocol docs: [Content](https://agentclientprotocol.com/protocol/tool-calls#content)
*/
var zToolCallContent = union([
	zContent.and(object({ type: literal("content") })),
	zDiff.and(object({ type: literal("diff") })),
	zTerminal.and(object({ type: literal("terminal") }))
]);
/**
* A file location being accessed or modified by a tool.
*
* Enables clients to implement "follow-along" features that track
* which files the agent is working with in real-time.
*
* See protocol docs: [Following the Agent](https://agentclientprotocol.com/protocol/tool-calls#following-the-agent)
*/
var zToolCallLocation = object({
	path: string(),
	line: int().gte(0).max(4294967295, { error: "Invalid value: Expected uint32 to be <= 4294967295" }).nullish(),
	_meta: record(string(), unknown()).nullish()
});
/**
* An update to an existing tool call.
*
* Used to report progress and results as tools execute. All fields except
* the tool call ID are optional - only changed fields need to be included.
*
* See protocol docs: [Updating](https://agentclientprotocol.com/protocol/tool-calls#updating)
*/
var zToolCallUpdate = object({
	toolCallId: zToolCallId,
	kind: defaultOnError(zToolKind.nullish(), () => void 0),
	status: defaultOnError(zToolCallStatus.nullish(), () => void 0),
	title: string().nullish(),
	content: defaultOnError(vecSkipError(zToolCallContent).nullish(), () => void 0),
	locations: defaultOnError(vecSkipError(zToolCallLocation).nullish(), () => void 0),
	rawInput: unknown().optional(),
	rawOutput: unknown().optional(),
	_meta: record(string(), unknown()).nullish()
});
/**
* Unique identifier for a permission option.
*/
var zPermissionOptionId = string();
/**
* The type of permission option being presented to the user.
*
* Helps clients choose appropriate icons and UI treatment.
*/
var zPermissionOptionKind = union([
	literal("allow_once"),
	literal("allow_always"),
	literal("reject_once"),
	literal("reject_always")
]);
/**
* Request for user permission to execute a tool call.
*
* Sent when the agent needs authorization before performing a sensitive operation.
*
* See protocol docs: [Requesting Permission](https://agentclientprotocol.com/protocol/tool-calls#requesting-permission)
*/
var zRequestPermissionRequest = object({
	sessionId: zSessionId,
	toolCall: zToolCallUpdate,
	options: array(object({
		optionId: zPermissionOptionId,
		name: string(),
		kind: zPermissionOptionKind,
		_meta: record(string(), unknown()).nullish()
	})),
	_meta: record(string(), unknown()).nullish()
});
/**
* An environment variable to set when launching an MCP server.
*/
var zEnvVariable = object({
	name: string(),
	value: string(),
	_meta: record(string(), unknown()).nullish()
});
/**
* Request to create a new terminal and execute a command.
*/
var zCreateTerminalRequest = object({
	sessionId: zSessionId,
	command: string(),
	args: array(string()).optional(),
	env: array(zEnvVariable).optional(),
	cwd: string().nullish(),
	outputByteLimit: number().nullish(),
	_meta: record(string(), unknown()).nullish()
});
/**
* Request to get the current output and status of a terminal.
*/
var zTerminalOutputRequest = object({
	sessionId: zSessionId,
	terminalId: zTerminalId,
	_meta: record(string(), unknown()).nullish()
});
/**
* Request to release a terminal and free its resources.
*/
var zReleaseTerminalRequest = object({
	sessionId: zSessionId,
	terminalId: zTerminalId,
	_meta: record(string(), unknown()).nullish()
});
/**
* Request to wait for a terminal command to exit.
*/
var zWaitForTerminalExitRequest = object({
	sessionId: zSessionId,
	terminalId: zTerminalId,
	_meta: record(string(), unknown()).nullish()
});
/**
* Request to kill a terminal without releasing it.
*/
var zKillTerminalRequest = object({
	sessionId: zSessionId,
	terminalId: zTerminalId,
	_meta: record(string(), unknown()).nullish()
});
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Session-scoped elicitation, optionally tied to a specific tool call.
*
* When `tool_call_id` is set, the elicitation is tied to a specific tool call.
* This is useful when an agent receives an elicitation from an MCP server
* during a tool call and needs to redirect it to the user.
*
* @experimental
*/
var zElicitationSessionScope = object({
	sessionId: zSessionId,
	toolCallId: zToolCallId.nullish()
});
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Request-scoped elicitation, tied to a specific JSON-RPC request outside of a session
* (e.g., during auth/configuration phases before any session is started).
*
* @experimental
*/
var zElicitationRequestScope = object({ requestId: zRequestId });
/**
* Object schema type.
*/
var zElicitationSchemaType = literal("object");
/**
* String format types for string properties in elicitation schemas.
*/
var zStringFormat = union([
	literal("email"),
	literal("uri"),
	literal("date"),
	literal("date-time")
]);
/**
* A titled enum option with a const value and human-readable title.
*/
var zEnumOption = object({
	const: string(),
	title: string(),
	_meta: record(string(), unknown()).nullish()
});
/**
* Schema for string properties in an elicitation form.
*
* When `enum` or `oneOf` is set, this represents a single-select enum
* with `"type": "string"`.
*/
var zStringPropertySchema = object({
	title: string().nullish(),
	description: string().nullish(),
	minLength: int().gte(0).max(4294967295, { error: "Invalid value: Expected uint32 to be <= 4294967295" }).nullish(),
	maxLength: int().gte(0).max(4294967295, { error: "Invalid value: Expected uint32 to be <= 4294967295" }).nullish(),
	pattern: string().nullish(),
	format: zStringFormat.nullish(),
	default: string().nullish(),
	enum: array(string()).nullish(),
	oneOf: array(zEnumOption).nullish(),
	_meta: record(string(), unknown()).nullish()
});
/**
* Schema for number (floating-point) properties in an elicitation form.
*/
var zNumberPropertySchema = object({
	title: string().nullish(),
	description: string().nullish(),
	minimum: number().nullish(),
	maximum: number().nullish(),
	default: number().nullish(),
	_meta: record(string(), unknown()).nullish()
});
/**
* Schema for integer properties in an elicitation form.
*/
var zIntegerPropertySchema = object({
	title: string().nullish(),
	description: string().nullish(),
	minimum: number().nullish(),
	maximum: number().nullish(),
	default: number().nullish(),
	_meta: record(string(), unknown()).nullish()
});
/**
* Schema for boolean properties in an elicitation form.
*/
var zBooleanPropertySchema = object({
	title: string().nullish(),
	description: string().nullish(),
	default: boolean().nullish(),
	_meta: record(string(), unknown()).nullish()
});
/**
* Items for a multi-select (array) property schema.
*/
var zMultiSelectItems = union([object({
	type: literal("string"),
	enum: array(string()),
	_meta: record(string(), unknown()).nullish()
}), object({
	anyOf: array(zEnumOption),
	_meta: record(string(), unknown()).nullish()
})]);
/**
* Schema for multi-select (array) properties in an elicitation form.
*/
var zMultiSelectPropertySchema = object({
	title: string().nullish(),
	description: string().nullish(),
	minItems: number().nullish(),
	maxItems: number().nullish(),
	items: zMultiSelectItems,
	default: array(string()).nullish(),
	_meta: record(string(), unknown()).nullish()
});
/**
* Property schema for elicitation form fields.
*
* Each variant corresponds to a JSON Schema `"type"` value.
* Single-select enums use the `String` variant with `enum` or `oneOf` set.
* Multi-select enums use the `Array` variant.
*/
var zElicitationPropertySchema = union([
	zStringPropertySchema.and(object({ type: literal("string") })),
	zNumberPropertySchema.and(object({ type: literal("number") })),
	zIntegerPropertySchema.and(object({ type: literal("integer") })),
	zBooleanPropertySchema.and(object({ type: literal("boolean") })),
	zMultiSelectPropertySchema.and(object({ type: literal("array") }))
]);
/**
* Type-safe elicitation schema for requesting structured user input.
*
* This represents a JSON Schema object with primitive-typed properties,
* as required by the elicitation specification.
*/
var zElicitationSchema = object({
	type: zElicitationSchemaType.optional().default("object"),
	title: string().nullish(),
	properties: record(string(), zElicitationPropertySchema).optional().default({}),
	required: array(string()).nullish(),
	description: string().nullish(),
	_meta: record(string(), unknown()).nullish()
});
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Form-based elicitation mode where the client renders a form from the provided schema.
*
* @experimental
*/
var zElicitationFormMode = intersection(union([zElicitationSessionScope, zElicitationRequestScope]), object({ requestedSchema: zElicitationSchema }));
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Unique identifier for an elicitation.
*
* @experimental
*/
var zElicitationId = string();
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* URL-based elicitation mode where the client directs the user to a URL.
*
* @experimental
*/
var zElicitationUrlMode = intersection(union([zElicitationSessionScope, zElicitationRequestScope]), object({
	elicitationId: zElicitationId,
	url: url()
}));
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Request from the agent to elicit structured user input.
*
* The agent sends this to the client to request information from the user,
* either via a form or by directing them to a URL.
* Elicitations are tied to a session (optionally a tool call) or a request.
*
* @experimental
*/
var zCreateElicitationRequest = intersection(union([zElicitationFormMode.and(object({ mode: literal("form") })), zElicitationUrlMode.and(object({ mode: literal("url") }))]), object({
	message: string(),
	_meta: record(string(), unknown()).nullish()
}));
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Unique identifier for an MCP server using the ACP transport.
*
* The value is opaque and generated by the ACP component providing the MCP server. It is
* used by `mcp/connect` to route connection requests back to the component that declared the
* server.
*
* @experimental
*/
var zMcpServerAcpId = string();
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Request parameters for `mcp/connect`.
*
* @experimental
*/
var zConnectMcpRequest = object({
	acpId: zMcpServerAcpId,
	_meta: record(string(), unknown()).nullish()
});
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* A unique identifier for an active MCP-over-ACP connection.
*
* @experimental
*/
var zMcpConnectionId = string();
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Request parameters for `mcp/message`.
*
* @experimental
*/
var zMessageMcpRequest = object({
	connectionId: zMcpConnectionId,
	method: string(),
	params: record(string(), unknown()).nullish(),
	_meta: record(string(), unknown()).nullish()
});
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Request parameters for `mcp/disconnect`.
*
* @experimental
*/
var zDisconnectMcpRequest = object({
	connectionId: zMcpConnectionId,
	_meta: record(string(), unknown()).nullish()
});
/**
* Allows for sending an arbitrary request that is not part of the ACP spec.
* Extension methods provide a way to add custom functionality while maintaining
* protocol compatibility.
*
* See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)
*/
var zExtRequest = unknown();
object({
	id: zRequestId,
	method: string(),
	params: union([
		zWriteTextFileRequest,
		zReadTextFileRequest,
		zRequestPermissionRequest,
		zCreateTerminalRequest,
		zTerminalOutputRequest,
		zReleaseTerminalRequest,
		zWaitForTerminalExitRequest,
		zKillTerminalRequest,
		zCreateElicitationRequest,
		zConnectMcpRequest,
		zMessageMcpRequest,
		zDisconnectMcpRequest,
		zExtRequest
	]).nullish()
});
/**
* Protocol version identifier.
*
* This version is only bumped for breaking changes.
* Non-breaking changes should be introduced via capabilities.
*/
var zProtocolVersion = int().gte(0).lte(65535);
/**
* Prompt capabilities supported by the agent in `session/prompt` requests.
*
* Baseline agent functionality requires support for [`ContentBlock::Text`]
* and [`ContentBlock::ResourceLink`] in prompt requests.
*
* Other variants must be explicitly opted in to.
* Capabilities for different types of content in prompt requests.
*
* Indicates which content types beyond the baseline (text and resource links)
* the agent can process.
*
* See protocol docs: [Prompt Capabilities](https://agentclientprotocol.com/protocol/initialization#prompt-capabilities)
*/
var zPromptCapabilities = object({
	image: boolean().optional().default(false),
	audio: boolean().optional().default(false),
	embeddedContext: boolean().optional().default(false),
	_meta: record(string(), unknown()).nullish()
});
/**
* MCP capabilities supported by the agent
*/
var zMcpCapabilities = object({
	http: boolean().optional().default(false),
	sse: boolean().optional().default(false),
	acp: boolean().optional().default(false),
	_meta: record(string(), unknown()).nullish()
});
/**
* Capabilities for the `session/list` method.
*
* By supplying `{}` it means that the agent supports listing of sessions.
*/
var zSessionListCapabilities = object({ _meta: record(string(), unknown()).nullish() });
/**
* Capabilities for the `session/delete` method.
*
* Supplying `{}` means the agent supports deleting sessions from `session/list`.
*/
var zSessionDeleteCapabilities = object({ _meta: record(string(), unknown()).nullish() });
/**
* Capabilities for additional session directories support.
*
* By supplying `{}` it means that the agent supports the `additionalDirectories`
* field on supported session lifecycle requests. Agents that also support
* `session/list` may return `SessionInfo.additionalDirectories` to report the
* complete ordered additional-root list associated with a listed session.
*/
var zSessionAdditionalDirectoriesCapabilities = object({ _meta: record(string(), unknown()).nullish() });
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Capabilities for the `session/fork` method.
*
* By supplying `{}` it means that the agent supports forking of sessions.
*
* @experimental
*/
var zSessionForkCapabilities = object({ _meta: record(string(), unknown()).nullish() });
/**
* Capabilities for the `session/resume` method.
*
* By supplying `{}` it means that the agent supports resuming of sessions.
*/
var zSessionResumeCapabilities = object({ _meta: record(string(), unknown()).nullish() });
/**
* Capabilities for the `session/close` method.
*
* By supplying `{}` it means that the agent supports closing of sessions.
*/
var zSessionCloseCapabilities = object({ _meta: record(string(), unknown()).nullish() });
/**
* Session capabilities supported by the agent.
*
* As a baseline, all Agents **MUST** support `session/new`, `session/prompt`, `session/cancel`, and `session/update`.
*
* Optionally, they **MAY** support other session methods and notifications by specifying additional capabilities.
*
* Note: `session/load` is still handled by the top-level `load_session` capability. This will be unified in future versions of the protocol.
*
* See protocol docs: [Session Capabilities](https://agentclientprotocol.com/protocol/initialization#session-capabilities)
*/
var zSessionCapabilities = object({
	list: defaultOnError(zSessionListCapabilities.nullish(), () => void 0),
	delete: defaultOnError(zSessionDeleteCapabilities.nullish(), () => void 0),
	additionalDirectories: defaultOnError(zSessionAdditionalDirectoriesCapabilities.nullish(), () => void 0),
	fork: defaultOnError(zSessionForkCapabilities.nullish(), () => void 0),
	resume: defaultOnError(zSessionResumeCapabilities.nullish(), () => void 0),
	close: defaultOnError(zSessionCloseCapabilities.nullish(), () => void 0),
	_meta: record(string(), unknown()).nullish()
});
/**
* Authentication-related capabilities supported by the agent.
*/
var zAgentAuthCapabilities = object({
	logout: defaultOnError(object({ _meta: record(string(), unknown()).nullish() }).nullish(), () => void 0),
	_meta: record(string(), unknown()).nullish()
});
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Provider configuration capabilities supported by the agent.
*
* By supplying `{}` it means that the agent supports provider configuration methods.
*
* @experimental
*/
var zProvidersCapabilities = object({ _meta: record(string(), unknown()).nullish() });
/**
* Marker for `document/didOpen` capability support.
*/
var zNesDocumentDidOpenCapabilities = object({ _meta: record(string(), unknown()).nullish() });
/**
* Capabilities for `document/didChange` events.
*/
var zNesDocumentDidChangeCapabilities = object({
	syncKind: union([literal("full"), literal("incremental")]),
	_meta: record(string(), unknown()).nullish()
});
/**
* Marker for `document/didClose` capability support.
*/
var zNesDocumentDidCloseCapabilities = object({ _meta: record(string(), unknown()).nullish() });
/**
* Marker for `document/didSave` capability support.
*/
var zNesDocumentDidSaveCapabilities = object({ _meta: record(string(), unknown()).nullish() });
/**
* Marker for `document/didFocus` capability support.
*/
var zNesDocumentDidFocusCapabilities = object({ _meta: record(string(), unknown()).nullish() });
/**
* Event capabilities the agent can consume.
*/
var zNesEventCapabilities = object({
	document: defaultOnError(object({
		didOpen: defaultOnError(zNesDocumentDidOpenCapabilities.nullish(), () => void 0),
		didChange: defaultOnError(zNesDocumentDidChangeCapabilities.nullish(), () => void 0),
		didClose: defaultOnError(zNesDocumentDidCloseCapabilities.nullish(), () => void 0),
		didSave: defaultOnError(zNesDocumentDidSaveCapabilities.nullish(), () => void 0),
		didFocus: defaultOnError(zNesDocumentDidFocusCapabilities.nullish(), () => void 0),
		_meta: record(string(), unknown()).nullish()
	}).nullish(), () => void 0),
	_meta: record(string(), unknown()).nullish()
});
/**
* Capabilities for recent files context.
*/
var zNesRecentFilesCapabilities = object({
	maxCount: int().gte(0).max(4294967295, { error: "Invalid value: Expected uint32 to be <= 4294967295" }).nullish(),
	_meta: record(string(), unknown()).nullish()
});
/**
* Capabilities for related snippets context.
*/
var zNesRelatedSnippetsCapabilities = object({ _meta: record(string(), unknown()).nullish() });
/**
* Capabilities for edit history context.
*/
var zNesEditHistoryCapabilities = object({
	maxCount: int().gte(0).max(4294967295, { error: "Invalid value: Expected uint32 to be <= 4294967295" }).nullish(),
	_meta: record(string(), unknown()).nullish()
});
/**
* Capabilities for user actions context.
*/
var zNesUserActionsCapabilities = object({
	maxCount: int().gte(0).max(4294967295, { error: "Invalid value: Expected uint32 to be <= 4294967295" }).nullish(),
	_meta: record(string(), unknown()).nullish()
});
/**
* Capabilities for open files context.
*/
var zNesOpenFilesCapabilities = object({ _meta: record(string(), unknown()).nullish() });
/**
* Capabilities for diagnostics context.
*/
var zNesDiagnosticsCapabilities = object({ _meta: record(string(), unknown()).nullish() });
/**
* Context capabilities the agent wants attached to each suggestion request.
*/
var zNesContextCapabilities = object({
	recentFiles: defaultOnError(zNesRecentFilesCapabilities.nullish(), () => void 0),
	relatedSnippets: defaultOnError(zNesRelatedSnippetsCapabilities.nullish(), () => void 0),
	editHistory: defaultOnError(zNesEditHistoryCapabilities.nullish(), () => void 0),
	userActions: defaultOnError(zNesUserActionsCapabilities.nullish(), () => void 0),
	openFiles: defaultOnError(zNesOpenFilesCapabilities.nullish(), () => void 0),
	diagnostics: defaultOnError(zNesDiagnosticsCapabilities.nullish(), () => void 0),
	_meta: record(string(), unknown()).nullish()
});
/**
* NES capabilities advertised by the agent during initialization.
*/
var zNesCapabilities = object({
	events: defaultOnError(zNesEventCapabilities.nullish(), () => void 0),
	context: defaultOnError(zNesContextCapabilities.nullish(), () => void 0),
	_meta: record(string(), unknown()).nullish()
});
/**
* The encoding used for character offsets in positions.
*
* Follows the same conventions as LSP 3.17. The default is UTF-16.
*/
var zPositionEncodingKind = union([
	literal("utf-16"),
	literal("utf-32"),
	literal("utf-8")
]);
/**
* Capabilities supported by the agent.
*
* Advertised during initialization to inform the client about
* available features and content types.
*
* See protocol docs: [Agent Capabilities](https://agentclientprotocol.com/protocol/initialization#agent-capabilities)
*/
var zAgentCapabilities = object({
	loadSession: boolean().optional().default(false),
	promptCapabilities: zPromptCapabilities.optional().default({
		image: false,
		audio: false,
		embeddedContext: false
	}),
	mcpCapabilities: zMcpCapabilities.optional().default({
		http: false,
		sse: false,
		acp: false
	}),
	sessionCapabilities: zSessionCapabilities.optional().default({}),
	auth: zAgentAuthCapabilities.optional().default({}),
	providers: defaultOnError(zProvidersCapabilities.nullish(), () => void 0),
	nes: defaultOnError(zNesCapabilities.nullish(), () => void 0),
	positionEncoding: defaultOnError(zPositionEncodingKind.nullish(), () => void 0),
	_meta: record(string(), unknown()).nullish()
});
/**
* Typed identifier used for auth method values on the wire.
*/
var zAuthMethodId = string();
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Describes a single environment variable for an [`AuthMethodEnvVar`] authentication method.
*
* @experimental
*/
var zAuthEnvVar = object({
	name: string(),
	label: string().nullish(),
	secret: boolean().optional().default(true),
	optional: boolean().optional().default(false),
	_meta: record(string(), unknown()).nullish()
});
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Environment variable authentication method.
*
* The user provides credentials that the client passes to the agent as environment variables.
*
* @experimental
*/
var zAuthMethodEnvVar = object({
	id: zAuthMethodId,
	name: string(),
	description: string().nullish(),
	vars: array(zAuthEnvVar),
	link: string().nullish(),
	_meta: record(string(), unknown()).nullish()
});
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Terminal-based authentication method.
*
* The client runs an interactive terminal for the user to authenticate via a TUI.
*
* @experimental
*/
var zAuthMethodTerminal = object({
	id: zAuthMethodId,
	name: string(),
	description: string().nullish(),
	args: array(string()).optional(),
	env: record(string(), string()).optional(),
	_meta: record(string(), unknown()).nullish()
});
/**
* Agent handles authentication itself.
*
* This is the default authentication method type.
*/
var zAuthMethodAgent = object({
	id: zAuthMethodId,
	name: string(),
	description: string().nullish(),
	_meta: record(string(), unknown()).nullish()
});
/**
* Describes an available authentication method.
*
* The `type` field acts as the discriminator in the serialized JSON form.
* When no `type` is present, the method is treated as `agent`.
*/
var zAuthMethod = union([
	zAuthMethodEnvVar.and(object({ type: literal("env_var") })),
	zAuthMethodTerminal.and(object({ type: literal("terminal") })),
	zAuthMethodAgent
]);
/**
* Metadata about the implementation of the client or agent.
* Describes the name and version of an MCP implementation, with an optional
* title for UI representation.
*/
var zImplementation = object({
	name: string(),
	title: string().nullish(),
	version: string(),
	_meta: record(string(), unknown()).nullish()
});
/**
* Response to the `initialize` method.
*
* Contains the negotiated protocol version and agent capabilities.
*
* See protocol docs: [Initialization](https://agentclientprotocol.com/protocol/initialization)
*/
var zInitializeResponse = object({
	protocolVersion: zProtocolVersion,
	agentCapabilities: zAgentCapabilities.optional().default({
		loadSession: false,
		promptCapabilities: {
			image: false,
			audio: false,
			embeddedContext: false
		},
		mcpCapabilities: {
			http: false,
			sse: false,
			acp: false
		},
		sessionCapabilities: {},
		auth: {}
	}),
	authMethods: defaultOnError(vecSkipError(zAuthMethod).optional().default([]), () => []),
	agentInfo: defaultOnError(zImplementation.nullish(), () => void 0),
	_meta: record(string(), unknown()).nullish()
});
/**
* Response to the `authenticate` method.
*/
var zAuthenticateResponse = object({ _meta: record(string(), unknown()).nullish() });
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Well-known API protocol identifiers for LLM providers.
*
* Agents and clients MUST handle unknown protocol identifiers gracefully.
*
* Protocol names beginning with `_` are free for custom use, like other ACP extension methods.
* Protocol names that do not begin with `_` are reserved for the ACP spec.
*
* @experimental
*/
var zLlmProtocol = union([
	literal("anthropic"),
	literal("openai"),
	literal("azure"),
	literal("vertex"),
	literal("bedrock"),
	string()
]);
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Current effective non-secret routing configuration for a provider.
*
* @experimental
*/
var zProviderCurrentConfig = object({
	apiType: zLlmProtocol,
	baseUrl: string(),
	_meta: record(string(), unknown()).nullish()
});
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Response to `providers/list`.
*
* @experimental
*/
var zListProvidersResponse = object({
	providers: requiredDefaultOnError(vecSkipError(object({
		id: string(),
		supported: requiredDefaultOnError(vecSkipError(zLlmProtocol), () => []),
		required: boolean(),
		current: zProviderCurrentConfig.nullish(),
		_meta: record(string(), unknown()).nullish()
	})), () => []),
	_meta: record(string(), unknown()).nullish()
});
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Response to `providers/set`.
*
* @experimental
*/
var zSetProviderResponse = object({ _meta: record(string(), unknown()).nullish() });
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Response to `providers/disable`.
*
* @experimental
*/
var zDisableProviderResponse = object({ _meta: record(string(), unknown()).nullish() });
/**
* Response to the `logout` method.
*/
var zLogoutResponse = object({ _meta: record(string(), unknown()).nullish() });
/**
* Unique identifier for a Session Mode.
*/
var zSessionModeId = string();
/**
* The set of modes and the one currently active.
*/
var zSessionModeState = object({
	currentModeId: zSessionModeId,
	availableModes: requiredDefaultOnError(vecSkipError(object({
		id: zSessionModeId,
		name: string(),
		description: string().nullish(),
		_meta: record(string(), unknown()).nullish()
	})), () => []),
	_meta: record(string(), unknown()).nullish()
});
/**
* Unique identifier for a session configuration option.
*/
var zSessionConfigId = string();
/**
* Semantic category for a session configuration option.
*
* This is intended to help Clients distinguish broadly common selectors (e.g. model selector vs
* session mode selector vs thought/reasoning level) for UX purposes (keyboard shortcuts, icons,
* placement). It MUST NOT be required for correctness. Clients MUST handle missing or unknown
* categories gracefully.
*
* Category names beginning with `_` are free for custom use, like other ACP extension methods.
* Category names that do not begin with `_` are reserved for the ACP spec.
*/
var zSessionConfigOptionCategory = union([
	literal("mode"),
	literal("model"),
	literal("model_config"),
	literal("thought_level"),
	string()
]);
/**
* Unique identifier for a session configuration option value.
*/
var zSessionConfigValueId = string();
/**
* A possible value for a session configuration option.
*/
var zSessionConfigSelectOption = object({
	value: zSessionConfigValueId,
	name: string(),
	description: string().nullish(),
	_meta: record(string(), unknown()).nullish()
});
/**
* A group of possible values for a session configuration option.
*/
var zSessionConfigSelectGroup = object({
	group: string(),
	name: string(),
	options: array(zSessionConfigSelectOption),
	_meta: record(string(), unknown()).nullish()
});
/**
* A single-value selector (dropdown) session configuration option payload.
*/
var zSessionConfigSelect = object({
	currentValue: zSessionConfigValueId,
	options: union([array(zSessionConfigSelectOption), array(zSessionConfigSelectGroup)])
});
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* A boolean on/off toggle session configuration option payload.
*
* @experimental
*/
var zSessionConfigBoolean = object({ currentValue: boolean() });
/**
* A session configuration option selector and its current state.
*/
var zSessionConfigOption = intersection(union([zSessionConfigSelect.and(object({ type: literal("select") })), zSessionConfigBoolean.and(object({ type: literal("boolean") }))]), object({
	id: zSessionConfigId,
	name: string(),
	description: string().nullish(),
	category: defaultOnError(zSessionConfigOptionCategory.nullish(), () => void 0),
	_meta: record(string(), unknown()).nullish()
}));
/**
* Response from creating a new session.
*
* See protocol docs: [Creating a Session](https://agentclientprotocol.com/protocol/session-setup#creating-a-session)
*/
var zNewSessionResponse = object({
	sessionId: zSessionId,
	modes: defaultOnError(zSessionModeState.nullish(), () => void 0),
	configOptions: defaultOnError(vecSkipError(zSessionConfigOption).nullish(), () => void 0),
	_meta: record(string(), unknown()).nullish()
});
/**
* Response from loading an existing session.
*/
var zLoadSessionResponse = object({
	modes: defaultOnError(zSessionModeState.nullish(), () => void 0),
	configOptions: defaultOnError(vecSkipError(zSessionConfigOption).nullish(), () => void 0),
	_meta: record(string(), unknown()).nullish()
});
/**
* Response from listing sessions.
*/
var zListSessionsResponse = object({
	sessions: requiredDefaultOnError(vecSkipError(object({
		sessionId: zSessionId,
		cwd: string(),
		additionalDirectories: array(string()).optional(),
		title: defaultOnError(string().nullish(), () => void 0),
		updatedAt: defaultOnError(string().nullish(), () => void 0),
		_meta: record(string(), unknown()).nullish()
	})), () => []),
	nextCursor: string().nullish(),
	_meta: record(string(), unknown()).nullish()
});
/**
* Response from deleting a session.
*/
var zDeleteSessionResponse = object({ _meta: record(string(), unknown()).nullish() });
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Response from forking an existing session.
*
* @experimental
*/
var zForkSessionResponse = object({
	sessionId: zSessionId,
	modes: defaultOnError(zSessionModeState.nullish(), () => void 0),
	configOptions: defaultOnError(vecSkipError(zSessionConfigOption).nullish(), () => void 0),
	_meta: record(string(), unknown()).nullish()
});
/**
* Response from resuming an existing session.
*/
var zResumeSessionResponse = object({
	modes: defaultOnError(zSessionModeState.nullish(), () => void 0),
	configOptions: defaultOnError(vecSkipError(zSessionConfigOption).nullish(), () => void 0),
	_meta: record(string(), unknown()).nullish()
});
/**
* Response from closing a session.
*/
var zCloseSessionResponse = object({ _meta: record(string(), unknown()).nullish() });
/**
* Response to `session/set_mode` method.
*/
var zSetSessionModeResponse = object({ _meta: record(string(), unknown()).nullish() });
/**
* Response to `session/set_config_option` method.
*/
var zSetSessionConfigOptionResponse = object({
	configOptions: requiredDefaultOnError(vecSkipError(zSessionConfigOption), () => []),
	_meta: record(string(), unknown()).nullish()
});
/**
* Response from processing a user prompt.
*
* See protocol docs: [Check for Completion](https://agentclientprotocol.com/protocol/prompt-turn#4-check-for-completion)
*/
var zPromptResponse = object({
	stopReason: union([
		literal("end_turn"),
		literal("max_tokens"),
		literal("max_turn_requests"),
		literal("refusal"),
		literal("cancelled")
	]),
	usage: defaultOnError(object({
		totalTokens: number(),
		inputTokens: number(),
		outputTokens: number(),
		thoughtTokens: number().nullish(),
		cachedReadTokens: number().nullish(),
		cachedWriteTokens: number().nullish(),
		_meta: record(string(), unknown()).nullish()
	}).nullish(), () => void 0),
	_meta: record(string(), unknown()).nullish()
});
/**
* Response to `nes/start`.
*/
var zStartNesResponse = object({
	sessionId: zSessionId,
	_meta: record(string(), unknown()).nullish()
});
/**
* A zero-based position in a text document.
*
* The meaning of `character` depends on the negotiated position encoding.
*/
var zPosition = object({
	line: int().gte(0).max(4294967295, { error: "Invalid value: Expected uint32 to be <= 4294967295" }),
	character: int().gte(0).max(4294967295, { error: "Invalid value: Expected uint32 to be <= 4294967295" }),
	_meta: record(string(), unknown()).nullish()
});
/**
* A range in a text document, expressed as start and end positions.
*/
var zRange = object({
	start: zPosition,
	end: zPosition,
	_meta: record(string(), unknown()).nullish()
});
/**
* A text edit within a suggestion.
*/
var zNesTextEdit = object({
	range: zRange,
	newText: string(),
	_meta: record(string(), unknown()).nullish()
});
/**
* A text edit suggestion.
*/
var zNesEditSuggestion = object({
	id: string(),
	uri: string(),
	edits: array(zNesTextEdit),
	cursorPosition: defaultOnError(zPosition.nullish(), () => void 0),
	_meta: record(string(), unknown()).nullish()
});
/**
* A jump-to-location suggestion.
*/
var zNesJumpSuggestion = object({
	id: string(),
	uri: string(),
	position: zPosition,
	_meta: record(string(), unknown()).nullish()
});
/**
* A rename symbol suggestion.
*/
var zNesRenameSuggestion = object({
	id: string(),
	uri: string(),
	position: zPosition,
	newName: string(),
	_meta: record(string(), unknown()).nullish()
});
/**
* A search-and-replace suggestion.
*/
var zNesSearchAndReplaceSuggestion = object({
	id: string(),
	uri: string(),
	search: string(),
	replace: string(),
	isRegex: boolean().nullish(),
	_meta: record(string(), unknown()).nullish()
});
/**
* Response to `nes/suggest`.
*/
var zSuggestNesResponse = object({
	suggestions: requiredDefaultOnError(vecSkipError(union([
		zNesEditSuggestion.and(object({ kind: literal("edit") })),
		zNesJumpSuggestion.and(object({ kind: literal("jump") })),
		zNesRenameSuggestion.and(object({ kind: literal("rename") })),
		zNesSearchAndReplaceSuggestion.and(object({ kind: literal("searchAndReplace") }))
	])), () => []),
	_meta: record(string(), unknown()).nullish()
});
/**
* Response from closing an NES session.
*/
var zCloseNesResponse = object({ _meta: record(string(), unknown()).nullish() });
/**
* Allows for sending an arbitrary response to an [`ExtRequest`] that is not part of the ACP spec.
* Extension methods provide a way to add custom functionality while maintaining
* protocol compatibility.
*
* See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)
*/
var zExtResponse = unknown();
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Response to `mcp/message`.
*
* This is the inner MCP response result payload. Any JSON value is valid.
*
* @experimental
*/
var zMessageMcpResponse = unknown();
/**
* JSON-RPC error object.
*
* Represents an error that occurred during method execution, following the
* JSON-RPC 2.0 error object specification with optional additional data.
*
* See protocol docs: [JSON-RPC Error Object](https://www.jsonrpc.org/specification#error_object)
*/
var zError = object({
	code: union([
		literal(-32700),
		literal(-32600),
		literal(-32601),
		literal(-32602),
		literal(-32603),
		literal(-32800),
		literal(-32e3),
		literal(-32002),
		literal(-32042),
		int().min(-2147483648, { error: "Invalid value: Expected int32 to be >= -2147483648" }).max(2147483647, { error: "Invalid value: Expected int32 to be <= 2147483647" })
	]),
	message: string(),
	data: unknown().optional()
});
union([object({
	id: zRequestId,
	result: union([
		zInitializeResponse,
		zAuthenticateResponse,
		zListProvidersResponse,
		zSetProviderResponse,
		zDisableProviderResponse,
		zLogoutResponse,
		zNewSessionResponse,
		zLoadSessionResponse,
		zListSessionsResponse,
		zDeleteSessionResponse,
		zForkSessionResponse,
		zResumeSessionResponse,
		zCloseSessionResponse,
		zSetSessionModeResponse,
		zSetSessionConfigOptionResponse,
		zPromptResponse,
		zStartNesResponse,
		zSuggestNesResponse,
		zCloseNesResponse,
		zExtResponse,
		zMessageMcpResponse
	])
}), object({
	id: zRequestId,
	error: zError
})]);
/**
* A streamed item of content
*/
var zContentChunk = object({
	content: zContentBlock,
	messageId: string().nullish(),
	_meta: record(string(), unknown()).nullish()
});
/**
* Represents a tool call that the language model has requested.
*
* Tool calls are actions that the agent executes on behalf of the language model,
* such as reading files, executing code, or fetching data from external sources.
*
* See protocol docs: [Tool Calls](https://agentclientprotocol.com/protocol/tool-calls)
*/
var zToolCall = object({
	toolCallId: zToolCallId,
	title: string(),
	kind: zToolKind.optional(),
	status: zToolCallStatus.optional(),
	content: defaultOnError(vecSkipError(zToolCallContent).optional(), () => []),
	locations: defaultOnError(vecSkipError(zToolCallLocation).optional(), () => []),
	rawInput: unknown().optional(),
	rawOutput: unknown().optional(),
	_meta: record(string(), unknown()).nullish()
});
/**
* Priority levels for plan entries.
*
* Used to indicate the relative importance or urgency of different
* tasks in the execution plan.
* See protocol docs: [Plan Entries](https://agentclientprotocol.com/protocol/agent-plan#plan-entries)
*/
var zPlanEntryPriority = union([
	literal("high"),
	literal("medium"),
	literal("low")
]);
/**
* Status of a plan entry in the execution flow.
*
* Tracks the lifecycle of each task from planning through completion.
* See protocol docs: [Plan Entries](https://agentclientprotocol.com/protocol/agent-plan#plan-entries)
*/
var zPlanEntryStatus = union([
	literal("pending"),
	literal("in_progress"),
	literal("completed")
]);
/**
* A single entry in the execution plan.
*
* Represents a task or goal that the assistant intends to accomplish
* as part of fulfilling the user's request.
* See protocol docs: [Plan Entries](https://agentclientprotocol.com/protocol/agent-plan#plan-entries)
*/
var zPlanEntry = object({
	content: string(),
	priority: zPlanEntryPriority,
	status: zPlanEntryStatus,
	_meta: record(string(), unknown()).nullish()
});
/**
* An execution plan for accomplishing complex tasks.
*
* Plans consist of multiple entries representing individual tasks or goals.
* Agents report plans to clients to provide visibility into their execution strategy.
* Plans can evolve during execution as the agent discovers new requirements or completes tasks.
*
* See protocol docs: [Agent Plan](https://agentclientprotocol.com/protocol/agent-plan)
*/
var zPlan = object({
	entries: requiredDefaultOnError(vecSkipError(zPlanEntry), () => []),
	_meta: record(string(), unknown()).nullish()
});
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Unique identifier for a plan within a session.
*
* @experimental
*/
var zPlanId = string();
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* A plan represented as structured entries.
*
* @experimental
*/
var zPlanItems = object({
	id: zPlanId,
	entries: requiredDefaultOnError(vecSkipError(zPlanEntry), () => []),
	_meta: record(string(), unknown()).nullish()
});
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* A plan represented by a file URI.
*
* @experimental
*/
var zPlanFile = object({
	id: zPlanId,
	uri: string(),
	_meta: record(string(), unknown()).nullish()
});
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* A plan represented as raw markdown content.
*
* @experimental
*/
var zPlanMarkdown = object({
	id: zPlanId,
	content: string(),
	_meta: record(string(), unknown()).nullish()
});
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* A content update for a plan identified by ID.
*
* @experimental
*/
var zPlanUpdate = object({
	plan: union([
		zPlanItems.and(object({ type: literal("items") })),
		zPlanFile.and(object({ type: literal("file") })),
		zPlanMarkdown.and(object({ type: literal("markdown") }))
	]),
	_meta: record(string(), unknown()).nullish()
});
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Removal notice for a plan identified by ID.
*
* @experimental
*/
var zPlanRemoved = object({
	id: zPlanId,
	_meta: record(string(), unknown()).nullish()
});
/**
* unstructured
*
* All text that was typed after the command name is provided as input.
*/
var zAvailableCommandInput = object({
	hint: string(),
	_meta: record(string(), unknown()).nullish()
});
/**
* Available commands are ready or have changed
*/
var zAvailableCommandsUpdate = object({
	availableCommands: requiredDefaultOnError(vecSkipError(object({
		name: string(),
		description: string(),
		input: defaultOnError(zAvailableCommandInput.nullish(), () => void 0),
		_meta: record(string(), unknown()).nullish()
	})), () => []),
	_meta: record(string(), unknown()).nullish()
});
/**
* The current mode of the session has changed
*
* See protocol docs: [Session Modes](https://agentclientprotocol.com/protocol/session-modes)
*/
var zCurrentModeUpdate = object({
	currentModeId: zSessionModeId,
	_meta: record(string(), unknown()).nullish()
});
/**
* Session configuration options have been updated.
*/
var zConfigOptionUpdate = object({
	configOptions: requiredDefaultOnError(vecSkipError(zSessionConfigOption), () => []),
	_meta: record(string(), unknown()).nullish()
});
/**
* Update to session metadata. All fields are optional to support partial updates.
*
* Agents send this notification to update session information like title or custom metadata.
* This allows clients to display dynamic session names and track session state changes.
*/
var zSessionInfoUpdate = object({
	title: string().nullish(),
	updatedAt: string().nullish(),
	_meta: record(string(), unknown()).nullish()
});
/**
* Cost information for a session.
*/
var zCost = object({
	amount: number(),
	currency: string(),
	_meta: record(string(), unknown()).nullish()
});
/**
* Context window and cost update for a session.
*/
var zUsageUpdate = object({
	used: number(),
	size: number(),
	cost: defaultOnError(zCost.nullish(), () => void 0),
	_meta: record(string(), unknown()).nullish()
});
/**
* Notification containing a session update from the agent.
*
* Used to stream real-time progress and results during prompt processing.
*
* See protocol docs: [Agent Reports Output](https://agentclientprotocol.com/protocol/prompt-turn#3-agent-reports-output)
*/
var zSessionNotification = object({
	sessionId: zSessionId,
	update: union([
		zContentChunk.and(object({ sessionUpdate: literal("user_message_chunk") })),
		zContentChunk.and(object({ sessionUpdate: literal("agent_message_chunk") })),
		zContentChunk.and(object({ sessionUpdate: literal("agent_thought_chunk") })),
		zToolCall.and(object({ sessionUpdate: literal("tool_call") })),
		zToolCallUpdate.and(object({ sessionUpdate: literal("tool_call_update") })),
		zPlan.and(object({ sessionUpdate: literal("plan") })),
		zPlanUpdate.and(object({ sessionUpdate: literal("plan_update") })),
		zPlanRemoved.and(object({ sessionUpdate: literal("plan_removed") })),
		zAvailableCommandsUpdate.and(object({ sessionUpdate: literal("available_commands_update") })),
		zCurrentModeUpdate.and(object({ sessionUpdate: literal("current_mode_update") })),
		zConfigOptionUpdate.and(object({ sessionUpdate: literal("config_option_update") })),
		zSessionInfoUpdate.and(object({ sessionUpdate: literal("session_info_update") })),
		zUsageUpdate.and(object({ sessionUpdate: literal("usage_update") }))
	]),
	_meta: record(string(), unknown()).nullish()
});
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Notification sent by the agent when a URL-based elicitation is complete.
*
* @experimental
*/
var zCompleteElicitationNotification = object({
	elicitationId: zElicitationId,
	_meta: record(string(), unknown()).nullish()
});
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Notification parameters for `mcp/message`.
*
* This is used when the wrapped MCP message is a notification and the outer JSON-RPC
* envelope has no `id`.
*
* @experimental
*/
var zMessageMcpNotification = object({
	connectionId: zMcpConnectionId,
	method: string(),
	params: record(string(), unknown()).nullish(),
	_meta: record(string(), unknown()).nullish()
});
/**
* Allows the Agent to send an arbitrary notification that is not part of the ACP spec.
* Extension notifications provide a way to send one-way messages for custom functionality
* while maintaining protocol compatibility.
*
* See protocol docs: [Extensibility](https://agentclientprotocol.com/protocol/extensibility)
*/
var zExtNotification = unknown();
object({
	method: string(),
	params: union([
		zSessionNotification,
		zCompleteElicitationNotification,
		zMessageMcpNotification,
		zExtNotification
	]).nullish()
});
/**
* File system capabilities that a client may support.
*
* See protocol docs: [FileSystem](https://agentclientprotocol.com/protocol/initialization#filesystem)
*/
var zFileSystemCapabilities = object({
	readTextFile: boolean().optional().default(false),
	writeTextFile: boolean().optional().default(false),
	_meta: record(string(), unknown()).nullish()
});
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Session-related capabilities supported by the client.
*
* @experimental
*/
var zClientSessionCapabilities = object({
	configOptions: defaultOnError(object({
		boolean: defaultOnError(object({ _meta: record(string(), unknown()).nullish() }).nullish(), () => void 0),
		_meta: record(string(), unknown()).nullish()
	}).nullish(), () => void 0),
	_meta: record(string(), unknown()).nullish()
});
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Capabilities for receiving `plan_update` and `plan_removed` session updates.
*
* @experimental
*/
var zPlanCapabilities = object({ _meta: record(string(), unknown()).nullish() });
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Authentication capabilities supported by the client.
*
* Advertised during initialization to inform the agent which authentication
* method types the client can handle. This governs opt-in types that require
* additional client-side support.
*
* @experimental
*/
var zAuthCapabilities = object({
	terminal: boolean().optional().default(false),
	_meta: record(string(), unknown()).nullish()
});
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Form-based elicitation capabilities.
*
* @experimental
*/
var zElicitationFormCapabilities = object({ _meta: record(string(), unknown()).nullish() });
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* URL-based elicitation capabilities.
*
* @experimental
*/
var zElicitationUrlCapabilities = object({ _meta: record(string(), unknown()).nullish() });
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Elicitation capabilities supported by the client.
*
* @experimental
*/
var zElicitationCapabilities = object({
	form: defaultOnError(zElicitationFormCapabilities.nullish(), () => void 0),
	url: defaultOnError(zElicitationUrlCapabilities.nullish(), () => void 0),
	_meta: record(string(), unknown()).nullish()
});
/**
* Marker for jump suggestion support.
*/
var zNesJumpCapabilities = object({ _meta: record(string(), unknown()).nullish() });
/**
* Marker for rename suggestion support.
*/
var zNesRenameCapabilities = object({ _meta: record(string(), unknown()).nullish() });
/**
* Marker for search and replace suggestion support.
*/
var zNesSearchAndReplaceCapabilities = object({ _meta: record(string(), unknown()).nullish() });
/**
* NES capabilities advertised by the client during initialization.
*/
var zClientNesCapabilities = object({
	jump: defaultOnError(zNesJumpCapabilities.nullish(), () => void 0),
	rename: defaultOnError(zNesRenameCapabilities.nullish(), () => void 0),
	searchAndReplace: defaultOnError(zNesSearchAndReplaceCapabilities.nullish(), () => void 0),
	_meta: record(string(), unknown()).nullish()
});
/**
* Request parameters for the initialize method.
*
* Sent by the client to establish connection and negotiate capabilities.
*
* See protocol docs: [Initialization](https://agentclientprotocol.com/protocol/initialization)
*/
var zInitializeRequest = object({
	protocolVersion: zProtocolVersion,
	clientCapabilities: object({
		fs: zFileSystemCapabilities.optional().default({
			readTextFile: false,
			writeTextFile: false
		}),
		terminal: boolean().optional().default(false),
		session: defaultOnError(zClientSessionCapabilities.nullish(), () => void 0),
		plan: defaultOnError(zPlanCapabilities.nullish(), () => void 0),
		auth: zAuthCapabilities.optional().default({ terminal: false }),
		elicitation: defaultOnError(zElicitationCapabilities.nullish(), () => void 0),
		nes: defaultOnError(zClientNesCapabilities.nullish(), () => void 0),
		positionEncodings: defaultOnError(vecSkipError(zPositionEncodingKind).optional(), () => []),
		_meta: record(string(), unknown()).nullish()
	}).optional().default({
		fs: {
			readTextFile: false,
			writeTextFile: false
		},
		terminal: false,
		auth: { terminal: false }
	}),
	clientInfo: defaultOnError(zImplementation.nullish(), () => void 0),
	_meta: record(string(), unknown()).nullish()
});
/**
* Request parameters for the authenticate method.
*
* Specifies which authentication method to use.
*/
var zAuthenticateRequest = object({
	methodId: zAuthMethodId,
	_meta: record(string(), unknown()).nullish()
});
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Request parameters for `providers/list`.
*
* @experimental
*/
var zListProvidersRequest = object({ _meta: record(string(), unknown()).nullish() });
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Request parameters for `providers/set`.
*
* Replaces the full configuration for one provider id.
*
* @experimental
*/
var zSetProviderRequest = object({
	id: string(),
	apiType: zLlmProtocol,
	baseUrl: string(),
	headers: record(string(), string()).optional(),
	_meta: record(string(), unknown()).nullish()
});
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Request parameters for `providers/disable`.
*
* @experimental
*/
var zDisableProviderRequest = object({
	id: string(),
	_meta: record(string(), unknown()).nullish()
});
/**
* Request parameters for the logout method.
*
* Terminates the current authenticated session.
*/
var zLogoutRequest = object({ _meta: record(string(), unknown()).nullish() });
/**
* An HTTP header to set when making requests to the MCP server.
*/
var zHttpHeader = object({
	name: string(),
	value: string(),
	_meta: record(string(), unknown()).nullish()
});
/**
* HTTP transport configuration for MCP.
*/
var zMcpServerHttp = object({
	name: string(),
	url: string(),
	headers: array(zHttpHeader),
	_meta: record(string(), unknown()).nullish()
});
/**
* SSE transport configuration for MCP.
*/
var zMcpServerSse = object({
	name: string(),
	url: string(),
	headers: array(zHttpHeader),
	_meta: record(string(), unknown()).nullish()
});
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* ACP transport configuration for MCP.
*
* The MCP server is provided by an ACP component and communicates over the ACP channel
* using `mcp/connect`, `mcp/message`, and `mcp/disconnect`.
*
* @experimental
*/
var zMcpServerAcp = object({
	name: string(),
	id: zMcpServerAcpId,
	_meta: record(string(), unknown()).nullish()
});
/**
* Stdio transport configuration for MCP.
*/
var zMcpServerStdio = object({
	name: string(),
	command: string(),
	args: array(string()),
	env: array(zEnvVariable),
	_meta: record(string(), unknown()).nullish()
});
/**
* Configuration for connecting to an MCP (Model Context Protocol) server.
*
* MCP servers provide tools and context that the agent can use when
* processing prompts.
*
* See protocol docs: [MCP Servers](https://agentclientprotocol.com/protocol/session-setup#mcp-servers)
*/
var zMcpServer = union([
	zMcpServerHttp.and(object({ type: literal("http") })),
	zMcpServerSse.and(object({ type: literal("sse") })),
	zMcpServerAcp.and(object({ type: literal("acp") })),
	zMcpServerStdio
]);
/**
* Request parameters for creating a new session.
*
* See protocol docs: [Creating a Session](https://agentclientprotocol.com/protocol/session-setup#creating-a-session)
*/
var zNewSessionRequest = object({
	cwd: string(),
	additionalDirectories: array(string()).optional(),
	mcpServers: array(zMcpServer),
	_meta: record(string(), unknown()).nullish()
});
/**
* Request parameters for loading an existing session.
*
* Only available if the Agent supports the `loadSession` capability.
*
* See protocol docs: [Loading Sessions](https://agentclientprotocol.com/protocol/session-setup#loading-sessions)
*/
var zLoadSessionRequest = object({
	mcpServers: array(zMcpServer),
	cwd: string(),
	additionalDirectories: array(string()).optional(),
	sessionId: zSessionId,
	_meta: record(string(), unknown()).nullish()
});
/**
* Request parameters for listing existing sessions.
*
* Only available if the Agent supports the `sessionCapabilities.list` capability.
*/
var zListSessionsRequest = object({
	cwd: string().nullish(),
	cursor: string().nullish(),
	_meta: record(string(), unknown()).nullish()
});
/**
* Request parameters for deleting an existing session from `session/list`.
*
* Only available if the Agent supports the `sessionCapabilities.delete` capability.
*/
var zDeleteSessionRequest = object({
	sessionId: zSessionId,
	_meta: record(string(), unknown()).nullish()
});
/**
* **UNSTABLE**
*
* This capability is not part of the spec yet, and may be removed or changed at any point.
*
* Request parameters for forking an existing session.
*
* Creates a new session based on the context of an existing one, allowing
* operations like generating summaries without affecting the original session's history.
*
* Only available if the Agent supports the `session.fork` capability.
*
* @experimental
*/
var zForkSessionRequest = object({
	sessionId: zSessionId,
	cwd: string(),
	additionalDirectories: array(string()).optional(),
	mcpServers: array(zMcpServer).optional(),
	_meta: record(string(), unknown()).nullish()
});
/**
* Request parameters for resuming an existing session.
*
* Resumes an existing session without returning previous messages (unlike `session/load`).
* This is useful for agents that can resume sessions but don't implement full session loading.
*
* Only available if the Agent supports the `sessionCapabilities.resume` capability.
*/
var zResumeSessionRequest = object({
	sessionId: zSessionId,
	cwd: string(),
	additionalDirectories: array(string()).optional(),
	mcpServers: array(zMcpServer).optional(),
	_meta: record(string(), unknown()).nullish()
});
/**
* Request parameters for closing an active session.
*
* If supported, the agent **must** cancel any ongoing work related to the session
* (treat it as if `session/cancel` was called) and then free up any resources
* associated with the session.
*
* Only available if the Agent supports the `sessionCapabilities.close` capability.
*/
var zCloseSessionRequest = object({
	sessionId: zSessionId,
	_meta: record(string(), unknown()).nullish()
});
/**
* Request parameters for setting a session mode.
*/
var zSetSessionModeRequest = object({
	sessionId: zSessionId,
	modeId: zSessionModeId,
	_meta: record(string(), unknown()).nullish()
});
/**
* Request parameters for setting a session configuration option.
*/
var zSetSessionConfigOptionRequest = intersection(union([object({
	value: boolean(),
	type: literal("boolean")
}), object({ value: zSessionConfigValueId })]), object({
	sessionId: zSessionId,
	configId: zSessionConfigId,
	_meta: record(string(), unknown()).nullish()
}));
/**
* Request parameters for sending a user prompt to the agent.
*
* Contains the user's message and any additional context.
*
* See protocol docs: [User Message](https://agentclientprotocol.com/protocol/prompt-turn#1-user-message)
*/
var zPromptRequest = object({
	sessionId: zSessionId,
	prompt: array(zContentBlock),
	_meta: record(string(), unknown()).nullish()
});
/**
* A workspace folder.
*/
var zWorkspaceFolder = object({
	uri: string(),
	name: string(),
	_meta: record(string(), unknown()).nullish()
});
/**
* Repository metadata for an NES session.
*/
var zNesRepository = object({
	name: string(),
	owner: string(),
	remoteUrl: string(),
	_meta: record(string(), unknown()).nullish()
});
/**
* Request to start an NES session.
*/
var zStartNesRequest = object({
	workspaceUri: string().nullish(),
	workspaceFolders: defaultOnError(vecSkipError(zWorkspaceFolder).nullish(), () => void 0),
	repository: defaultOnError(zNesRepository.nullish(), () => void 0),
	_meta: record(string(), unknown()).nullish()
});
/**
* What triggered the suggestion request.
*/
var zNesTriggerKind = union([
	literal("automatic"),
	literal("diagnostic"),
	literal("manual")
]);
/**
* A recently accessed file.
*/
var zNesRecentFile = object({
	uri: string(),
	languageId: string(),
	text: string(),
	_meta: record(string(), unknown()).nullish()
});
/**
* A code excerpt from a file.
*/
var zNesExcerpt = object({
	startLine: int().gte(0).max(4294967295, { error: "Invalid value: Expected uint32 to be <= 4294967295" }),
	endLine: int().gte(0).max(4294967295, { error: "Invalid value: Expected uint32 to be <= 4294967295" }),
	text: string(),
	_meta: record(string(), unknown()).nullish()
});
/**
* A related code snippet from a file.
*/
var zNesRelatedSnippet = object({
	uri: string(),
	excerpts: array(zNesExcerpt),
	_meta: record(string(), unknown()).nullish()
});
/**
* An entry in the edit history.
*/
var zNesEditHistoryEntry = object({
	uri: string(),
	diff: string(),
	_meta: record(string(), unknown()).nullish()
});
/**
* A user action (typing, cursor movement, etc.).
*/
var zNesUserAction = object({
	action: string(),
	uri: string(),
	position: zPosition,
	timestampMs: number(),
	_meta: record(string(), unknown()).nullish()
});
/**
* An open file in the editor.
*/
var zNesOpenFile = object({
	uri: string(),
	languageId: string(),
	visibleRange: defaultOnError(zRange.nullish(), () => void 0),
	lastFocusedMs: defaultOnError(number().nullish(), () => void 0),
	_meta: record(string(), unknown()).nullish()
});
/**
* Severity of a diagnostic.
*/
var zNesDiagnosticSeverity = union([
	literal("error"),
	literal("warning"),
	literal("information"),
	literal("hint")
]);
/**
* A diagnostic (error, warning, etc.).
*/
var zNesDiagnostic = object({
	uri: string(),
	range: zRange,
	severity: zNesDiagnosticSeverity,
	message: string(),
	_meta: record(string(), unknown()).nullish()
});
/**
* Context attached to a suggestion request.
*/
var zNesSuggestContext = object({
	recentFiles: defaultOnError(vecSkipError(zNesRecentFile).nullish(), () => void 0),
	relatedSnippets: defaultOnError(vecSkipError(zNesRelatedSnippet).nullish(), () => void 0),
	editHistory: defaultOnError(vecSkipError(zNesEditHistoryEntry).nullish(), () => void 0),
	userActions: defaultOnError(vecSkipError(zNesUserAction).nullish(), () => void 0),
	openFiles: defaultOnError(vecSkipError(zNesOpenFile).nullish(), () => void 0),
	diagnostics: defaultOnError(vecSkipError(zNesDiagnostic).nullish(), () => void 0),
	_meta: record(string(), unknown()).nullish()
});
/**
* Request for a code suggestion.
*/
var zSuggestNesRequest = object({
	sessionId: zSessionId,
	uri: string(),
	version: number(),
	position: zPosition,
	selection: defaultOnError(zRange.nullish(), () => void 0),
	triggerKind: zNesTriggerKind,
	context: defaultOnError(zNesSuggestContext.nullish(), () => void 0),
	_meta: record(string(), unknown()).nullish()
});
/**
* Request to close an NES session.
*
* The agent **must** cancel any ongoing work related to the NES session
* and then free up any resources associated with the session.
*/
var zCloseNesRequest = object({
	sessionId: zSessionId,
	_meta: record(string(), unknown()).nullish()
});
object({
	id: zRequestId,
	method: string(),
	params: union([
		zInitializeRequest,
		zAuthenticateRequest,
		zListProvidersRequest,
		zSetProviderRequest,
		zDisableProviderRequest,
		zLogoutRequest,
		zNewSessionRequest,
		zLoadSessionRequest,
		zListSessionsRequest,
		zDeleteSessionRequest,
		zForkSessionRequest,
		zResumeSessionRequest,
		zCloseSessionRequest,
		zSetSessionModeRequest,
		zSetSessionConfigOptionRequest,
		zPromptRequest,
		zStartNesRequest,
		zSuggestNesRequest,
		zCloseNesRequest,
		zMessageMcpRequest,
		zExtRequest
	]).nullish()
});
/**
* Response to `fs/write_text_file`
*/
var zWriteTextFileResponse = object({ _meta: record(string(), unknown()).nullish() });
/**
* Response containing the contents of a text file.
*/
var zReadTextFileResponse = object({
	content: string(),
	_meta: record(string(), unknown()).nullish()
});
/**
* The user selected one of the provided options.
*/
var zSelectedPermissionOutcome = object({
	optionId: zPermissionOptionId,
	_meta: record(string(), unknown()).nullish()
});
/**
* Response to a permission request.
*/
var zRequestPermissionResponse = object({
	outcome: union([object({ outcome: literal("cancelled") }), zSelectedPermissionOutcome.and(object({ outcome: literal("selected") }))]),
	_meta: record(string(), unknown()).nullish()
});
/**
* Response containing the ID of the created terminal.
*/
var zCreateTerminalResponse = object({
	terminalId: zTerminalId,
	_meta: record(string(), unknown()).nullish()
});
/**
* Exit status of a terminal command.
*/
var zTerminalExitStatus = object({
	exitCode: int().gte(0).max(4294967295, { error: "Invalid value: Expected uint32 to be <= 4294967295" }).nullish(),
	signal: string().nullish(),
	_meta: record(string(), unknown()).nullish()
});
/**
* Response containing the terminal output and exit status.
*/
var zTerminalOutputResponse = object({
	output: string(),
	truncated: boolean(),
	exitStatus: zTerminalExitStatus.nullish(),
	_meta: record(string(), unknown()).nullish()
});
/**
* Response to terminal/release method
*/
var zReleaseTerminalResponse = object({ _meta: record(string(), unknown()).nullish() });
/**
* Response containing the exit status of a terminal command.
*/
var zWaitForTerminalExitResponse = object({
	exitCode: int().gte(0).max(4294967295, { error: "Invalid value: Expected uint32 to be <= 4294967295" }).nullish(),
	signal: string().nullish(),
	_meta: record(string(), unknown()).nullish()
});
/**
* Response to `terminal/kill` method
*/
var zKillTerminalResponse = object({ _meta: record(string(), unknown()).nullish() });
/**
* Allowed wire representations for [`ElicitationContentValue`].
*/
var zElicitationContentValue = union([
	string(),
	number(),
	number(),
	boolean(),
	array(string())
]);
union([object({
	id: zRequestId,
	result: union([
		zWriteTextFileResponse,
		zReadTextFileResponse,
		zRequestPermissionResponse,
		zCreateTerminalResponse,
		zTerminalOutputResponse,
		zReleaseTerminalResponse,
		zWaitForTerminalExitResponse,
		zKillTerminalResponse,
		intersection(union([
			object({ content: record(string(), zElicitationContentValue).nullish() }).and(object({ action: literal("accept") })),
			object({ action: literal("decline") }),
			object({ action: literal("cancel") })
		]), object({ _meta: record(string(), unknown()).nullish() })),
		object({
			connectionId: zMcpConnectionId,
			_meta: record(string(), unknown()).nullish()
		}),
		object({ _meta: record(string(), unknown()).nullish() }),
		zExtResponse,
		zMessageMcpResponse
	])
}), object({
	id: zRequestId,
	error: zError
})]);
/**
* Notification to cancel ongoing operations for a session.
*
* See protocol docs: [Cancellation](https://agentclientprotocol.com/protocol/prompt-turn#cancellation)
*/
var zCancelNotification = object({
	sessionId: zSessionId,
	_meta: record(string(), unknown()).nullish()
});
/**
* Notification sent when a file is opened in the editor.
*/
var zDidOpenDocumentNotification = object({
	sessionId: zSessionId,
	uri: string(),
	languageId: string(),
	version: number(),
	text: string(),
	_meta: record(string(), unknown()).nullish()
});
/**
* A content change event for a document.
*
* When `range` is `None`, `text` is the full content of the document.
* When `range` is `Some`, `text` replaces the given range.
*/
var zTextDocumentContentChangeEvent = object({
	range: zRange.nullish(),
	text: string(),
	_meta: record(string(), unknown()).nullish()
});
/**
* Notification sent when a file is edited.
*/
var zDidChangeDocumentNotification = object({
	sessionId: zSessionId,
	uri: string(),
	version: number(),
	contentChanges: array(zTextDocumentContentChangeEvent),
	_meta: record(string(), unknown()).nullish()
});
/**
* Notification sent when a file is closed.
*/
var zDidCloseDocumentNotification = object({
	sessionId: zSessionId,
	uri: string(),
	_meta: record(string(), unknown()).nullish()
});
/**
* Notification sent when a file is saved.
*/
var zDidSaveDocumentNotification = object({
	sessionId: zSessionId,
	uri: string(),
	_meta: record(string(), unknown()).nullish()
});
/**
* Notification sent when a file becomes the active editor tab.
*/
var zDidFocusDocumentNotification = object({
	sessionId: zSessionId,
	uri: string(),
	version: number(),
	position: zPosition,
	visibleRange: zRange,
	_meta: record(string(), unknown()).nullish()
});
/**
* Notification sent when a suggestion is accepted.
*/
var zAcceptNesNotification = object({
	sessionId: zSessionId,
	id: string(),
	_meta: record(string(), unknown()).nullish()
});
/**
* The reason a suggestion was rejected.
*/
var zNesRejectReason = union([
	literal("rejected"),
	literal("ignored"),
	literal("replaced"),
	literal("cancelled")
]);
/**
* Notification sent when a suggestion is rejected.
*/
var zRejectNesNotification = object({
	sessionId: zSessionId,
	id: string(),
	reason: defaultOnError(zNesRejectReason.nullish(), () => void 0),
	_meta: record(string(), unknown()).nullish()
});
object({
	method: string(),
	params: union([
		zCancelNotification,
		zDidOpenDocumentNotification,
		zDidChangeDocumentNotification,
		zDidCloseDocumentNotification,
		zDidSaveDocumentNotification,
		zDidFocusDocumentNotification,
		zAcceptNesNotification,
		zRejectNesNotification,
		zMessageMcpNotification,
		zExtNotification
	]).nullish()
});
object({
	requestId: zRequestId,
	_meta: record(string(), unknown()).nullish()
});
//#endregion
//#region node_modules/@agentclientprotocol/sdk/dist/stream.js
/**
* Creates an ACP Stream from a pair of newline-delimited JSON streams.
*
* This is the typical way to handle ACP connections over stdio, converting
* between AnyMessage objects and newline-delimited JSON.
*
* @param output - The writable stream to send encoded messages to
* @param input - The readable stream to receive encoded messages from
* @returns A Stream for bidirectional ACP communication
*/
function ndJsonStream(output, input) {
	const textEncoder = new TextEncoder();
	const textDecoder = new TextDecoder();
	let cancelled = false;
	let inputReader;
	return {
		readable: new ReadableStream({
			async start(controller) {
				let content = "";
				const reader = input.getReader();
				inputReader = reader;
				try {
					while (true) {
						const { value, done } = await reader.read();
						if (cancelled) return;
						if (done) {
							content += textDecoder.decode();
							break;
						}
						if (!value) continue;
						content += textDecoder.decode(value, { stream: true });
						const lines = content.split("\n");
						content = lines.pop() || "";
						for (const line of lines) {
							if (cancelled) return;
							const trimmedLine = line.trim();
							if (trimmedLine) try {
								const message = JSON.parse(trimmedLine);
								controller.enqueue(message);
							} catch (err) {
								console.error("Failed to parse JSON message:", trimmedLine, err);
							}
						}
					}
					if (cancelled) return;
					const trimmedLine = content.trim();
					if (trimmedLine) try {
						const message = JSON.parse(trimmedLine);
						controller.enqueue(message);
					} catch (err) {
						console.error("Failed to parse JSON message:", trimmedLine, err);
					}
				} catch (err) {
					if (cancelled) return;
					controller.error(err);
					return;
				} finally {
					if (inputReader === reader) inputReader = void 0;
					reader.releaseLock();
				}
				if (cancelled) return;
				controller.close();
			},
			cancel(reason) {
				cancelled = true;
				return inputReader?.cancel(reason);
			}
		}),
		writable: new WritableStream({ async write(message) {
			const content = JSON.stringify(message) + "\n";
			const writer = output.getWriter();
			try {
				await writer.write(textEncoder.encode(content));
			} finally {
				writer.releaseLock();
			}
		} })
	};
}
//#endregion
//#region node_modules/@agentclientprotocol/sdk/dist/jsonrpc.js
var CANCEL_REQUEST_METHOD = "$/cancel_request";
function isRecord(value) {
	return typeof value === "object" && value !== null;
}
function isJsonRpcId(value) {
	return value === null || typeof value === "string" || typeof value === "number" && Number.isFinite(value);
}
function cancelRequestId(params) {
	if (!isRecord(params) || !isJsonRpcId(params["requestId"])) return;
	return params["requestId"];
}
/**
* Helpers for constructing `HandleResult` values.
*/
var Handled = {
	/**
	* Marks a message as handled.
	*/
	yes() {
		return { handled: true };
	},
	/**
	* Leaves a message unhandled so later handlers can process it.
	*/
	no(message, retry = false) {
		return {
			handled: false,
			message,
			retry
		};
	}
};
function rejectedPromise(error) {
	const promise = Promise.reject(error);
	promise.catch(() => {});
	return promise;
}
function errorDetails(error) {
	if (error instanceof Error) return error.message;
	if (typeof error === "object" && error != null && "message" in error && typeof error.message === "string") return error.message;
}
function isZodError(error) {
	return typeof error === "object" && error !== null && "name" in error && error.name === "ZodError" && "issues" in error && Array.isArray(error.issues) && "format" in error && typeof error.format === "function";
}
function errorToResult(error) {
	if (error instanceof RequestError) return error.toResult();
	if (isZodError(error)) return RequestError.invalidParams(error.format()).toResult();
	const details = errorDetails(error);
	try {
		return RequestError.internalError(details ? JSON.parse(details) : {}).toResult();
	} catch {
		return RequestError.internalError({ details }).toResult();
	}
}
function requestCancelledError(reason) {
	if (reason instanceof RequestError && reason.code === -32800) return reason;
	return RequestError.requestCancelled(reason);
}
function errorToRequestResult(error, signal) {
	const requestCancelled = abortErrorToRequestCancelled(error, signal);
	return requestCancelled ? requestCancelled.toResult() : errorToResult(error);
}
function abortErrorToRequestCancelled(error, signal) {
	if (!signal.aborted || !isAbortError(error)) return;
	return requestCancelledError(signal.reason);
}
function isAbortError(error) {
	if (typeof error !== "object" || error === null) return false;
	const maybeAbortError = error;
	return maybeAbortError.name === "AbortError" || maybeAbortError.code === "ABORT_ERR";
}
/**
* Responder for one incoming JSON-RPC request.
*
* Handlers may use this when they need to decide exactly when or how the
* response is sent.
*/
var RequestResponder = class {
	id;
	sendResult;
	signal;
	finishRequest;
	didRespond = false;
	constructor(id, sendResult, signal = new AbortController().signal, finishRequest) {
		this.id = id;
		this.sendResult = sendResult;
		this.signal = signal;
		this.finishRequest = finishRequest;
	}
	/**
	* Whether this request has already received a response.
	*/
	get responded() {
		return this.didRespond;
	}
	/**
	* Sends a successful JSON-RPC response.
	*/
	respond(response) {
		return this.respondWithResult({ result: response ?? null });
	}
	/**
	* Sends an error JSON-RPC response.
	*/
	respondWithError(error) {
		const errorResponse = error instanceof RequestError ? error.toErrorResponse() : error;
		return this.respondWithResult({ error: errorResponse });
	}
	/**
	* Sends a complete JSON-RPC result payload.
	*/
	respondWithResult(result) {
		if (this.didRespond) return rejectedPromise(/* @__PURE__ */ new Error("JSON-RPC request already responded"));
		this.didRespond = true;
		return this.sendResult(result).finally(() => {
			this.finishRequest?.();
		});
	}
};
/**
* Disposable handle returned when a handler is registered dynamically.
*/
var HandlerRegistration = class {
	disposeHandler;
	active = true;
	constructor(disposeHandler) {
		this.disposeHandler = disposeHandler;
	}
	/**
	* Unregisters the associated handler.
	*/
	dispose() {
		if (!this.active) return;
		this.active = false;
		this.disposeHandler();
	}
	/**
	* Supports explicit resource management with `using`.
	*/
	[Symbol.dispose]() {
		this.dispose();
	}
	/**
	* Returns this registration for call sites that intentionally keep it active.
	*/
	runIndefinitely() {
		return this;
	}
};
/**
* Per-connection context passed to low-level JSON-RPC handlers.
*/
var ConnectionContext = class {
	connection;
	constructor(connection) {
		this.connection = connection;
	}
	/**
	* Sends a request over the connection.
	*/
	sendRequest(method, params, mapResponse, options) {
		return this.connection.sendRequest(method, params, mapResponse, options);
	}
	/**
	* Sends a notification over the connection.
	*/
	sendNotification(method, params) {
		return this.connection.sendNotification(method, params);
	}
	/**
	* Sends a protocol-level request cancellation notification.
	*/
	sendCancelRequest(requestId) {
		return this.connection.sendCancelRequest(requestId);
	}
	/**
	* Registers a handler that can be disposed independently.
	*/
	addDynamicHandler(handler) {
		return this.connection.addDynamicHandler(handler);
	}
	/**
	* AbortSignal that aborts when the connection closes.
	*/
	get signal() {
		return this.connection.signal;
	}
	/**
	* Promise that resolves when the connection closes.
	*/
	get closed() {
		return this.connection.closed;
	}
};
/**
* Lower-level JSON-RPC connection over an ACP `Stream`.
*
* Most ACP integrations should use `agent(...)` or `client(...)`. Use this
* class when building generic JSON-RPC middleware or custom dispatch behavior.
*/
var Connection = class {
	pendingResponses = /* @__PURE__ */ new Map();
	incomingRequests = /* @__PURE__ */ new Map();
	nextRequestId = 0;
	staticHandlers = [];
	dynamicHandlers = /* @__PURE__ */ new Set();
	stream;
	writeQueue = Promise.resolve();
	abortController = new AbortController();
	closedPromise;
	retryQueue = [];
	context = new ConnectionContext(this);
	receiveReader;
	constructor(requestHandlerOrStream, notificationHandlerOrHandlers, streamOrOptions, options) {
		if (typeof requestHandlerOrStream === "function") {
			const requestHandler = requestHandlerOrStream;
			const notificationHandler = notificationHandlerOrHandlers;
			const stream = streamOrOptions;
			this.initialize(stream, [...options?.handlers ?? [], this.legacyHandler(requestHandler, notificationHandler)]);
			return;
		}
		const stream = requestHandlerOrStream;
		const handlers = notificationHandlerOrHandlers;
		const connectionOptions = streamOrOptions;
		this.initialize(stream, [...connectionOptions?.handlers ?? [], ...handlers]);
	}
	/**
	* Creates a builder for configuring a handler-based connection.
	*/
	static builder() {
		return new ConnectionBuilder();
	}
	/**
	* Runs an operation while the connection is open, then closes the connection.
	*
	* If the stream closes before `op` settles, the returned promise rejects with
	* the connection close reason.
	*/
	runUntil(op) {
		let opSettled = false;
		const opPromise = Promise.resolve().then(() => op(this.context)).finally(() => {
			opSettled = true;
		});
		const closedPromise = this.closed.then(() => {
			if (opSettled) return new Promise(() => {});
			throw this.closedReason();
		});
		return Promise.race([opPromise, closedPromise]).finally(() => {
			opSettled = true;
			this.close();
		});
	}
	/**
	* Adds a handler after the connection has started.
	*
	* Any messages queued with `Handled.no(message, true)` are retried after the
	* handler is added.
	*/
	addDynamicHandler(handler) {
		this.dynamicHandlers.add(handler);
		if (this.retryQueue.length > 0) for (const message of this.retryQueue.splice(0)) this.processIncomingMessage(message).catch((error) => this.close(error));
		return new HandlerRegistration(() => {
			this.dynamicHandlers.delete(handler);
		});
	}
	/**
	* AbortSignal that aborts when the connection closes.
	*/
	get signal() {
		return this.abortController.signal;
	}
	/**
	* Promise that resolves when the connection closes.
	*/
	get closed() {
		return this.closedPromise;
	}
	/** @internal */
	getContext() {
		return this.context;
	}
	/**
	* Sends a JSON-RPC request.
	*
	* `mapResponse` can convert the raw result before the returned promise
	* resolves.
	*/
	sendRequest(method, params, mapResponse, options = {}) {
		if (this.abortController.signal.aborted) return rejectedPromise(this.closedReason());
		const id = this.nextRequestId++;
		let cancel = () => {};
		const responsePromise = new Promise((resolve, reject) => {
			const pendingResponse = {
				resolve: (response) => {
					try {
						resolve(mapResponse ? mapResponse(response) : response);
					} catch (error) {
						reject(error);
					}
				},
				reject
			};
			cancel = () => {
				if (pendingResponse.cancellationSent) return;
				pendingResponse.cancellationSent = true;
				pendingResponse.cleanup?.();
				this.sendCancelRequest(id).catch(() => {});
			};
			options.cancellationSignal?.addEventListener("abort", cancel, { once: true });
			pendingResponse.cleanup = () => {
				options.cancellationSignal?.removeEventListener("abort", cancel);
			};
			this.pendingResponses.set(id, pendingResponse);
		});
		responsePromise.catch(() => {});
		this.sendMessage({
			jsonrpc: "2.0",
			id,
			method,
			params
		}).catch(() => {});
		if (options.cancellationSignal?.aborted) cancel();
		return responsePromise;
	}
	/**
	* Sends a protocol-level request cancellation notification.
	*/
	sendCancelRequest(requestId) {
		return this.sendNotification(CANCEL_REQUEST_METHOD, { requestId });
	}
	/**
	* Sends a JSON-RPC notification.
	*/
	sendNotification(method, params) {
		if (this.abortController.signal.aborted) return rejectedPromise(this.closedReason());
		return this.sendMessage({
			jsonrpc: "2.0",
			method,
			params
		});
	}
	/**
	* Closes the connection and rejects pending requests.
	*/
	close(error) {
		if (this.abortController.signal.aborted) return;
		const closeError = error ?? /* @__PURE__ */ new Error("ACP connection closed");
		this.abortController.abort(closeError);
		for (const pendingResponse of this.pendingResponses.values()) {
			pendingResponse.cleanup?.();
			pendingResponse.reject(closeError);
		}
		this.pendingResponses.clear();
		for (const controller of this.incomingRequests.values()) controller.abort(closeError);
		this.incomingRequests.clear();
		this.receiveReader?.cancel(closeError).catch(() => {});
	}
	initialize(stream, handlers) {
		this.stream = stream;
		this.staticHandlers = handlers;
		this.closedPromise = new Promise((resolve) => {
			this.abortController.signal.addEventListener("abort", () => resolve());
		});
		this.receive();
	}
	legacyHandler(requestHandler, notificationHandler) {
		return { handleMessage: async (message, cx) => {
			if (message.kind === "request") {
				const result = await requestHandler(message.method, message.params, cx);
				await message.responder.respond(result);
			} else await notificationHandler(message.method, message.params, cx);
			return Handled.yes();
		} };
	}
	async receive() {
		let closeError = void 0;
		try {
			const reader = this.stream.readable.getReader();
			this.receiveReader = reader;
			try {
				while (!this.abortController.signal.aborted) {
					const { value: message, done } = await reader.read();
					if (this.abortController.signal.aborted) break;
					if (done) break;
					if (!message) continue;
					this.receiveMessage(message);
				}
			} finally {
				if (this.receiveReader === reader) this.receiveReader = void 0;
				reader.releaseLock();
			}
		} catch (error) {
			closeError = error;
		} finally {
			this.close(closeError);
		}
	}
	receiveMessage(message) {
		if (this.abortController.signal.aborted) return;
		if ("method" in message) {
			if (!("id" in message)) this.handleProtocolNotification(message);
			this.processIncomingMessage(this.toIncomingMessage(message)).catch((error) => this.close(error));
		} else if ("id" in message) this.handleResponse(message);
		else console.error("Invalid message", { message });
	}
	async processIncomingMessage(message) {
		if (this.abortController.signal.aborted) return;
		let current = message;
		let retry = false;
		try {
			for (const handler of [...this.staticHandlers, ...this.dynamicHandlers.values()]) {
				if (this.abortController.signal.aborted) return;
				const result = await handler.handleMessage(current, this.context) ?? { handled: true };
				if (result.handled) return;
				current = result.message ?? current;
				retry = retry || Boolean(result.retry);
			}
			if (retry) this.retryQueue.push(current);
			else if (current.kind === "request") await current.responder.respondWithError(RequestError.methodNotFound(current.method));
		} catch (error) {
			if (this.abortController.signal.aborted) return;
			if (current.kind === "request" && !current.responder.responded) await current.responder.respondWithResult(errorToRequestResult(error, current.responder.signal));
			else {
				const response = errorToResult(error);
				if ("error" in response) console.error("Error handling notification", message.raw, response.error);
			}
		}
	}
	toIncomingMessage(message) {
		if ("id" in message) {
			const abortController = new AbortController();
			this.incomingRequests.set(message.id, abortController);
			const finishRequest = () => {
				if (this.incomingRequests.get(message.id) === abortController) this.incomingRequests.delete(message.id);
			};
			return {
				kind: "request",
				method: message.method,
				params: message.params,
				raw: message,
				signal: abortController.signal,
				responder: new RequestResponder(message.id, (result) => this.sendMessage({
					jsonrpc: "2.0",
					id: message.id,
					...result
				}), abortController.signal, finishRequest)
			};
		}
		return {
			kind: "notification",
			method: message.method,
			params: message.params,
			raw: message
		};
	}
	handleResponse(response) {
		const pendingResponse = this.pendingResponses.get(response.id);
		if (pendingResponse) {
			this.pendingResponses.delete(response.id);
			pendingResponse.cleanup?.();
			if ("result" in response) pendingResponse.resolve(response.result);
			else if ("error" in response) {
				const { code, message, data } = response.error;
				pendingResponse.reject(new RequestError(code, message, data));
			} else pendingResponse.reject(RequestError.invalidRequest(response));
		} else console.error("Got response to unknown request", response.id);
	}
	handleProtocolNotification(message) {
		if (message.method !== CANCEL_REQUEST_METHOD) return;
		const requestId = cancelRequestId(message.params);
		if (requestId === void 0) return;
		const controller = this.incomingRequests.get(requestId);
		if (!controller || controller.signal.aborted) return;
		controller.abort(RequestError.requestCancelled({ requestId }));
	}
	closedReason() {
		return this.abortController.signal.reason ?? /* @__PURE__ */ new Error("ACP connection closed");
	}
	async sendMessage(message) {
		if (this.abortController.signal.aborted) return rejectedPromise(this.closedReason());
		this.writeQueue = this.writeQueue.then(async () => {
			if (this.abortController.signal.aborted) throw this.closedReason();
			const writer = this.stream.writable.getWriter();
			try {
				await writer.write(message);
			} finally {
				writer.releaseLock();
			}
		}).catch((error) => {
			this.close(error);
			throw error;
		});
		return this.writeQueue;
	}
};
/**
* Builder for a lower-level handler-based JSON-RPC connection.
*/
var ConnectionBuilder = class {
	handlers = [];
	connectionName;
	/**
	* Sets a diagnostic name used by handlers created from this builder.
	*/
	name(name) {
		this.connectionName = name;
		return this;
	}
	/**
	* Adds a raw JSON-RPC handler to the handler chain.
	*/
	withHandler(handler) {
		this.handlers.push(handler);
		return this;
	}
	/**
	* Adds a handler that can inspect every incoming request or notification.
	*
	* Observer callbacks that return void pass the message through to later
	* handlers. Return `Handled.yes()` to stop dispatch explicitly.
	*/
	onReceiveMessage(handler) {
		return this.withHandler({
			handleMessage: async (message, cx) => await handler(message, cx) ?? Handled.no(message),
			describe: () => this.connectionName ?? "onReceiveMessage"
		});
	}
	/**
	* Adds a typed request handler for one method.
	*/
	onReceiveRequest(method, parse, handler) {
		return this.withHandler({
			handleMessage: async (message, cx) => {
				if (message.kind !== "request" || message.method !== method) return Handled.no(message);
				return await handler(parse(message.params), message.responder, cx) ?? Handled.yes();
			},
			describe: () => `${this.connectionName ?? "request"}:${method}`
		});
	}
	/**
	* Adds a typed notification handler for one method.
	*/
	onReceiveNotification(method, parse, handler) {
		return this.withHandler({
			handleMessage: async (message, cx) => {
				if (message.kind !== "notification" || message.method !== method) return Handled.no(message);
				return await handler(parse(message.params), cx) ?? Handled.yes();
			},
			describe: () => `${this.connectionName ?? "notification"}:${method}`
		});
	}
	/**
	* Connects the configured handlers to a stream.
	*/
	connect(stream, options) {
		return new Connection(stream, this.handlers, options);
	}
	/**
	* Connects to a stream for the lifetime of `op`, then closes the connection.
	*/
	connectWith(stream, op, options) {
		return this.connect(stream, options).runUntil(op);
	}
};
/**
* JSON-RPC error object.
*
* Represents an error that occurred during method execution, following the
* JSON-RPC 2.0 error object specification with optional additional data.
*
* See protocol docs: [JSON-RPC Error Object](https://www.jsonrpc.org/specification#error_object)
*/
var RequestError = class RequestError extends Error {
	code;
	/**
	* Additional JSON-RPC error data.
	*/
	data;
	constructor(code, message, data) {
		super(message);
		this.code = code;
		this.name = "RequestError";
		this.data = data;
	}
	/**
	* Invalid JSON was received by the server. An error occurred on the server while parsing the JSON text.
	*/
	static parseError(data, additionalMessage) {
		return new RequestError(-32700, `Parse error${additionalMessage ? `: ${additionalMessage}` : ""}`, data);
	}
	/**
	* The JSON sent is not a valid Request object.
	*/
	static invalidRequest(data, additionalMessage) {
		return new RequestError(-32600, `Invalid request${additionalMessage ? `: ${additionalMessage}` : ""}`, data);
	}
	/**
	* The method does not exist / is not available.
	*/
	static methodNotFound(method) {
		return new RequestError(-32601, `"Method not found": ${method}`, { method });
	}
	/**
	* Invalid method parameter(s).
	*/
	static invalidParams(data, additionalMessage) {
		return new RequestError(-32602, `Invalid params${additionalMessage ? `: ${additionalMessage}` : ""}`, data);
	}
	/**
	* Internal JSON-RPC error.
	*/
	static internalError(data, additionalMessage) {
		return new RequestError(-32603, `Internal error${additionalMessage ? `: ${additionalMessage}` : ""}`, data);
	}
	/**
	* Execution of the request was aborted.
	*/
	static requestCancelled(data, additionalMessage) {
		return new RequestError(-32800, `Request cancelled${additionalMessage ? `: ${additionalMessage}` : ""}`, data);
	}
	/**
	* Authentication required.
	*/
	static authRequired(data, additionalMessage) {
		return new RequestError(-32e3, `Authentication required${additionalMessage ? `: ${additionalMessage}` : ""}`, data);
	}
	/**
	* Resource, such as a file, was not found
	*/
	static resourceNotFound(uri) {
		return new RequestError(-32002, `Resource not found${uri ? `: ${uri}` : ""}`, uri && { uri });
	}
	/**
	* Converts this error to a JSON-RPC result object.
	*/
	toResult() {
		return { error: {
			code: this.code,
			message: this.message,
			data: this.data
		} };
	}
	/**
	* Converts this error to a JSON-RPC error response payload.
	*/
	toErrorResponse() {
		return {
			code: this.code,
			message: this.message,
			data: this.data
		};
	}
};
//#endregion
//#region node_modules/@agentclientprotocol/sdk/dist/acp.js
function emptyObjectResponse(response) {
	return response ?? {};
}
function isStream(value) {
	return typeof value === "object" && value !== null && "readable" in value && "writable" in value;
}
function memoryStreamPair() {
	const leftToRight = new TransformStream();
	const rightToLeft = new TransformStream();
	return [{
		readable: rightToLeft.readable,
		writable: leftToRight.writable
	}, {
		readable: leftToRight.readable,
		writable: rightToLeft.writable
	}];
}
AGENT_METHODS.initialize, AGENT_METHODS.authenticate, AGENT_METHODS.logout, AGENT_METHODS.providers_list, AGENT_METHODS.providers_set, AGENT_METHODS.providers_disable, AGENT_METHODS.session_new, AGENT_METHODS.session_load, AGENT_METHODS.session_list, AGENT_METHODS.session_delete, AGENT_METHODS.session_fork, AGENT_METHODS.session_resume, AGENT_METHODS.session_close, AGENT_METHODS.session_set_mode, AGENT_METHODS.session_set_config_option, AGENT_METHODS.session_prompt, AGENT_METHODS.session_cancel, AGENT_METHODS.nes_start, AGENT_METHODS.nes_suggest, AGENT_METHODS.nes_accept, AGENT_METHODS.nes_reject, AGENT_METHODS.nes_close, AGENT_METHODS.document_did_open, AGENT_METHODS.document_did_change, AGENT_METHODS.document_did_close, AGENT_METHODS.document_did_save, AGENT_METHODS.document_did_focus, CLIENT_METHODS.session_request_permission, CLIENT_METHODS.session_update, CLIENT_METHODS.fs_write_text_file, CLIENT_METHODS.fs_read_text_file, CLIENT_METHODS.terminal_create, CLIENT_METHODS.terminal_output, CLIENT_METHODS.terminal_release, CLIENT_METHODS.terminal_wait_for_exit, CLIENT_METHODS.terminal_kill, CLIENT_METHODS.elicitation_create, CLIENT_METHODS.elicitation_complete, PROTOCOL_METHODS.cancel_request;
var startActiveSession = Symbol("startActiveSession");
var AcpContext = class {
	cx;
	currentRequestId;
	/** @internal */
	constructor(cx, currentRequestId) {
		this.cx = cx;
		this.currentRequestId = currentRequestId;
	}
	/**
	* JSON-RPC id of the request currently being handled.
	*
	* This is `undefined` for notification handlers and for contexts created
	* outside an inbound request, such as `connect(...)` and `connectWith(...)`.
	*/
	get requestId() {
		return this.currentRequestId;
	}
	/** @internal */
	get connectionContext() {
		return this.cx;
	}
	/** @internal */
	sendRequest(method, params, mapResponse, options) {
		return this.cx.sendRequest(method, params, mapResponse, options);
	}
	/** @internal */
	sendNotification(method, params) {
		return this.cx.sendNotification(method, params);
	}
	/** @internal */
	addDynamicHandler(handler) {
		return this.cx.addDynamicHandler(handler);
	}
};
/**
* Context passed to agent-side handlers.
*
* Agents use this context to call client-side ACP methods while handling
* requests such as `session/prompt`.
*/
var AgentContext = class AgentContext extends AcpContext {
	constructor(cx, requestId) {
		super(cx, requestId);
	}
	/** @internal */
	static create(cx, requestId) {
		return new AgentContext(cx, requestId);
	}
	request(method, params, options) {
		const spec = clientRequestSpecsByMethod[method];
		return this.sendRequest(method, params, spec?.mapResponse, options);
	}
	notify(method, params) {
		return this.sendNotification(method, params);
	}
};
/**
* Context used by clients to call agent-side ACP methods.
*
* `connectWith` passes a `ClientContext` to the callback. Client handlers also
* receive one as `ctx.agent` when they need to call back into the agent.
*/
var ClientContext = class ClientContext extends AcpContext {
	constructor(cx, requestId) {
		super(cx, requestId);
	}
	/** @internal */
	static create(cx, requestId) {
		return new ClientContext(cx, requestId);
	}
	/** @internal */
	[startActiveSession](params, options) {
		return this.sendRequest(AGENT_METHODS.session_new, params, (response) => this.attachSession(response), options);
	}
	buildSession(cwdOrRequest) {
		if (typeof cwdOrRequest === "string") return SessionBuilder.create(this, {
			cwd: cwdOrRequest,
			mcpServers: []
		});
		return SessionBuilder.create(this, cwdOrRequest);
	}
	/**
	* Builds active-session helpers around a `session/new` response.
	*/
	attachSession(response) {
		const updates = new AsyncQueue();
		const closeSignal = this.connectionContext.signal;
		const failUpdatesOnClose = () => {
			updates.fail(closeSignal.reason ?? /* @__PURE__ */ new Error("ACP connection closed"));
		};
		if (closeSignal.aborted) failUpdatesOnClose();
		else closeSignal.addEventListener("abort", failUpdatesOnClose);
		const sessionRegistration = sessionUpdateRouter(this.connectionContext).attach(response, updates);
		const closeRegistration = new HandlerRegistration(() => {
			closeSignal.removeEventListener("abort", failUpdatesOnClose);
		});
		return ActiveSession.create(this, response, updates, [sessionRegistration, closeRegistration]);
	}
	request(method, params, options) {
		const spec = agentRequestSpecsByMethod[method];
		return this.sendRequest(method, params, spec?.mapResponse, options);
	}
	notify(method, params) {
		return this.sendNotification(method, params);
	}
};
var AcpConnectionHandle = class {
	connection;
	constructor(connection) {
		this.connection = connection;
	}
	get signal() {
		return this.connection.signal;
	}
	get closed() {
		return this.connection.closed;
	}
	close(error) {
		this.connection.close(error);
	}
};
var AgentConnectionHandle = class extends AcpConnectionHandle {
	connectHandlers;
	client;
	didStartConnectHandlers = false;
	constructor(connection, connectHandlers = []) {
		super(connection);
		this.connectHandlers = connectHandlers;
		this.client = AgentContext.create(connection.getContext());
	}
	/** @internal */
	startConnectHandlers() {
		if (this.didStartConnectHandlers) return;
		this.didStartConnectHandlers = true;
		runConnectHandlers(this, this.connectHandlers);
	}
};
var ClientConnectionHandle = class extends AcpConnectionHandle {
	connectHandlers;
	agent;
	didStartConnectHandlers = false;
	constructor(connection, connectHandlers = []) {
		super(connection);
		this.connectHandlers = connectHandlers;
		this.agent = ClientContext.create(connection.getContext());
	}
	/** @internal */
	startConnectHandlers() {
		if (this.didStartConnectHandlers) return;
		this.didStartConnectHandlers = true;
		runConnectHandlers(this, this.connectHandlers);
	}
};
function agentConnection(connection, connectHandlers = []) {
	return new AgentConnectionHandle(connection, connectHandlers);
}
function clientConnection(connection, connectHandlers = []) {
	return new ClientConnectionHandle(connection, connectHandlers);
}
var AsyncQueue = class {
	values = [];
	waiters = [];
	failed = false;
	failure;
	enqueue(value) {
		if (this.failed) return;
		const waiter = this.waiters.shift();
		if (waiter) waiter.resolve(value);
		else this.values.push({
			kind: "value",
			value
		});
	}
	reject(error) {
		if (this.failed) return;
		if (this.waiters.length > 0) {
			for (const waiter of this.waiters.splice(0)) waiter.reject(error);
			return;
		}
		this.values.push({
			kind: "error",
			error
		});
	}
	clearErrors() {
		this.values = this.values.filter((entry) => entry.kind === "value");
	}
	fail(error) {
		if (this.failed) return;
		this.failed = true;
		this.failure = error;
		for (const waiter of this.waiters.splice(0)) waiter.reject(error);
	}
	next() {
		if (this.values.length > 0) {
			const entry = this.values.shift();
			if (entry.kind === "error") return Promise.reject(entry.error);
			return Promise.resolve(entry.value);
		}
		if (this.failed) return Promise.reject(this.failure);
		return new Promise((resolve, reject) => {
			this.waiters.push({
				resolve,
				reject
			});
		});
	}
};
function cloneNewSessionRequest(request) {
	return {
		...request,
		additionalDirectories: request.additionalDirectories ? [...request.additionalDirectories] : void 0,
		mcpServers: [...request.mcpServers]
	};
}
/**
* Builder for creating an `ActiveSession`.
*
* Start from `ctx.buildSession("/absolute/cwd")` for the common case, or
* pass a full `NewSessionRequest` to `ctx.buildSession(...)` when the session
* needs MCP servers, `_meta`, or additional request fields. All paths in ACP
* payloads should be absolute.
*/
var SessionBuilder = class SessionBuilder {
	cx;
	request;
	constructor(cx, request) {
		this.cx = cx;
		this.request = cloneNewSessionRequest(request);
	}
	/** @internal */
	static create(cx, request) {
		return new SessionBuilder(cx, request);
	}
	/**
	* Returns the `session/new` request that will be sent.
	*
	* The returned object is a defensive copy, so mutating it does not change the
	* builder.
	*/
	toRequest() {
		return cloneNewSessionRequest(this.request);
	}
	/**
	* Replaces the additional workspace roots for this session.
	*
	* `additionalDirectories` expand the session's file-system scope without
	* changing `cwd`. Each path should be absolute.
	*/
	withAdditionalDirectories(additionalDirectories) {
		this.request = {
			...this.request,
			additionalDirectories: [...additionalDirectories]
		};
		return this;
	}
	/**
	* Adds one MCP server to the `session/new` request.
	*/
	withMcpServer(mcpServer) {
		this.request = {
			...this.request,
			mcpServers: [...this.request.mcpServers, mcpServer]
		};
		return this;
	}
	/**
	* Starts the session and returns an `ActiveSession` for prompting and reading
	* updates.
	*
	* Call `dispose()` on the returned session when you no longer need update
	* routing, or use `withSession(...)` to scope disposal automatically.
	*/
	async start(options) {
		return this.cx[startActiveSession](this.toRequest(), options);
	}
	/**
	* Starts the session, runs `op`, and disposes the active-session update
	* routing when `op` finishes or throws.
	*/
	async withSession(op) {
		const session = await this.start();
		try {
			return await op(session);
		} finally {
			session.dispose();
		}
	}
};
/**
* Convenience wrapper for an active ACP session.
*
* An active session routes `session/update` notifications for one session ID
* into an async queue. Use `prompt(...)` to send user content, then read updates
* with `nextUpdate()` until a `stop` message is returned.
*/
var ActiveSession = class ActiveSession {
	cx;
	sessionResponse;
	updates;
	registrations;
	constructor(cx, sessionResponse, updates, registrations) {
		this.cx = cx;
		this.sessionResponse = sessionResponse;
		this.updates = updates;
		this.registrations = registrations;
	}
	/** @internal */
	static create(cx, sessionResponse, updates, registrations) {
		return new ActiveSession(cx, sessionResponse, updates, registrations);
	}
	/**
	* Session ID returned by `session/new`.
	*/
	get sessionId() {
		return this.sessionResponse.sessionId;
	}
	/**
	* Mode state returned when the session was created, if the agent provided it.
	*/
	get modes() {
		return this.sessionResponse.modes;
	}
	/**
	* Metadata returned when the session was created.
	*/
	get meta() {
		return this.sessionResponse._meta;
	}
	/**
	* Full response returned by `session/new`.
	*/
	get newSessionResponse() {
		return this.sessionResponse;
	}
	/**
	* Sends a prompt to this session.
	*
	* Strings are converted to one text content block. A single content block is
	* wrapped in an array. The returned promise resolves with the final
	* `PromptResponse`, and the same completion is also queued as a `stop`
	* message for `nextUpdate()`.
	*/
	prompt(prompt, options) {
		this.updates.clearErrors();
		const response = this.cx.request(AGENT_METHODS.session_prompt, {
			sessionId: this.sessionId,
			prompt: this.promptBlocks(prompt)
		}, options);
		response.then((value) => {
			this.updates.enqueue({
				kind: "stop",
				response: value,
				stopReason: value.stopReason
			});
		}, (error) => {
			this.updates.reject(error);
		});
		return response;
	}
	/**
	* Reads the next update or stop message for this session.
	*/
	nextUpdate() {
		return this.updates.next();
	}
	/**
	* Reads text chunks until the current prompt turn stops.
	*
	* Only `agent_message_chunk` updates with text content are appended. Other
	* update types are ignored by this helper; use `nextUpdate()` when you need
	* tool calls, plans, or the final `PromptResponse`.
	*/
	async readText() {
		let output = "";
		for (;;) {
			const message = await this.nextUpdate();
			if (message.kind === "stop") return output;
			const { update } = message;
			if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") output += update.content.text;
		}
	}
	/**
	* Stops routing updates to this active-session helper.
	*
	* This does not close the ACP session on the agent. Use `ClientContext`
	* session lifecycle methods when the protocol session itself should be closed
	* or deleted.
	*/
	dispose() {
		for (const registration of this.registrations.splice(0)) registration.dispose();
		this.updates.fail(/* @__PURE__ */ new Error("Active session disposed"));
	}
	/**
	* Supports explicit resource management with `using`.
	*/
	[Symbol.dispose]() {
		this.dispose();
	}
	promptBlocks(prompt) {
		if (typeof prompt === "string") return [{
			type: "text",
			text: prompt
		}];
		if (Array.isArray(prompt)) return prompt;
		return [prompt];
	}
};
function parseParams(parser, params) {
	if (!parser) return params;
	if (typeof parser === "function") return parser(params);
	return parser.parse(params);
}
function requestSpec(method, params, mapResponse) {
	return {
		method,
		params,
		mapResponse
	};
}
function notificationSpec(method, params) {
	return {
		method,
		params
	};
}
function registerAppRequest(builder, spec, context, handler) {
	builder.onReceiveRequest(spec.method, (params) => parseParams(spec.params, params), async (params, responder, cx) => {
		const response = await handler(context(params, cx, responder.signal, responder.id));
		await responder.respond(spec.mapResponse ? spec.mapResponse(response) : response);
	});
}
function registerAppNotification(builder, spec, context, handler) {
	builder.onReceiveNotification(spec.method, (params) => parseParams(spec.params, params), (params, cx) => handler(context(params, cx, cx.signal)));
}
function specsByMethod(specs) {
	const byMethod = {};
	for (const spec of Object.values(specs)) byMethod[spec.method] = spec;
	return byMethod;
}
var agentRequestSpecs = {
	initialize: requestSpec(AGENT_METHODS.initialize, zInitializeRequest),
	newSession: requestSpec(AGENT_METHODS.session_new, zNewSessionRequest),
	loadSession: requestSpec(AGENT_METHODS.session_load, zLoadSessionRequest, emptyObjectResponse),
	unstable_forkSession: requestSpec(AGENT_METHODS.session_fork, zForkSessionRequest),
	listSessions: requestSpec(AGENT_METHODS.session_list, zListSessionsRequest),
	deleteSession: requestSpec(AGENT_METHODS.session_delete, zDeleteSessionRequest, emptyObjectResponse),
	resumeSession: requestSpec(AGENT_METHODS.session_resume, zResumeSessionRequest),
	closeSession: requestSpec(AGENT_METHODS.session_close, zCloseSessionRequest, emptyObjectResponse),
	setSessionMode: requestSpec(AGENT_METHODS.session_set_mode, zSetSessionModeRequest, emptyObjectResponse),
	setSessionConfigOption: requestSpec(AGENT_METHODS.session_set_config_option, zSetSessionConfigOptionRequest),
	authenticate: requestSpec(AGENT_METHODS.authenticate, zAuthenticateRequest, emptyObjectResponse),
	unstable_listProviders: requestSpec(AGENT_METHODS.providers_list, zListProvidersRequest),
	unstable_setProvider: requestSpec(AGENT_METHODS.providers_set, zSetProviderRequest, emptyObjectResponse),
	unstable_disableProvider: requestSpec(AGENT_METHODS.providers_disable, zDisableProviderRequest, emptyObjectResponse),
	logout: requestSpec(AGENT_METHODS.logout, zLogoutRequest, emptyObjectResponse),
	prompt: requestSpec(AGENT_METHODS.session_prompt, zPromptRequest),
	unstable_startNes: requestSpec(AGENT_METHODS.nes_start, zStartNesRequest),
	unstable_suggestNes: requestSpec(AGENT_METHODS.nes_suggest, zSuggestNesRequest),
	unstable_closeNes: requestSpec(AGENT_METHODS.nes_close, zCloseNesRequest, emptyObjectResponse)
};
var agentNotificationSpecs = {
	cancel: notificationSpec(AGENT_METHODS.session_cancel, zCancelNotification),
	unstable_didOpenDocument: notificationSpec(AGENT_METHODS.document_did_open, zDidOpenDocumentNotification),
	unstable_didChangeDocument: notificationSpec(AGENT_METHODS.document_did_change, zDidChangeDocumentNotification),
	unstable_didCloseDocument: notificationSpec(AGENT_METHODS.document_did_close, zDidCloseDocumentNotification),
	unstable_didSaveDocument: notificationSpec(AGENT_METHODS.document_did_save, zDidSaveDocumentNotification),
	unstable_didFocusDocument: notificationSpec(AGENT_METHODS.document_did_focus, zDidFocusDocumentNotification),
	unstable_acceptNes: notificationSpec(AGENT_METHODS.nes_accept, zAcceptNesNotification),
	unstable_rejectNes: notificationSpec(AGENT_METHODS.nes_reject, zRejectNesNotification)
};
var clientRequestSpecs = {
	requestPermission: requestSpec(CLIENT_METHODS.session_request_permission, zRequestPermissionRequest),
	writeTextFile: requestSpec(CLIENT_METHODS.fs_write_text_file, zWriteTextFileRequest, emptyObjectResponse),
	readTextFile: requestSpec(CLIENT_METHODS.fs_read_text_file, zReadTextFileRequest),
	createTerminal: requestSpec(CLIENT_METHODS.terminal_create, zCreateTerminalRequest),
	terminalOutput: requestSpec(CLIENT_METHODS.terminal_output, zTerminalOutputRequest),
	releaseTerminal: requestSpec(CLIENT_METHODS.terminal_release, zReleaseTerminalRequest, emptyObjectResponse),
	waitForTerminalExit: requestSpec(CLIENT_METHODS.terminal_wait_for_exit, zWaitForTerminalExitRequest),
	killTerminal: requestSpec(CLIENT_METHODS.terminal_kill, zKillTerminalRequest, emptyObjectResponse),
	unstable_createElicitation: requestSpec(CLIENT_METHODS.elicitation_create, zCreateElicitationRequest)
};
var clientNotificationSpecs = {
	sessionUpdate: notificationSpec(CLIENT_METHODS.session_update, zSessionNotification),
	unstable_completeElicitation: notificationSpec(CLIENT_METHODS.elicitation_complete, zCompleteElicitationNotification)
};
var agentRequestSpecsByMethod = specsByMethod(agentRequestSpecs);
specsByMethod(agentNotificationSpecs);
var clientRequestSpecsByMethod = specsByMethod(clientRequestSpecs);
var clientNotificationSpecsByMethod = specsByMethod(clientNotificationSpecs);
function clientRequestContext(params, agent, signal, requestId) {
	return {
		params,
		requestId,
		signal,
		agent
	};
}
function clientNotificationContext(params, agent, signal) {
	return {
		params,
		signal,
		agent
	};
}
var SessionUpdateRouter = class {
	activeSessions = /* @__PURE__ */ new Map();
	handleMessage(message) {
		if (message.kind !== "notification" || message.method !== CLIENT_METHODS.session_update) return Handled.no(message);
		const notification = zSessionNotification.parse(message.params);
		const update = {
			kind: "session_update",
			notification,
			update: notification.update
		};
		const activeSessions = this.activeSessions.get(notification.sessionId);
		if (activeSessions && activeSessions.size > 0) for (const session of activeSessions) session.enqueue(update);
		return Handled.no(message);
	}
	attach(response, updates) {
		const sessions = this.activeSessions.get(response.sessionId) ?? /* @__PURE__ */ new Set();
		sessions.add(updates);
		this.activeSessions.set(response.sessionId, sessions);
		return new HandlerRegistration(() => {
			sessions.delete(updates);
			if (sessions.size === 0) this.activeSessions.delete(response.sessionId);
		});
	}
};
var sessionUpdateRouters = /* @__PURE__ */ new WeakMap();
function sessionUpdateRouter(cx) {
	let router = sessionUpdateRouters.get(cx);
	if (!router) {
		router = new SessionUpdateRouter();
		sessionUpdateRouters.set(cx, router);
	}
	return router;
}
function runConnectHandlers(connection, handlers) {
	for (const handler of handlers) {
		let result;
		try {
			result = handler(connection);
		} catch (error) {
			connection.close(error);
			throw error;
		}
		Promise.resolve(result).catch((error) => {
			connection.close(error);
		});
	}
}
var appBuilder = Symbol("appBuilder");
var runAgentConnectHandlers = Symbol("runAgentConnectHandlers");
var runClientConnectHandlers = Symbol("runClientConnectHandlers");
/**
* Creates a client-side app.
*
* Register request and notification handlers by ACP method name, then use
* `connectWith(...)` to run the workflow that calls agent-side methods.
*/
function client(options) {
	return new ClientApp(options);
}
/**
* Client-side app builder.
*
* Methods on this class register typed client handlers and return `this`, so
* apps can be built with a fluent chain. `connectWith(...)` is the usual entry
* point for clients because it provides a `ClientContext` for calling
* agent-side requests and session helpers.
*/
var ClientApp = class {
	builder = Connection.builder();
	connectHandlers = [];
	constructor(options = {}) {
		if (options.name) this.builder.name(options.name);
		this.builder.withHandler({
			handleMessage: (message, cx) => sessionUpdateRouter(cx).handleMessage(message),
			describe: () => "client-session-update-router"
		});
	}
	/** @internal */
	[appBuilder]() {
		return this.builder;
	}
	/** @internal */
	[runClientConnectHandlers](connection) {
		runConnectHandlers(connection, this.connectHandlers);
	}
	connect(target) {
		return this.connectConnection(target).connection;
	}
	connectWith(target, op) {
		const { rawConnection, connection } = this.connectConnection(target);
		return rawConnection.runUntil(() => op(connection.agent));
	}
	/**
	* Registers a handler that runs when this client app opens a connection.
	*
	* Use this for connection-scoped work that needs to call agent-side ACP
	* methods outside an inbound request handler.
	*/
	onConnect(handler) {
		this.connectHandlers.push(handler);
		return this;
	}
	onRequest(method, handlerOrParams, handler) {
		if (handler) return this.request({
			method,
			params: handlerOrParams
		}, handler);
		const spec = clientRequestSpecsByMethod[method];
		if (!spec) throw new Error(`Unknown ACP request method '${method}'. Pass a params parser for custom methods.`);
		return this.request(spec, handlerOrParams);
	}
	onNotification(method, handlerOrParams, handler) {
		if (handler) return this.notification({
			method,
			params: handlerOrParams
		}, handler);
		const spec = clientNotificationSpecsByMethod[method];
		if (!spec) throw new Error(`Unknown ACP notification method '${method}'. Pass a params parser for custom methods.`);
		return this.notification(spec, handlerOrParams);
	}
	request(spec, handler) {
		registerAppRequest(this.builder, spec, (params, cx, signal, requestId) => clientRequestContext(params, ClientContext.create(cx, requestId), signal, requestId), handler);
		return this;
	}
	notification(spec, handler) {
		registerAppNotification(this.builder, spec, (params, cx, signal) => clientNotificationContext(params, ClientContext.create(cx), signal), handler);
		return this;
	}
	connectConnection(target) {
		if (isStream(target)) {
			const state = this.openStreamConnection(target);
			this[runClientConnectHandlers](state.connection);
			return state;
		}
		const [thisStream, peerStream] = memoryStreamPair();
		const peerRawConnection = target[appBuilder]().connect(peerStream);
		const peerConnection = agentConnection(peerRawConnection);
		const state = this.openStreamConnection(thisStream);
		state.rawConnection.closed.then(() => peerConnection.close());
		peerRawConnection.closed.then(() => state.connection.close());
		try {
			target[runAgentConnectHandlers](peerConnection);
			this[runClientConnectHandlers](state.connection);
		} catch (error) {
			peerConnection.close(error);
			state.connection.close(error);
			throw error;
		}
		return state;
	}
	openStreamConnection(stream) {
		const rawConnection = this.builder.connect(stream);
		return {
			rawConnection,
			connection: clientConnection(rawConnection, this.connectHandlers)
		};
	}
};
AGENT_METHODS.initialize, AGENT_METHODS.authenticate, AGENT_METHODS.providers_list, AGENT_METHODS.providers_set, AGENT_METHODS.providers_disable, AGENT_METHODS.session_new, AGENT_METHODS.session_load, AGENT_METHODS.session_set_mode, AGENT_METHODS.session_set_config_option, AGENT_METHODS.session_prompt, AGENT_METHODS.session_list, AGENT_METHODS.session_delete, AGENT_METHODS.session_fork, AGENT_METHODS.session_resume, AGENT_METHODS.session_close, AGENT_METHODS.logout, AGENT_METHODS.nes_start, AGENT_METHODS.nes_suggest, AGENT_METHODS.nes_close;
AGENT_METHODS.session_cancel, AGENT_METHODS.nes_accept, AGENT_METHODS.nes_reject, AGENT_METHODS.document_did_open, AGENT_METHODS.document_did_change, AGENT_METHODS.document_did_close, AGENT_METHODS.document_did_save, AGENT_METHODS.document_did_focus;
var legacyClientRequestMethods = /* @__PURE__ */ new Set([
	CLIENT_METHODS.session_request_permission,
	CLIENT_METHODS.fs_write_text_file,
	CLIENT_METHODS.fs_read_text_file,
	CLIENT_METHODS.terminal_create,
	CLIENT_METHODS.terminal_output,
	CLIENT_METHODS.terminal_release,
	CLIENT_METHODS.terminal_wait_for_exit,
	CLIENT_METHODS.terminal_kill,
	CLIENT_METHODS.elicitation_create
]);
var legacyClientNotificationMethods = /* @__PURE__ */ new Set([CLIENT_METHODS.session_update, CLIENT_METHODS.elicitation_complete]);
function legacyClientApp(implementation) {
	const app = client().onRequest(CLIENT_METHODS.session_request_permission, (ctx) => implementation.requestPermission(ctx.params)).onNotification(CLIENT_METHODS.session_update, (ctx) => implementation.sessionUpdate(ctx.params)).onRequest(CLIENT_METHODS.fs_write_text_file, async (ctx) => await implementation.writeTextFile?.(ctx.params) ?? {}).onRequest(CLIENT_METHODS.fs_read_text_file, async (ctx) => await implementation.readTextFile?.(ctx.params)).onRequest(CLIENT_METHODS.terminal_create, async (ctx) => await implementation.createTerminal?.(ctx.params)).onRequest(CLIENT_METHODS.terminal_output, async (ctx) => await implementation.terminalOutput?.(ctx.params)).onRequest(CLIENT_METHODS.terminal_release, async (ctx) => await implementation.releaseTerminal?.(ctx.params) ?? {}).onRequest(CLIENT_METHODS.terminal_wait_for_exit, async (ctx) => await implementation.waitForTerminalExit?.(ctx.params)).onRequest(CLIENT_METHODS.terminal_kill, async (ctx) => await implementation.killTerminal?.(ctx.params) ?? {});
	if (implementation.unstable_createElicitation) app.onRequest(CLIENT_METHODS.elicitation_create, (ctx) => implementation.unstable_createElicitation(ctx.params));
	if (implementation.unstable_completeElicitation) app.onNotification(CLIENT_METHODS.elicitation_complete, (ctx) => implementation.unstable_completeElicitation(ctx.params));
	if (implementation.extMethod) app[appBuilder]().withHandler({
		handleMessage: async (message) => {
			if (message.kind !== "request" || legacyClientRequestMethods.has(message.method)) return Handled.no(message);
			await message.responder.respond(await implementation.extMethod(message.method, message.params));
			return Handled.yes();
		},
		describe: () => "legacy-client-extension-request"
	});
	if (implementation.extNotification) app[appBuilder]().withHandler({
		handleMessage: async (message) => {
			if (message.kind !== "notification" || legacyClientNotificationMethods.has(message.method)) return Handled.no(message);
			await implementation.extNotification(message.method, message.params);
			return Handled.yes();
		},
		describe: () => "legacy-client-extension-notification"
	});
	return app;
}
/**
* A client-side connection to an agent.
*
* This class provides the client's view of an ACP connection, allowing
* clients (such as code editors) to communicate with agents. It implements
* the {@link Agent} interface to provide methods for initializing sessions, sending
* prompts, and managing the agent lifecycle.
*
* See protocol docs: [Client](https://agentclientprotocol.com/protocol/overview#client)
*
* @deprecated Prefer {@link client}, which registers typed handlers with a
* single context object and supports `connectWith` and session helpers.
*/
var ClientSideConnection = class {
	connection;
	/**
	* Creates a new client-side connection to an agent.
	*
	* This establishes the communication channel between a client and agent
	* following the ACP specification.
	*
	* @param toClient - A function that creates a Client handler to process incoming agent requests
	* @param stream - The bidirectional message stream for communication. Typically created using
	*                 {@link ndJsonStream} for stdio-based connections.
	*
	* See protocol docs: [Communication Model](https://agentclientprotocol.com/protocol/overview#communication-model)
	*
	* @deprecated Prefer `client({ name }).connectWith(stream, async (ctx) => ...)`.
	*/
	constructor(toClient, stream) {
		this.connection = legacyClientApp(toClient(this))[appBuilder]().connect(stream);
	}
	/**
	* Establishes the connection with a client and negotiates protocol capabilities.
	*
	* This method is called once at the beginning of the connection to:
	* - Negotiate the protocol version to use
	* - Exchange capability information between client and agent
	* - Determine available authentication methods
	*
	* The agent should respond with its supported protocol version and capabilities.
	*
	* See protocol docs: [Initialization](https://agentclientprotocol.com/protocol/initialization)
	*/
	initialize(params) {
		return this.connection.sendRequest(AGENT_METHODS.initialize, params);
	}
	/**
	* Creates a new conversation session with the agent.
	*
	* Sessions represent independent conversation contexts with their own history and state.
	*
	* The agent should:
	* - Create a new session context
	* - Connect to any specified MCP servers
	* - Return a unique session ID for future requests
	*
	* The request may include `additionalDirectories` to expand the session's filesystem
	* scope beyond `cwd` without changing the base for relative paths.
	*
	* May return an `auth_required` error if the agent requires authentication.
	*
	* See protocol docs: [Session Setup](https://agentclientprotocol.com/protocol/session-setup)
	*/
	newSession(params) {
		return this.connection.sendRequest(AGENT_METHODS.session_new, params);
	}
	/**
	* Loads an existing session to resume a previous conversation.
	*
	* This method is only available if the agent advertises the `loadSession` capability.
	*
	* The agent should:
	* - Restore the session context and conversation history
	* - Connect to the specified MCP servers
	* - Stream the entire conversation history back to the client via notifications
	*
	* The request may include `additionalDirectories` to set the complete list of
	* additional workspace roots for the loaded session.
	*
	* See protocol docs: [Loading Sessions](https://agentclientprotocol.com/protocol/session-setup#loading-sessions)
	*/
	loadSession(params) {
		return this.connection.sendRequest(AGENT_METHODS.session_load, params, emptyObjectResponse);
	}
	/**
	* **UNSTABLE**
	*
	* This capability is not part of the spec yet, and may be removed or changed at any point.
	*
	* Forks an existing session to create a new independent session.
	*
	* Creates a new session based on the context of an existing one, allowing
	* operations like generating summaries without affecting the original session's history.
	*
	* The request may include `additionalDirectories` to set the complete list of
	* additional workspace roots for the forked session.
	*
	* This method is only available if the agent advertises the `session.fork` capability.
	*
	* @experimental
	*/
	unstable_forkSession(params) {
		return this.connection.sendRequest(AGENT_METHODS.session_fork, params);
	}
	/**
	* Lists existing sessions from the agent.
	*
	* This method is only available if the agent advertises the `listSessions` capability.
	*
	* Returns a list of sessions with metadata like session ID, working directory,
	* title, and last update time. Supports filtering by working directory,
	* `additionalDirectories`, and cursor-based pagination.
	*/
	listSessions(params) {
		return this.connection.sendRequest(AGENT_METHODS.session_list, params);
	}
	/**
	* Deletes an existing session returned by `session/list`.
	*
	* This method is only available if the agent advertises the `sessionCapabilities.delete` capability.
	*/
	deleteSession(params) {
		return this.connection.sendRequest(AGENT_METHODS.session_delete, params, emptyObjectResponse);
	}
	/**
	* Resumes an existing session without returning previous messages.
	*
	* This method is only available if the agent advertises the `session.resume` capability.
	*
	* The agent should resume the session context, allowing the conversation to continue
	* without replaying the message history (unlike `session/load`).
	*
	* The request may include `additionalDirectories` to set the complete list of
	* additional workspace roots for the resumed session.
	*/
	resumeSession(params) {
		return this.connection.sendRequest(AGENT_METHODS.session_resume, params);
	}
	/**
	* Closes an active session and frees up any resources associated with it.
	*
	* This method is only available if the agent advertises the `session.close` capability.
	*
	* The agent must cancel any ongoing work (as if `session/cancel` was called)
	* and then free up any resources associated with the session.
	*/
	closeSession(params) {
		return this.connection.sendRequest(AGENT_METHODS.session_close, params, emptyObjectResponse);
	}
	/**
	* Sets the operational mode for a session.
	*
	* Allows switching between different agent modes (e.g., "ask", "architect", "code")
	* that affect system prompts, tool availability, and permission behaviors.
	*
	* The mode must be one of the modes advertised in `availableModes` during session
	* creation or loading. Agents may also change modes autonomously and notify the
	* client via `current_mode_update` notifications.
	*
	* This method can be called at any time during a session, whether the Agent is
	* idle or actively generating a turn.
	*
	* See protocol docs: [Session Modes](https://agentclientprotocol.com/protocol/session-modes)
	*/
	setSessionMode(params) {
		return this.connection.sendRequest(AGENT_METHODS.session_set_mode, params, emptyObjectResponse);
	}
	/**
	* Set a configuration option for a given session.
	*
	* The response contains the full set of configuration options and their current values,
	* as changing one option may affect the available values or state of other options.
	*/
	setSessionConfigOption(params) {
		return this.connection.sendRequest(AGENT_METHODS.session_set_config_option, params);
	}
	/**
	* Authenticates the client using the specified authentication method.
	*
	* Called when the agent requires authentication before allowing session creation.
	* The client provides the authentication method ID that was advertised during initialization.
	*
	* After successful authentication, the client can proceed to create sessions with
	* `newSession` without receiving an `auth_required` error.
	*
	* See protocol docs: [Initialization](https://agentclientprotocol.com/protocol/initialization)
	*/
	authenticate(params) {
		return this.connection.sendRequest(AGENT_METHODS.authenticate, params, emptyObjectResponse);
	}
	/**
	* **UNSTABLE**
	*
	* This capability is not part of the spec yet, and may be removed or changed at any point.
	*
	* Lists providers that can be configured by the client.
	*
	* This method is only available if the agent advertises the `providers` capability.
	*
	* @experimental
	*/
	unstable_listProviders(params) {
		return this.connection.sendRequest(AGENT_METHODS.providers_list, params);
	}
	/**
	* **UNSTABLE**
	*
	* This capability is not part of the spec yet, and may be removed or changed at any point.
	*
	* Replaces the configuration for a provider.
	*
	* This method is only available if the agent advertises the `providers` capability.
	*
	* @experimental
	*/
	unstable_setProvider(params) {
		return this.connection.sendRequest(AGENT_METHODS.providers_set, params, emptyObjectResponse);
	}
	/**
	* **UNSTABLE**
	*
	* This capability is not part of the spec yet, and may be removed or changed at any point.
	*
	* Disables a provider.
	*
	* This method is only available if the agent advertises the `providers` capability.
	*
	* @experimental
	*/
	unstable_disableProvider(params) {
		return this.connection.sendRequest(AGENT_METHODS.providers_disable, params, emptyObjectResponse);
	}
	/**
	* Logout of the current authentication method.
	*/
	logout(params) {
		return this.connection.sendRequest(AGENT_METHODS.logout, params, emptyObjectResponse);
	}
	/**
	* Processes a user prompt within a session.
	*
	* This method handles the whole lifecycle of a prompt:
	* - Receives user messages with optional context (files, images, etc.)
	* - Processes the prompt using language models
	* - Reports language model content and tool calls to the Clients
	* - Requests permission to run tools
	* - Executes any requested tool calls
	* - Returns when the turn is complete with a stop reason
	*
	* See protocol docs: [Prompt Turn](https://agentclientprotocol.com/protocol/prompt-turn)
	*/
	prompt(params) {
		return this.connection.sendRequest(AGENT_METHODS.session_prompt, params);
	}
	/**
	* Cancels ongoing operations for a session.
	*
	* This is a notification sent by the client to cancel an ongoing prompt turn.
	*
	* Upon receiving this notification, the Agent SHOULD:
	* - Stop all language model requests as soon as possible
	* - Abort all tool call invocations in progress
	* - Send any pending `session/update` notifications
	* - Respond to the original `session/prompt` request with `StopReason::Cancelled`
	*
	* See protocol docs: [Cancellation](https://agentclientprotocol.com/protocol/prompt-turn#cancellation)
	*/
	cancel(params) {
		return this.connection.sendNotification(AGENT_METHODS.session_cancel, params);
	}
	/**
	* **UNSTABLE**: This capability is not part of the spec yet, and may be removed or changed at any point.
	*
	* Starts a NES (Next Edit Suggestions) session.
	*
	* @experimental
	*/
	unstable_startNes(params) {
		return this.connection.sendRequest(AGENT_METHODS.nes_start, params);
	}
	/**
	* **UNSTABLE**: This capability is not part of the spec yet, and may be removed or changed at any point.
	*
	* Sends a NES suggestion request.
	*
	* @experimental
	*/
	unstable_suggestNes(params) {
		return this.connection.sendRequest(AGENT_METHODS.nes_suggest, params);
	}
	/**
	* **UNSTABLE**: This capability is not part of the spec yet, and may be removed or changed at any point.
	*
	* Closes a NES session.
	*
	* @experimental
	*/
	unstable_closeNes(params) {
		return this.connection.sendRequest(AGENT_METHODS.nes_close, params, emptyObjectResponse);
	}
	/**
	* **UNSTABLE**: This capability is not part of the spec yet, and may be removed or changed at any point.
	*
	* Notifies the agent that a document was opened.
	*
	* @experimental
	*/
	unstable_didOpenDocument(params) {
		return this.connection.sendNotification(AGENT_METHODS.document_did_open, params);
	}
	/**
	* **UNSTABLE**: This capability is not part of the spec yet, and may be removed or changed at any point.
	*
	* Notifies the agent that a document was changed.
	*
	* @experimental
	*/
	unstable_didChangeDocument(params) {
		return this.connection.sendNotification(AGENT_METHODS.document_did_change, params);
	}
	/**
	* **UNSTABLE**: This capability is not part of the spec yet, and may be removed or changed at any point.
	*
	* Notifies the agent that a document was closed.
	*
	* @experimental
	*/
	unstable_didCloseDocument(params) {
		return this.connection.sendNotification(AGENT_METHODS.document_did_close, params);
	}
	/**
	* **UNSTABLE**: This capability is not part of the spec yet, and may be removed or changed at any point.
	*
	* Notifies the agent that a document was saved.
	*
	* @experimental
	*/
	unstable_didSaveDocument(params) {
		return this.connection.sendNotification(AGENT_METHODS.document_did_save, params);
	}
	/**
	* **UNSTABLE**: This capability is not part of the spec yet, and may be removed or changed at any point.
	*
	* Notifies the agent that a document received focus.
	*
	* @experimental
	*/
	unstable_didFocusDocument(params) {
		return this.connection.sendNotification(AGENT_METHODS.document_did_focus, params);
	}
	/**
	* **UNSTABLE**: This capability is not part of the spec yet, and may be removed or changed at any point.
	*
	* Notifies the agent that a NES suggestion was accepted.
	*
	* @experimental
	*/
	unstable_acceptNes(params) {
		return this.connection.sendNotification(AGENT_METHODS.nes_accept, params);
	}
	/**
	* **UNSTABLE**: This capability is not part of the spec yet, and may be removed or changed at any point.
	*
	* Notifies the agent that a NES suggestion was rejected.
	*
	* @experimental
	*/
	unstable_rejectNes(params) {
		return this.connection.sendNotification(AGENT_METHODS.nes_reject, params);
	}
	request(method, params, options) {
		const spec = agentRequestSpecsByMethod[method];
		return this.connection.sendRequest(method, params, spec?.mapResponse, options);
	}
	notify(method, params) {
		return this.connection.sendNotification(method, params);
	}
	/**
	* Extension method.
	*
	* @deprecated Use {@link request}.
	*/
	extMethod(method, params) {
		return this.request(method, params);
	}
	/**
	* Extension notification.
	*
	* @deprecated Use {@link notify}.
	*/
	extNotification(method, params) {
		return this.notify(method, params);
	}
	/**
	* AbortSignal that aborts when the connection closes.
	*
	* This signal can be used to:
	* - Listen for connection closure: `connection.signal.addEventListener('abort', () => {...})`
	* - Check connection status synchronously: `if (connection.signal.aborted) {...}`
	* - Pass to other APIs (fetch, setTimeout) for automatic cancellation
	*
	* The connection closes when the underlying stream ends, either normally or due to an error.
	*
	* @example
	* ```typescript
	* const connection = new ClientSideConnection(client, stream);
	*
	* // Listen for closure
	* connection.signal.addEventListener('abort', () => {
	*   console.log('Connection closed - performing cleanup');
	* });
	*
	* // Check status
	* if (connection.signal.aborted) {
	*   console.log('Connection is already closed');
	* }
	*
	* // Pass to other APIs
	* fetch(url, { signal: connection.signal });
	* ```
	*/
	get signal() {
		return this.connection.signal;
	}
	/**
	* Promise that resolves when the connection closes.
	*
	* The connection closes when the underlying stream ends, either normally or due to an error.
	* Once closed, the connection cannot send or receive any more messages.
	*
	* This is useful for async/await style cleanup:
	*
	* @example
	* ```typescript
	* const connection = new ClientSideConnection(client, stream);
	* await connection.closed;
	* console.log('Connection closed - performing cleanup');
	* ```
	*/
	get closed() {
		return this.connection.closed;
	}
};
//#endregion
//#region src/main/agentChatAcp.ts
/**
* ACP-backed chat driver. Instead of speaking each CLI's bespoke protocol, this
* talks the Agent Client Protocol (ACP) to an agent adapter subprocess — so the
* same code drives Claude, Codex, etc. via their adapters. It implements the
* {@link AgentDriver} contract, slotting in behind the buffer/persist/replay
* machinery in agentChat.ts.
*
* Each provider maps to an adapter that reuses the user's existing login for that
* tool (no API keys): Claude via `@agentclientprotocol/claude-agent-acp` (drives
* the local `claude` CLI), Codex via `@agentclientprotocol/codex-acp` (bundles
* `@openai/codex`).
*/
var AUGMENTED_PATH$1 = [
	process.env.PATH ?? "",
	`${(0, node_os.homedir)()}/.local/bin`,
	`${(0, node_os.homedir)()}/.claude/local`,
	"/opt/homebrew/bin",
	"/usr/local/bin",
	"/usr/bin",
	"/bin"
].filter(Boolean).join(":");
/** Map our permission modes onto Codex's initial agent mode. */
function codexMode(mode) {
	if (mode === "bypassPermissions") return "agent-full-access";
	if (mode === "plan") return "read-only";
	return "agent";
}
var PROVIDERS = {
	claude: {
		entry: () => require.resolve("@agentclientprotocol/claude-agent-acp/dist/index.js"),
		env: (opts) => {
			const env = {};
			if (opts.model) env.ANTHROPIC_MODEL = opts.model;
			return env;
		}
	},
	codex: {
		entry: () => require.resolve("@agentclientprotocol/codex-acp/dist/index.js"),
		env: (opts) => {
			const env = { INITIAL_AGENT_MODE: codexMode(opts.permissionMode) };
			if (opts.model) env.CODEX_CONFIG = JSON.stringify({ model: opts.model });
			return env;
		}
	}
};
/** Build the user turn's ACP content blocks (text + attachments). */
function promptBlocks(text, attachments) {
	const blocks = [];
	if (text) blocks.push({
		type: "text",
		text
	});
	for (const a of attachments) if (a.mediaType.startsWith("image/")) blocks.push({
		type: "image",
		data: a.data,
		mimeType: a.mediaType
	});
	else {
		const decoded = decodeTextFile(a.data);
		blocks.push({
			type: "text",
			text: decoded != null ? `Attached file \`${a.name}\`:\n\`\`\`\n${decoded}\n\`\`\`` : `Attached file \`${a.name}\` (binary, not included).`
		});
	}
	if (blocks.length === 0) blocks.push({
		type: "text",
		text: ""
	});
	return blocks;
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
/**
* Flatten ACP tool-call content into display text, preserving newlines so the
* UI can render it as Markdown. Capped so a huge output can't bloat the
* persisted buffer.
*/
function toolContentText(content) {
	if (!Array.isArray(content)) return "";
	const text = content.map((c) => {
		if (c && typeof c === "object") {
			const block = c;
			if (block.content && typeof block.content.text === "string") return block.content.text;
			if (typeof block.text === "string") return block.text;
		}
		return "";
	}).join("\n").trim();
	return text.length > 4e3 ? `${text.slice(0, 4e3)}\n…(truncated)` : text;
}
/** Turn ACP `enum` / `oneOf` into {value,label} options. */
function enumOptions(enumValues, oneOf) {
	if (oneOf?.length) return oneOf.map((o) => ({
		value: o.const,
		label: o.title
	}));
	if (enumValues?.length) return enumValues.map((v) => ({
		value: v,
		label: v
	}));
	return [];
}
/** Normalize an ACP elicitation form schema into flat fields the UI can render. */
function normalizeSchema(schema) {
	const s = schema ?? {};
	const required = new Set(s.required ?? []);
	return Object.entries(s.properties ?? {}).map(([key, p]) => {
		const base = {
			key,
			label: p.title || key,
			description: p.description ?? void 0,
			required: required.has(key),
			default: p.default
		};
		switch (p.type) {
			case "boolean": return {
				...base,
				input: "boolean"
			};
			case "number": return {
				...base,
				input: "number"
			};
			case "integer": return {
				...base,
				input: "integer"
			};
			case "array": {
				const items = p.items ?? {};
				return {
					...base,
					input: "multiselect",
					options: enumOptions(items.enum, items.oneOf)
				};
			}
			default: {
				const opts = enumOptions(p.enum, p.oneOf);
				return opts.length ? {
					...base,
					input: "select",
					options: opts
				} : {
					...base,
					input: "text"
				};
			}
		}
	});
}
/** Map a user's elicitation answer onto the ACP response shape. */
function elicitResponse(action, content) {
	if (action === "accept") return {
		action: "accept",
		content: content ?? {}
	};
	if (action === "decline") return { action: "decline" };
	return { action: "cancel" };
}
function startAcpDriver(opts, emit) {
	const spec = PROVIDERS[opts.provider];
	let proc = null;
	let conn = null;
	let sessionId = null;
	let closed = false;
	let permissionMode = opts.permissionMode;
	let suppressReplay = false;
	const pendingPerms = /* @__PURE__ */ new Map();
	const pendingElicits = /* @__PURE__ */ new Map();
	let readyResolve;
	const ready = new Promise((r) => {
		readyResolve = r;
	});
	const clientImpl = {
		async requestPermission(params) {
			const options = params.options ?? [];
			const allow = options.find((o) => o.kind === "allow_once") ?? options.find((o) => o.kind === "allow_always");
			const reject = options.find((o) => o.kind === "reject_once") ?? options.find((o) => o.kind === "reject_always");
			const decide = (yes) => yes && allow ? { outcome: {
				outcome: "selected",
				optionId: allow.optionId
			} } : !yes && reject ? { outcome: {
				outcome: "selected",
				optionId: reject.optionId
			} } : { outcome: { outcome: "cancelled" } };
			if (permissionMode === "bypassPermissions") return decide(true);
			if (permissionMode === "acceptEdits" && params.toolCall?.kind && [
				"edit",
				"delete",
				"move"
			].includes(params.toolCall.kind)) return decide(true);
			const id = String(params.toolCall?.toolCallId ?? crypto.randomUUID());
			emit({
				type: "permission",
				id,
				toolName: params.toolCall?.title ?? "tool",
				input: params.toolCall?.rawInput
			});
			return new Promise((resolve) => {
				pendingPerms.set(id, (yes) => resolve(decide(yes)));
			});
		},
		async sessionUpdate(params) {
			if (suppressReplay) return;
			const u = params.update;
			switch (u.sessionUpdate) {
				case "agent_message_chunk":
					if (u.content.type === "text") emit({
						type: "assistant_text",
						text: u.content.text
					});
					break;
				case "agent_thought_chunk":
					if (u.content.type === "text") emit({
						type: "thinking",
						text: u.content.text
					});
					break;
				case "tool_call":
					emit({
						type: "tool_use",
						id: String(u.toolCallId),
						name: u.title || u.kind || "tool",
						input: u.rawInput
					});
					break;
				case "tool_call_update":
					if (u.status === "completed" || u.status === "failed") emit({
						type: "tool_result",
						id: String(u.toolCallId),
						ok: u.status === "completed",
						summary: toolContentText(u.content)
					});
					break;
				default: break;
			}
		},
		async unstable_createElicitation(params) {
			const message = params.message;
			if (params.mode === "url") {
				const id = params.elicitationId;
				emit({
					type: "elicitation",
					id,
					mode: "url",
					message,
					fields: [],
					url: params.url
				});
				return new Promise((resolve) => {
					pendingElicits.set(id, (action, content) => resolve(elicitResponse(action, content)));
				});
			}
			const id = crypto.randomUUID();
			emit({
				type: "elicitation",
				id,
				mode: "form",
				message,
				fields: normalizeSchema(params.requestedSchema)
			});
			return new Promise((resolve) => {
				pendingElicits.set(id, (action, content) => resolve(elicitResponse(action, content)));
			});
		},
		async unstable_completeElicitation(params) {
			const id = params.elicitationId;
			if (id) {
				const r = pendingElicits.get(id);
				if (r) {
					pendingElicits.delete(id);
					r("accept");
				}
				emit({
					type: "elicitation_resolved",
					id
				});
			}
		}
	};
	async function init() {
		const env = {
			...process.env,
			PATH: AUGMENTED_PATH$1,
			ELECTRON_RUN_AS_NODE: "1",
			...spec.env(opts)
		};
		proc = (0, node_child_process.spawn)(process.execPath, [spec.entry()], {
			cwd: opts.cwd,
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			],
			env
		});
		proc.on("error", (err) => {
			if (closed) return;
			emit({
				type: "error",
				message: `Failed to launch ${opts.provider} adapter: ${err.message}`
			});
		});
		proc.stderr?.setEncoding("utf8");
		proc.stderr?.on("data", (chunk) => {
			const t = chunk.trim();
			if (t) console.error(`[agentChatAcp:${opts.provider}] ${t}`);
		});
		proc.on("exit", (code) => {
			if (closed) return;
			const exitCode = code ?? 0;
			if (code != null && code !== 0) emit({
				type: "error",
				message: `${opts.provider} adapter exited with code ${code}`
			});
			emit({
				type: "exited",
				code: exitCode
			});
		});
		conn = new ClientSideConnection(() => clientImpl, ndJsonStream(node_stream.Writable.toWeb(proc.stdin), node_stream.Readable.toWeb(proc.stdout)));
		const canLoad = !!(await conn.initialize({
			protocolVersion: 1,
			clientCapabilities: {
				fs: {
					readTextFile: false,
					writeTextFile: false
				},
				elicitation: {
					form: {},
					url: {}
				}
			}
		})).agentCapabilities?.loadSession;
		if (opts.resume && opts.acpResumeId && canLoad) try {
			suppressReplay = true;
			await conn.loadSession({
				sessionId: opts.acpResumeId,
				cwd: opts.cwd,
				mcpServers: []
			});
			sessionId = opts.acpResumeId;
		} catch {
			sessionId = null;
		} finally {
			suppressReplay = false;
		}
		if (!sessionId) sessionId = (await conn.newSession({
			cwd: opts.cwd,
			mcpServers: []
		})).sessionId;
		emit({
			type: "system",
			sessionId,
			model: null
		});
		readyResolve();
	}
	init().catch((err) => {
		emit({
			type: "error",
			message: `ACP init failed: ${err?.message ?? err}`
		});
		readyResolve();
	});
	return {
		send(text, attachments = []) {
			ready.then(() => {
				if (closed || !conn || !sessionId) return;
				return conn.prompt({
					sessionId,
					prompt: promptBlocks(text, attachments)
				}).then((res) => {
					emit({
						type: "result",
						ok: res.stopReason !== "refusal",
						durationMs: null
					});
				});
			}).catch((err) => {
				if (closed) return;
				emit({
					type: "error",
					message: `Send failed: ${err?.message ?? err}`
				});
			});
		},
		respond(requestId, allow) {
			const resolver = pendingPerms.get(requestId);
			if (resolver) {
				pendingPerms.delete(requestId);
				resolver(allow);
			}
			emit({
				type: "permission_resolved",
				id: requestId,
				allow
			});
		},
		resolveElicit(id, action, content) {
			const r = pendingElicits.get(id);
			if (r) {
				pendingElicits.delete(id);
				r(action, content);
			}
			emit({
				type: "elicitation_resolved",
				id
			});
		},
		setPermissionMode(mode) {
			permissionMode = mode;
		},
		cancel() {
			if (conn && sessionId) conn.cancel({ sessionId }).catch(() => {});
		},
		stop() {
			closed = true;
			if (conn && sessionId) conn.cancel({ sessionId }).catch(() => {});
			try {
				proc?.kill();
			} catch {}
		}
	};
}
//#endregion
//#region src/main/agentChat.ts
/**
* Native chat agent sessions. Unlike the PTY terminals, these drive a coding
* agent over the Agent Client Protocol (ACP) and emit a normalized
* {@link AgentChatEvent} stream the view renders as a chat UI.
*
* This module owns the generic session lifecycle — buffering, persistence,
* replay/reattach — while the actual protocol lives behind {@link AgentDriver}
* (see agentChatAcp.ts). One driver per provider (Claude, Codex, …).
*
* Sessions live in the main process so they survive renderer reloads/HMR.
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
/** The ACP session id from the most recent `system` event, if any. */
function lastAcpSessionId(events) {
	if (!events) return null;
	for (let i = events.length - 1; i >= 0; i--) {
		const e = events[i];
		if (e.type === "system" && e.sessionId) return e.sessionId;
	}
	return null;
}
var sessions = /* @__PURE__ */ new Map();
/**
* Per-session event log, retained while the session is alive so a webview that
* remounts/reloads (worktree nav, HMR, full reload) can replay the conversation
* from the still-running main process. Mirrors the terminal scrollback buffer.
*/
var buffers = /* @__PURE__ */ new Map();
var MAX_BUFFER = 5e3;
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
/** Wire the main->renderer push callback (set once at startup). */
function setAgentChatCallback(fn) {
	emitGlobal = fn;
}
/**
* Start a chat session, or reattach to a live one. If the session is already
* running in this process (e.g. the webview reloaded), we replay its buffered
* history instead of spawning a second process. Always returns true.
*/
function startSession(opts) {
	if (sessions.has(opts.sessionId)) {
		replay(opts.sessionId);
		return true;
	}
	const persisted = opts.resume ? loadPersisted(opts.sessionId) : null;
	buffers.set(opts.sessionId, persisted ?? []);
	if (persisted && persisted.length > 0) replay(opts.sessionId);
	const acpResumeId = opts.resume ? lastAcpSessionId(persisted) : null;
	const emit = emitterFor(opts.sessionId);
	const driver = startAcpDriver({
		...opts,
		acpResumeId
	}, emit);
	sessions.set(opts.sessionId, driver);
	return true;
}
/**
* Switch provider/model/permission mode mid-conversation: stop the current
* driver and relaunch, resuming the agent's ACP session so context carries over.
*/
function restart(opts) {
	sessions.get(opts.sessionId)?.stop();
	const buf = buffers.get(opts.sessionId) ?? [];
	if (!buffers.has(opts.sessionId)) buffers.set(opts.sessionId, buf);
	const acpResumeId = lastAcpSessionId(buf);
	const emit = emitterFor(opts.sessionId);
	const driver = startAcpDriver({
		...opts,
		resume: true,
		acpResumeId
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
/** Change a live session's permission mode without relaunching the agent. */
function setPermissionMode(sessionId, mode) {
	sessions.get(sessionId)?.setPermissionMode(mode);
}
/** Answer a pending structured elicitation for a session. */
function resolveElicit(sessionId, id, action, content) {
	sessions.get(sessionId)?.resolveElicit(id, action, content);
}
/** Cancel the running turn but keep the session alive so the user can continue. */
function cancel(sessionId) {
	sessions.get(sessionId)?.cancel();
}
/**
* Stop (kill) a session's agent process. The persisted history is intentionally
* kept on disk so the chat can be reopened with its full conversation — see
* startSession's resume path. (Nothing deletes chat history today; that's a
* deliberate future "delete chat" action, not a side effect of closing.)
*/
function stop(sessionId) {
	sessions.get(sessionId)?.stop();
	sessions.delete(sessionId);
	buffers.delete(sessionId);
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
	buffers.clear();
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
	agentChatStart: ({ sessionId, worktreeId, provider, resume, permissionMode, model }) => {
		const row = worktreesRepo.get(worktreeId);
		if (!row) return {
			ok: false,
			error: "Worktree not found"
		};
		return startSession({
			sessionId,
			cwd: row.path,
			provider,
			resume,
			permissionMode,
			model
		}) ? { ok: true } : {
			ok: false,
			error: "Session already running"
		};
	},
	agentChatRestart: ({ sessionId, worktreeId, provider, permissionMode, model }) => {
		const row = worktreesRepo.get(worktreeId);
		if (!row) return {
			ok: false,
			error: "Worktree not found"
		};
		restart({
			sessionId,
			cwd: row.path,
			provider,
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
		case "agentChatElicit":
			resolveElicit(msg.sessionId, msg.id, msg.action, msg.content);
			break;
		case "agentChatSetMode":
			setPermissionMode(msg.sessionId, msg.permissionMode);
			break;
		case "agentChatCancel":
			cancel(msg.sessionId);
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
