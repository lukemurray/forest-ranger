/**
 * Registry of mounted editors' save fns, so ⌥⌘S can save them all at once. Lives
 * outside FileEditor so the shortcut handler (RootLayout) doesn't pull Monaco into
 * the startup bundle — the editor itself is lazy-loaded on the first file tab.
 */
export const savers = new Map<string, () => Promise<void>>();

export async function saveAllFiles() {
	await Promise.all([...savers.values()].map((fn) => fn()));
}
