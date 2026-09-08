import { useSyncExternalStore } from "react";
import type { AgentPermissionMode, AgentProvider } from "../../shared/types";

/**
 * Chat is driven by a provider (Claude or Codex) and a model, both switchable
 * inside the chat. This holds the defaults new chats start with and the option
 * lists the in-chat pickers show.
 */
export type ModeOption = { value: string; label: string };

export type ChatConfig = {
	defaultProvider: AgentProvider;
	/** Model alias; "default" means the provider's own default (no override). */
	defaultModel: string;
	defaultPermissionMode: AgentPermissionMode;
	/**
	 * Preferred starting mode per provider (the agent's own mode ids, e.g. "auto").
	 * "" / absent = use the agent's own default. Applied when a new chat starts.
	 */
	defaultModeByProvider?: Partial<Record<AgentProvider, string>>;
	/**
	 * The mode options each provider last advertised, remembered so Settings can
	 * offer them before any chat is open. Agent-driven, so learned at runtime.
	 */
	modesByProvider?: Partial<Record<AgentProvider, ModeOption[]>>;
};

type ModelOption = { value: string; label: string };

// Concrete models the user picks from. Versions are best-effort labels (they
// shift as new models ship); the chat also shows the model the agent actually
// resolved to if it differs, which is the ground truth.
export const CLAUDE_MODELS: ModelOption[] = [
	{ value: "opus", label: "Opus 4.8" },
	{ value: "sonnet", label: "Sonnet 4.6" },
	{ value: "haiku", label: "Haiku 4.5" },
];

// Codex model ids are best-effort; "default" lets Codex use its configured model.
export const CODEX_MODELS: ModelOption[] = [
	{ value: "default", label: "Default" },
	{ value: "gpt-5-codex", label: "GPT-5 Codex" },
];

type ProviderSpec = {
	value: AgentProvider;
	label: string;
	models: ModelOption[];
	defaultModel: string;
};

export const PROVIDERS: ProviderSpec[] = [
	{ value: "claude", label: "Claude", models: CLAUDE_MODELS, defaultModel: "opus" },
	{ value: "codex", label: "Codex", models: CODEX_MODELS, defaultModel: "default" },
];

export const PERMISSION_MODES: { value: AgentPermissionMode; label: string }[] = [
	{ value: "default", label: "Default (ask to edit)" },
	{ value: "acceptEdits", label: "Accept edits" },
	{ value: "plan", label: "Plan mode" },
	{ value: "bypassPermissions", label: "Bypass permissions" },
];

function providerSpec(provider: AgentProvider): ProviderSpec {
	return PROVIDERS.find((p) => p.value === provider) ?? PROVIDERS[0];
}

/** Models available for a provider. */
export function modelsFor(provider: AgentProvider): ModelOption[] {
	return providerSpec(provider).models;
}

/** Human label for a provider. */
export function providerLabel(provider: AgentProvider): string {
	return providerSpec(provider).label;
}

/** Convert a model-picker value into the launch argument (null = provider default). */
export function modelArg(model: string | null | undefined): string | null {
	return !model || model === "default" ? null : model;
}

/** Label for a model value within a provider (falls back to the raw value). */
export function modelLabel(provider: AgentProvider, model: string | null | undefined): string {
	const v = model || "default";
	return modelsFor(provider).find((m) => m.value === v)?.label ?? v;
}

/** Coerce an unknown/legacy model value to one valid for the provider. */
export function coerceModel(provider: AgentProvider, model: string | null | undefined): string {
	const spec = providerSpec(provider);
	return spec.models.some((m) => m.value === model) ? (model as string) : spec.defaultModel;
}

/** Coerce an unknown provider value to a supported one. */
export function coerceProvider(provider: string | null | undefined): AgentProvider {
	return PROVIDERS.some((p) => p.value === provider)
		? (provider as AgentProvider)
		: PROVIDERS[0].value;
}

// --- combined provider·model picker (single clickable control) ---

/** Compose a provider+model into one picker value. */
export function composeChoice(provider: AgentProvider, model: string): string {
	return `${provider}:${model}`;
}

/** Parse a combined picker value back into provider + model. */
export function parseChoice(value: string): { provider: AgentProvider; model: string } {
	const [p, ...rest] = value.split(":");
	const provider = coerceProvider(p);
	return { provider, model: coerceModel(provider, rest.join(":")) };
}

/** Flat option list for the combined provider·model control. */
export function choiceOptions(): { value: string; label: string }[] {
	return PROVIDERS.flatMap((p) =>
		p.models.map((m) => ({
			value: composeChoice(p.value, m.value),
			label: `${p.label} · ${m.label}`,
		})),
	);
}

const DEFAULTS: ChatConfig = {
	defaultProvider: "claude",
	defaultModel: "opus",
	defaultPermissionMode: "default",
};
const KEY = "forest-ranger:chat-config";

function read(): ChatConfig {
	try {
		const raw = localStorage.getItem(KEY);
		const cfg = raw ? { ...DEFAULTS, ...JSON.parse(raw) } : DEFAULTS;
		const defaultProvider = coerceProvider(cfg.defaultProvider);
		return {
			...cfg,
			defaultProvider,
			defaultModel: coerceModel(defaultProvider, cfg.defaultModel),
		};
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

/** Remember a provider's advertised mode options (no-op if unchanged). */
export function rememberProviderModes(provider: AgentProvider, options: ModeOption[]): void {
	const cur = config.modesByProvider?.[provider];
	if (JSON.stringify(cur) === JSON.stringify(options)) return;
	setChatConfig({ modesByProvider: { ...config.modesByProvider, [provider]: options } });
}

/** Set the preferred starting mode for a provider ("" clears the override). */
export function setDefaultMode(provider: AgentProvider, value: string): void {
	setChatConfig({
		defaultModeByProvider: { ...config.defaultModeByProvider, [provider]: value || undefined },
	});
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
