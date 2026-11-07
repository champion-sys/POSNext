/**
 * Connects the window to the database process. Only these calls cross, and only from the
 * app's own page. The key stays in the main process and the database process: the window
 * learns whether the database opened, never with what.
 */

const path = require("node:path")
const { app, ipcMain, utilityProcess } = require("electron")
const { openDeviceSecrets } = require("../secrets")
const { LOCK, findKey } = require("./encryption")
const { isAppPage } = require("./handler")

const METHODS = ["all", "run", "batch"]
const DATABASE_FILE = "pos-next.sqlite"

let host = null
let opening = null
let nextId = 0
const pending = new Map()

function rejectPending(reason) {
	for (const { reject } of pending.values()) reject(new Error(reason))
	pending.clear()
}

function startHost() {
	const child = utilityProcess.fork(path.join(__dirname, "host.js"))
	host = child
	child.on("message", ({ id, result, error }) => {
		const request = pending.get(id)
		pending.delete(id)
		if (error) request?.reject(new Error(error))
		else request?.resolve(result)
	})
	// Uncommitted work rolls back with the process. The next request starts a new one.
	child.on("exit", () => {
		if (host !== child) return
		host = null
		opening = null
		rejectPending("The database process stopped")
	})
}

function send(method, args) {
	return new Promise((resolve, reject) => {
		const id = nextId++
		pending.set(id, { resolve, reject })
		host.postMessage({ id, method, args })
	})
}

async function startDatabase() {
	const filePath = path.join(app.getPath("userData"), DATABASE_FILE)
	const { key, locked } = findKey(filePath, openDeviceSecrets())
	if (locked) return { locked }

	startHost()
	return send("open", [filePath, key])
}

/**
 * Anything that stops the database from opening stops the app. A window that went on
 * would show an empty till over sales that are still on the disk.
 * @returns {Promise<{encrypted: boolean}|{locked: string}>}
 */
function openDatabase() {
	opening ??= startDatabase()
		.catch((error) => {
			console.error("Could not open the database:", error.message)
			return { locked: LOCK.OPEN_FAILED }
		})
		.then((state) => {
			// Nothing stays open, so that trying again starts from the disk
			if (state.locked) {
				opening = null
				host?.kill()
			}
			return state
		})
	return opening
}

async function request(method, args) {
	const { locked } = await openDatabase()
	if (locked) throw new Error(`The database is locked: ${locked}`)
	return send(method, args)
}

function registerDatabaseIpc() {
	ipcMain.handle("db:open", (event) => {
		if (!isAppPage(event.senderFrame.url)) throw new Error("Not allowed")
		return openDatabase()
	})

	for (const method of METHODS) {
		ipcMain.handle(`db:${method}`, (event, ...args) => {
			if (!isAppPage(event.senderFrame.url)) throw new Error("Not allowed")
			return request(method, args)
		})
	}
}

module.exports = { registerDatabaseIpc }
