import styles from "./Segmented.module.css";

/** Segmented single-select control (e.g. run target). */
export function Segmented<T extends string>({
	value,
	options,
	onChange,
}: {
	value: T;
	options: { value: T; label: string }[];
	onChange: (value: T) => void;
}) {
	return (
		<div className={styles.segmented}>
			{options.map((o) => (
				<button
					key={o.value}
					type="button"
					data-active={value === o.value || undefined}
					onClick={() => onChange(o.value)}
				>
					{o.label}
				</button>
			))}
		</div>
	);
}
