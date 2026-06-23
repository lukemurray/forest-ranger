/** "3m ago", "2h ago", "5d ago" — compact relative time from a ms timestamp. */
export function relativeTime(ms: number | null): string {
	if (!ms) return "—";
	const diff = Date.now() - ms;
	const sec = Math.round(diff / 1000);
	if (sec < 60) return "just now";
	const min = Math.round(sec / 60);
	if (min < 60) return `${min}m ago`;
	const hr = Math.round(min / 60);
	if (hr < 24) return `${hr}h ago`;
	const day = Math.round(hr / 24);
	if (day < 30) return `${day}d ago`;
	const mo = Math.round(day / 30);
	if (mo < 12) return `${mo}mo ago`;
	return `${Math.round(mo / 12)}y ago`;
}

export function shortHash(head: string | null): string {
	return head ? head.slice(0, 7) : "—";
}

/** Collapse the user's home dir to ~ for compact path display. */
export function tildePath(path: string): string {
	return path.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
}
