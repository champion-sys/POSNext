/**
 * Connects the window to the database process. Only these three calls cross, and only
 * from the app's own page.
 */

const path = require("node:path")
const { app, ipcMain, utilityProcess } = require("electron")
const { isAppPage } = require("./handler")

const METHODS = ["all", "run", "batch"]
const DATABASE_FILE = "pos-next.sqlite"

let host = null
let nextId = 0
const pending = new Map()

function rejectPending(reason) {
	for (const { reject } of pending.values()) reject(new Error(reason))
	pending.clear()
}

function getHost() {
	if (host) return host

	host = utilityProcess.fork(path.join(__dirname, "host.js"), [
		path.join(app.getPath("userData"), DATABASE_FILE),
	])
	host.on("message", ({ id, result, error }) => {
		const request = pending.get(id)
		pending.delete(id)
		if (error) request?.reject(new Error(error))
		else request?.resolve(result)
	})
	// Uncommitted work rolls back with the process. The next request starts a new one.
	host.on("exit", () => {
		host = null
		rejectPending("The database process stopped")
	})
	return host
}

function request(method, args) {
	return new Promise((resolve, reject) => {
		const id = nextId++
		pending.set(id, { resolve, reject })
		getHost().postMessage({ id, method, args })
	})
}

function registerDatabaseIpc() {
	for (const method of METHODS) {
		ipcMain.handle(`db:${method}`, (event, ...args) => {
			if (!isAppPage(event.senderFrame.url)) throw new Error("Not allowed")
			return request(method, args)
		})
	}
}

module.exports = { registerDatabaseIpc }
