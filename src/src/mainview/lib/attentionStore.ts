import { useSyncExternalStore } from "react";
import type { StatusSets } from "../../shared/types";

/**
 * Live chat status pushed from main: which chats are working, awaiting an answer
 * (permission/input), or have unread finished output — each with the worktrees and
 * projects it touches. Drives the sidebar dots and chat-tab indicators, so the dock
 * badge isn't the only signal of *where* something is happening.
 */
type Sets = { sessions: Set<string>; worktrees: Set<string>; projects: Set<string> };
type State = { attention: Sets; working: Sets; unread: Sets };

const empty = (): Sets => ({ sessions: new Set(), worktrees: new Set(), projects: new Set() });
const toSets = (s: StatusSets): Sets => ({
	sessions: new Set(s.sessions),
	worktrees: new Set(s.worktrees),
	projects: new Set(s.projects),
});

let state: State = { attention: empty(), working: empty(), unread: empty() };
const listeners = new Set<() => void>();

export function setChatStatus(attention: StatusSets, working: StatusSets, unread: StatusSets) {
	state = { attention: toSets(attention), working: toSets(working), unread: toSets(unread) };
	for (const l of listeners) l();
}

export function useChatStatus(): State {
	return useSyncExternalStore(
		(l) => {
			listeners.add(l);
			return () => listeners.delete(l);
		},
		() => state,
	);
}
