/**
 * The web implementation: the worker owns most of the data, and the main thread keeps
 * talking to Dexie directly for what never went through the worker.
 *
 * @module platform/store/web
 */

import { dexieStore } from "./web/dexie"
import { draftStore } from "./web/drafts"
import { WORKER_METHODS } from "./methods"
import { offlineWorker } from "./web/workerClient"

const worker = Object.fromEntries(
	WORKER_METHODS.map((name) => [name, (...args) => offlineWorker[name](...args)]),
)

const store = { ...worker, ...dexieStore, ...draftStore }

export function openStore() {
	return store
}
