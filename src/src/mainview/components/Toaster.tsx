import { dismiss, useToasts } from "../lib/toast";
import styles from "./Toaster.module.css";

export function Toaster() {
	const toasts = useToasts();
	if (toasts.length === 0) return null;

	return (
		<div className={styles.stack}>
			{toasts.map((t) => (
				<button
					key={t.id}
					className={styles.toast}
					data-tone={t.tone}
					onClick={() => dismiss(t.id)}
					title="Dismiss"
				>
					{t.message}
				</button>
			))}
		</div>
	);
}
