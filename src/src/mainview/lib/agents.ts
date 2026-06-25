import { useSyncExternalStore } from "react";

export type Agent = {
	id: string;
	label: string;
	/** Plain launch (no session pinning). */
	command: string;
	/** Start a pinned session; `{id}` is replaced with a generated UUID. */
	newSessionCommand: string;
	/** Resume a session; `{id}` is replaced with the stored session UUID. */
	resumeCommand: string;
};

type Preset = Omit<Agent, "id">;

/** One-click presets; users can also add custom agents. */
export const AGENT_PRESETS: Preset[] = [
	{
		label: "Claude Code",
		command: "claude",
		newSessionCommand: "claude --session-id {id}",
		resumeCommand: "claude --resume {id}",
	},
	{ label: "Codex", command: "codex", newSessionCommand: "", resumeCommand: "" },
	{ label: "Cursor Agent", command: "cursor-agent", newSessionCommand: "", resumeCommand: "" },
	{ label: "Copilot CLI", command: "copilot", newSessionCommand: "", resumeCommand: "" },
	{ label: "opencode", command: "opencode", newSessionCommand: "", resumeCommand: "" },
];

/**
 * Resolve how to launch an agent: if it pins a session, generate a UUID and
 * substitute it, returning the id so resume can target that exact conversation.
 */
export function prepareAgentLaunch(agent: Agent): {
	command: string;
	sessionId: string | null;
} {
	if (agent.newSessionCommand.includes("{id}")) {
		const sessionId = crypto.randomUUID();
		return {
			command: agent.newSessionCommand.replace(/\{id\}/g, sessionId),
			sessionId,
		};
	}
	return { command: agent.command, sessionId: null };
}

const KEY = "forest-ranger:agents";

function read(): Agent[] {
	try {
		const raw = localStorage.getItem(KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.map((a) => ({ resumeCommand: "", newSessionCommand: "", ...a }));
	} catch {
		return [];
	}
}

let agents: Agent[] = read();
const listeners = new Set<() => void>();

function commit(next: Agent[]) {
	agents = next;
	localStorage.setItem(KEY, JSON.stringify(next));
	for (const fn of listeners) fn();
}

export function addAgent(
	label: string,
	command: string,
	resumeCommand = "",
	newSessionCommand = "",
): void {
	commit([
		...agents,
		{ id: crypto.randomUUID(), label, command, resumeCommand, newSessionCommand },
	]);
}

export function updateAgent(
	id: string,
	label: string,
	command: string,
	resumeCommand: string,
	newSessionCommand: string,
): void {
	commit(
		agents.map((a) =>
			a.id === id
				? { ...a, label, command, resumeCommand, newSessionCommand }
				: a,
		),
	);
}

export function removeAgent(id: string): void {
	commit(agents.filter((a) => a.id !== id));
}

export function getAgents(): Agent[] {
	return agents;
}

export function useAgents(): Agent[] {
	return useSyncExternalStore(
		(fn) => {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
		() => agents,
	);
}
