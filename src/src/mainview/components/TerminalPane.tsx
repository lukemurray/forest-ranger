import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { api, bus, subscribeTerminal } from "../rpc";
import { useThemeMode, type ThemeMode } from "../lib/theme";
import styles from "./TerminalPane.module.css";

function isDark(mode: ThemeMode): boolean {
	return (
		mode === "dark" ||
		(mode === "system" &&
			window.matchMedia("(prefers-color-scheme: dark)").matches)
	);
}

function xtermTheme(dark: boolean) {
	return dark
		? { background: "#121419", foreground: "#e6e8ec", cursor: "#e6e8ec", selectionBackground: "#2c333d" }
		: { background: "#ffffff", foreground: "#1c1f26", cursor: "#1c1f26", selectionBackground: "#d2d6dd" };
}

/**
 * One PTY session rendered with xterm.js. The session is keyed by `sessionId`
 * (stable per worktree+command) so switching worktrees recreates it cleanly.
 */
export function TerminalPane({
	sessionId,
	worktreeId,
	commandId,
}: {
	sessionId: string;
	worktreeId: string;
	commandId: string | null;
}) {
	const hostRef = useRef<HTMLDivElement>(null);
	const termRef = useRef<Terminal | null>(null);
	const themeMode = useThemeMode();
	const dark = isDark(themeMode);
	const darkRef = useRef(dark);
	darkRef.current = dark;

	// Re-theme the live terminal whenever the app theme changes (no recreation).
	useEffect(() => {
		if (termRef.current) termRef.current.options.theme = xtermTheme(dark);
	}, [dark]);

	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;

		const term = new Terminal({
			fontFamily:
				'"SF Mono", ui-monospace, "JetBrains Mono", Menlo, monospace',
			fontSize: 12,
			cursorBlink: true,
			theme: xtermTheme(darkRef.current),
		});
		termRef.current = term;
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.open(host);

		const safeFit = () => {
			// Hidden tabs report 0 size — fitting then would send bogus dimensions.
			if (host.clientWidth > 0 && host.clientHeight > 0) fit.fit();
		};
		safeFit();

		const unsub = subscribeTerminal(sessionId, {
			onData: (b64) => term.write(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))),
			onExit: (code) =>
				term.write(`\r\n\x1b[2m[process exited: ${code}]\x1b[0m\r\n`),
		});

		term.onData((data) => bus.termInput({ sessionId, data }));

		api
			.termStart({
				sessionId,
				worktreeId,
				commandId,
				cols: term.cols,
				rows: term.rows,
			})
			.then((res) => {
				if (!res.ok) {
					term.write(`\r\n\x1b[31m${res.error ?? "Failed to start"}\x1b[0m\r\n`);
				}
			});

		const onResize = () => {
			if (host.clientWidth === 0 || host.clientHeight === 0) return;
			safeFit();
			bus.termResize({ sessionId, cols: term.cols, rows: term.rows });
		};
		const ro = new ResizeObserver(onResize);
		ro.observe(host);

		return () => {
			ro.disconnect();
			unsub();
			bus.termKill({ sessionId });
			term.dispose();
			termRef.current = null;
		};
	}, [sessionId, worktreeId, commandId]);

	return <div ref={hostRef} className={styles.host} />;
}
