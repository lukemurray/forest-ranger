import { useSyncExternalStore } from "react";
import type { AgentPermissionMode } from "../../shared/types";

/**
 * Chat is driven by a provider (Claude today). The model and permission mode are
 * chosen inside the chat, not pre-baked as separate agents — this holds the
 * defaults new chats start with and the option lists the in-chat pickers show.
 */
export type ChatConfig = {
	/** Model alias; "default" means the provider's own default (no --model). */
	defaultModel: string;
	defaultPermissionMode: AgentPermissionMode;
};

// Concrete models the user picks from. Versions are best-effort labels (they
// shift as new models ship); the chat also shows the model the agent actually
// resolved to if it differs, which is the ground truth.
export const CLAUDE_MODELS: { value: string; label: string }[] = [
	{ value: "opus", label: "Opus 4.8" },
	{ value: "sonnet", label: "Sonnet 4.6" },
	{ value: "haiku", label: "Haiku 4.5" },
];

export const PERMISSION_MODES: { value: AgentPermissionMode; label: string }[] = [
	{ value: "default", label: "Default (ask to edit)" },
	{ value: "acceptEdits", label: "Accept edits" },
	{ value: "plan", label: "Plan mode" },
	{ value: "bypassPermissions", label: "Bypass permissions" },
];

/** Convert a model-picker value into the launch argument (null = provider default). */
export function modelArg(model: string | null | undefined): string | null {
	return !model || model === "default" ? null : model;
}

/** Label for a model value (falls back to the raw value). */
export function modelLabel(model: string | null | undefined): string {
	const v = model || "default";
	return CLAUDE_MODELS.find((m) => m.value === v)?.label ?? v;
}

const DEFAULTS: ChatConfig = { defaultModel: "opus", defaultPermissionMode: "default" };
const KEY = "forest-ranger:chat-config";

/** Coerce an unknown/legacy model value (e.g. the old opaque "default") to a real one. */
export function coerceModel(model: string | null | undefined): string {
	return CLAUDE_MODELS.some((m) => m.value === model) ? (model as string) : DEFAULTS.defaultModel;
}

function read(): ChatConfig {
	try {
		const raw = localStorage.getItem(KEY);
		const cfg = raw ? { ...DEFAULTS, ...JSON.parse(raw) } : DEFAULTS;
		return { ...cfg, defaultModel: coerceModel(cfg.defaultModel) };
	} catch {
		return DEFAULTS;
	}
}

let config: ChatConfig = read();
const listeners = new Set<() => void>();

export function getChatConfig(): ChatConfig {
	return config;
}

export function setChatConfig(patch: Partial<ChatConfig>): void {
	config = { ...config, ...patch };
	localStorage.setItem(KEY, JSON.stringify(config));
	for (const fn of listeners) fn();
}

export function useChatConfig(): ChatConfig {
	return useSyncExternalStore(
		(fn) => {
			listeners.add(fn);
			return () => listeners.delete(fn);
		},
		() => config,
	);
}
