const path = require("node:path")
const { app, BrowserWindow, ipcMain, protocol, net } = require("electron")
const { pathToFileURL } = require("node:url")
const { getAvailablePrinters, printHTML } = require("./printing/printer")
const { startAutoUpdate } = require("./updater")

const RENDERER_DIR = path.join(__dirname, "..", "renderer")

// A real origin, so routing and storage behave as they do on the web
protocol.registerSchemesAsPrivileged([
	{ scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
])

let mainWindow = null

function serveRenderer() {
	protocol.handle("app", (request) => {
		const { pathname } = new URL(request.url)
		const file = path.join(RENDERER_DIR, decodeURIComponent(pathname))
		const isAsset = file.startsWith(RENDERER_DIR) && path.extname(file)
		return net.fetch(pathToFileURL(isAsset ? file : path.join(RENDERER_DIR, "index.html")).toString())
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
		},
	})
	mainWindow.loadURL("app://pos/")
	mainWindow.on("closed", () => {
		mainWindow = null
	})
}

ipcMain.handle("printers:list", () => getAvailablePrinters(mainWindow))
ipcMain.handle("printers:print", (_event, html, printerName) => printHTML(html, printerName))

// A second window would mean two senders for the same sales queue
if (!app.requestSingleInstanceLock()) {
	app.quit()
} else {
	app.on("second-instance", () => mainWindow?.focus())
	app.whenReady().then(() => {
		serveRenderer()
		createWindow()
		startAutoUpdate()
	})
	app.on("window-all-closed", () => app.quit())
}
