const { contextBridge, ipcRenderer } = require("electron")

// The only native features the app can reach
contextBridge.exposeInMainWorld("electronAPI", {
	getPrinters: () => ipcRenderer.invoke("printers:list"),
	printReceipt: (html, printerName) => ipcRenderer.invoke("printers:print", html, printerName),
})
