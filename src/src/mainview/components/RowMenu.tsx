import type { ReactElement, ReactNode } from "react";
import { ContextMenu } from "@base-ui-components/react/context-menu";
import { api } from "../rpc";
import { openInEditor, openInTerminal } from "../lib/openTargets";
import { FolderIcon, RevealIcon, TerminalIcon } from "./icons";
import styles from "./RowMenu.module.css";

/** Wraps a row element so right-clicking it opens `children` as a context menu. */
export function RowMenu({
	trigger,
	children,
}: {
	trigger: ReactElement;
	children: ReactNode;
}) {
	return (
		<ContextMenu.Root>
			<ContextMenu.Trigger render={trigger as ReactElement<Record<string, unknown>>} />
			<ContextMenu.Portal>
				<ContextMenu.Positioner className={styles.positioner}>
					<ContextMenu.Popup className={styles.popup}>{children}</ContextMenu.Popup>
				</ContextMenu.Positioner>
			</ContextMenu.Portal>
		</ContextMenu.Root>
	);
}

export function MenuItem({
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
		<ContextMenu.Item
			className={styles.item}
			data-danger={danger || undefined}
			onClick={onClick}
		>
			{icon}
			{label}
		</ContextMenu.Item>
	);
}

export function Separator() {
	return <ContextMenu.Separator className={styles.separator} />;
}

/** The standard "open this path" actions, shared by worktree rows and cards. */
export function OpenItems({ path }: { path: string }) {
	return (
		<>
			<MenuItem
				icon={<FolderIcon size={15} />}
				label="Open in editor"
				onClick={() => openInEditor(path)}
			/>
			<MenuItem
				icon={<TerminalIcon size={15} />}
				label="Open in terminal"
				onClick={() => openInTerminal(path)}
			/>
			<MenuItem
				icon={<RevealIcon size={15} />}
				label="Reveal in Finder"
				onClick={() => api.revealInFinder({ path })}
			/>
		</>
	);
}
