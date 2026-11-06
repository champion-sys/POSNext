/**
 * Entry point of the database's utility process. better-sqlite3 is synchronous, so it
 * runs here to keep a long write from freezing the window.
 */

const Database = require("better-sqlite3")
const { createHandler } = require("./handler")

const db = new Database(process.argv[2])

// A sale that was committed must survive losing power a moment later
db.pragma("journal_mode = WAL")
db.pragma("synchronous = FULL")

const handler = createHandler(db)

process.parentPort.on("message", ({ data: { id, method, args } }) => {
	try {
		process.parentPort.postMessage({ id, result: handler[method](...args) })
	} catch (error) {
		process.parentPort.postMessage({ id, error: error.message })
	}
})
