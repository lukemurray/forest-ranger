/** Detect installed editors/terminals and open worktrees in them (macOS). */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { AppId, OpenApp, OpenResult } from "../shared/types";

const SEARCH_DIRS = [
	"/Applications",
	join(homedir(), "Applications"),
	"/System/Applications",
	"/System/Applications/Utilities",
];

type CatalogEntry = {
	id: AppId;
	label: string;
	/** macOS .app bundle name, used for both disk detection and `open -a`. */
	bundle: string;
	kind: "editor" | "terminal";
};

// Order matters: used as the default-app priority (first installed wins).
const CATALOG: CatalogEntry[] = [
	{ id: "cursor", label: "Cursor", bundle: "Cursor", kind: "editor" },
	{ id: "vscode", label: "VS Code", bundle: "Visual Studio Code", kind: "editor" },
	{ id: "zed", label: "Zed", bundle: "Zed", kind: "editor" },
	{ id: "ghostty", label: "Ghostty", bundle: "Ghostty", kind: "terminal" },
	{ id: "iterm", label: "iTerm", bundle: "iTerm", kind: "terminal" },
	{ id: "warp", label: "Warp", bundle: "Warp", kind: "terminal" },
	{ id: "terminal", label: "Terminal", bundle: "Terminal", kind: "terminal" },
];

const BUNDLE_BY_ID = new Map(CATALOG.map((a) => [a.id, a.bundle]));

function isInstalled(bundle: string): boolean {
	return SEARCH_DIRS.some((dir) => existsSync(join(dir, `${bundle}.app`)));
}

let cached: OpenApp[] | null = null;

/** Installed editors/terminals, plus Finder (always available). Cached per run. */
export function detectApps(): OpenApp[] {
	if (cached) return cached;
	const apps: OpenApp[] = CATALOG.filter((a) => isInstalled(a.bundle)).map(
		({ id, label, kind }) => ({ id, label, kind }),
	);
	apps.push({ id: "finder", label: "Finder", kind: "system" });
	cached = apps;
	return apps;
}

function shQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

function appleScriptStr(s: string): string {
	return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Write a self-contained launcher script that cd's into `cwd`, runs `command`,
 * then drops into an interactive shell so output (and dev servers) stay visible.
 * Handing terminals a single executable file avoids all the per-terminal arg
 * quoting/`-e` fragility. Returns the script path (a `.command` so a bare `open`
 * routes it to the default terminal handler).
 */
function writeRunScript(cwd: string, command: string): string {
	const shell = process.env.SHELL || "/bin/zsh";
	const dir = mkdtempSync(join(tmpdir(), "forest-ranger-run-"));
	const file = join(dir, "run.command");
	// Run through a login shell so the user's PATH (homebrew/nvm/etc.) is loaded,
	// then drop into an interactive shell so output and dev servers stay visible.
	const launch = `${command}; exec ${shell} -i`;
	const script = `#!/bin/sh\ncd ${shQuote(cwd)} || exit 1\nexec ${shell} -l -c ${shQuote(launch)}\n`;
	writeFileSync(file, script, { mode: 0o755 });
	return file;
}

/**
 * Build the argv that launches `scriptPath` in a terminal app. Pure (testable).
 * Terminal/iTerm via AppleScript; Ghostty runs the script as its `-e` target;
 * anything else (incl. Warp) falls back to the default `.command` handler.
 */
export function terminalArgv(app: AppId, scriptPath: string): string[] {
	if (app === "ghostty") {
		return ["open", "-na", "Ghostty", "--args", "-e", scriptPath];
	}
	if (app === "iterm") {
		const as = [
			'tell application "iTerm"',
			"activate",
			"set w to (create window with default profile)",
			`tell current session of w to write text ${appleScriptStr(shQuote(scriptPath))}`,
			"end tell",
		].join("\n");
		return ["osascript", "-e", as];
	}
	if (app === "terminal") {
		const as = [
			'tell application "Terminal"',
			"activate",
			`do script ${appleScriptStr(shQuote(scriptPath))}`,
			"end tell",
		].join("\n");
		return ["osascript", "-e", as];
	}
	// warp / unknown: let the OS open the .command with the default handler.
	return ["open", scriptPath];
}

/** Run a shell command in a worktree directory via the chosen terminal app. */
export function runInTerminal(
	app: AppId,
	cwd: string,
	command: string,
): OpenResult {
	try {
		const scriptPath = writeRunScript(cwd, command);
		const [cmd, ...args] = terminalArgv(app, scriptPath);
		const proc = spawnSync(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
		if (proc.status !== 0) {
			return {
				ok: false,
				error: proc.stderr?.toString().trim() || "Failed to launch terminal",
			};
		}
		return { ok: true };
	} catch (err) {
		return { ok: false, error: String(err) };
	}
}

export function openWorktree(path: string, app: AppId): OpenResult {
	try {
		// Finder: open the folder itself (reveal is a separate action).
		const argv =
			app === "finder"
				? ["open", path]
				: ["open", "-a", BUNDLE_BY_ID.get(app) ?? "", path];
		if (app !== "finder" && !BUNDLE_BY_ID.has(app)) {
			return { ok: false, error: `Unknown app: ${app}` };
		}
		const [cmd, ...args] = argv;
		const proc = spawnSync(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
		if (proc.status !== 0) {
			return {
				ok: false,
				error: proc.stderr?.toString().trim() || `Couldn't open ${app}`,
			};
		}
		return { ok: true };
	} catch (err) {
		return { ok: false, error: String(err) };
	}
}
