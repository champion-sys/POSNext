/**
 * The device's storage, for the whole app: Dexie in a worker on the web, SQLite on the
 * desktop and Android. Components and stores only ever see the methods listed in
 * ./methods, so none of them needs to know which one is running.
 *
 * @module platform/store
 */

import { logger } from "@/utils/logger"
import { PLATFORM, WEB } from "../runtime"
import { STORE_METHODS } from "./methods"

const log = logger.create("LocalStore")

// A build folds this to one branch, which keeps the other platform out of its bundle
const loadImplementation = PLATFORM === WEB ? () => import("./web") : () => import("./native")

let opening = null

function getStore() {
	if (!opening) {
		opening = loadImplementation()
			.then((implementation) => implementation.openStore())
			.catch((error) => {
				opening = null
				throw error
			})
	}
	return opening
}

export const localStore = Object.fromEntries(
	STORE_METHODS.map((name) => [name, async (...args) => (await getStore())[name](...args)]),
)

/**
 * The desktop and Android apps only: the web has no key to lose.
 * @returns {Promise<{locked: string|null, encrypted: boolean}>}
 */
export async function checkNativeDatabase() {
	const { checkDatabase } = await loadImplementation()
	return checkDatabase()
}

// The web worker and the database have always started with the page
if (typeof window !== "undefined") {
	getStore().catch((error) => log.error("Failed to open local storage", error))
}
