/**
 * Recursive pane-tiling model for a worktree's sessions. Leaves are tab *groups*
 * (an ordered set of session ids with one active); internal nodes are *splits*
 * (row = side by side, col = stacked). The tree is derived per worktree and kept
 * reconciled against the actual session list, so it degrades gracefully as
 * sessions open/close. Session state lives in the main process and replays on
 * remount, so moving a tab between groups is safe (see TerminalPane/ChatPane).
 *
 * Not persisted across app restarts in v1: session ids regenerate each run, so a
 * saved arrangement can't be re-keyed. Tiling survives worktree navigation (the
 * store is in memory) and resets to a single group on relaunch.
 */

export type PaneGroup = {
	kind: "group";
	id: string;
	tabs: string[];
	/** The visible tab in this group (its pane fills the group body). */
	active: string | null;
};
export type PaneSplit = {
	kind: "split";
	id: string;
	dir: "row" | "col";
	children: PaneNode[];
	/** Fractions summing to 1, one per child. */
	sizes: number[];
};
export type PaneNode = PaneGroup | PaneSplit;

/** Where a dropped tab lands: into a group's tab set, or splitting it off an edge. */
export type DropDir = "center" | "left" | "right" | "top" | "bottom";

let seq = 0;
const nid = (p: string) => `${p}_${Date.now().toString(36)}_${(seq++).toString(36)}`;

export function group(tabs: string[], active?: string | null): PaneGroup {
	return { kind: "group", id: nid("g"), tabs, active: active ?? tabs[tabs.length - 1] ?? null };
}

function equalSizes(n: number): number[] {
	return Array.from({ length: n }, () => 1 / n);
}

export function allTabs(node: PaneNode): string[] {
	return node.kind === "group" ? node.tabs.slice() : node.children.flatMap(allTabs);
}

/** The group containing `tab`, or null. */
export function groupOf(node: PaneNode, tab: string): PaneGroup | null {
	if (node.kind === "group") return node.tabs.includes(tab) ? node : null;
	for (const c of node.children) {
		const g = groupOf(c, tab);
		if (g) return g;
	}
	return null;
}

/** The leftmost/topmost group — the fallback home for stray tabs. */
export function firstGroup(node: PaneNode): PaneGroup {
	return node.kind === "group" ? node : firstGroup(node.children[0]);
}

/** Replace the group with the given id via `fn` (may return a split, enabling splits). */
function mapGroup(node: PaneNode, id: string, fn: (g: PaneGroup) => PaneNode): PaneNode {
	if (node.kind === "group") return node.id === id ? fn(node) : node;
	return { ...node, children: node.children.map((c) => mapGroup(c, id, fn)) };
}

/** Remove a tab wherever it appears (leaves possibly-empty groups; call simplify after). */
function stripTab(node: PaneNode, tab: string): PaneNode {
	if (node.kind === "group") {
		if (!node.tabs.includes(tab)) return node;
		const tabs = node.tabs.filter((t) => t !== tab);
		const active = node.active === tab ? (tabs[tabs.length - 1] ?? null) : node.active;
		return { ...node, tabs, active };
	}
	return { ...node, children: node.children.map((c) => stripTab(c, tab)) };
}

/**
 * Collapse the tree: drop empty groups, flatten nested same-direction splits, and
 * unwrap single-child splits. Sizes are preserved when a split's child count is
 * unchanged, else re-equalized. Returns null if nothing is left.
 */
export function simplify(node: PaneNode): PaneNode | null {
	if (node.kind === "group") return node.tabs.length > 0 ? node : null;
	const before = node.children.length;
	let children = node.children
		.map(simplify)
		.filter((c): c is PaneNode => c !== null)
		.flatMap((c) => (c.kind === "split" && c.dir === node.dir ? c.children : [c]));
	if (children.length === 0) return null;
	if (children.length === 1) return children[0];
	const sizes = children.length === before ? node.sizes : equalSizes(children.length);
	return { ...node, children, sizes };
}

/**
 * Add tabs to the group holding `focus` (if in this tree), else the first group.
 * Keys already placed anywhere in the tree are skipped, so restoring a persisted
 * layout (whose panes are re-added as their sessions reopen) is idempotent — a tab
 * keeps its saved position instead of being duplicated into the focused group.
 */
export function insertTabs(root: PaneNode | undefined, tabs: string[], focus: string | null): PaneNode {
	const existing = new Set(root ? allTabs(root) : []);
	const add = tabs.filter((t) => !existing.has(t));
	if (!add.length) return root ?? group([]);
	if (!root) return group(add);
	const home = (focus && groupOf(root, focus)) || firstGroup(root);
	return mapGroup(root, home.id, (g) => ({ ...g, tabs: [...g.tabs, ...add], active: add[add.length - 1] }));
}

/** Drop `tab` (from anywhere in the tree) into `targetGroupId` at `index` (default end). */
export function moveTabToGroup(
	root: PaneNode,
	tab: string,
	targetGroupId: string,
	index?: number,
): PaneNode {
	const stripped = stripTab(root, tab);
	const placed = mapGroup(stripped, targetGroupId, (g) => {
		const tabs = g.tabs.filter((t) => t !== tab);
		const at = index === undefined ? tabs.length : Math.max(0, Math.min(index, tabs.length));
		tabs.splice(at, 0, tab);
		return { ...g, tabs, active: tab };
	});
	return simplify(placed) ?? group([tab]);
}

/** Split `targetGroupId` in `dir`, placing `tab` in a new group before/after it. */
export function splitOffTab(
	root: PaneNode,
	tab: string,
	targetGroupId: string,
	dir: "row" | "col",
	before: boolean,
): PaneNode {
	const stripped = stripTab(root, tab);
	const withSplit = mapGroup(stripped, targetGroupId, (g) => {
		const fresh = group([tab], tab);
		const children = before ? [fresh, g] : [g, fresh];
		return { kind: "split", id: nid("s"), dir, children, sizes: [0.5, 0.5] };
	});
	return simplify(withSplit) ?? group([tab]);
}

export function setActive(root: PaneNode, groupId: string, tab: string): PaneNode {
	return mapGroup(root, groupId, (g) => ({ ...g, active: tab }));
}

/** Rename a tab key in place (used when a reused preview tab swaps its file). */
export function renameTab(root: PaneNode, oldKey: string, newKey: string): PaneNode {
	if (root.kind === "group") {
		if (!root.tabs.includes(oldKey)) return root;
		return {
			...root,
			tabs: root.tabs.map((t) => (t === oldKey ? newKey : t)),
			active: root.active === oldKey ? newKey : root.active,
		};
	}
	return { ...root, children: root.children.map((c) => renameTab(c, oldKey, newKey)) };
}

/** Set the fraction sizes of the split with `splitId`. */
export function setSizes(root: PaneNode, splitId: string, sizes: number[]): PaneNode {
	if (root.kind === "group") return root;
	if (root.id === splitId) return { ...root, sizes };
	return { ...root, children: root.children.map((c) => setSizes(c, splitId, sizes)) };
}

/** Remove a tab and collapse the tree; returns an empty group if the tree empties. */
export function removeTab(root: PaneNode, tab: string): PaneNode {
	return simplify(stripTab(root, tab)) ?? group([]);
}

/**
 * Make the tree contain exactly `tabs`: drop absent ids, add missing ones to the
 * first group. Used defensively on render so the layout never disagrees with the
 * live session list.
 */
export function reconcile(root: PaneNode | undefined, tabs: string[]): PaneNode {
	const present = new Set(tabs);
	let n: PaneNode = root ?? group([]);
	for (const t of allTabs(n)) if (!present.has(t)) n = stripTab(n, t);
	n = simplify(n) ?? group([]);
	const have = new Set(allTabs(n));
	const missing = tabs.filter((t) => !have.has(t));
	return missing.length ? insertTabs(n, missing, null) : n;
}

/** Map a pointer position within a group body to a drop target (edge or center). */
export function dropDirAt(x: number, y: number, w: number, h: number): DropDir {
	const fx = x / w;
	const fy = y / h;
	// Center third stays a "move into group"; outer bands split.
	if (fx > 0.33 && fx < 0.67 && fy > 0.33 && fy < 0.67) return "center";
	// Nearest edge by normalized distance.
	const dist = { left: fx, right: 1 - fx, top: fy, bottom: 1 - fy };
	return (Object.keys(dist) as (keyof typeof dist)[]).reduce((a, b) =>
		dist[a] <= dist[b] ? a : b,
	);
}
