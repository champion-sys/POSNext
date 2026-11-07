/**
 * The renderer's side of the desktop database. The statements run in a utility process,
 * see desktop/electron/db.
 *
 * @module platform/electron/sqlExecutor
 */

import { DatabaseLockedError } from "../store/databaseLock"

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

export async function openExecutor() {
	const database = window.electronAPI.db
	const { locked, encrypted } = await database.open()
	if (locked) throw new DatabaseLockedError(locked)
	return { ...createElectronExecutor(database), encrypted }
}
