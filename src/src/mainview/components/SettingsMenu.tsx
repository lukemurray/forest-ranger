import { useState } from "react";
import { SettingsDialog } from "./SettingsDialog";
import { ChevronUpDownIcon, TreeIcon } from "./icons";
import styles from "./SettingsMenu.module.css";

/** Sidebar footer button that opens the Settings dialog. */
export function SettingsMenu() {
	const [open, setOpen] = useState(false);
	return (
		<>
			<button
				className={`${styles.footer} electrobun-webkit-app-region-no-drag`}
				onClick={() => setOpen(true)}
			>
				<span className={styles.mark}>
					<TreeIcon size={15} />
				</span>
				<span className={styles.footerText}>
					<span className={styles.footerTitle}>Settings</span>
					<span className={styles.footerSub}>Forest Ranger</span>
				</span>
				<ChevronUpDownIcon size={15} />
			</button>
			<SettingsDialog open={open} onOpenChange={setOpen} />
		</>
	);
}
