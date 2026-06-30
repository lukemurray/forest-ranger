/** PTY-backed terminal sessions using node-pty. */

import * as pty from "node-pty";

// Sessions live in the main process, so they survive renderer reloads/HMR. We
// keep a capped scrollback buffer per session so a reattaching view can replay.
const BUFFER_CAP = 256 * 1024;

type Session = {
	proc: pty.IPty;
	chunks: Buffer[];
	size: number;
};

const sessions = new Map<string, Session>();

type Callbacks = {
	onData: (sessionId: string, dataB64: string) => void;
	onExit: (sessionId: string, exitCode: number) => void;
};

let cb: Callbacks | null = null;

/** Wire the main->renderer push callbacks (set once at startup). */
export function setTerminalCallbacks(callbacks: Callbacks) {
	cb = callbacks;
}

/**
 * Start a login+interactive shell in `cwd` with a real PTY. If `command` is
 * given, it's typed into the shell so it runs immediately and the shell stays
 * open afterward (so output/dev servers persist and stay interactive).
 */
export function startSession(opts: {
	sessionId: string;
	cwd: string;
	command?: string;
	cols: number;
	rows: number;
}): void {
	const { sessionId, cwd, command, cols, rows } = opts;

	// Reattach: the PTY already exists (e.g. after an HMR remount). Replay the
	// buffered scrollback to the (new) view and keep streaming — don't respawn.
	const existing = sessions.get(sessionId);
	if (existing) {
		if (existing.chunks.length > 0) {
			cb?.onData(sessionId, Buffer.concat(existing.chunks).toString("base64"));
		}
		return;
	}

	const shell = process.env.SHELL || "/bin/zsh";
	const proc = pty.spawn(shell, ["-il"], {
		name: "xterm-256color",
		cols,
		rows,
		cwd,
		env: { ...process.env, TERM: "xterm-256color" } as Record<string, string>,
	});

	const session: Session = { proc, chunks: [], size: 0 };
	sessions.set(sessionId, session);

	proc.onData((data: string) => {
		const b = Buffer.from(data, "utf8");
		session.chunks.push(b);
		session.size += b.length;
		while (session.size > BUFFER_CAP && session.chunks.length > 1) {
			session.size -= session.chunks.shift()!.length;
		}
		cb?.onData(sessionId, b.toString("base64"));
	});

	proc.onExit(({ exitCode }) => {
		sessions.delete(sessionId);
		cb?.onExit(sessionId, exitCode);
	});

	if (command) {
		// Give the shell a beat to initialize, then run the command.
		setTimeout(() => write(sessionId, `${command}\n`), 60);
	}
}

export function write(sessionId: string, data: string): void {
	sessions.get(sessionId)?.proc.write(data);
}

export function resize(sessionId: string, cols: number, rows: number): void {
	try {
		sessions.get(sessionId)?.proc.resize(cols, rows);
	} catch {
		// resize on a dead pty throws; ignore.
	}
}

export function kill(sessionId: string): void {
	const s = sessions.get(sessionId);
	if (!s) return;
	closeProc(s.proc);
	sessions.delete(sessionId);
}

/** Kill every live session — used when the app is quitting. */
export function killAll(): void {
	for (const s of sessions.values()) closeProc(s.proc);
	sessions.clear();
}

function closeProc(proc: pty.IPty): void {
	// Killing the PTY sends SIGHUP to the foreground group (kills dev servers)
	// and finishes off the shell itself.
	try {
		proc.kill();
	} catch {
		// already gone
	}
}
