let electron = require("electron");
//#region src/preload/index.ts
electron.contextBridge.exposeInMainWorld("forestRanger", {
	invoke: (method, params) => electron.ipcRenderer.invoke("rpc", method, params),
	send: (message) => electron.ipcRenderer.send("message", message),
	onEvent: (handler) => {
		const listener = (_e, event) => handler(event);
		electron.ipcRenderer.on("event", listener);
		return () => electron.ipcRenderer.removeListener("event", listener);
	}
});
//#endregion
