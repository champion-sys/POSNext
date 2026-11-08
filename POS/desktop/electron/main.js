const path = require("node:path")
const { app, BrowserWindow, Menu, ipcMain, protocol, net, shell } = require("electron")
const { pathToFileURL } = require("node:url")
const { getAvailablePrinters, printHTML } = require("./printing/printer")
const { registerPrinterIpc } = require("./printing/ipc")
const { registerDatabaseIpc } = require("./db/ipc")
const { startAutoUpdate } = require("./updater")
const { registerSecretHandlers } = require("./secrets")
const { CONTENT_SECURITY_POLICY, confineToApp } = require("./security")

const RENDERER_DIR = path.join(__dirname, "..", "renderer")

// A real origin, so routing and storage behave as they do on the web
protocol.registerSchemesAsPrivileged([
	{ scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
])

let mainWindow = null

function serveRenderer() {
	protocol.handle("app", async (request) => {
		const { pathname } = new URL(request.url)
		const file = path.join(RENDERER_DIR, decodeURIComponent(pathname))
		const isAsset = file.startsWith(RENDERER_DIR) && path.extname(file)
		const response = await net.fetch(
			pathToFileURL(isAsset ? file : path.join(RENDERER_DIR, "index.html")).toString(),
		)
		response.headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY)
		return response
	})
}

function createWindow() {
	mainWindow = new BrowserWindow({
		width: 1366,
		height: 768,
		title: "POS Next",
		webPreferences: {
			preload: path.join(__dirname, "preload.js"),
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
			devTools: !app.isPackaged,
		},
	})
	mainWindow.loadURL("app://pos/")
	mainWindow.on("closed", () => {
		mainWindow = null
	})
}

registerPrinterIpc(ipcMain, {
	list: () => getAvailablePrinters(mainWindow),
	print: (html, printerName, options) => printHTML(html, printerName, options),
})
registerDatabaseIpc()
registerSecretHandlers()

app.on("web-contents-created", (_event, contents) => confineToApp(contents, shell))

// A second window would mean two senders for the same sales queue
if (!app.requestSingleInstanceLock()) {
	app.quit()
} else {
	app.on("second-instance", () => mainWindow?.focus())
	app.whenReady().then(() => {
		if (app.isPackaged) Menu.setApplicationMenu(null)
		serveRenderer()
		createWindow()
		startAutoUpdate()
	})
	app.on("window-all-closed", () => app.quit())
}
