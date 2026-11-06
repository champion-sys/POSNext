const { contextBridge, ipcRenderer } = require("electron")

// The only native features the app can reach
contextBridge.exposeInMainWorld("electronAPI", {
	getPrinters: () => ipcRenderer.invoke("printers:list"),
	printReceipt: (html, printerName) => ipcRenderer.invoke("printers:print", html, printerName),
})

// Decrypted in the main process, so the app's storage never holds them in the clear
contextBridge.exposeInMainWorld("electronSecrets", {
	get: (key) => ipcRenderer.invoke("secrets:get", key),
	set: (key, value) => ipcRenderer.invoke("secrets:set", key, value),
	remove: (key) => ipcRenderer.invoke("secrets:remove", key),
})
