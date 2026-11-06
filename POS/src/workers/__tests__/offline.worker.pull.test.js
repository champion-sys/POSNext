import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const tables = vi.hoisted(() => ({}))

vi.mock("dexie", () => {
	class FakeTable {
		constructor(primaryKey) {
			this.primaryKey = primaryKey
			this.rows = new Map()
		}

		select(matches) {
			const rows = this.rows
			const primaryKey = this.primaryKey
			return {
				count: async () => [...rows.values()].filter(matches).length,
				delete: async () => {
					for (const row of [...rows.values()].filter(matches)) rows.delete(row[primaryKey])
				},
			}
		}

		where(index) {
			return {
				equals: (value) => this.select((row) => row[index] === value),
				anyOf: (values) => this.select((row) => values.includes(row[index])),
			}
		}

		filter(matches) {
			return this.select(matches)
		}

		async bulkGet(keys) {
			return keys.map((key) => this.rows.get(key))
		}

		async put(row) {
			this.rows.set(row[this.primaryKey], row)
		}

		async bulkPut(rows) {
			for (const row of rows) this.rows.set(row[this.primaryKey], row)
		}

		async delete(key) {
			this.rows.delete(key)
		}

		async bulkDelete(keys) {
			for (const key of keys) this.rows.delete(key)
		}

		async clear() {
			this.rows.clear()
		}

		async count() {
			return this.rows.size
		}
	}

	Object.assign(tables, {
		items: new FakeTable("item_code"),
		item_prices: new FakeTable("item_code"),
		customers: new FakeTable("name"),
		payment_methods: new FakeTable("mode_of_payment"),
		offers: new FakeTable("name"),
		settings: new FakeTable("key"),
	})

	return {
		default: class {
			tables = Object.keys(tables).map((name) => ({ name }))
			open = async () => {}
			close = async () => {}
			table = (name) => tables[name]
			transaction = async (...args) => args.at(-1)()
		},
	}
})

let nextId = 0

async function send(type, payload) {
	const id = ++nextId
	await self.onmessage({ data: { type, payload, id } })
	return self.postMessage.mock.calls.find(([message]) => message.id === id)[0]
}

const apply = (entity, page) =>
	send("APPLY_PULL_PAGE", { entity, page: { rows: [], deleted: [], ...page }, posProfile: "Main" })

const setting = (key) => tables.settings.rows.get(key)?.value

describe("applying a pulled page", () => {
	beforeAll(async () => {
		self.postMessage = vi.fn()
		vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true })))
		await import("../offline.worker.js")
	})

	beforeEach(() => {
		self.postMessage.mockClear()
		for (const table of Object.values(tables)) table.rows.clear()
	})

	describe.each(["items", "item_prices"])("%s", (entity) => {
		it("stores rows and removes deleted items with their prices", async () => {
			tables.items.rows.set("OLD", { item_code: "OLD" })
			tables.item_prices.rows.set("OLD", { item_code: "OLD" })

			const reply = await apply(entity, { rows: [{ item_code: "NEW", rate: 5 }], deleted: ["OLD"] })

			expect(reply.type).toBe("SUCCESS")
			expect(tables.items.rows.has("NEW")).toBe(true)
			expect(tables.items.rows.has("OLD")).toBe(false)
			expect(tables.item_prices.rows.has("OLD")).toBe(false)
		})

		it("keeps cached batch data on an updated item", async () => {
			tables.items.rows.set("A", { item_code: "A", batch_no_data: ["B1"] })

			await apply(entity, { rows: [{ item_code: "A", rate: 7 }] })

			expect(tables.items.rows.get("A")).toMatchObject({ rate: 7, batch_no_data: ["B1"] })
		})
	})

	it("stores customers and removes deleted ones", async () => {
		tables.customers.rows.set("OLD", { name: "OLD" })

		await apply("customers", { rows: [{ name: "NEW" }], deleted: ["OLD"] })

		expect([...tables.customers.rows.keys()]).toEqual(["NEW"])
	})

	it("stores taxes where loadTaxRules reads them", async () => {
		await apply("taxes", { rows: [{ rate: 15 }] })

		expect(setting("tax_rules_Main")).toEqual([{ rate: 15 }])
	})

	it("stores an emptied tax list, so a removed tax leaves the device", async () => {
		tables.settings.rows.set("tax_rules_Main", { key: "tax_rules_Main", value: [{ rate: 15 }] })

		await apply("taxes", { rows: [] })

		expect(setting("tax_rules_Main")).toEqual([])
	})

	it("replaces the profile's payment methods and leaves other profiles alone", async () => {
		tables.payment_methods.rows.set("Removed", { mode_of_payment: "Removed", pos_profile: "Main" })
		tables.payment_methods.rows.set("Other", { mode_of_payment: "Other", pos_profile: "Second" })

		await apply("payment_methods", { rows: [{ mode_of_payment: "Cash" }] })

		expect([...tables.payment_methods.rows.keys()].sort()).toEqual(["Cash", "Other"])
		expect(tables.payment_methods.rows.get("Cash").pos_profile).toBe("Main")
	})

	it("stores profile data in the shape setPosProfile restores", async () => {
		await apply("pos_profile", {
			rows: [{ pos_profile: { item_groups: [{ item_group: "Food" }] }, item_groups_hierarchy: [{ item_group: "Food" }] }],
		})

		expect(setting("pos_profile_data:Main")).toEqual({
			profileItemGroups: [{ item_group: "Food" }],
			itemGroups: [{ item_group: "Food" }],
		})
	})

	it("replaces the profile's offers", async () => {
		tables.offers.rows.set("OLD", { name: "OLD", pos_profile: "Main" })

		await apply("offers", { rows: [{ name: "NEW" }] })

		expect([...tables.offers.rows.keys()]).toEqual(["NEW"])
	})

	it("fails when offers cannot be stored, so the cursor is not saved", async () => {
		vi.spyOn(tables.offers, "bulkPut").mockRejectedValueOnce(new Error("disk full"))

		const reply = await apply("offers", { rows: [{ name: "NEW" }] })

		expect(reply.type).toBe("ERROR")
	})

	it("rejects an unknown entity", async () => {
		const reply = await apply("sales_invoices", {})

		expect(reply.type).toBe("ERROR")
	})
})

describe("clearing a cache", () => {
	const saveStates = (...entities) => {
		for (const entity of entities) {
			const key = `pull_state:${entity}`
			tables.settings.rows.set(key, { key, value: { cursor: "c1", version: "v1" } })
		}
	}

	beforeEach(() => {
		for (const table of Object.values(tables)) table.rows.clear()
		saveStates("items", "item_prices", "customers", "taxes")
	})

	it("forgets the catalog's position with the items, so they are pulled again", async () => {
		await send("CLEAR_ITEMS_CACHE")

		expect(setting("pull_state:items")).toBeUndefined()
		expect(setting("pull_state:item_prices")).toBeUndefined()
		expect(setting("pull_state:customers")).toBeDefined()
	})

	it("forgets the customers' position with the customers", async () => {
		await send("CLEAR_CUSTOMERS_CACHE")

		expect(setting("pull_state:customers")).toBeUndefined()
		expect(setting("pull_state:items")).toBeDefined()
	})
})

describe("items a profile hides when unavailable", () => {
	const shownCount = async () => (await send("COUNT_ITEMS_BY_GROUP", { itemGroups: [] })).payload

	const hidden = { item_code: "A", hide_when_unavailable: 1, is_stock_item: 1 }

	beforeEach(() => tables.items.rows.clear())

	it("hides a stock item with nothing left", async () => {
		tables.items.rows.set("A", { ...hidden, actual_qty: 0 })

		expect(await shownCount()).toBe(0)
	})

	it("shows it again once stock returns", async () => {
		tables.items.rows.set("A", { ...hidden, actual_qty: 3 })

		expect(await shownCount()).toBe(1)
	})

	it("hides an unavailable bundle", async () => {
		tables.items.rows.set("A", { item_code: "A", hide_when_unavailable: 1, is_bundle: true, actual_qty: 0 })

		expect(await shownCount()).toBe(0)
	})

	it("always shows services and templates", async () => {
		tables.items.rows.set("S", { item_code: "S", hide_when_unavailable: 1, is_stock_item: 0, actual_qty: 0 })
		tables.items.rows.set("T", { ...hidden, item_code: "T", has_variants: 1, actual_qty: 0 })

		expect(await shownCount()).toBe(2)
	})

	it("shows empty items for a profile that does not hide them", async () => {
		tables.items.rows.set("A", { item_code: "A", is_stock_item: 1, actual_qty: 0 })

		expect(await shownCount()).toBe(1)
	})
})
