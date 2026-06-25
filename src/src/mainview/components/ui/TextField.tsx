import type { InputHTMLAttributes, ReactNode } from "react";
import styles from "./TextField.module.css";

/** Labeled text input used across dialogs/forms. */
export function TextField({
	label,
	mono,
	className,
	...rest
}: {
	label?: ReactNode;
	mono?: boolean;
} & InputHTMLAttributes<HTMLInputElement>) {
	const input = (
		<input
			className={`${styles.input} ${mono ? styles.mono : ""} ${className ?? ""}`}
			{...rest}
		/>
	);
	if (!label) return input;
	return (
		<label className={styles.field}>
			<span className={styles.label}>{label}</span>
			{input}
		</label>
	);
}
