import { useSyncExternalStore } from "react";

export type Toast = { id: number; message: string; tone: "error" | "info" };

let toasts: Toast[] = [];
let nextId = 0;
const listeners = new Set<() => void>();

function emit() {
	for (const fn of listeners) fn();
}

export function notify(message: string, tone: Toast["tone"] = "info") {
	const id = ++nextId;
	toasts = [...toasts, { id, message, tone }];
	emit();
	setTimeout(() => dismiss(id), 4000);
}

export function dismiss(id: number) {
	toasts = toasts.filter((t) => t.id !== id);
	emit();
}

function subscribe(fn: () => void) {
	listeners.add(fn);
	return () => listeners.delete(fn);
}

export function useToasts(): Toast[] {
	return useSyncExternalStore(subscribe, () => toasts);
}
