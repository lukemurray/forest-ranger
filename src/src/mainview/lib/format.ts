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

/** Compact elapsed duration since a ms timestamp: "0:42", "3:07", "1h 12m". */
export function elapsed(sinceMs: number): string {
	const sec = Math.max(0, Math.floor((Date.now() - sinceMs) / 1000));
	if (sec < 3600) {
		const m = Math.floor(sec / 60);
		const s = sec % 60;
		return `${m}:${String(s).padStart(2, "0")}`;
	}
	const h = Math.floor(sec / 3600);
	const m = Math.floor((sec % 3600) / 60);
	return `${h}h ${m}m`;
}

/** Exact local date+time for a hover tooltip: "Sep 10, 2026, 2:41:03 PM". */
export function clockTime(ms: number): string {
	return new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "medium" });
}

/** Divider label: bare time ("2:41 PM") if today, else with a short date. */
export function timeDivider(ms: number): string {
	const d = new Date(ms);
	const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
	const today = new Date();
	const sameDay = d.toDateString() === today.toDateString();
	if (sameDay) return time;
	const date = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
	return `${date} · ${time}`;
}

export function shortHash(head: string | null): string {
	return head ? head.slice(0, 7) : "—";
}

/** Collapse the user's home dir to ~ for compact path display. */
export function tildePath(path: string): string {
	return path.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
}

/** Split "a/b/c.ts" into dir ("a/b/") and name ("c.ts") for two-tone display. */
export function splitPath(path: string): { dir: string; name: string } {
	const i = path.lastIndexOf("/");
	return i === -1
		? { dir: "", name: path }
		: { dir: path.slice(0, i + 1), name: path.slice(i + 1) };
}
