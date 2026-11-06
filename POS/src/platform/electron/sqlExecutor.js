/**
 * The renderer's side of the desktop database. The statements run in a utility process,
 * see desktop/electron/db.
 *
 * @module platform/electron/sqlExecutor
 */

/**
 * @param {{all: Function, run: Function, batch: Function}} database - The preload API
 * @returns {import("../sql/outbox").SqlExecutor}
 */
export function createElectronExecutor(database) {
	return {
		all: (sql, params = []) => database.all(sql, params),
		run: (sql, params = []) => database.run(sql, params),
		batch: (statements) => database.batch(statements),
	}
}

export function openExecutor() {
	return createElectronExecutor(window.electronAPI.db)
}
