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
	const [signingIn, setSigningIn] = useState(false);
	const [clientId, setClientId] = useState(status.clientId ?? "");
	const isGitLab = status.type === "gitlab";
	const signedIn = isGitLab && status.signedInAs != null;
	// The provider's CLI: gh for GitHub, glab for GitLab.
	const cli = status.type === "github" ? "gh" : "glab";
	const viaCli = status.cliUser != null;
	const [cliBusy, setCliBusy] = useState(false);

	/** Connect through the CLI's existing login (or stop using it). */
	async function connectCli(enable: boolean) {
		setCliBusy(true);
		setResult(null);
		const res = await api.integrationUseCli({ type: status.type, host, enable });
		setCliBusy(false);
		if (!res.ok) setResult({ ok: false, text: res.error ?? `Couldn't use ${cli}` });
		else if (enable) setResult({ ok: true, text: `Connected via ${cli} as ${res.user}` });
		onSaved();
	}

	async function signIn() {
		setSigningIn(true);
		setResult(null);
		const res = await api.gitlabSignIn({ host, clientId: clientId.trim() || undefined });
		setSigningIn(false);
		setResult(res.ok ? { ok: true, text: `Signed in as ${res.user}` } : { ok: false, text: res.error ?? "Sign-in failed" });
		if (res.ok) onSaved();
	}
	async function signOut() {
		await api.gitlabSignOut({});
		setResult(null);
		onSaved();
	}

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

			<div className={styles.signIn}>
				{viaCli ? (
					<>
						<span className={styles.ok}>
							Connected via {cli}
							{status.cliUser ? ` as @${status.cliUser}` : ""}
						</span>
						<Button variant="ghost" onClick={() => connectCli(false)} disabled={cliBusy}>
							Disconnect
						</Button>
					</>
				) : (
					<>
						<Button variant="primary" onClick={() => connectCli(true)} disabled={cliBusy}>
							{cliBusy ? `Checking ${cli}…` : `Use ${cli} sign-in`}
						</Button>
						<span className={styles.hint}>
							Uses your <code>{cli}</code> CLI login — nothing to set up on {meta.label}.
						</span>
					</>
				)}
			</div>
			{isGitLab && !viaCli && (
				<div className={styles.signIn}>
					{signedIn ? (
						<>
							<span className={styles.ok}>
								Signed in{status.signedInAs ? ` as @${status.signedInAs}` : ""}
							</span>
							<Button variant="ghost" onClick={signOut}>
								Sign out
							</Button>
						</>
					) : (
						<>
							<Button variant="subtle" onClick={signIn} disabled={signingIn}>
								{signingIn ? "Waiting for your browser…" : "Sign in with GitLab"}
							</Button>
							<span className={styles.hint}>
								{signingIn
									? "Approve Forest Ranger on the GitLab page that opened."
									: "Opens GitLab in your browser — no token to create or paste."}
							</span>
						</>
					)}
				</div>
			)}
			{isGitLab && !signedIn && !viaCli && (!status.oauthReady || status.clientId) && (
				<div className={styles.fields}>
					<TextField
						label="Application ID"
						mono
						value={clientId}
						onChange={(e) => setClientId(e.target.value)}
						placeholder="From GitLab → Applications"
						spellCheck={false}
					/>
					<p className={styles.hint}>
						Sign-in needs a GitLab OAuth application, registered once (Edit profile →
						Applications, or a group's Settings → Applications): redirect URI{" "}
						<code>http://127.0.0.1:33417/oauth/callback</code>, <b>Confidential</b>{" "}
						unchecked, scope <code>api</code>. Paste its Application ID here.
					</p>
				</div>
			)}

			<div className={styles.fields}>
				<TextField
					label="Host"
					mono
					value={host}
					onChange={(e) => setHost(e.target.value)}
					placeholder={status.type === "github" ? "github.com" : "https://gitlab.com"}
					spellCheck={false}
				/>
				{isGitLab && !signedIn && !viaCli && (
					<p className={styles.hint}>Or use a personal access token:</p>
				)}
				{!signedIn && !viaCli && (
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
				)}
				{!signedIn && !viaCli && <p className={styles.hint}>{meta.tokenHint}</p>}
			</div>

			<div className={styles.actions}>
				<Button variant="subtle" onClick={test} disabled={testing}>
					{testing ? "Testing…" : "Test connection"}
				</Button>
				{status.hasToken && !viaCli && !signedIn && (
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
