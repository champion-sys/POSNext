import { beforeEach, describe, expect, it, vi } from "vitest"
import { isCatalogWalked, PULL_ENTITIES, pullStateKey, runPull } from "../pullEngine"

const POS_PROFILE = "Main"

function createStore(initial = {}) {
	const states = new Map(Object.entries(initial))
	const log = []
	return {
		states,
		log,
		getState: vi.fn(async (entity) => states.get(entity) ?? null),
		saveState: vi.fn(async (entity, state) => {
			log.push(`save:${entity}:${state.cursor}`)
			states.set(entity, state)
		}),
		applyPage: vi.fn(async (entity, page) => {
			log.push(`apply:${entity}:${page.next_cursor}`)
		}),
	}
}

/** A server that answers from `pages`, keyed by the cursor it was asked for. */
function createServer(manifest, pages = {}) {
	return {
		getManifest: vi.fn(async () => manifest),
		pull: vi.fn(async ({ entity, cursor }) => {
			const page = pages[entity]?.[cursor ?? "start"]
			if (!page) throw new Error(`no page for ${entity} at ${cursor}`)
			return page
		}),
	}
}

const page = (next_cursor, has_more, rows = [], deleted = []) => ({ rows, deleted, next_cursor, has_more })

const threePages = {
	start: page("c1", true, [{ item_code: "A" }]),
	c1: page("c2", true, [{ item_code: "B" }]),
	c2: page("c3", false, [{ item_code: "C" }], ["OLD"]),
}

describe("the order of a full pull", () => {
	it("reads stock after the items it applies to", () => {
		expect(PULL_ENTITIES.indexOf("stock")).toBeGreaterThan(PULL_ENTITIES.indexOf("items"))
	})
})

describe("runPull", () => {
	const pull = (server, store, options = {}) =>
		runPull({ server, store, posProfile: POS_PROFILE, entities: ["items"], ...options })

	describe("pagination", () => {
		it("walks every page, each from the cursor of the one before", async () => {
			const server = createServer({ items: "v2" }, { items: threePages })
			const store = createStore()

			const results = await pull(server, store)

			expect(server.pull.mock.calls.map(([args]) => args.cursor)).toEqual([null, "c1", "c2"])
			expect(results.items).toEqual({ status: "updated", pages: 3, rows: 3, deleted: 1 })
		})

		it("tells the manifest which entities this run is about", async () => {
			const server = createServer({ items: "v2" }, { items: { start: page("c1", false) } })

			await pull(server, createStore(), { entities: ["items"] })

			expect(server.getManifest).toHaveBeenCalledWith(POS_PROFILE, ["items"])
		})

		it("passes the profile and page size to the server", async () => {
			const server = createServer({ items: "v2" }, { items: { start: page("c1", false) } })

			await pull(server, createStore(), { pageSize: 50 })

			expect(server.pull).toHaveBeenCalledWith({
				entity: "items",
				posProfile: POS_PROFILE,
				cursor: null,
				limit: 50,
			})
		})

		it("continues from the saved cursor, not from the beginning", async () => {
			const server = createServer(
				{ items: "v2" },
				{ items: { c9: page("c10", false, [{ item_code: "D" }]) } },
			)
			const store = createStore({ items: { cursor: "c9", version: "v1", scope: null } })

			await pull(server, store)

			expect(server.pull).toHaveBeenCalledTimes(1)
			expect(server.pull.mock.calls[0][0].cursor).toBe("c9")
		})

		it("gives up when the server reports more rows but the cursor does not move", async () => {
			const server = createServer({ items: "v2" }, { items: { c1: page("c1", true) } })
			const store = createStore({ items: { cursor: "c1", version: "v1", scope: null } })

			const results = await pull(server, store)

			expect(results.items.status).toBe("failed")
			expect(server.pull).toHaveBeenCalledTimes(1)
		})

		it("keeps the final cursor even when the server stepped it back", async () => {
			const server = createServer({ items: "v2" }, { items: { c5: page("c4", false) } })
			const store = createStore({ items: { cursor: "c5", version: "v1", scope: null } })

			const results = await pull(server, store)

			expect(results.items.status).toBe("updated")
			expect(store.states.get("items").cursor).toBe("c4")
		})
	})

	describe("saving progress", () => {
		it("saves each cursor only after its page is applied", async () => {
			const server = createServer({ items: "v2" }, { items: threePages })
			const store = createStore()

			await pull(server, store)

			expect(store.log).toEqual([
				"apply:items:c1",
				"save:items:c1",
				"apply:items:c2",
				"save:items:c2",
				"apply:items:c3",
				"save:items:c3",
			])
		})

		it("records the manifest version only when the walk is complete", async () => {
			const server = createServer({ items: "v2" }, { items: threePages })
			const store = createStore()

			await pull(server, store)

			expect(store.saveState.mock.calls.map(([, state]) => state.version)).toEqual([null, null, "v2"])
		})
	})

	describe("resume after failure", () => {
		it("resumes from the last applied page when a request fails", async () => {
			const pages = { start: threePages.start }
			const server = createServer({ items: "v2" }, { items: pages })
			const store = createStore()

			const first = await pull(server, store)

			expect(first.items.status).toBe("failed")
			expect(store.states.get("items")).toMatchObject({ cursor: "c1", version: null })

			pages.c1 = threePages.c1
			pages.c2 = threePages.c2
			server.pull.mockClear()

			const second = await pull(server, store)

			expect(server.pull.mock.calls.map(([args]) => args.cursor)).toEqual(["c1", "c2"])
			expect(second.items.status).toBe("updated")
			expect(store.states.get("items")).toMatchObject({ cursor: "c3", version: "v2" })
		})

		it("repeats a page that could not be stored, instead of skipping it", async () => {
			const server = createServer({ items: "v2" }, { items: threePages })
			const store = createStore()
			store.applyPage
				.mockImplementationOnce(async () => {})
				.mockImplementationOnce(async () => {
					throw new Error("disk full")
				})

			const first = await pull(server, store)

			expect(first.items.status).toBe("failed")
			expect(store.states.get("items").cursor).toBe("c1")

			server.pull.mockClear()
			await pull(server, store)

			expect(server.pull.mock.calls.map(([args]) => args.cursor)).toEqual(["c1", "c2"])
		})

		it("finishes an interrupted walk even if the manifest has not moved", async () => {
			const server = createServer({ items: "v1" }, { items: { c1: threePages.c2 } })
			const store = createStore({ items: { cursor: "c1", version: null, scope: null } })

			const results = await pull(server, store)

			expect(results.items.status).toBe("updated")
			expect(store.states.get("items").version).toBe("v1")
		})

		it("leaves other entities to finish when one fails", async () => {
			const server = createServer(
				{ items: "v2", customers: "v2" },
				{ customers: { start: page("c1", false) } },
			)
			const store = createStore()

			const results = await pull(server, store, { entities: ["items", "customers"] })

			expect(results.items.status).toBe("failed")
			expect(results.customers.status).toBe("updated")
		})
	})

	describe("deletions", () => {
		it("hands rows and deletions to the store in one page", async () => {
			const server = createServer(
				{ items: "v2" },
				{ items: { start: page("c1", false, [{ item_code: "A" }], ["GONE", "DISABLED"]) } },
			)
			const store = createStore()

			await pull(server, store)

			expect(store.applyPage).toHaveBeenCalledWith("items", {
				rows: [{ item_code: "A" }],
				deleted: ["GONE", "DISABLED"],
				next_cursor: "c1",
				has_more: false,
			})
		})

		it("applies a page that only has deletions", async () => {
			const server = createServer({ items: "v2" }, { items: { start: page("c1", false, [], ["GONE"]) } })
			const store = createStore()

			const results = await pull(server, store)

			expect(results.items).toMatchObject({ pages: 1, rows: 0, deleted: 1 })
			expect(store.applyPage).toHaveBeenCalledTimes(1)
		})
	})

	describe("unchanged manifest", () => {
		it("does no work when the version matches", async () => {
			const server = createServer({ items: "v1" })
			const store = createStore({ items: { cursor: "c1", version: "v1", scope: null } })

			const results = await pull(server, store)

			expect(results.items).toEqual({ status: "unchanged", pages: 0, rows: 0, deleted: 0 })
			expect(server.pull).not.toHaveBeenCalled()
			expect(store.applyPage).not.toHaveBeenCalled()
			expect(store.saveState).not.toHaveBeenCalled()
		})

		it("pulls only the entity that moved", async () => {
			const server = createServer(
				{ items: "v1", customers: "v2" },
				{ customers: { c1: page("c2", false) } },
			)
			const store = createStore({
				items: { cursor: "c1", version: "v1", scope: null },
				customers: { cursor: "c1", version: "v1", scope: null },
			})

			await pull(server, store, { entities: ["items", "customers"] })

			expect(server.pull).toHaveBeenCalledTimes(1)
			expect(server.pull.mock.calls[0][0].entity).toBe("customers")
		})

		it("skips an entity the server does not report", async () => {
			const server = createServer({})

			const results = await pull(server, createStore())

			expect(results).toEqual({})
			expect(server.pull).not.toHaveBeenCalled()
		})
	})

	describe("scope", () => {
		const manifest = { items: "v1", scopes: { items: "scope-b" } }

		it("starts over when the scope moved, though the version did not", async () => {
			const server = createServer(manifest, { items: { start: page("c1", false) } })
			const store = createStore({ items: { cursor: "c9", version: "v1", scope: "scope-a" } })

			await pull(server, store)

			expect(server.pull.mock.calls[0][0].cursor).toBeNull()
			expect(store.states.get("items")).toMatchObject({ scope: "scope-b", version: "v1" })
		})

		it("does not mistake a half done walk of a new scope for a finished one", async () => {
			const server = createServer(manifest, { items: { start: page("c1", true) } })
			const store = createStore({ items: { cursor: "c9", version: "v1", scope: "scope-a" } })

			await pull(server, store)
			server.pull.mockClear()
			const second = await pull(server, store)

			expect(second.items.status).toBe("failed")
			expect(server.pull.mock.calls[0][0].cursor).toBe("c1")
		})
	})

	it("reports a manifest failure to the caller", async () => {
		const server = { getManifest: vi.fn().mockRejectedValue(new Error("offline")), pull: vi.fn() }

		await expect(pull(server, createStore())).rejects.toThrow("offline")
		expect(server.pull).not.toHaveBeenCalled()
	})
})

describe("PULL_ENTITIES", () => {
	it("pulls prices before items, so a first pull cannot skip a price change", () => {
		expect(PULL_ENTITIES.indexOf("item_prices")).toBeLessThan(PULL_ENTITIES.indexOf("items"))
	})

	it("pulls taxes before the catalog", () => {
		expect(PULL_ENTITIES.indexOf("taxes")).toBeLessThan(PULL_ENTITIES.indexOf("items"))
	})
})

describe("isCatalogWalked", () => {
	it("is true once a walk of that profile finished", () => {
		expect(isCatalogWalked({ version: "v1", posProfile: POS_PROFILE }, POS_PROFILE)).toBe(true)
	})

	it("is false during a walk", () => {
		expect(isCatalogWalked({ version: null, posProfile: POS_PROFILE }, POS_PROFILE)).toBe(false)
	})

	it("is false for another profile", () => {
		expect(isCatalogWalked({ version: "v1", posProfile: "Other" }, POS_PROFILE)).toBe(false)
	})

	it("is false with no state", () => {
		expect(isCatalogWalked(null, POS_PROFILE)).toBe(false)
	})
})

describe("pullStateKey", () => {
	it("gives each entity its own key", () => {
		expect(new Set(PULL_ENTITIES.map(pullStateKey)).size).toBe(PULL_ENTITIES.length)
	})
})
