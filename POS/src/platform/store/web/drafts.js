/**
 * Draft invoices on the web. They have their own IndexedDB database, separate from
 * the offline cache, which existing installs must keep.
 *
 * @module platform/store/web/drafts
 */

const DB_NAME = "pos_next_drafts"
const DB_VERSION = 1
const STORE_NAME = "invoices"

let db = null

async function initDB() {
	if (db) return db

	return new Promise((resolve, reject) => {
		const request = indexedDB.open(DB_NAME, DB_VERSION)

		request.onerror = () => reject(request.error)
		request.onsuccess = () => {
			db = request.result
			resolve(db)
		}

		request.onupgradeneeded = (event) => {
			const database = event.target.result

			if (!database.objectStoreNames.contains(STORE_NAME)) {
				const objectStore = database.createObjectStore(STORE_NAME, {
					keyPath: "id",
					autoIncrement: true,
				})

				objectStore.createIndex("draft_id", "draft_id", { unique: true })
				objectStore.createIndex("created_at", "created_at", { unique: false })
				objectStore.createIndex("customer", "customer", { unique: false })
			}
		}
	})
}

async function request(mode, run) {
	const database = await initDB()

	return new Promise((resolve, reject) => {
		const store = database.transaction([STORE_NAME], mode).objectStore(STORE_NAME)
		const pending = run(store)

		pending.onsuccess = () => resolve(pending.result)
		pending.onerror = () => reject(pending.error)
	})
}

const getDraft = (draftId) => request("readonly", (store) => store.index("draft_id").get(draftId))

async function deleteDraft(draftId) {
	const draft = await getDraft(draftId)
	await request("readwrite", (store) => store.delete(draft.id))
}

export const draftStore = {
	addDraft: (draft) => request("readwrite", (store) => store.add(draft)),
	putDraft: (draft) => request("readwrite", (store) => store.put(draft)),
	getDraft,
	listDrafts: () => request("readonly", (store) => store.getAll()),
	countDrafts: () => request("readonly", (store) => store.count()),
	clearDrafts: () => request("readwrite", (store) => store.clear()),
	deleteDraft,
}
