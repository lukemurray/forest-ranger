import type { AgentProvider } from "../../shared/types";
import {
	PROVIDERS,
	providerLabel,
	setChatConfig,
	setDefaultMode,
	useChatConfig,
} from "../lib/chatConfig";
import { Select } from "./ui/Select";
import styles from "./AgentsManager.module.css";

/**
 * Chat provider settings. Chat is driven by Claude or Codex over ACP. The model
 * (and effort, fast mode, …) is chosen live inside each chat from the agent's own
 * list, so it isn't a global setting here.
 */
export function AgentsManager() {
	const config = useChatConfig();

	return (
		<div>
			<p className={styles.intro}>
				In-app Chat is powered by <strong>Claude</strong> and <strong>Codex</strong>{" "}
				over the Agent Client Protocol. Model, effort, and permission mode are
				chosen inside each chat from the agent's own options — this just sets which
				provider new chats start with.
			</p>

			<div className={styles.customFields}>
				<div className={styles.field}>
					<span className={styles.fieldLabel}>Default provider</span>
					<Select
						value={config.defaultProvider}
						onValueChange={(v) => setChatConfig({ defaultProvider: v as AgentProvider })}
						options={PROVIDERS.map((p) => ({ value: p.value, label: p.label }))}
						ariaLabel="Default provider"
					/>
				</div>
				<DefaultModeField provider={config.defaultProvider} />
			</div>
		</div>
	);
}

/**
 * Default starting mode for a provider, chosen from the mode options that provider
 * has advertised in a chat (remembered in config). "Agent default" leaves it to the
 * agent. If no chat has run for this provider yet, the options aren't known.
 */
function DefaultModeField({ provider }: { provider: AgentProvider }) {
	const config = useChatConfig();
	const modes = config.modesByProvider?.[provider] ?? [];
	const value = config.defaultModeByProvider?.[provider] ?? "";

	return (
		<div className={styles.field}>
			<span className={styles.fieldLabel}>Default mode</span>
			{modes.length === 0 ? (
				<p className={styles.hint}>
					Start a {providerLabel(provider)} chat once to load its modes.
				</p>
			) : (
				<Select
					value={value}
					onValueChange={(v) => setDefaultMode(provider, v)}
					options={[{ value: "", label: "Agent default" }, ...modes]}
					ariaLabel="Default mode"
				/>
			)}
		</div>
	);
}
