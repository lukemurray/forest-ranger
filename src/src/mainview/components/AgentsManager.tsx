import {
	CLAUDE_MODELS,
	PERMISSION_MODES,
	setChatConfig,
	useChatConfig,
} from "../lib/chatConfig";
import { Select } from "./ui/Select";
import styles from "./AgentsManager.module.css";

/**
 * Chat provider settings. Chat is driven by Claude today; model and permission
 * mode are chosen inside each chat, so this just sets the defaults new chats
 * start with.
 */
export function AgentsManager() {
	const config = useChatConfig();

	return (
		<div>
			<p className={styles.intro}>
				In-app Chat is powered by <strong>Claude</strong>. You can change the model
				and permission mode inside any chat — these are just the defaults new chats
				start with.
			</p>

			<div className={styles.customFields}>
				<div className={styles.field}>
					<span className={styles.fieldLabel}>Default model</span>
					<Select
						value={config.defaultModel}
						onValueChange={(v) => setChatConfig({ defaultModel: v })}
						options={CLAUDE_MODELS}
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
