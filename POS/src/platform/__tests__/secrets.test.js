import { createRequire } from "node:module"
import { afterEach, describe, expect, it, vi } from "vitest"
import { androidSecretStore, openSecretStore } from "../secrets"

// The desktop's main process is CommonJS, and Node loads it as it will in Electron
const { createSecretStore, isAppFrame } = createRequire(import.meta.url)(
	"../../../desktop/electron/secrets.js",
)

const MISSING = new Error("Item with given key does not exist")

globalThis.__ = (text) => text

describe("androidSecretStore", () => {
	it("reads a value", async () => {
		const plugin = { get: vi.fn().mockResolvedValue({ value: "abc" }) }

		expect(await androidSecretStore(plugin).get("key")).toBe("abc")
		expect(plugin.get).toHaveBeenCalledWith({ key: "key" })
	})

	it("reads a missing key as empty", async () => {
		const plugin = { get: vi.fn().mockRejectedValue(MISSING) }

		expect(await androidSecretStore(plugin).get("key")).toBeNull()
	})

	it("does not read a keystore failure as a device that was never enrolled", async () => {
		const plugin = {
			get: vi.fn().mockRejectedValue(new Error("Keystore was tampered with")),
		}

		await expect(androidSecretStore(plugin).get("key")).rejects.toThrow(
			"Keystore",
		)
	})

	it("writes a value", async () => {
		const plugin = {
			get: vi.fn().mockResolvedValue({ value: "abc" }),
			set: vi.fn().mockResolvedValue({ value: true }),
		}

		await androidSecretStore(plugin).set("key", "abc")

		expect(plugin.set).toHaveBeenCalledWith({ key: "key", value: "abc" })
	})

	it("keeps an empty value, as enrolling does to test the store", async () => {
		const plugin = {
			get: vi.fn().mockResolvedValue({ value: "" }),
			set: vi.fn().mockResolvedValue({ value: true }),
		}

		await expect(androidSecretStore(plugin).set("key", "")).resolves.toBeUndefined()
	})

	it("fails when the plugin reports success and stored nothing", async () => {
		const plugin = {
			get: vi.fn().mockRejectedValue(MISSING),
			set: vi.fn().mockResolvedValue({ value: true }),
		}

		await expect(androidSecretStore(plugin).set("key", "abc")).rejects.toThrow(
			"cannot store secrets safely",
		)
	})

	it("fails when the old value is still there", async () => {
		const plugin = {
			get: vi.fn().mockResolvedValue({ value: "old" }),
			set: vi.fn().mockResolvedValue({ value: true }),
		}

		await expect(androidSecretStore(plugin).set("key", "new")).rejects.toThrow(
			"cannot store secrets safely",
		)
	})

	it("reports a read back the Keystore refuses", async () => {
		const plugin = {
			get: vi.fn().mockRejectedValue(new Error("Keystore was tampered with")),
			set: vi.fn().mockResolvedValue({ value: true }),
		}

		await expect(androidSecretStore(plugin).set("key", "abc")).rejects.toThrow(
			"Keystore",
		)
	})

	it("removing a missing key is not a failure", async () => {
		const plugin = { remove: vi.fn().mockRejectedValue(MISSING) }

		await expect(androidSecretStore(plugin).remove("key")).resolves.toBeNull()
	})
})

describe("openSecretStore", () => {
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it("keeps nothing on the web", () => {
		expect(() => openSecretStore("web")).toThrow()
	})

	it("uses the desktop's preload bridge", () => {
		const bridge = {}
		vi.stubGlobal("electronSecrets", bridge)

		expect(openSecretStore("electron")).toBe(bridge)
	})

	it("reaches the Android plugin through Capacitor's bridge", async () => {
		const nativePromise = vi.fn().mockResolvedValue({ value: "abc" })
		vi.stubGlobal("Capacitor", { nativePromise })

		expect(await openSecretStore("android").get("key")).toBe("abc")
		expect(nativePromise).toHaveBeenCalledWith("SecureStoragePlugin", "get", {
			key: "key",
		})
	})
})

describe("createSecretStore", () => {
	const filePath = "/data/secrets.json"

	function memoryFiles() {
		const contents = new Map()
		return {
			contents,
			readFileSync(path) {
				if (!contents.has(path))
					throw Object.assign(new Error("missing"), { code: "ENOENT" })
				return contents.get(path)
			},
			writeFileSync: (path, text) => contents.set(path, text),
			renameSync(from, to) {
				contents.set(to, contents.get(from))
				contents.delete(from)
			},
		}
	}

	const cipher = {
		encryptString: (text) =>
			Buffer.from(`sealed:${text}`.split("").reverse().join("")),
		decryptString: (buffer) =>
			buffer.toString().split("").reverse().join("").replace("sealed:", ""),
	}

	function open(files = memoryFiles(), isSecure = () => true) {
		return {
			files,
			store: createSecretStore({ filePath, cipher, isSecure, files }),
		}
	}

	it("reads back what it stored", () => {
		const { store } = open()
		store.set("token", "abc")
		expect(store.get("token")).toBe("abc")
	})

	it("has nothing before the first write", () => {
		expect(open().store.get("token")).toBeNull()
	})

	it("never writes the value in the clear", () => {
		const { store, files } = open()
		store.set("token", "very-secret")
		expect(files.contents.get(filePath)).not.toContain("very-secret")
	})

	it("keeps the other keys", () => {
		const { store } = open()
		store.set("a", "1")
		store.set("b", "2")
		store.remove("a")

		expect(store.get("a")).toBeNull()
		expect(store.get("b")).toBe("2")
	})

	it("leaves no temporary file behind", () => {
		const { store, files } = open()
		store.set("token", "abc")
		expect([...files.contents.keys()]).toEqual([filePath])
	})

	it("refuses to store on a system that cannot encrypt", () => {
		const { store, files } = open(memoryFiles(), () => false)

		expect(() => store.set("token", "abc")).toThrow()
		expect(files.contents.size).toBe(0)
	})

	it("does not pass off a damaged file as an empty one", () => {
		const files = memoryFiles()
		files.contents.set(filePath, "{broken")

		expect(() => open(files).store.get("token")).toThrow(SyntaxError)
	})
})

describe("isAppFrame", () => {
	it("accepts the app's own page", () => {
		expect(
			isAppFrame({ senderFrame: { url: "app://pos/device/sign-in" } }),
		).toBe(true)
	})

	it("refuses anything else", () => {
		expect(
			isAppFrame({ senderFrame: { url: "https://shop.example.com/" } }),
		).toBe(false)
		expect(isAppFrame({ senderFrame: null })).toBe(false)
		expect(isAppFrame({})).toBe(false)
	})
})
