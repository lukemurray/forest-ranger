/** PTY-backed terminal sessions using Bun's native `terminal` spawn option. */

type Session = {
	proc: ReturnType<typeof Bun.spawn>;
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
	const shell = process.env.SHELL || "/bin/zsh";

	const proc = Bun.spawn([shell, "-il"], {
		cwd,
		env: { ...process.env, TERM: "xterm-256color" },
		terminal: {
			cols,
			rows,
			data(_term: unknown, data: Uint8Array) {
				cb?.onData(sessionId, Buffer.from(data).toString("base64"));
			},
		},
	} as never);

	sessions.set(sessionId, { proc });

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
	try {
		s.proc.kill();
	} catch {
		// already gone
	}
	sessions.delete(sessionId);
}
