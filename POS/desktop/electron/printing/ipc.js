/**
 * Connects the window to the printers. Printers reach the outside world, so only the
 * app's own page may use them, as with the database and the secrets.
 */

const { isAppPage } = require("../db/handler")

/**
 * @param {Electron.IpcMain} ipc
 * @param {{list: () => Promise<Array>, print: (html: string, printerName: string, options?: {paper?: string, copies?: number}) => Promise<Object>}} printers
 */
function registerPrinterIpc(ipc, printers) {
	for (const method of ["list", "print"]) {
		ipc.handle(`printers:${method}`, (event, ...args) => {
			if (!isAppPage(event.senderFrame?.url)) throw new Error("Not allowed")
			return printers[method](...args)
		})
	}
}

module.exports = { registerPrinterIpc }
