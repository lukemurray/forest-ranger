/** PTY-backed terminal sessions using Bun's native `terminal` spawn option. */

// Sessions live in the Bun process, so they survive webview reloads/HMR. We keep
// a capped scrollback buffer per session so a reattaching view can replay it.
const BUFFER_CAP = 256 * 1024;

type Session = {
	proc: ReturnType<typeof Bun.spawn>;
	chunks: Uint8Array[];
	size: number;
};

const sessions = new Map<string, Session>();

type Callbacks = {
	onData: (sessionId: string, dataB64: string) => void;
	onExit: (sessionId: string, exitCode: number) => void;
};

let cb: Callbacks | null = null;

/** Wire the bun->webview push callbacks (set once at startup). */
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
	const session: Session = { proc: undefined as never, chunks: [], size: 0 };

	const proc = Bun.spawn([shell, "-il"], {
		cwd,
		env: { ...process.env, TERM: "xterm-256color" },
		terminal: {
			cols,
			rows,
			data(_term: unknown, data: Uint8Array) {
				const b = new Uint8Array(data); // copy — Bun may reuse the buffer
				session.chunks.push(b);
				session.size += b.length;
				while (session.size > BUFFER_CAP && session.chunks.length > 1) {
					session.size -= session.chunks.shift()!.length;
				}
				cb?.onData(sessionId, Buffer.from(b).toString("base64"));
			},
		},
	} as never);

	session.proc = proc;
	sessions.set(sessionId, session);

	if (command) {
		// Give the shell a beat to initialize, then run the command.
		setTimeout(() => write(sessionId, `${command}\n`), 60);
	}

	proc.exited.then((code: number) => {
		sessions.delete(sessionId);
		cb?.onExit(sessionId, code);
	});
}

export function write(sessionId: string, data: string): void {
	const s = sessions.get(sessionId);
	(s?.proc as { terminal?: { write(d: string): void } } | undefined)?.terminal?.write(data);
}

export function resize(sessionId: string, cols: number, rows: number): void {
	const s = sessions.get(sessionId);
	(s?.proc as { terminal?: { resize(c: number, r: number): void } } | undefined)?.terminal?.resize(
		cols,
		rows,
	);
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

function closeProc(proc: ReturnType<typeof Bun.spawn>): void {
	// Closing the PTY sends SIGHUP to the foreground group (kills dev servers);
	// kill() finishes off the shell itself.
	try {
		(proc as { terminal?: { close(): void } }).terminal?.close();
	} catch {
		// already gone
	}
	try {
		proc.kill();
	} catch {
		// already gone
	}
}
