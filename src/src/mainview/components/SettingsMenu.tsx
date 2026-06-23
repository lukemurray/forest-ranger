import { Menu } from "@base-ui-components/react/menu";
import { setThemeMode, useThemeMode, type ThemeMode } from "../lib/theme";
import {
	CheckIcon,
	ChevronUpDownIcon,
	GearIcon,
	TreeIcon,
} from "./icons";
import styles from "./SettingsMenu.module.css";

const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
	{ value: "system", label: "Follow system" },
	{ value: "light", label: "Light" },
	{ value: "dark", label: "Dark" },
];

export function SettingsMenu() {
	const mode = useThemeMode();

	return (
		<Menu.Root>
			<Menu.Trigger
				className={`${styles.footer} electrobun-webkit-app-region-no-drag`}
			>
				<span className={styles.mark}>
					<TreeIcon size={15} />
				</span>
				<span className={styles.footerText}>
					<span className={styles.footerTitle}>Settings</span>
					<span className={styles.footerSub}>Forest Ranger</span>
				</span>
				<ChevronUpDownIcon size={15} />
			</Menu.Trigger>

			<Menu.Portal>
				<Menu.Positioner
					className={styles.positioner}
					side="top"
					align="start"
					sideOffset={6}
				>
					<Menu.Popup className={styles.popup}>
						<div className={styles.header}>
							<GearIcon size={15} /> Settings
						</div>

						<Menu.Group>
							<Menu.GroupLabel className={styles.groupLabel}>
								Theme
							</Menu.GroupLabel>
							<Menu.RadioGroup
								value={mode}
								onValueChange={(value) => setThemeMode(value as ThemeMode)}
							>
								{THEME_OPTIONS.map((opt) => (
									<Menu.RadioItem
										key={opt.value}
										value={opt.value}
										closeOnClick={false}
										className={styles.item}
									>
										<span className={styles.itemLabel}>{opt.label}</span>
										<Menu.RadioItemIndicator className={styles.indicator}>
											<CheckIcon size={15} />
										</Menu.RadioItemIndicator>
									</Menu.RadioItem>
								))}
							</Menu.RadioGroup>
						</Menu.Group>
					</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}
