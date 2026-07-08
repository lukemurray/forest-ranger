import type { AgentProvider } from "../../shared/types";
import {
	PERMISSION_MODES,
	PROVIDERS,
	coerceModel,
	modelsFor,
	setChatConfig,
	useChatConfig,
} from "../lib/chatConfig";
import { Select } from "./ui/Select";
import styles from "./AgentsManager.module.css";

/**
 * Chat provider settings. Chat is driven by Claude or Codex over ACP; model and
 * permission mode are chosen inside each chat, so this just sets the defaults new
 * chats start with.
 */
export function AgentsManager() {
	const config = useChatConfig();

	function changeProvider(provider: AgentProvider) {
		// Keep the model valid for the newly-selected provider.
		setChatConfig({
			defaultProvider: provider,
			defaultModel: coerceModel(provider, config.defaultModel),
		});
	}

	return (
		<div>
			<p className={styles.intro}>
				In-app Chat is powered by <strong>Claude</strong> and <strong>Codex</strong>{" "}
				over the Agent Client Protocol. You can change the provider, model, and
				permission mode inside any chat — these are just the defaults new chats
				start with.
			</p>

			<div className={styles.customFields}>
				<div className={styles.field}>
					<span className={styles.fieldLabel}>Default provider</span>
					<Select
						value={config.defaultProvider}
						onValueChange={changeProvider}
						options={PROVIDERS.map((p) => ({ value: p.value, label: p.label }))}
						ariaLabel="Default provider"
					/>
				</div>
				<div className={styles.field}>
					<span className={styles.fieldLabel}>Default model</span>
					<Select
						value={config.defaultModel}
						onValueChange={(v) => setChatConfig({ defaultModel: v })}
						options={modelsFor(config.defaultProvider)}
						ariaLabel="Default model"
					/>
				</div>
				<div className={styles.field}>
					<span className={styles.fieldLabel}>Default permission mode</span>
					<Select
						value={config.defaultPermissionMode}
						onValueChange={(v) => setChatConfig({ defaultPermissionMode: v })}
						options={PERMISSION_MODES}
						ariaLabel="Default permission mode"
					/>
				</div>
			</div>
		</div>
	);
}
