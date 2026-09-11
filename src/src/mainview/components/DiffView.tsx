import { useEffect, useState } from "react";
import {
	Diff as DiffViewer,
	Hunk,
	markEdits,
	parseDiff,
	tokenize,
	type HunkData,
} from "react-diff-view";
import { refractor } from "refractor";
import "react-diff-view/style/index.css";
import type { FileDiff } from "../../shared/types";
import { api } from "../rpc";
import styles from "./DiffView.module.css";

/**
 * A file's unified diff, fetched on demand — a single commit's change when
 * `commit` is given, else committed-vs-`base`, else the working-tree diff. Used
 * both inline (the review list) and as a standalone pane/tab in the workspace.
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
	/** Show the file-path header strip (for the standalone pane); off inline. */
	header?: boolean;
}) {
	const [diff, setDiff] = useState<FileDiff | null>(null);

	useEffect(() => {
		let live = true;
		setDiff(null);
		api.fileDiff({ id: worktreeId, path, base, commit }).then((d) => live && setDiff(d));
		return () => {
			live = false;
		};
	}, [worktreeId, path, base, commit]);

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
				{diff === null ? (
					<div className={styles.note}>Loading diff…</div>
				) : diff.binary ? (
					<div className={styles.note}>Binary file — no text diff.</div>
				) : diff.diff.trim() === "" ? (
					<div className={styles.note}>No diff available.</div>
				) : (
					<Rendered diffText={diff.diff} path={path} />
				)}
			</div>
		</div>
	);
}

function Rendered({ diffText, path }: { diffText: string; path: string }) {
	const files = parseDiff(diffText);
	const file = files[0];
	if (!file || file.hunks.length === 0) {
		return <div className={styles.note}>No diff available.</div>;
	}

	const lang = langForPath(path);
	let tokens;
	try {
		tokens = tokenize(file.hunks as HunkData[], {
			highlight: !!lang,
			refractor,
			language: lang as string,
			enhancers: [markEdits(file.hunks as HunkData[], { type: "block" })],
		});
	} catch {
		tokens = undefined;
	}

	return (
		<div className={styles.diff}>
			<DiffViewer viewType="unified" diffType={file.type} hunks={file.hunks} tokens={tokens}>
				{(hunks) => hunks.map((h) => <Hunk key={h.content} hunk={h} />)}
			</DiffViewer>
		</div>
	);
}

const LANG_BY_EXT: Record<string, string> = {
	ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
	mjs: "javascript", cjs: "javascript", json: "json", css: "css",
	scss: "scss", less: "less", html: "markup", xml: "markup", vue: "markup",
	svelte: "markup", md: "markdown", mdx: "markdown", py: "python", rb: "ruby",
	go: "go", rs: "rust", java: "java", kt: "kotlin", c: "c", h: "c",
	cpp: "cpp", cc: "cpp", hpp: "cpp", cs: "csharp", php: "php", swift: "swift",
	sh: "bash", bash: "bash", zsh: "bash", yml: "yaml", yaml: "yaml",
	toml: "toml", sql: "sql", graphql: "graphql", gql: "graphql",
};

function langForPath(path: string): string | undefined {
	const ext = path.split(".").pop()?.toLowerCase();
	const lang = ext ? LANG_BY_EXT[ext] : undefined;
	return lang && refractor.registered(lang) ? lang : undefined;
}
