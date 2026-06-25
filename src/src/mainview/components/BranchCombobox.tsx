import { Combobox } from "@base-ui-components/react/combobox";
import { ChevronUpDownIcon } from "./icons";
import styles from "./BranchCombobox.module.css";

/** Type-to-filter branch picker, shared by the changes view and dialogs. */
export function BranchCombobox({
	value,
	branches,
	onSelect,
	placeholder = "branch…",
	block = false,
}: {
	value: string | null;
	branches: string[];
	onSelect: (branch: string) => void;
	placeholder?: string;
	block?: boolean;
}) {
	return (
		<Combobox.Root
			items={branches}
			value={value ?? ""}
			onValueChange={(v) => {
				if (typeof v === "string" && v) onSelect(v);
			}}
		>
			<div className={`${styles.combo} ${block ? styles.block : ""}`}>
				<Combobox.Input
					className={styles.comboInput}
					placeholder={placeholder}
					// Defer so the selection wins over the component's own focus handling,
					// letting you type to replace the current branch right away.
					onFocus={(e) => {
						const el = e.currentTarget;
						setTimeout(() => el.select(), 0);
					}}
				/>
				<Combobox.Icon className={styles.comboIcon}>
					<ChevronUpDownIcon size={13} />
				</Combobox.Icon>
			</div>
			<Combobox.Portal>
				<Combobox.Positioner className={styles.comboPositioner} sideOffset={4}>
					<Combobox.Popup className={styles.comboPopup}>
						<Combobox.Empty className={styles.comboEmpty}>
							No matching branch
						</Combobox.Empty>
						<Combobox.List>
							{(item: string) => (
								<Combobox.Item key={item} value={item} className={styles.comboItem}>
									{item}
								</Combobox.Item>
							)}
						</Combobox.List>
					</Combobox.Popup>
				</Combobox.Positioner>
			</Combobox.Portal>
		</Combobox.Root>
	);
}
