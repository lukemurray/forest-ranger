import { useState } from "react";
import {
	addAgent,
	AGENT_PRESETS,
	removeAgent,
	useAgents,
} from "../lib/agents";
import { PlusIcon, TrashIcon } from "./icons";
import { Button } from "./ui/Button";
import { TextField } from "./ui/TextField";
import styles from "./AgentsManager.module.css";

/** Manage the app-level agent list (used in Settings and the quick dialog). */
export function AgentsManager() {
	const agents = useAgents();
	const [label, setLabel] = useState("");
	const [command, setCommand] = useState("");
	const [resume, setResume] = useState("");
	const [newSession, setNewSession] = useState("");

	const configured = new Set(agents.map((a) => a.command));
	const presets = AGENT_PRESETS.filter((p) => !configured.has(p.command));

	function addCustom() {
		if (label.trim() === "" || command.trim() === "") return;
		addAgent(label.trim(), command.trim(), resume.trim(), newSession.trim());
		setLabel("");
		setCommand("");
		setResume("");
		setNewSession("");
	}

	return (
		<div>
			{agents.length > 0 && (
				<ul className={styles.list}>
					{agents.map((a) => (
						<li key={a.id} className={styles.row}>
							<span className={styles.rowLabel}>{a.label}</span>
							<code className={styles.rowCommand}>{a.command}</code>
							<button
								className={styles.remove}
								onClick={() => removeAgent(a.id)}
								title="Remove"
							>
								<TrashIcon size={14} />
							</button>
						</li>
					))}
				</ul>
			)}

			{presets.length > 0 && (
				<div className={styles.presets}>
					<span className={styles.presetLabel}>Quick add</span>
					<div className={styles.presetChips}>
						{presets.map((p) => (
							<button
								key={p.command}
								className={styles.chip}
								onClick={() =>
								addAgent(p.label, p.command, p.resumeCommand, p.newSessionCommand)
							}
							>
								<PlusIcon size={12} /> {p.label}
							</button>
						))}
					</div>
				</div>
			)}

			<div className={styles.custom}>
				<span className={styles.presetLabel}>Custom</span>
				<div className={styles.customFields}>
					<TextField
						label="Label"
						value={label}
						onChange={(e) => setLabel(e.target.value)}
						placeholder="My Agent"
					/>
					<TextField
						label="Command"
						mono
						value={command}
						onChange={(e) => setCommand(e.target.value)}
						placeholder="command"
						spellCheck={false}
					/>
					<TextField
						label="New-session command (optional)"
						mono
						value={newSession}
						onChange={(e) => setNewSession(e.target.value)}
						placeholder="{id} = generated id"
						spellCheck={false}
					/>
					<TextField
						label="Resume command (optional)"
						mono
						value={resume}
						onChange={(e) => setResume(e.target.value)}
						onKeyDown={(e) => e.key === "Enter" && addCustom()}
						placeholder="e.g. claude --resume {id}"
						spellCheck={false}
					/>
					<div className={styles.customActions}>
						<Button variant="ghost" onClick={addCustom}>
							Add agent
						</Button>
					</div>
				</div>
			</div>
		</div>
	);
}
