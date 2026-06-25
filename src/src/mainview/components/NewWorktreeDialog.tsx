import { useEffect, useState } from "react";
import { api } from "../rpc";
import { useAgents, type Agent } from "../lib/agents";
import { tildePath } from "../lib/format";
import { BranchCombobox } from "./BranchCombobox";
import { Modal, ModalClose, ModalTitle } from "./ui/Modal";
import { Button } from "./ui/Button";
import { TextField } from "./ui/TextField";
import styles from "./NewWorktreeDialog.module.css";

export function NewWorktreeDialog({
	open,
	onOpenChange,
	projectId,
	onCreated,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	projectId: string;
	onCreated: (worktreeId: string, path: string, agent: Agent | null) => void;
}) {
	const agents = useAgents();
	const [branches, setBranches] = useState<string[]>([]);
	const [name, setName] = useState("");
	const [base, setBase] = useState("");
	const [location, setLocation] = useState("");
	const [agentId, setAgentId] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!open) return;
		setName("");
		setError(null);
		setBusy(false);
		setAgentId(agents[0]?.id ?? "");
		api.projectBranches({ projectId }).then((r) => {
			setBranches(r.branches);
			setBase(r.base ?? "");
			setLocation(tildePath(r.worktreeDir));
		});
		// agents read once on open; intentionally not a dep
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [open, projectId]);

	async function create() {
		setBusy(true);
		setError(null);
		const res = await api.createWorktree({
			projectId,
			name,
			base: base || null,
			location: location.trim() || null,
		});
		setBusy(false);
		if (!res.ok || !res.worktreeId) {
			setError(res.error ?? "Failed to create worktree");
			return;
		}
		onCreated(
			res.worktreeId,
			res.path ?? "",
			agents.find((a) => a.id === agentId) ?? null,
		);
		onOpenChange(false);
	}

	return (
		<Modal open={open} onOpenChange={onOpenChange} width={420}>
			<ModalTitle className={styles.title}>New worktree</ModalTitle>

			<div className={styles.fields}>
				<TextField
					label="Branch name (optional)"
					mono
					value={name}
					onChange={(e) => setName(e.target.value)}
					onKeyDown={(e) => e.key === "Enter" && !busy && create()}
					placeholder="auto-generated if blank"
					spellCheck={false}
					autoFocus
				/>

				<div className={styles.field}>
					<span className={styles.label}>Base branch</span>
					<BranchCombobox
						value={base}
						branches={branches}
						onSelect={setBase}
						placeholder="current HEAD"
						block
					/>
				</div>

				<TextField
					label="Location"
					mono
					value={location}
					onChange={(e) => setLocation(e.target.value)}
					spellCheck={false}
					placeholder="~/path/to/worktrees"
				/>

				<label className={styles.field}>
					<span className={styles.label}>Launch agent</span>
					<select
						className={styles.select}
						value={agentId}
						onChange={(e) => setAgentId(e.target.value)}
					>
						<option value="">None</option>
						{agents.map((a) => (
							<option key={a.id} value={a.id}>
								{a.label}
							</option>
						))}
					</select>
				</label>
			</div>

			{error && <p className={styles.error}>{error}</p>}

			<div className={styles.actions}>
				<ModalClose className={styles.cancel}>Cancel</ModalClose>
				<Button variant="primary" onClick={create} disabled={busy}>
					{busy ? "Creating…" : "Create worktree"}
				</Button>
			</div>
		</Modal>
	);
}
