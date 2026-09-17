import type { ChatDiff } from "../../shared/types";
import { collapseContext, diffStat, lineDiff } from "../lib/lineDiff";
import styles from "./AgentDiff.module.css";

/**
 * A compact, colorized inline preview of an agent's file edit(s) — one hunk-style
 * block per file, with a "View diff" action that opens the full Monaco side-by-side
 * diff in a tab. No Monaco here, so many edits in a transcript stay cheap.
 */
export function AgentDiff({ diffs, onOpen }: { diffs: ChatDiff[]; onOpen: (path: string) => void }) {
	return (
		<div className={styles.wrap}>
			{diffs.map((d, i) => (
				<FileDiff key={`${d.path}:${i}`} diff={d} onOpen={onOpen} />
			))}
		</div>
	);
}

function FileDiff({ diff, onOpen }: { diff: ChatDiff; onOpen: (path: string) => void }) {
	const lines = lineDiff(diff.oldText ?? "", diff.newText);
	const { add, del } = diffStat(lines);
	const shown = collapseContext(lines);
	const name = diff.path.split("/").pop() ?? diff.path;
	return (
		<div className={styles.file}>
			<div className={styles.head}>
				<span className={styles.name} title={diff.path}>
					{name}
				</span>
				<span className={styles.stat}>
					{add > 0 && <span className={styles.add}>+{add}</span>}
					{del > 0 && <span className={styles.del}>−{del}</span>}
				</span>
				<button className={styles.view} onClick={() => onOpen(diff.path)} title="Open side-by-side diff">
					View diff
				</button>
			</div>
			<div className={styles.body}>
				{shown.map((l, i) =>
					l === null ? (
						<div key={i} className={styles.gap} aria-hidden>
							⋯
						</div>
					) : (
						<div key={i} className={styles.line} data-type={l.type}>
							<span className={styles.sign}>{l.type === "add" ? "+" : l.type === "del" ? "−" : " "}</span>
							<span className={styles.text}>{l.text || " "}</span>
						</div>
					),
				)}
			</div>
		</div>
	);
}
