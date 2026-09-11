/**
 * A small per-worktree memory of recently-opened files (most recent first),
 * persisted in localStorage. Feeds ⌘P ordering so files you've touched surface
 * first. Keyed by worktree so each has its own recency.
 */
const KEY = "forest-ranger:recent-files";
const MAX = 100;

type Store = Record<string, string[]>;

function read(): Store {
	try {
		const v = JSON.parse(localStorage.getItem(KEY) || "{}");
		return v && typeof v === "object" ? v : {};
	} catch {
		return {};
	}
}

function write(s: Store) {
	try {
		localStorage.setItem(KEY, JSON.stringify(s));
	} catch {
		/* ignore */
	}
}

/** Note that a file was opened in a worktree (moves it to the front). */
export function recordRecentFile(worktreeId: string, path: string) {
	const s = read();
	const list = [path, ...(s[worktreeId] ?? []).filter((p) => p !== path)].slice(0, MAX);
	s[worktreeId] = list;
	write(s);
}

/** path → recency index (0 = most recent) for a worktree; missing = not recent. */
export function recentRank(worktreeId: string): Map<string, number> {
	const m = new Map<string, number>();
	(read()[worktreeId] ?? []).forEach((p, i) => m.set(p, i));
	return m;
}
