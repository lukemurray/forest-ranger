export type DiffLine = { type: "ctx" | "add" | "del"; text: string };

// LCS is O(m·n) in memory; cap it so a huge pasted edit can't allocate a giant
// table. Past the cap we fall back to a coarse "replace whole thing" diff — the
// inline preview stays cheap and the user opens Monaco for the real thing.
// ponytail: O(m·n) LCS, cap protects the pathological case; swap for Myers if it bites.
const MAX_CELLS = 2_000_000;

/**
 * Line-level diff of two texts (LCS backtrack). Returns every line tagged
 * context / added / removed, in order — good enough to render an edit inline.
 */
export function lineDiff(oldText: string, newText: string): DiffLine[] {
	const a = oldText.length ? oldText.split("\n") : [];
	const b = newText.length ? newText.split("\n") : [];
	const m = a.length;
	const n = b.length;
	if (m * n > MAX_CELLS) {
		return [
			...a.map((text): DiffLine => ({ type: "del", text })),
			...b.map((text): DiffLine => ({ type: "add", text })),
		];
	}
	// dp[i][j] = LCS length of a[i:] and b[j:].
	const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
	for (let i = m - 1; i >= 0; i--) {
		for (let j = n - 1; j >= 0; j--) {
			dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
		}
	}
	const out: DiffLine[] = [];
	let i = 0;
	let j = 0;
	while (i < m && j < n) {
		if (a[i] === b[j]) out.push({ type: "ctx", text: a[i++] }), j++;
		else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ type: "del", text: a[i++] });
		else out.push({ type: "add", text: b[j++] });
	}
	while (i < m) out.push({ type: "del", text: a[i++] });
	while (j < n) out.push({ type: "add", text: b[j++] });
	return out;
}

/** Added / removed line counts, for the diff header. */
export function diffStat(lines: DiffLine[]): { add: number; del: number } {
	let add = 0;
	let del = 0;
	for (const l of lines) {
		if (l.type === "add") add++;
		else if (l.type === "del") del++;
	}
	return { add, del };
}

/**
 * Collapse long runs of unchanged context to keep the inline preview compact:
 * keep `pad` context lines around each change, replace the rest with a gap
 * marker (null). Leading/trailing context beyond `pad` is dropped too.
 */
export function collapseContext(lines: DiffLine[], pad = 3): (DiffLine | null)[] {
	const keep = new Array(lines.length).fill(false);
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].type !== "ctx") {
			for (let k = Math.max(0, i - pad); k <= Math.min(lines.length - 1, i + pad); k++) keep[k] = true;
		}
	}
	const out: (DiffLine | null)[] = [];
	let gap = false;
	for (let i = 0; i < lines.length; i++) {
		if (keep[i]) {
			out.push(lines[i]);
			gap = false;
		} else if (!gap) {
			out.push(null); // one gap marker per collapsed run
			gap = true;
		}
	}
	return out;
}
