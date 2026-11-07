// @vitest-environment node
import { EventEmitter } from "node:events"
import fs from "node:fs"
import Module, { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const IPC = resolve(__dirname, "../../../../desktop/electron/db/ipc.js")
const SECRETS = resolve(__dirname, "../../../../desktop/electron/secrets.js")
const require = createRequire(import.meta.url)
const { DATABASE_KEY, LOCK } = require("../../../../desktop/electron/db/encryption.js")

const APP_PAGE = { senderFrame: { url: "app://pos/" } }
const FOREIGN_PAGE = { senderFrame: { url: "https://example.com/" } }

function fakeElectron(userData, answer) {
	const processes = []
	const handlers = new Map()

	return {
		handlers,
		processes,
		app: { getPath: () => userData },
		ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
		safeStorage: {
			isEncryptionAvailable: () => true,
			encryptString: (value) => Buffer.from(value),
			decryptString: (value) => value.toString(),
		},
		utilityProcess: {
			fork(script, args = []) {
				const child = Object.assign(new EventEmitter(), {
					script,
					args,
					messages: [],
					kill() {
						child.emit("exit", 0)
					},
					postMessage(message) {
						child.messages.push(message)
						queueMicrotask(() =>
							child.emit("message", { id: message.id, result: answer(message) }),
						)
					},
				})
				processes.push(child)
				return child
			},
		},
	}
}

const realLoad = Module._load

/** Loads the real ipc.js and secrets.js, which ask for Electron's API as they go. */
function startIpc(electron) {
	Module._load = function (request, ...rest) {
		return request === "electron" ? electron : realLoad.call(this, request, ...rest)
	}
	for (const file of Object.keys(require.cache)) {
		if (file.includes("/desktop/electron/")) delete require.cache[file]
	}
	require(IPC).registerDatabaseIpc()
	require(SECRETS).registerSecretHandlers()
}

describe("the window's way to the database", () => {
	let userData
	const opened = ({ method }) => (method === "open" ? { encrypted: true } : [{ a: 1 }])

	beforeEach(() => {
		userData = fs.mkdtempSync(join(tmpdir(), "pos-ipc-"))
	})

	afterEach(() => {
		Module._load = realLoad
		fs.rmSync(userData, { recursive: true, force: true })
		vi.restoreAllMocks()
	})

	function start(answer = opened) {
		const electron = fakeElectron(userData, answer)
		startIpc(electron)
		return {
			electron,
			call: (channel, event = APP_PAGE, ...args) => electron.handlers.get(channel)(event, ...args),
		}
	}

	const database = () => join(userData, "pos-next.sqlite")
	const leaveEncryptedFile = () => fs.writeFileSync(database(), Buffer.alloc(4096, 0x5a))
	const savedSecrets = () => JSON.parse(fs.readFileSync(join(userData, "secrets.json"), "utf8"))

	it("gives the key to the database process by message, never on its command line", async () => {
		const { electron, call } = start()

		await call("db:open")

		const [child] = electron.processes
		expect(child.args).toEqual([])
		const [{ method, args }] = child.messages
		expect(method).toBe("open")
		expect(args[1]).toMatch(/^[0-9a-f]{64}$/)
	})

	it("tells the window how the database opened, and nothing of the key", async () => {
		const { call } = start()

		expect(await call("db:open")).toEqual({ encrypted: true })
	})

	it("keeps the key only in the secrets file, under the operating system's encryption", async () => {
		const { electron, call } = start()

		await call("db:open")

		expect(savedSecrets()[DATABASE_KEY]).toBeTruthy()
		const [{ args }] = electron.processes[0].messages
		expect(fs.existsSync(database())).toBe(false)
		expect(args[0]).toBe(database())
	})

	it("uses the same key after a restart", async () => {
		const first = start()
		await first.call("db:open")
		const [{ args: firstArgs }] = first.electron.processes[0].messages

		const second = start()
		await second.call("db:open")
		const [{ args: secondArgs }] = second.electron.processes[0].messages

		expect(secondArgs[1]).toBe(firstArgs[1])
	})

	it("refuses a frame that is not the app", async () => {
		const { electron, call } = start()

		expect(() => call("db:open", FOREIGN_PAGE)).toThrow("Not allowed")
		expect(electron.processes).toEqual([])
	})

	it("starts one process for many calls", async () => {
		const { electron, call } = start()

		await Promise.all([call("db:open"), call("db:all", APP_PAGE, "SELECT 1"), call("db:open")])

		expect(electron.processes).toHaveLength(1)
	})

	it("hands a process that stopped the key again", async () => {
		const { electron, call } = start()
		await call("db:open")
		electron.processes[0].emit("exit", 1)

		await call("db:all", APP_PAGE, "SELECT 1")

		expect(electron.processes).toHaveLength(2)
		expect(electron.processes[1].messages[0].args[1]).toMatch(/^[0-9a-f]{64}$/)
	})

	describe("when the database is locked", () => {
		it("starts no process, and generates no key, for a file with no key", async () => {
			leaveEncryptedFile()
			const { electron, call } = start()

			expect(await call("db:open")).toEqual({ locked: LOCK.KEY_MISSING })
			expect(electron.processes).toEqual([])
			expect(fs.existsSync(join(userData, "secrets.json"))).toBe(false)
		})

		it("fails every statement, so nothing reads as empty", async () => {
			leaveEncryptedFile()
			const { call } = start()

			await expect(call("db:all", APP_PAGE, "SELECT 1")).rejects.toThrow(LOCK.KEY_MISSING)
			await expect(call("db:run", APP_PAGE, "DELETE FROM kv")).rejects.toThrow(LOCK.KEY_MISSING)
		})

		it("passes on what the process found, and stops it", async () => {
			const { electron, call } = start(() => ({ locked: LOCK.KEY_REJECTED }))
			const kill = vi.fn()

			const answer = call("db:open")
			electron.processes[0].kill = kill

			expect(await answer).toEqual({ locked: LOCK.KEY_REJECTED })
			expect(kill).toHaveBeenCalled()
		})

		it("treats a file it cannot look at as locked, not empty", async () => {
			vi.spyOn(console, "error").mockImplementation(() => {})
			fs.mkdirSync(database())
			const { call } = start()

			expect(await call("db:open")).toEqual({ locked: LOCK.OPEN_FAILED })
		})

		it("looks again on the next try, so a key put back opens the file", async () => {
			leaveEncryptedFile()
			const { electron, call } = start()
			expect(await call("db:open")).toEqual({ locked: LOCK.KEY_MISSING })

			fs.writeFileSync(
				join(userData, "secrets.json"),
				JSON.stringify({ [DATABASE_KEY]: Buffer.from("ab".repeat(32)).toString("base64") }),
			)

			expect(await call("db:open")).toEqual({ encrypted: true })
			expect(electron.processes).toHaveLength(1)
		})
	})

	describe("the secrets a page may ask for", () => {
		it.each(["secrets:get", "secrets:set", "secrets:remove"])("%s refuses the database key", async (channel) => {
			const { call } = start()

			expect(() => call(channel, APP_PAGE, DATABASE_KEY, "value")).toThrow("Not allowed")
		})

		it("cannot be walked around with an array, which reads the same entry", async () => {
			const { call } = start()
			await call("db:open")

			expect(() => call("secrets:get", APP_PAGE, [DATABASE_KEY])).toThrow("Not allowed")
		})

		it("still answers for the device's other secrets", async () => {
			const { call } = start()

			await call("secrets:set", APP_PAGE, "pos_next_device_token", "token")

			expect(await call("secrets:get", APP_PAGE, "pos_next_device_token")).toBe("token")
		})
	})
})
