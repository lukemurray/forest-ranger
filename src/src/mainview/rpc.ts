import { Electroview } from "electrobun/view";
import type { AppRPC } from "../shared/types";

type DataChangedScope = "projects" | "worktrees";

const listeners = new Set<(scope: DataChangedScope) => void>();

/** Subscribe to "data changed" pushes from the Bun process. */
export function onDataChanged(fn: (scope: DataChangedScope) => void) {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

const rpcConfig = Electroview.defineRPC<AppRPC>({
	handlers: {
		requests: {},
		messages: {
			dataChanged: ({ scope }) => {
				for (const fn of listeners) fn(scope);
			},
		},
	},
});

const electroview = new Electroview({ rpc: rpcConfig });

const win = window as unknown as {
	__electrobun_encrypt?: unknown;
	__electrobunBunBridge?: unknown;
};

/**
 * Whether the transport can actually deliver a message right now. Two things
 * race on startup and can both lag behind first paint:
 *  - the bun WebSocket finishing its handshake (`OPEN`), and
 *  - the preload's async `initEncryption()` assigning `__electrobun_encrypt`.
 * If we send before both are ready, Electrobun silently drops the message and
 * the request 15s-times-out. (No socket = remote browser → postMessage path,
 * which doesn't encrypt, so we only need the bridge to exist.)
 */
function canSend(): boolean {
	const socket = electroview.bunSocket;
	if (socket) {
		return (
			socket.readyState === WebSocket.OPEN &&
			typeof win.__electrobun_encrypt === "function"
		);
	}
	return win.__electrobunBunBridge != null;
}

/** Resolves once {@link canSend} is true, polling, with an 8s safety cap. */
const bridgeReady: Promise<void> = new Promise((resolve) => {
	if (canSend()) return resolve();
	const start = Date.now();
	const timer = setInterval(() => {
		if (canSend() || Date.now() - start > 8000) {
			clearInterval(timer);
			resolve();
		}
	}, 30);
});

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const rawRequest = electroview.rpc!.request;

/**
 * Typed request methods for every Bun-side handler. Each call waits for the
 * bridge to be ready, then retries a couple of times on timeout to absorb any
 * residual startup race.
 */
export const api = new Proxy(rawRequest, {
	get(target, prop: string) {
		const fn = (target as unknown as Record<string, unknown>)[prop];
		if (typeof fn !== "function") return fn;
		const call = fn as (...a: unknown[]) => Promise<unknown>;
		return async (...args: unknown[]) => {
			await bridgeReady;
			let lastErr: unknown;
			for (let attempt = 0; attempt < 3; attempt++) {
				try {
					return await call.apply(target, args);
				} catch (err) {
					lastErr = err;
					if (!String(err).includes("timed out")) throw err;
					await delay(200);
				}
			}
			throw lastErr;
		};
	},
}) as typeof rawRequest;
