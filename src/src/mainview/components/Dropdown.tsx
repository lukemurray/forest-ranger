import type { ReactElement, ReactNode } from "react";
import { Menu } from "@base-ui-components/react/menu";
import styles from "./RowMenu.module.css";

/** Left-click dropdown menu (vs RowMenu, which is a right-click context menu). */
export function Dropdown({
	trigger,
	children,
}: {
	trigger: ReactElement;
	children: ReactNode;
}) {
	return (
		<Menu.Root>
			<Menu.Trigger render={trigger as ReactElement<Record<string, unknown>>} />
			<Menu.Portal>
				<Menu.Positioner className={styles.positioner} sideOffset={4}>
					<Menu.Popup className={styles.popup}>{children}</Menu.Popup>
				</Menu.Positioner>
			</Menu.Portal>
		</Menu.Root>
	);
}

export function DropdownItem({
	icon,
	label,
	onClick,
	danger,
}: {
	icon?: ReactNode;
	label: string;
	onClick: () => void;
	danger?: boolean;
}) {
	return (
		<Menu.Item className={styles.item} data-danger={danger || undefined} onClick={onClick}>
			{icon}
			{label}
		</Menu.Item>
	);
}

export function DropdownSeparator() {
	return <Menu.Separator className={styles.separator} />;
}
