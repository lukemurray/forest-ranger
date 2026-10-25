import type { Worktree } from "../../shared/types";

/**
 * What to call a worktree, plus a muted note to show beside it — one rule for the
 * sidebar, ⌘T, Home, the title bar and project cards.
 *
 * - labelled:  "my review"           note: its branch, or "feature/x, detached"
 * - on branch: "feature/x"           note: none
 * - detached:  "feature/x"           note: "detached" — named by where it came
 *   from (reflog), falling back to its folder, never a bare "detached"
 */
export function worktreeLabel(
	wt: Pick<Worktree, "name" | "branch" | "isDetached" | "path"> & { detachedFrom?: string | null },
): { label: string; note: string | null } {
	const origin = wt.branch ?? (wt.isDetached ? (wt.detachedFrom ?? folderOf(wt.path)) : null);
	if (wt.name) {
		return { label: wt.name, note: wt.branch ?? (origin ? `${origin}, detached` : "detached") };
	}
	if (wt.branch) return { label: wt.branch, note: null };
	return { label: origin ?? "detached", note: "detached" };
}

function folderOf(path: string): string | null {
	return path.split("/").filter(Boolean).pop() ?? null;
}
