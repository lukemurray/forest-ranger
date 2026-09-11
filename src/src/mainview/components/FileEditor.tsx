import { useEffect, useRef, useState } from "react";
import * as monaco from "monaco-editor";
import { api } from "../rpc";
import { notify } from "../lib/toast";
import { useThemeMode, type ThemeMode } from "../lib/theme";
import { monacoLang, monacoTheme } from "../lib/monaco";
import styles from "./DiffView.module.css";

function isDark(mode: ThemeMode): boolean {
	return (
		mode === "dark" ||
		(mode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches)
	);
}

/** Edit a working-tree file in Monaco. ⌘S / the Save button writes it to disk. */
export function FileEditor({ worktreeId, path }: { worktreeId: string; path: string }) {
	const [state, setState] = useState<{ content: string; binary: boolean } | null>(null);
	const [dirty, setDirty] = useState(false);
	const [saving, setSaving] = useState(false);
	const hostRef = useRef<HTMLDivElement>(null);
	const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
	const saveRef = useRef<() => void>(() => {});
	const dark = isDark(useThemeMode());

	useEffect(() => {
		let live = true;
		api.readFile({ id: worktreeId, path }).then((r) => {
			if (!live) return;
			setState({ content: r.content, binary: r.binary });
			setDirty(false);
		});
		return () => {
			live = false;
		};
	}, [worktreeId, path]);

	// Build the editor once the file has loaded (and isn't binary).
	useEffect(() => {
		const host = hostRef.current;
		if (!host || !state || state.binary) return;

		const save = async () => {
			const ed = editorRef.current;
			if (!ed) return;
			setSaving(true);
			const res = await api.writeFile({ id: worktreeId, path, content: ed.getValue() });
			setSaving(false);
			if (res.ok) setDirty(false);
			else notify(res.error ?? "Save failed", "error");
		};

		const editor = monaco.editor.create(host, {
			value: state.content,
			language: monacoLang(path),
			automaticLayout: true,
			minimap: { enabled: false },
			scrollBeyondLastLine: false,
			fontSize: 12,
		});
		editorRef.current = editor;
		editor.onDidChangeModelContent(() => setDirty(true));
		editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void save());
		saveRef.current = save;
		return () => {
			editor.dispose();
			editorRef.current = null;
		};
	}, [state, path, worktreeId]);

	// Theme is a global Monaco setting.
	useEffect(() => {
		monaco.editor.setTheme(monacoTheme(dark));
	}, [dark]);

	return (
		<div className={styles.pane}>
			<div className={styles.header}>
				<span className={styles.path} title={path}>
					{dirty ? "● " : ""}
					{path}
				</span>
				<div className={styles.actions}>
					<button
						className={styles.saveBtn}
						onClick={() => saveRef.current()}
						disabled={!dirty || saving}
					>
						{saving ? "Saving…" : "Save"}
					</button>
				</div>
			</div>
			<div className={styles.body}>
				{state === null ? (
					<div className={styles.note}>Loading…</div>
				) : state.binary ? (
					<div className={styles.note}>Binary file — can't edit as text.</div>
				) : (
					<div ref={hostRef} className={styles.editor} />
				)}
			</div>
		</div>
	);
}
