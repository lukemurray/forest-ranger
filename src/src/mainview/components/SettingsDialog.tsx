import { useEffect, useState, type ReactNode } from "react";
import { Modal, ModalClose, ModalTitle } from "./ui/Modal";
import type { AppId, OpenApp, RunTarget } from "../../shared/types";
import { setThemeMode, useThemeMode, type ThemeMode } from "../lib/theme";
import { setDefaultRunTarget, useDefaultRunTarget } from "../lib/runTarget";
import {
	listEditors,
	listTerminals,
	resolveDefaults,
	setEditor,
	setTerminal,
	useEditor,
	useTerminal,
} from "../lib/openTargets";
import { AgentsManager } from "./AgentsManager";
import { CheckIcon } from "./icons";
import styles from "./SettingsDialog.module.css";

type Section = "general" | "apps" | "agents";

const SECTIONS: { id: Section; label: string }[] = [
	{ id: "general", label: "General" },
	{ id: "apps", label: "Applications" },
	{ id: "agents", label: "Agents" },
];

const RUN_OPTIONS: { value: RunTarget; label: string }[] = [
	{ value: "in-app", label: "In-app terminal" },
	{ value: "external", label: "External terminal" },
];
const THEME_OPTIONS: { value: ThemeMode; label: string }[] = [
	{ value: "system", label: "Follow system" },
	{ value: "light", label: "Light" },
	{ value: "dark", label: "Dark" },
];

function Option({
	selected,
	label,
	onClick,
}: {
	selected: boolean;
	label: string;
	onClick: () => void;
}) {
	return (
		<button className={styles.option} data-selected={selected || undefined} onClick={onClick}>
			<span>{label}</span>
			{selected && <CheckIcon size={15} />}
		</button>
	);
}

function Group({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className={styles.group}>
			<div className={styles.groupLabel}>{label}</div>
			<div className={styles.options}>{children}</div>
		</div>
	);
}

export function SettingsDialog({
	open,
	onOpenChange,
	initialSection = "general",
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	initialSection?: Section;
}) {
	const [section, setSection] = useState<Section>(initialSection);
	const mode = useThemeMode();
	const runTarget = useDefaultRunTarget();
	const editor = useEditor();
	const terminal = useTerminal();
	const [editors, setEditors] = useState<OpenApp[]>([]);
	const [terminals, setTerminals] = useState<OpenApp[]>([]);

	useEffect(() => {
		if (!open) return;
		setSection(initialSection);
		listEditors().then(setEditors);
		listTerminals().then(setTerminals);
		resolveDefaults();
	}, [open, initialSection]);

	return (
		<Modal
			open={open}
			onOpenChange={onOpenChange}
			width={680}
			padded={false}
			className={styles.popup}
		>
			<nav className={styles.sidebar}>
				<ModalTitle className={styles.sidebarTitle}>Settings</ModalTitle>
						{SECTIONS.map((s) => (
							<button
								key={s.id}
								className={styles.navItem}
								data-active={section === s.id || undefined}
								onClick={() => setSection(s.id)}
							>
								{s.label}
							</button>
						))}
					</nav>

					<div className={styles.content}>
						{section === "general" && (
							<>
								<Group label="Run commands & agents in">
									{RUN_OPTIONS.map((o) => (
										<Option
											key={o.value}
											label={o.label}
											selected={runTarget === o.value}
											onClick={() => setDefaultRunTarget(o.value)}
										/>
									))}
								</Group>
								<Group label="Theme">
									{THEME_OPTIONS.map((o) => (
										<Option
											key={o.value}
											label={o.label}
											selected={mode === o.value}
											onClick={() => setThemeMode(o.value)}
										/>
									))}
								</Group>
							</>
						)}

						{section === "apps" && (
							<>
								<Group label="Editor">
									{editors.length === 0 ? (
										<div className={styles.note}>No editors found</div>
									) : (
										editors.map((a) => (
											<Option
												key={a.id}
												label={a.label}
												selected={editor === a.id}
												onClick={() => setEditor(a.id as AppId)}
											/>
										))
									)}
								</Group>
								<Group label="Terminal">
									{terminals.length === 0 ? (
										<div className={styles.note}>No terminals found</div>
									) : (
										terminals.map((a) => (
											<Option
												key={a.id}
												label={a.label}
												selected={terminal === a.id}
												onClick={() => setTerminal(a.id as AppId)}
											/>
										))
									)}
								</Group>
							</>
						)}

						{section === "agents" && (
							<Group label="Agents">
								<AgentsManager />
							</Group>
						)}
					</div>

					<ModalClose className={styles.close}>Done</ModalClose>
		</Modal>
	);
}
