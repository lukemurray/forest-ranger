import { Menu } from "@base-ui-components/react/menu";
import type { AgentProvider, ConfigOption } from "../../shared/types";
import { PROVIDERS, modelLabel, modelsFor, providerLabel } from "../lib/chatConfig";
import { CheckIcon, ChevronIcon, ChevronUpDownIcon, SparkleIcon } from "./icons";
import menu from "./RowMenu.module.css";
import styles from "./ChatSettingsMenu.module.css";

const isMode = (o: ConfigOption) => o.id === "mode" || o.category === "mode";

/**
 * Chat settings as a menu of submenus: provider + the agent's config options
 * (model, thinking effort, fast mode, …), each expanding to a checkmarked option
 * list. Permission mode is left out — it stays inline as a quick toggle.
 */
export function ChatSettingsMenu({
	provider,
	onProvider,
	configOptions,
	onConfig,
	model,
	onModel,
	working,
}: {
	provider: AgentProvider;
	onProvider: (p: AgentProvider) => void;
	configOptions: ConfigOption[];
	onConfig: (id: string, value: string) => void;
	model: string;
	onModel: (m: string) => void;
	working: boolean;
}) {
	const rows = configOptions.filter((o) => !isMode(o));
	const modelOpt = configOptions.find((o) => o.id === "model" || o.category === "model");
	const modelText = modelOpt
		? (modelOpt.options.find((x) => x.value === modelOpt.currentValue)?.label ??
			modelOpt.currentValue)
		: modelLabel(provider, model);

	return (
		<Menu.Root>
			<Menu.Trigger className={styles.trigger}>
				<span className={styles.provider} data-working={working || undefined}>
					<SparkleIcon size={13} />
				</span>
				<span className={styles.summary}>
					{providerLabel(provider)} · {modelText}
				</span>
				<ChevronUpDownIcon size={13} />
			</Menu.Trigger>
			<Menu.Portal>
				<Menu.Positioner className={menu.positioner} side="top" align="start" sideOffset={6}>
					<Menu.Popup className={menu.popup}>
						<Setting
							label="Provider"
							value={provider}
							valueLabel={providerLabel(provider)}
							options={PROVIDERS.map((p) => ({ value: p.value, label: p.label }))}
							onSelect={(v) => onProvider(v as AgentProvider)}
						/>
						{configOptions.length > 0 ? (
							rows.map((o) => (
								<Setting
									key={o.id}
									label={o.name}
									value={o.currentValue}
									valueLabel={
										o.options.find((x) => x.value === o.currentValue)?.label ?? o.currentValue
									}
									options={o.options.map((x) => ({ value: x.value, label: x.label }))}
									onSelect={(v) => onConfig(o.id, v)}
								/>
							))
						) : (
							<Setting
								label="Model"
								value={model}
								valueLabel={modelLabel(provider, model)}
								options={modelsFor(provider)}
								onSelect={onModel}
							/>
						)}
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}

function Setting({
	label,
	value,
	valueLabel,
	options,
	onSelect,
}: {
	label: string;
	value: string;
	valueLabel: string;
	options: { value: string; label: string }[];
	onSelect: (value: string) => void;
}) {
	return (
		<Menu.SubmenuRoot>
			<Menu.SubmenuTrigger className={`${menu.item} ${styles.settingRow}`}>
				<span className={styles.settingLabel}>{label}</span>
				<span className={styles.settingValue}>{valueLabel}</span>
				<ChevronIcon size={13} />
			</Menu.SubmenuTrigger>
			<Menu.Portal>
				<Menu.Positioner className={menu.positioner}>
					<Menu.Popup className={menu.popup}>
						<Menu.RadioGroup value={value} onValueChange={(v) => onSelect(v as string)}>
							{options.map((o) => (
								<Menu.RadioItem key={o.value} value={o.value} className={`${menu.item} ${styles.radio}`}>
									<span className={styles.check}>
										<Menu.RadioItemIndicator>
											<CheckIcon size={14} />
										</Menu.RadioItemIndicator>
									</span>
									{o.label}
								</Menu.RadioItem>
							))}
						</Menu.RadioGroup>
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.SubmenuRoot>
	);
}
