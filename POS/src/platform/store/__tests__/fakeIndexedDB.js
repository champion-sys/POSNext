/** Just enough raw IndexedDB for the drafts database, which does not go through Dexie */

function respond(result) {
	const request = { result, error: null }
	queueMicrotask(() => request.onsuccess?.())
	return request
}

function fail(error) {
	const request = { result: undefined, error }
	queueMicrotask(() => request.onerror?.())
	return request
}

export function createFakeIndexedDB() {
	const rows = new Map()
	let nextId = 1

	const objectStore = {
		add(value) {
			const row = { ...structuredClone(value), id: nextId++ }
			rows.set(row.id, row)
			return respond(row.id)
		},
		put(value) {
			if (value.id === undefined) return fail(new Error("Missing key"))
			rows.set(value.id, structuredClone(value))
			return respond(value.id)
		},
		getAll: () => respond([...rows.values()].map((row) => structuredClone(row))),
		count: () => respond(rows.size),
		delete(id) {
			rows.delete(id)
			return respond(undefined)
		},
		clear() {
			rows.clear()
			return respond(undefined)
		},
		index: (name) => ({
			get(value) {
				const row = [...rows.values()].find((candidate) => candidate[name] === value)
				return respond(row ? structuredClone(row) : undefined)
			},
		}),
		createIndex() {},
	}

	const database = {
		objectStoreNames: { contains: () => true },
		transaction: () => ({ objectStore: () => objectStore }),
	}

	return { open: () => respond(database) }
}
