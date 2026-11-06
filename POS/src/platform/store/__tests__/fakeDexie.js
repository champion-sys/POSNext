/**
 * A thin in-memory Dexie, because fake-indexeddb is not installed. It covers only the API
 * the app calls. Like IndexedDB, instances with the same name share their data, which is
 * how the worker and the main thread meet.
 */

const databases = new Map()

export function resetFakeDexie() {
	databases.clear()
}

const clone = (value) => structuredClone(value)

function compare(a, b) {
	if (a === b) return 0
	if (a === undefined) return -1
	if (b === undefined) return 1
	return a < b ? -1 : 1
}

function parseSchema(schema) {
	const [primary, ...indexes] = schema.split(",").map((part) => part.trim())
	const autoIncrement = primary.startsWith("++")
	const keyPath = primary.replace(/^(\+\+|&)/, "")
	const compound = keyPath.startsWith("[") ? keyPath.slice(1, -1).split("+") : null
	return {
		autoIncrement,
		keyPath,
		compound,
		unique: indexes.filter((index) => index.startsWith("&")).map((index) => index.slice(1)),
	}
}

class Table {
	constructor(name, schema) {
		this.name = name
		this.schema = parseSchema(schema)
		this.rows = new Map()
		this.nextId = 1
	}

	keyOf(row) {
		const { compound, keyPath } = this.schema
		return compound ? JSON.stringify(compound.map((field) => row[field])) : row[keyPath]
	}

	normalizeKey(key) {
		return Array.isArray(key) ? JSON.stringify(key) : key
	}

	sorted() {
		return [...this.rows.entries()].sort(([a], [b]) => compare(a, b)).map(([, row]) => row)
	}

	store(row, { insert }) {
		const stored = clone(row)
		if (this.schema.autoIncrement && stored[this.schema.keyPath] === undefined) {
			stored[this.schema.keyPath] = this.nextId++
		}

		const key = this.keyOf(stored)
		if (key === undefined) throw Object.assign(new Error("Missing key"), { name: "DataError" })
		if (insert && this.rows.has(key)) throw Object.assign(new Error("Key exists"), { name: "ConstraintError" })

		for (const field of this.schema.unique) {
			for (const [otherKey, other] of this.rows) {
				if (otherKey !== key && other[field] === stored[field]) {
					throw Object.assign(new Error(`${field} not unique`), { name: "ConstraintError" })
				}
			}
		}

		this.rows.set(key, stored)
		return key
	}

	add(row) {
		return Promise.resolve().then(() => this.store(row, { insert: true }))
	}

	put(row) {
		return Promise.resolve().then(() => this.store(row, { insert: false }))
	}

	async bulkPut(rows) {
		for (const row of rows) this.store(row, { insert: false })
	}

	async get(key) {
		if (key !== null && typeof key === "object" && !Array.isArray(key)) {
			const found = this.sorted().find((row) => Object.entries(key).every(([field, value]) => row[field] === value))
			return found ? clone(found) : undefined
		}
		const row = this.rows.get(this.normalizeKey(key))
		return row ? clone(row) : undefined
	}

	async bulkGet(keys) {
		return keys.map((key) => {
			const row = this.rows.get(this.normalizeKey(key))
			return row ? clone(row) : undefined
		})
	}

	async update(key, changes) {
		const row = this.rows.get(this.normalizeKey(key))
		if (!row) return 0
		for (const [field, value] of Object.entries(clone(changes))) {
			if (value === undefined) delete row[field]
			else row[field] = value
		}
		return 1
	}

	async delete(key) {
		this.rows.delete(this.normalizeKey(key))
	}

	async bulkDelete(keys) {
		for (const key of keys) this.rows.delete(this.normalizeKey(key))
	}

	async clear() {
		this.rows.clear()
	}

	async count() {
		return this.rows.size
	}

	collection() {
		return new Collection(this, () => this.sorted())
	}

	toArray() {
		return this.collection().toArray()
	}

	filter(predicate) {
		return this.collection().filter(predicate)
	}

	limit(count) {
		return this.collection().limit(count)
	}

	orderBy(index) {
		return new Collection(this, () =>
			this.sorted()
				.filter((row) => row[index] !== undefined)
				.sort((a, b) => compare(a[index], b[index])),
		)
	}

	where(index) {
		const matching = (predicate) =>
			new Collection(this, () =>
				this.sorted()
					.filter((row) => {
						const value = row[index]
						return Array.isArray(value) ? value.some(predicate) : value !== undefined && predicate(value)
					})
					.sort((a, b) => compare(a[index], b[index])),
			)

		return {
			equals: (expected) => matching((value) => value === expected),
			anyOf: (expected) => matching((value) => expected.includes(value)),
			startsWith: (prefix) => matching((value) => String(value).startsWith(prefix)),
			startsWithIgnoreCase: (prefix) =>
				matching((value) => String(value).toLowerCase().startsWith(prefix.toLowerCase())),
		}
	}
}

class Collection {
	constructor(table, source) {
		this.table = table
		this.source = source
		this.predicates = []
		this.skip = 0
		this.take = Number.POSITIVE_INFINITY
	}

	filter(predicate) {
		this.predicates.push(predicate)
		return this
	}

	offset(count) {
		this.skip = count
		return this
	}

	limit(count) {
		this.take = count
		return this
	}

	matches() {
		return this.source()
			.filter((row) => this.predicates.every((predicate) => predicate(clone(row))))
			.slice(this.skip, this.skip + this.take)
	}

	async toArray() {
		return clone(this.matches())
	}

	async count() {
		return this.matches().length
	}

	async first() {
		const [row] = this.matches()
		return row ? clone(row) : undefined
	}

	async primaryKeys() {
		return this.matches().map((row) => this.table.keyOf(row))
	}

	async delete() {
		const rows = this.matches()
		for (const row of rows) this.table.rows.delete(this.table.keyOf(row))
		return rows.length
	}
}

export class FakeDexie {
	constructor(name) {
		if (!databases.has(name)) databases.set(name, { tables: new Map(), transactions: 0 })
		this.database = databases.get(name)
		this.exposeTables()
	}

	exposeTables() {
		for (const [name, table] of this.database.tables) this[name] = table
	}

	version() {
		return {
			stores: (schema) => {
				for (const [name, definition] of Object.entries(schema)) {
					if (!this.database.tables.has(name)) {
						this.database.tables.set(name, new Table(name, definition))
					}
				}
				this.exposeTables()
			},
		}
	}

	get tables() {
		return [...this.database.tables.values()]
	}

	table(name) {
		return this.database.tables.get(name)
	}

	async open() {
		this.exposeTables()
		return this
	}

	async close() {}

	async transaction(_mode, ...args) {
		const run = args.at(-1)
		if (this.database.transactions > 0) return run()

		const snapshot = this.tables.map((table) => [table, clone([...table.rows]), table.nextId])
		this.database.transactions++
		try {
			return await run()
		} catch (error) {
			for (const [table, rows, nextId] of snapshot) {
				table.rows = new Map(rows)
				table.nextId = nextId
			}
			throw error
		} finally {
			this.database.transactions--
		}
	}
}
