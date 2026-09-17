import { useEffect, useRef, useState } from "react";
import * as monaco from "monaco-editor";
import { api } from "../rpc";
import { useThemeMode, type ThemeMode } from "../lib/theme";
import { getViewState, monacoLang, monacoTheme, saveViewState } from "../lib/monaco";
import styles from "./DiffView.module.css";

function isDark(mode: ThemeMode): boolean {
	return (
		mode === "dark" ||
		(mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches)
	);
}

type Contents = { before: string; after: string; binary: boolean };

/**
 * A file's diff in a Monaco diff editor — a single commit's change when `commit`
 * is given, else committed-vs-`base`, else HEAD vs the working tree.
 */
export function DiffView({
	worktreeId,
	path,
	base,
	commit,
	header = true,
}: {
	worktreeId: string;
	path: string;
	base: string | null;
	commit?: string;
	header?: boolean;
}) {
	const [data, setData] = useState<Contents | null>(null);
	const dark = isDark(useThemeMode());
	const hostRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		let live = true;
		setData(null);
		api.fileContents({ id: worktreeId, path, base, commit }).then((d) => live && setData(d));
		return () => {
			live = false;
		};
	}, [worktreeId, path, base, commit]);

	// Build the diff editor once the contents arrive; tear it down on change/unmount.
	useEffect(() => {
		const host = hostRef.current;
		if (!host || !data || data.binary) return;
		const lang = monacoLang(path);
		const original = monaco.editor.createModel(data.before, lang);
		const modified = monaco.editor.createModel(data.after, lang);
		const editor = monaco.editor.createDiffEditor(host, {
			readOnly: true,
			renderSideBySide: true,
			automaticLayout: true,
			minimap: { enabled: false },
			scrollBeyondLastLine: false,
			renderOverviewRuler: false,
			fontSize: 12,
		});
		editor.setModel({ original, modified });
		// Land back on the same scroll position when returning to this diff tab.
		const viewKey = `diff:${worktreeId}:${commit ?? ""}:${base ?? ""}:${path}`;
		const saved = getViewState(viewKey) as monaco.editor.IDiffEditorViewState | null;
		if (saved) editor.restoreViewState(saved);
		return () => {
			saveViewState(viewKey, editor.saveViewState());
			editor.dispose();
			original.dispose();
			modified.dispose();
		};
	}, [data, path, worktreeId, base, commit]);

	// Theme is a global Monaco setting — apply the app's resolved light/dark.
	useEffect(() => {
		monaco.editor.setTheme(monacoTheme(dark));
	}, [dark]);

	const ref = commit ? `@ ${commit.slice(0, 8)}` : base ? `vs ${base}` : "working tree";

	return (
		<div className={styles.pane}>
			{header && (
				<div className={styles.header}>
					<span className={styles.path} title={path}>
						{path}
					</span>
					<span className={styles.ref}>{ref}</span>
				</div>
			)}
			<div className={styles.body}>
				{data === null ? (
					<div className={styles.note}>Loading diff…</div>
				) : data.binary ? (
					<div className={styles.note}>Binary file — no text diff.</div>
				) : data.before === "" && data.after === "" ? (
					<div className={styles.note}>No changes.</div>
				) : (
					<div ref={hostRef} className={styles.editor} />
				)}
			</div>
		</div>
	);
}
