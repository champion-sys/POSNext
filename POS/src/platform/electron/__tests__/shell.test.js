// @vitest-environment node
import Module, { createRequire } from "node:module"
import { EventEmitter } from "node:events"
import { describe, expect, it, vi } from "vitest"

const require = createRequire(import.meta.url)
const MAIN = require.resolve("../../../../desktop/electron/main.js")
const {
	CONTENT_SECURITY_POLICY,
	isExternalLink,
} = require("../../../../desktop/electron/security.js")

const APP_PAGE = { senderFrame: { url: "app://pos/" } }

function fakeElectron({ isPackaged }) {
	const windows = []
	const handlers = new Map()
	const app = Object.assign(new EventEmitter(), {
		isPackaged,
		getPath: () => "/tmp",
		requestSingleInstanceLock: () => true,
		whenReady: () => Promise.resolve(),
		quit: vi.fn(),
	})

	class BrowserWindow extends EventEmitter {
		constructor(options) {
			super()
			this.options = options
			this.loadURL = vi.fn()
			this.webContents = {
				getPrintersAsync: async () => [{ name: "Receipts" }],
			}
			windows.push(this)
		}
	}

	return {
		app,
		BrowserWindow,
		windows,
		handlers,
		ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
		Menu: { setApplicationMenu: vi.fn() },
		net: {
			fetch: vi.fn(
				async () =>
					new Response("<html></html>", {
						headers: { "content-type": "text/html" },
					}),
			),
		},
		protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
		safeStorage: {},
		shell: { openExternal: vi.fn(async () => {}) },
		utilityProcess: {},
	}
}

/** Runs main.js in Node as the desktop app would, with Electron's API replaced. */
async function startShell({ isPackaged = false } = {}) {
	const electron = fakeElectron({ isPackaged })
	const load = Module._load
	Module._load = function (request, ...rest) {
		if (request === "electron") return electron
		if (request === "electron-updater")
			return { autoUpdater: { on() {}, checkForUpdates: async () => {} } }
		return load.call(this, request, ...rest)
	}

	for (const file of Object.keys(require.cache)) {
		if (file.includes("/desktop/electron/")) delete require.cache[file]
	}
	const updateTimer = vi
		.spyOn(globalThis, "setInterval")
		.mockImplementation(() => 0)
	try {
		require(MAIN)
	} finally {
		Module._load = load
	}
	await new Promise((resolve) => setTimeout(resolve))
	updateTimer.mockRestore()
	return electron
}

function confinedContents(electron) {
	const contents = Object.assign(new EventEmitter(), {
		setWindowOpenHandler: vi.fn(),
	})
	electron.app.emit("web-contents-created", {}, contents)
	return {
		contents,
		openWindow: contents.setWindowOpenHandler.mock.calls[0][0],
	}
}

function directives(policy) {
	return Object.fromEntries(
		policy.split("; ").map((directive) => {
			const [name, ...sources] = directive.split(" ")
			return [name, sources]
		}),
	)
}

describe("the printers", () => {
	it.each(["printers:list", "printers:print"])(
		"%s refuses a frame that is not the app",
		async (channel) => {
			const { handlers } = await startShell()
			const handler = handlers.get(channel)

			expect(() =>
				handler({ senderFrame: { url: "https://evil.example.com/" } }),
			).toThrow("Not allowed")
			expect(() =>
				handler({ senderFrame: { url: "app://pos.evil/" } }),
			).toThrow("Not allowed")
			expect(() => handler({ senderFrame: null })).toThrow("Not allowed")
		},
	)

	it("lists printers for the app's own page", async () => {
		const { handlers } = await startShell()

		await expect(handlers.get("printers:list")(APP_PAGE)).resolves.toEqual([
			{ name: "Receipts" },
		])
	})
})

describe("navigation", () => {
	const navigate = (contents, url) => {
		const event = { preventDefault: vi.fn() }
		contents.emit("will-navigate", event, url)
		return event.preventDefault.mock.calls.length > 0
	}

	it("stays on the app origin", async () => {
		const { contents } = confinedContents(await startShell())

		expect(navigate(contents, "app://pos/app")).toBe(false)
		expect(navigate(contents, "https://nexus.brainwise.me/")).toBe(true)
		expect(navigate(contents, "file:///etc/passwd")).toBe(true)
		expect(navigate(contents, "app://other/")).toBe(true)
	})

	it("sends an https link to the system browser, never to a new window", async () => {
		const electron = await startShell()
		const { openWindow } = confinedContents(electron)

		expect(openWindow({ url: "https://nexus.brainwise.me/" })).toEqual({
			action: "deny",
		})
		expect(electron.shell.openExternal).toHaveBeenCalledWith(
			"https://nexus.brainwise.me/",
		)
	})

	it.each([
		"http://example.com/",
		"file:///etc/passwd",
		"smb://server/share",
		"app://pos/",
		"about:blank",
		"not a url",
	])("opens %s nowhere", async (url) => {
		const electron = await startShell()
		const { openWindow } = confinedContents(electron)

		expect(openWindow({ url })).toEqual({ action: "deny" })
		expect(electron.shell.openExternal).not.toHaveBeenCalled()
	})

	it("treats only https as an external link", () => {
		expect(isExternalLink("https://example.com")).toBe(true)
		expect(isExternalLink("javascript:alert(1)")).toBe(false)
	})
})

describe("the content security policy", () => {
	it("goes on what app:// serves", async () => {
		const electron = await startShell()
		const [[, serve]] = electron.protocol.handle.mock.calls

		const response = await serve({ url: "app://pos/" })

		expect(response.headers.get("content-security-policy")).toBe(
			CONTENT_SECURITY_POLICY,
		)
		expect(response.headers.get("content-type")).toBe("text/html")
	})

	it("runs no script the app did not ship", () => {
		const policy = directives(CONTENT_SECURITY_POLICY)

		expect(policy["script-src"]).toEqual(["'self'"])
		expect(policy["object-src"]).toEqual(["'none'"])
		expect(policy["base-uri"]).toEqual(["'none'"])
	})

	it("reaches a server chosen at enrollment, over http inside a network and by websocket", () => {
		const policy = directives(CONTENT_SECURITY_POLICY)

		expect(policy["connect-src"]).toEqual(
			expect.arrayContaining(["https:", "http:", "wss:", "ws:"]),
		)
		expect(policy["img-src"]).toEqual(
			expect.arrayContaining(["https:", "http:", "data:"]),
		)
	})
})

describe("a packaged build", () => {
	it("has no DevTools and no default menu", async () => {
		const { windows, Menu } = await startShell({ isPackaged: true })

		expect(windows[0].options.webPreferences.devTools).toBe(false)
		expect(Menu.setApplicationMenu).toHaveBeenCalledWith(null)
	})

	it("keeps both in development", async () => {
		const { windows, Menu } = await startShell({ isPackaged: false })

		expect(windows[0].options.webPreferences.devTools).toBe(true)
		expect(Menu.setApplicationMenu).not.toHaveBeenCalled()
	})

	it("keeps the window sandboxed either way", async () => {
		const { windows } = await startShell({ isPackaged: true })

		expect(windows[0].options.webPreferences).toMatchObject({
			contextIsolation: true,
			nodeIntegration: false,
			sandbox: true,
		})
	})
})
