import type { AgentProvider } from "../../shared/types";
import {
	PERMISSION_MODES,
	PROVIDERS,
	setChatConfig,
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
