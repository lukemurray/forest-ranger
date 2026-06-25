import { useEffect, useState } from "react";
import type { CommandRunTarget } from "../../shared/types";
import { Modal, ModalClose, ModalTitle } from "./ui/Modal";
import { Button } from "./ui/Button";
import { TextField } from "./ui/TextField";
import { Segmented } from "./ui/Segmented";
import styles from "./CommandDialog.module.css";

const RUN_TARGETS: { value: CommandRunTarget; label: string }[] = [
	{ value: "default", label: "Default" },
	{ value: "in-app", label: "In-app" },
	{ value: "external", label: "External" },
];

export function CommandDialog({
	open,
	onOpenChange,
	title,
	initialLabel = "",
	initialCommand = "",
	initialDir = "",
	initialRunTarget = "default",
	onSubmit,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	initialLabel?: string;
	initialCommand?: string;
	initialDir?: string;
	initialRunTarget?: CommandRunTarget;
	onSubmit: (
		label: string,
		command: string,
		dir: string,
		runTarget: CommandRunTarget,
	) => void;
}) {
	const [label, setLabel] = useState(initialLabel);
	const [command, setCommand] = useState(initialCommand);
	const [dir, setDir] = useState(initialDir);
	const [runTarget, setRunTarget] = useState<CommandRunTarget>(initialRunTarget);

	useEffect(() => {
		if (open) {
			setLabel(initialLabel);
			setCommand(initialCommand);
			setDir(initialDir);
			setRunTarget(initialRunTarget);
		}
	}, [open, initialLabel, initialCommand, initialDir, initialRunTarget]);

	const valid = label.trim() !== "" && command.trim() !== "";

	function save() {
		if (!valid) return;
		// Normalize the directory: trim, drop leading "./" and slashes.
		const cleanDir = dir.trim().replace(/^\.\/+/, "").replace(/^\/+/, "");
		onSubmit(label.trim(), command.trim(), cleanDir, runTarget);
		onOpenChange(false);
	}

	return (
		<Modal open={open} onOpenChange={onOpenChange} width={420}>
			<ModalTitle className={styles.title}>{title}</ModalTitle>

			<div className={styles.fields}>
				<TextField
					label="Label"
					value={label}
					onChange={(e) => setLabel(e.target.value)}
					placeholder="Run"
					autoFocus
				/>
				<TextField
					label="Command"
					mono
					value={command}
					onChange={(e) => setCommand(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && save()}
					placeholder="npm run dev"
					spellCheck={false}
				/>
				<TextField
					label="Working directory (optional)"
					mono
					value={dir}
					onChange={(e) => setDir(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && save()}
					placeholder="repo root — e.g. apps/web"
					spellCheck={false}
				/>

				<div className={styles.field}>
					<span className={styles.label}>Run in</span>
					<Segmented value={runTarget} options={RUN_TARGETS} onChange={setRunTarget} />
				</div>
			</div>

			<div className={styles.actions}>
				<ModalClose className={styles.cancel}>Cancel</ModalClose>
				<Button variant="primary" disabled={!valid} onClick={save}>
					Save
				</Button>
			</div>
		</Modal>
	);
}
