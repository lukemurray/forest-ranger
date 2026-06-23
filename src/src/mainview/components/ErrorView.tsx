import { useState } from "react";
import { useRouter } from "@tanstack/react-router";
import styles from "./ErrorView.module.css";

export function ErrorView({ error }: { error: Error }) {
	const router = useRouter();
	const [retrying, setRetrying] = useState(false);

	async function retry() {
		setRetrying(true);
		try {
			await router.invalidate();
		} finally {
			setRetrying(false);
		}
	}

	return (
		<div className={styles.root}>
			<div className={`${styles.titlebar} electrobun-webkit-app-region-drag`} />
			<div className={styles.center}>
				<div className={styles.card}>
					<h2 className={styles.title}>Couldn't load</h2>
					<p className={styles.message}>{error.message}</p>
					<button
						className={styles.retry}
						onClick={retry}
						disabled={retrying}
					>
						{retrying ? "Retrying…" : "Retry"}
					</button>
				</div>
			</div>
		</div>
	);
}
