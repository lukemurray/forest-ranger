import { useEffect, useState } from "react";
import type { IntegrationStatus, IntegrationType } from "../../shared/types";
import { api } from "../rpc";
import { TextField } from "./ui/TextField";
import { Button } from "./ui/Button";
import { PlugIcon } from "./icons";
import styles from "./IntegrationsManager.module.css";

const META: Record<
	IntegrationType,
	{ label: string; blurb: string; tokenHint: string }
> = {
	github: {
		label: "GitHub",
		blurb:
			"Show pull-request and checks status on each worktree whose origin points at this GitHub host.",
		tokenHint: "Personal access token (classic or fine-grained) with repo read access.",
	},
	gitlab: {
		label: "GitLab",
		blurb:
			"Show merge-request and pipeline status on each worktree whose origin points at this GitLab host.",
		tokenHint: "Personal access token with the read_api scope.",
	},
};

export function IntegrationsManager() {
	const [items, setItems] = useState<IntegrationStatus[] | null>(null);

	function load() {
		api.listIntegrations({}).then(setItems);
	}
	useEffect(() => {
		load();
	}, []);

	if (!items) return <div className={styles.note}>Loading…</div>;

	return (
		<div className={styles.list}>
			{items.map((it) => (
				<IntegrationCard key={it.type} status={it} onSaved={load} />
			))}
		</div>
	);
}

function IntegrationCard({
	status,
	onSaved,
}: {
	status: IntegrationStatus;
	onSaved: () => void;
}) {
	const meta = META[status.type];
	const [enabled, setEnabled] = useState(status.enabled);
	const [host, setHost] = useState(status.host);
	const [token, setToken] = useState("");
	const [testing, setTesting] = useState(false);
	const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
	const [saving, setSaving] = useState(false);

	// Re-sync local fields when the saved status changes (e.g. after onSaved).
	useEffect(() => {
		setEnabled(status.enabled);
		setHost(status.host);
		setToken("");
	}, [status.enabled, status.host, status.hasToken]);

	async function test() {
		setTesting(true);
		setResult(null);
		const res = await api.testIntegration({
			type: status.type,
			host,
			token: token === "" ? null : token,
		});
		setTesting(false);
		setResult(
			res.ok
				? { ok: true, text: `Connected as ${res.user}` }
				: { ok: false, text: res.error ?? "Connection failed" },
		);
	}

	async function save(nextEnabled = enabled, clearToken = false) {
		setSaving(true);
		await api.setIntegration({
			type: status.type,
			enabled: nextEnabled,
			host,
			token: clearToken ? "" : token === "" ? null : token,
		});
		setSaving(false);
		setResult(null);
		onSaved();
	}

	return (
		<div className={styles.card} data-enabled={enabled || undefined}>
			<div className={styles.head}>
				<PlugIcon size={16} />
				<div className={styles.headText}>
					<div className={styles.name}>{meta.label}</div>
					<div className={styles.blurb}>{meta.blurb}</div>
				</div>
				<label className={styles.toggle}>
					<input
						type="checkbox"
						checked={enabled}
						onChange={(e) => {
							setEnabled(e.target.checked);
							void save(e.target.checked);
						}}
					/>
					{enabled ? "Enabled" : "Disabled"}
				</label>
			</div>

			<div className={styles.fields}>
				<TextField
					label="Host"
					mono
					value={host}
					onChange={(e) => setHost(e.target.value)}
					placeholder={status.type === "github" ? "github.com" : "https://gitlab.com"}
					spellCheck={false}
				/>
				<TextField
					label="Access token"
					type="password"
					value={token}
					onChange={(e) => setToken(e.target.value)}
					placeholder={
						status.hasToken ? "•••••••• saved — leave blank to keep" : "Paste token"
					}
					spellCheck={false}
				/>
				<p className={styles.hint}>{meta.tokenHint}</p>
			</div>

			<div className={styles.actions}>
				<Button variant="subtle" onClick={test} disabled={testing}>
					{testing ? "Testing…" : "Test connection"}
				</Button>
				{status.hasToken && (
					<Button variant="ghost" onClick={() => save(enabled, true)} disabled={saving}>
						Clear token
					</Button>
				)}
				<Button variant="primary" onClick={() => save()} disabled={saving}>
					{saving ? "Saving…" : "Save"}
				</Button>
				{result && (
					<span className={result.ok ? styles.ok : styles.err}>{result.text}</span>
				)}
			</div>
		</div>
	);
}
