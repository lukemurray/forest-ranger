import { contextBridge, ipcRenderer } from "electron";
import type { ForestRangerBridge, MainEvent } from "../shared/types";

/**
 * The only surface the renderer can touch. Requests go over `invoke` (one
 * response each), fire-and-forget renderer→main over `send`, and main→renderer
 * pushes arrive via `onEvent`.
 */
const bridge: ForestRangerBridge = {
	invoke: (method, params) => ipcRenderer.invoke("rpc", method, params),
	send: (message) => ipcRenderer.send("message", message),
	onEvent: (handler) => {
		const listener = (_e: unknown, event: MainEvent) => handler(event);
		ipcRenderer.on("event", listener);
		return () => ipcRenderer.removeListener("event", listener);
	},
};

contextBridge.exposeInMainWorld("forestRanger", bridge);
