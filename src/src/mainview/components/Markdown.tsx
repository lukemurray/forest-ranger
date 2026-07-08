import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "../rpc";
import styles from "./Markdown.module.css";

/**
 * Stabilize a still-streaming markdown tail so incomplete constructs don't flash
 * as the wrong element before the rest arrives. We re-render live on every token
 * (so partial markdown resolves into its final form as text streams in); this
 * just prevents the *last, not-yet-complete* line from rendering prematurely —
 * e.g. a lone `---` that's about to become a table delimiter or heading, or an
 * unterminated code fence.
 */
function stabilizeStreamingTail(text: string): string {
	let t = text;
	// Odd number of fences → one is still open; close it so the tail renders as a
	// code block instead of leaking. No-op once the closing fence streams in.
	const fences = (t.match(/^\s{0,3}```/gm) ?? []).length;
	if (fences % 2 === 1) t += "\n```";
	// A bare rule as the final line is almost always an in-progress table
	// delimiter / heading underline — hold it until the next line arrives so it
	// doesn't flash as a horizontal rule.
	t = t.replace(/\n[ \t]{0,3}(?:-{3,}|\*{3,}|_{3,})[ \t]*$/, "");
	return t;
}

/**
 * Full Markdown rendering for chat messages (GFM: tables, task lists,
 * strikethrough, autolinks, …) via react-markdown. Element styling lives in the
 * CSS module under `.md`; links are intercepted to open in the OS browser.
 */
export function Markdown({ text }: { text: string }) {
	return (
		<div className={styles.md}>
			<ReactMarkdown
				remarkPlugins={[remarkGfm]}
				components={{
					a: ({ href, children }) => (
						<a
							onClick={(e) => {
								e.preventDefault();
								if (href) api.openUrl({ url: href });
							}}
						>
							{children}
						</a>
					),
				}}
			>
				{stabilizeStreamingTail(text)}
			</ReactMarkdown>
		</div>
	);
}
