import type { ProjectCommand } from "../../shared/types";
import { MenuItem, RowMenu, Separator } from "./RowMenu";
import { Dropdown, DropdownItem } from "./Dropdown";
import { ChevronIcon, PencilIcon, PlayIcon, TrashIcon } from "./icons";
import styles from "./RunCommands.module.css";

/** Beyond this many commands, collapse them into a single "Run ▾" menu. */
const COLLAPSE_AT = 2;

/**
 * Run commands in the top bar: individual buttons, collapsing into a "Run ▾"
 * menu once there are several. The "Add" button is rendered by the caller (to
 * the right of these); this renders nothing when there are no commands.
 */
export function RunCommands({
	commands,
	onRun,
	onEdit,
	onDelete,
}: {
	commands: ProjectCommand[];
	onRun: (cmd: ProjectCommand) => void;
	onEdit: (cmd: ProjectCommand) => void;
	onDelete: (id: string) => void;
}) {
	if (commands.length === 0) return null;

	if (commands.length > COLLAPSE_AT) {
		return (
			<Dropdown
				trigger={
					<button className={`${styles.cmd} ${styles.run}`} data-tip="Run a command" aria-label="Run a command">
						<PlayIcon size={13} /> Run <ChevronIcon size={12} />
					</button>
				}
			>
				{commands.map((c) => (
					<DropdownItem key={c.id} label={c.label} onClick={() => onRun(c)} />
				))}
			</Dropdown>
		);
	}

	return (
		<>
			{commands.map((c) => (
				<RowMenu
					key={c.id}
					trigger={
						<button
							className={`${styles.cmd} ${styles.run}`}
							onClick={() => onRun(c)}
							data-tip={c.command}
							aria-label={`Run ${c.label}`}
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
