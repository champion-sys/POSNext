/**
 * A device's database that is there but cannot be opened, which is not the same thing as
 * a database with nothing in it. The app stops on this: see pages/DatabaseLocked.vue.
 *
 * @module platform/store/databaseLock
 */

/** The same codes as desktop/electron/db/encryption.js. The stop page shows them for support. */
export const LOCK = {
	KEY_MISSING: "key-missing",
	KEY_UNREADABLE: "key-unreadable",
	KEY_REJECTED: "key-rejected",
	NO_SECURE_STORAGE: "no-secure-storage",
	OPEN_FAILED: "open-failed",
}

export class DatabaseLockedError extends Error {
	/** @param {string} reason - A value of LOCK */
	constructor(reason) {
		super(`The local database is locked: ${reason}`)
		this.name = "DatabaseLockedError"
		this.reason = reason
	}
}
