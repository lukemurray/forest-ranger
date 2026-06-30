import type {
	AgentChatEvent,
	ForestRangerBridge,
	MainEvent,
	RpcRequests,
	ViewMessage,
} from "../shared/types";

const bridge = (window as unknown as { forestRanger: ForestRangerBridge }).forestRanger;

type DataChangedScope = "projects" | "worktrees";
const listeners = new Set<(scope: DataChangedScope) => void>();

/** Subscribe to "data changed" notifications (from main or local mutations). */
export function onDataChanged(fn: (scope: DataChangedScope) => void) {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

/** Fire a "data changed" notification locally (after a view-initiated mutation). */
export function emitDataChanged(scope: DataChangedScope) {
	for (const fn of listeners) fn(scope);
}

type TermSub = { onData: (data: string) => void; onExit: (code: number) => void };
const termSubs = new Map<string, TermSub>();

/** Subscribe to a PTY session's output/exit. Call before termStart(sessionId). */
export function subscribeTerminal(sessionId: string, sub: TermSub) {
	termSubs.set(sessionId, sub);
	return () => termSubs.delete(sessionId);
}

const chatSubs = new Map<string, (event: AgentChatEvent) => void>();

/** Subscribe to a chat agent session's events. Call before agentChatStart. */
export function subscribeAgentChat(
	sessionId: string,
	sub: (event: AgentChatEvent) => void,
) {
	chatSubs.set(sessionId, sub);
	return () => chatSubs.delete(sessionId);
}

// Route main-process push events to the right subscribers.
bridge.onEvent((e: MainEvent) => {
	switch (e.type) {
		case "dataChanged":
			for (const fn of listeners) fn(e.scope);
			break;
		case "termData":
			termSubs.get(e.sessionId)?.onData(e.data);
			break;
		case "termExit":
			termSubs.get(e.sessionId)?.onExit(e.exitCode);
			break;
		case "agentChatEvent":
			chatSubs.get(e.sessionId)?.(e.event);
			break;
	}
});

/** Typed request methods, one per main-process handler (`api.foo(params)`). */
type Api = {
	[M in keyof RpcRequests]: (
		params: RpcRequests[M]["params"],
	) => Promise<RpcRequests[M]["response"]>;
};
export const api = new Proxy({} as Api, {
	get(_t, prop: string) {
		return (params: unknown) =>
			bridge.invoke(prop as keyof RpcRequests, params as never);
	},
});

/** Fire-and-forget messages to main (`bus.termInput({...})`). */
type MsgType = ViewMessage["type"];
type PayloadOf<T extends MsgType> = Omit<Extract<ViewMessage, { type: T }>, "type">;
type Bus = { [T in MsgType]: (payload: PayloadOf<T>) => void };
export const bus = new Proxy({} as Bus, {
	get(_t, prop: string) {
		return (payload: object) =>
			bridge.send({ type: prop as MsgType, ...payload } as ViewMessage);
	},
});
