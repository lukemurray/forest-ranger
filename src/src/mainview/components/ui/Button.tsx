import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import styles from "./Button.module.css";

type Variant = "primary" | "success" | "ghost" | "dashed" | "danger" | "subtle";

/** App button with shared variants, replacing the many bespoke button classes. */
export const Button = forwardRef<
	HTMLButtonElement,
	{ variant?: Variant; icon?: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>
>(function Button({ variant = "ghost", icon, children, className, ...rest }, ref) {
	return (
		<button
			ref={ref}
			className={`${styles.button} ${styles[variant]} ${className ?? ""}`}
			{...rest}
		>
			{icon}
			{children}
		</button>
	);
});
