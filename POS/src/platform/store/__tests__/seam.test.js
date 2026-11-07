import { readFileSync, readdirSync } from "node:fs"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"
import { migrate } from "@/platform/sql/migrations"
import { STORE_METHODS, WORKER_METHODS } from "../methods"
import { DatabaseLockedError, LOCK } from "../databaseLock"
import { checkDatabase, createNativeStore } from "../native"
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
	const SHARED = ["components", "core", "composables", "pages", "services", "stores", "utils"]

	const sharedFiles = SHARED.flatMap((folder) =>
		readdirSync(path.join(SRC, folder), { recursive: true })
			.map((file) => path.join(folder, file))
			.filter((file) => /\.(js|ts|vue)$/.test(file) && !file.includes("__tests__")),
	)

	function findInSharedCode(pattern, except = []) {
		return sharedFiles.filter(
			(file) =>
				!except.some((allowed) => file.endsWith(allowed)) &&
				pattern.test(readFileSync(path.join(SRC, file), "utf8")),
		)
	}

	it("leaves no Dexie or IndexedDB outside the web implementation", () => {
		const pattern = /from\s+["']dexie["']|\bindexedDB\.open|\bdb\.(table|[a-z_]+)\.|utils\/offline\/db|from\s+["']\.\/db["']/
		expect(findInSharedCode(pattern, ["utils/offline/db.js"])).toEqual([])
	})

	it("calls nothing that one of the platforms does not have", () => {
		const called = new Set(
			sharedFiles.flatMap((file) =>
				[...readFileSync(path.join(SRC, file), "utf8").matchAll(/\b(?:offlineWorker|localStore)\.(\w+)/g)].map(
					([, name]) => name,
				),
			),
		)

		expect(called.size).toBeGreaterThan(30)
		expect([...called].filter((name) => !STORE_METHODS.includes(name))).toEqual([])
	})

	it("leaves no native storage code in shared files", () => {
		expect(findInSharedCode(/electronAPI\.db|capacitor-community|better-sqlite3/i)).toEqual([])
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

	it("never pretends a broken queue is an empty one to an export", async () => {
		const store = failing()

		expect(await store.listUnsyncedInvoices()).toEqual([])
		await expect(store.listUnconfirmedRows()).rejects.toThrow("cannot open")
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

describe("when the database is locked", () => {
	const locked = () => Promise.reject(new DatabaseLockedError(LOCK.KEY_MISSING))

	it.each([
		["the queue", "getOfflineInvoiceCount", []],
		["the catalog", "searchCachedItems", ["x"]],
		["a setting", "getSetting", ["key", "fallback"]],
		["the cache", "isCacheReady", []],
	])("does not answer %s as if it were empty", async (_, method, args) => {
		await expect(createNativeStore(locked)[method](...args)).rejects.toMatchObject({
			reason: LOCK.KEY_MISSING,
		})
	})

	it("names the reason to the app's start", async () => {
		expect(await checkDatabase(locked)).toEqual({ locked: LOCK.KEY_MISSING, encrypted: false })
	})

	it("does not stop the app for a database that opened", async () => {
		expect(await checkDatabase(async () => ({ encrypted: true }))).toEqual({ locked: null, encrypted: true })
	})

	it("says when a database opened plain", async () => {
		expect(await checkDatabase(async () => ({ encrypted: false }))).toEqual({ locked: null, encrypted: false })
	})

	it("leaves any other failure to degrade as it always has", async () => {
		const failing = async () => {
			throw new Error("cannot open")
		}

		expect(await checkDatabase(failing)).toEqual({ locked: null, encrypted: false })
	})
})
