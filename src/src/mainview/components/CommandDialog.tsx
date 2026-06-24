import { useEffect, useState } from "react";
import { Dialog } from "@base-ui-components/react/dialog";
import type { RunTarget } from "../../shared/types";
import styles from "./CommandDialog.module.css";

export function CommandDialog({
	open,
	onOpenChange,
	title,
	initialLabel = "",
	initialCommand = "",
	initialDir = "",
	initialRunTarget = "in-app",
	onSubmit,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	initialLabel?: string;
	initialCommand?: string;
	initialDir?: string;
	initialRunTarget?: RunTarget;
	onSubmit: (
		label: string,
		command: string,
		dir: string,
		runTarget: RunTarget,
	) => void;
}) {
	const [label, setLabel] = useState(initialLabel);
	const [command, setCommand] = useState(initialCommand);
	const [dir, setDir] = useState(initialDir);
	const [runTarget, setRunTarget] = useState<RunTarget>(initialRunTarget);

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
		<Dialog.Root open={open} onOpenChange={onOpenChange}>
			<Dialog.Portal>
				<Dialog.Backdrop className={styles.backdrop} />
				<Dialog.Popup className={styles.popup}>
					<Dialog.Title className={styles.title}>{title}</Dialog.Title>

					<label className={styles.field}>
						<span>Label</span>
						<input
							className={styles.input}
							value={label}
							onChange={(e) => setLabel(e.target.value)}
							placeholder="Run"
							autoFocus
						/>
					</label>
					<label className={styles.field}>
						<span>Command</span>
						<input
							className={styles.input}
							value={command}
							onChange={(e) => setCommand(e.target.value)}
							onKeyDown={(e) => e.key === "Enter" && save()}
							placeholder="npm run dev"
							spellCheck={false}
						/>
					</label>
					<label className={styles.field}>
						<span>Working directory (optional)</span>
						<input
							className={styles.input}
							value={dir}
							onChange={(e) => setDir(e.target.value)}
							onKeyDown={(e) => e.key === "Enter" && save()}
							placeholder="repo root — e.g. apps/web"
							spellCheck={false}
						/>
					</label>

					<div className={styles.field}>
						<span>Run in</span>
						<div className={styles.segmented}>
							<button
								type="button"
								data-active={runTarget === "in-app" || undefined}
								onClick={() => setRunTarget("in-app")}
							>
								In-app terminal
							</button>
							<button
								type="button"
								data-active={runTarget === "external" || undefined}
								onClick={() => setRunTarget("external")}
							>
								External terminal
							</button>
						</div>
					</div>

					<div className={styles.actions}>
						<Dialog.Close className={styles.cancel}>Cancel</Dialog.Close>
						<button className={styles.save} disabled={!valid} onClick={save}>
							Save
						</button>
					</div>
				</Dialog.Popup>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
