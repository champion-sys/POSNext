/**
 * Entry point of the database's utility process. The SQLite module is synchronous, so it
 * runs here to keep a long write, or the first encryption of a large file, from freezing
 * the window. The key arrives by message, because a process's arguments can be read by
 * other programs on the machine.
 */

const Database = require("better-sqlite3-multiple-ciphers")
const { openDatabase } = require("./encryption")
const { createHandler } = require("./handler")

let handler = null

function open(filePath, key) {
	const { db, ...state } = openDatabase(Database, filePath, key)
	if (db) handler = createHandler(db)
	return state
}

process.parentPort.on("message", ({ data: { id, method, args } }) => {
	try {
		const result = method === "open" ? open(...args) : handler[method](...args)
		process.parentPort.postMessage({ id, result })
	} catch (error) {
		process.parentPort.postMessage({ id, error: error.message })
	}
})
