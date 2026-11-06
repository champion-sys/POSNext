/**
 * What the database process accepts. Nothing here depends on Electron, so it can be
 * tested against any SQLite with the same prepare and exec API.
 */

// Reading or writing the app's tables, and migrating them. ATTACH and VACUUM INTO could
// reach any file the app can, and PRAGMA could weaken durability, so a renderer gets none.
const ALLOWED_STATEMENT = /^\s*(SELECT|WITH|INSERT|UPDATE|DELETE|CREATE|ALTER|DROP)\b/i
const READ_STATEMENT = /^\s*(SELECT|WITH)\b/i

/**
 * Whether a request comes from the app's own page. Compares the parts, because the
 * origin of a custom scheme is the string "null" to Node's URL.
 * @param {string} url - The URL of the frame that sent the request
 */
function isAppPage(url) {
	if (!URL.canParse(url)) return false
	const { protocol, host } = new URL(url)
	return protocol === "app:" && host === "pos"
}

function assertAllowed(sql) {
	if (typeof sql !== "string" || !ALLOWED_STATEMENT.test(sql)) {
		throw new Error(`Statement not allowed: ${String(sql).slice(0, 40)}`)
	}
}

/**
 * @param {Object} db - An open database
 * @returns {{all: Function, run: Function, batch: Function}} The only operations there are
 */
function createHandler(db) {
	return {
		all(sql, params = []) {
			assertAllowed(sql)
			if (!READ_STATEMENT.test(sql)) throw new Error("all() only reads")
			return db.prepare(sql).all(...params)
		},

		run(sql, params = []) {
			assertAllowed(sql)
			if (READ_STATEMENT.test(sql)) throw new Error("run() only writes")
			db.prepare(sql).run(...params)
		},

		batch(statements) {
			for (const { sql } of statements) assertAllowed(sql)

			db.exec("BEGIN IMMEDIATE")
			try {
				for (const { sql, params = [] } of statements) {
					db.prepare(sql).run(...params)
				}
				db.exec("COMMIT")
			} catch (error) {
				db.exec("ROLLBACK")
				throw error
			}
		},
	}
}

module.exports = { createHandler, isAppPage }
