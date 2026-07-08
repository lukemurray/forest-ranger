import type { ReactNode } from "react";
import { Select as BaseSelect } from "@base-ui-components/react/select";
import { CheckIcon, ChevronUpDownIcon } from "../icons";
import styles from "./Select.module.css";

/** Base UI dropdown select with the app's styling. */
export function Select<T extends string>({
	value,
	onValueChange,
	options,
	ariaLabel,
	className,
	leading,
	renderValue,
}: {
	value: T;
	onValueChange: (value: T) => void;
	options: { value: T; label: string }[];
	ariaLabel?: string;
	className?: string;
	/** Optional content rendered inside the trigger, before the selected value. */
	leading?: ReactNode;
	/** Customize the selected value shown in the trigger (list items are unaffected). */
	renderValue?: (value: T) => ReactNode;
}) {
	const items = Object.fromEntries(options.map((o) => [o.value, o.label]));
	return (
		<BaseSelect.Root
			items={items}
			value={value}
			onValueChange={(v) => onValueChange(v as T)}
		>
			<BaseSelect.Trigger
				className={`${styles.trigger} ${className ?? ""}`}
				aria-label={ariaLabel}
			>
				{leading}
				{renderValue ? (
					<BaseSelect.Value>{(v: T) => renderValue(v)}</BaseSelect.Value>
				) : (
					<BaseSelect.Value />
				)}
				<BaseSelect.Icon className={styles.icon}>
					<ChevronUpDownIcon size={14} />
				</BaseSelect.Icon>
			</BaseSelect.Trigger>
			<BaseSelect.Portal>
				<BaseSelect.Positioner
					className={styles.positioner}
					sideOffset={4}
					alignItemWithTrigger={false}
				>
					<BaseSelect.Popup className={styles.popup}>
						{options.map((o) => (
							<BaseSelect.Item key={o.value} value={o.value} className={styles.item}>
								<BaseSelect.ItemText>{o.label}</BaseSelect.ItemText>
								<BaseSelect.ItemIndicator className={styles.indicator}>
									<CheckIcon size={14} />
								</BaseSelect.ItemIndicator>
							</BaseSelect.Item>
						))}
					</BaseSelect.Popup>
				</BaseSelect.Positioner>
			</BaseSelect.Portal>
		</BaseSelect.Root>
	);
}
