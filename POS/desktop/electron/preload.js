const { contextBridge, ipcRenderer } = require("electron")

// The only native features the app can reach
contextBridge.exposeInMainWorld("electronAPI", {
	getPrinters: () => ipcRenderer.invoke("printers:list"),
	printReceipt: (html, printerName) => ipcRenderer.invoke("printers:print", html, printerName),
	db: {
		open: () => ipcRenderer.invoke("db:open"),
		all: (sql, params) => ipcRenderer.invoke("db:all", sql, params),
		run: (sql, params) => ipcRenderer.invoke("db:run", sql, params),
		batch: (statements) => ipcRenderer.invoke("db:batch", statements),
	},
})

// Decrypted in the main process, so the app's storage never holds them in the clear
contextBridge.exposeInMainWorld("electronSecrets", {
	get: (key) => ipcRenderer.invoke("secrets:get", key),
	set: (key, value) => ipcRenderer.invoke("secrets:set", key, value),
	remove: (key) => ipcRenderer.invoke("secrets:remove", key),
})
