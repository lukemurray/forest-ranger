import type { ProjectCommand } from "../../shared/types";
import { MenuItem, RowMenu, Separator } from "./RowMenu";
import { Dropdown, DropdownItem, DropdownSeparator } from "./Dropdown";
import { ChevronIcon, PencilIcon, PlayIcon, PlusIcon, TrashIcon } from "./icons";
import styles from "./RunCommands.module.css";

/** Beyond this many commands, collapse them into a single "Run ▾" menu. */
const COLLAPSE_AT = 3;

/**
 * Run commands in the top bar. The "Add" button stays at the left; commands
 * show as individual buttons, collapsing into a "Run ▾" menu once there are
 * several. Buttons are sized to match the other top-bar action buttons.
 */
export function RunCommands({
	commands,
	onRun,
	onEdit,
	onDelete,
	onAdd,
}: {
	commands: ProjectCommand[];
	onRun: (cmd: ProjectCommand) => void;
	onEdit: (cmd: ProjectCommand) => void;
	onDelete: (id: string) => void;
	onAdd: () => void;
}) {
	if (commands.length === 0) {
		return (
			<button className={`${styles.cmd} ${styles.add}`} onClick={onAdd}>
				<PlusIcon size={14} /> Add a run command
			</button>
		);
	}

	const addButton = (
		<button className={`${styles.cmd} ${styles.add}`} onClick={onAdd} title="Add a run command">
			<PlusIcon size={14} /> Add
		</button>
	);

	if (commands.length > COLLAPSE_AT) {
		return (
			<>
				{addButton}
				<Dropdown
					trigger={
						<button className={`${styles.cmd} ${styles.run}`}>
							<PlayIcon size={13} /> Run <ChevronIcon size={12} />
						</button>
					}
				>
					{commands.map((c) => (
						<DropdownItem key={c.id} label={c.label} onClick={() => onRun(c)} />
					))}
					<DropdownSeparator />
					<DropdownItem label="Add command" onClick={onAdd} />
				</Dropdown>
			</>
		);
	}

	return (
		<>
			{addButton}
			{commands.map((c) => (
				<RowMenu
					key={c.id}
					trigger={
						<button
							className={`${styles.cmd} ${styles.run}`}
							onClick={() => onRun(c)}
							title={c.command}
						>
							<PlayIcon size={13} /> {c.label}
						</button>
					}
				>
					<MenuItem icon={<PencilIcon size={15} />} label="Edit command" onClick={() => onEdit(c)} />
					<Separator />
					<MenuItem
						icon={<TrashIcon size={15} />}
						label="Delete command"
						danger
						onClick={() => onDelete(c.id)}
					/>
				</RowMenu>
			))}
		</>
	);
}
