import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { api } from "../rpc";
import styles from "./Markdown.module.css";

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
				{text}
			</ReactMarkdown>
		</div>
	);
}
