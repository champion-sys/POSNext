import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"
import { migrate } from "@/platform/sql/migrations"
import { STORE_METHODS, WORKER_METHODS } from "../methods"
import { createNativeStore } from "../native"
import { createSqlStore } from "../sqlStore"
import { createNodeExecutor } from "./sqliteHarness"

const SRC = path.resolve(__dirname, "../../..")

describe("what the app calls", () => {
	it("keeps every name offlineWorker has always had", () => {
		const source = readFileSync(path.join(SRC, "platform/store/web/workerClient.js"), "utf8")
		const names = [...source.matchAll(/^\t(?:async )?(\w+)\(/gm)].map(([, name]) => name)
		const internal = [
			"constructor",
			"init",
			"startHealthCheck",
			"shouldRetryMessage",
			"retryMessage",
			"handleWorkerCrash",
			"rejectAllPending",
			"sendMessage",
			"gracefulFallback",
		]

		expect(names.filter((name) => !internal.includes(name)).sort()).toEqual([...WORKER_METHODS].sort())
	})

	it("is complete on the web", async () => {
		const { openStore } = await import("../web")
		const web = openStore()

		expect(STORE_METHODS.filter((name) => typeof web[name] !== "function")).toEqual([])
		expect(Object.keys(web).filter((name) => !STORE_METHODS.includes(name))).toEqual([])
	})

	it("is complete on SQLite", () => {
		const store = createSqlStore(createNodeExecutor())

		expect(STORE_METHODS.filter((name) => typeof store[name] !== "function")).toEqual([])
		expect(Object.keys(store).filter((name) => !STORE_METHODS.includes(name))).toEqual([])
	})
})

describe("keeping platforms out of shared code", () => {
	const sharedFiles = import.meta.glob(
		["/src/{components,pages,stores,composables,services}/**/*.{js,ts,vue}", "/src/utils/**/*.{js,ts}"],
		{ query: "?raw", import: "default" },
	)

	async function findInSharedCode(pattern, except = []) {
		const offenders = []
		for (const [file, load] of Object.entries(sharedFiles)) {
			if (file.includes("__tests__") || except.some((allowed) => file.endsWith(allowed))) continue
			if (pattern.test(await load())) offenders.push(file)
		}
		return offenders
	}

	it("leaves no Dexie or IndexedDB outside the web implementation", async () => {
		const pattern = /from\s+["']dexie["']|\bindexedDB\.open|\bdb\.(table|[a-z_]+)\.|utils\/offline\/db|from\s+["']\.\/db["']/
		expect(await findInSharedCode(pattern, ["/utils/offline/db.js"])).toEqual([])
	})

	it("leaves no native storage code in shared files", async () => {
		expect(await findInSharedCode(/electronAPI\.db|capacitor-community|better-sqlite3/i)).toEqual([])
	})
})

describe("when the database fails", () => {
	const failing = () => createNativeStore(async () => Promise.reject(new Error("cannot open")))

	it("keeps the screens up on reads", async () => {
		const store = failing()

		expect(await store.getOfflineInvoiceCount()).toBe(0)
		expect(await store.searchCachedItems("x")).toEqual([])
		expect(await store.isCacheReady()).toBe(false)
		expect(await store.getCacheStats()).toMatchObject({ items: 0, cacheReady: false })
		expect(await store.getSetting("key", "fallback")).toBe("fallback")
	})

	it("never pretends a sale was saved", async () => {
		await expect(failing().saveOfflineInvoice({ items: [{}] })).rejects.toThrow("cannot open")
	})

	it("tries again on the next call", async () => {
		const sql = createNodeExecutor()
		await migrate(sql)
		const open = vi.fn().mockRejectedValueOnce(new Error("busy")).mockResolvedValue(createSqlStore(sql))
		const store = createNativeStore(open)

		expect(await store.isCacheReady()).toBe(false)
		await store.setSetting("key", 1)

		expect(await store.getSetting("key")).toBe(1)
		expect(open).toHaveBeenCalledTimes(2)
	})

	it("opens the database only once", async () => {
		const sql = createNodeExecutor()
		await migrate(sql)
		const open = vi.fn(async () => createSqlStore(sql))
		const store = createNativeStore(open)

		await Promise.all([store.isCacheReady(), store.getOfflineInvoiceCount(), store.getSetting("key")])

		expect(open).toHaveBeenCalledTimes(1)
	})
})
