import { useNavigate } from "@tanstack/react-router";
import { api, emitDataChanged } from "../rpc";
import { openSession } from "./terminalStore";
import { getChatConfig, providerLabel } from "./chatConfig";
import { notify } from "./toast";

/**
 * The two project-level "new" flows (creating a worktree, reviewing a branch),
 * shared by the project view and the sidebar shortcuts so they behave identically
 * wherever they're triggered.
 */
export function useProjectActions(projectId: string) {
	const navigate = useNavigate();

	/** After NewWorktreeDialog creates one: reveal it, and optionally start a chat. */
	function onWorktreeCreated(worktreeId: string, _path: string, startChat: boolean) {
		emitDataChanged("worktrees");
		navigate({
			to: "/project/$projectId/worktree/$worktreeId",
			params: { projectId, worktreeId },
		});
		if (startChat) {
			const config = getChatConfig();
			const agent = providerLabel(config.defaultProvider);
			openSession({
				worktreeId,
				projectId,
				kind: "chat",
				commandId: null,
				command: null,
				resumeCommand: null,
				sessionId: crypto.randomUUID(),
				provider: config.defaultProvider,
				permissionMode: config.defaultPermissionMode,
				model: config.defaultModel,
				agentLabel: agent,
				name: "New chat",
				title: agent,
			});
		}
	}

	/** Review a branch: a detached worktree at its tip + a chat seeded to review it. */
	async function startReview(branch: string, _base: string | null, prompt: string) {
		const res = await api.createWorktree({
			projectId,
			name: "",
			base: branch,
			location: null,
			detach: true,
		});
		if (!res.ok || !res.worktreeId) {
			notify(res.error ?? "Failed to create review worktree", "error");
			return;
		}
		emitDataChanged("worktrees");
		navigate({
			to: "/project/$projectId/worktree/$worktreeId",
			params: { projectId, worktreeId: res.worktreeId },
		});
		const config = getChatConfig();
		const agent = providerLabel(config.defaultProvider);
		openSession({
			worktreeId: res.worktreeId,
			projectId,
			kind: "chat",
			commandId: null,
			command: null,
			resumeCommand: null,
			sessionId: crypto.randomUUID(),
			provider: config.defaultProvider,
			permissionMode: config.defaultPermissionMode,
			model: config.defaultModel,
			agentLabel: agent,
			name: `Review ${branch}`,
			renamed: true,
			title: `Review ${branch}`,
			initialPrompt: prompt,
		});
	}

	return { onWorktreeCreated, startReview };
}
