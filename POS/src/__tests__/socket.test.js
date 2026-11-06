import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const fakeSocket = {
	on: vi.fn(),
	off: vi.fn(),
	connect: vi.fn(),
	disconnect: vi.fn(),
}

vi.mock("socket.io-client", () => ({ io: vi.fn(() => fakeSocket) }))

async function loadOn(platform) {
	vi.resetModules()
	vi.stubEnv("VITE_PLATFORM", platform)
	vi.stubGlobal("__SOCKETIO_PORT__", 9000)

	const { io } = await import("socket.io-client")
	return { io, ...(await import("../socket")) }
}

beforeEach(() => {
	vi.clearAllMocks()
})

afterEach(() => {
	vi.unstubAllEnvs()
	vi.unstubAllGlobals()
})

describe("in the browser", () => {
	it("connects with the session cookie, to the site's namespace", async () => {
		const { io, initSocket } = await loadOn("web")

		const socket = initSocket("shop.example.com")

		expect(socket).toBe(fakeSocket)
		expect(io).toHaveBeenCalledTimes(1)
		const [url, options] = io.mock.calls[0]
		expect(url).toMatch(/\/shop\.example\.com$/)
		expect(options.withCredentials).toBe(true)
	})

	it("keeps one socket", async () => {
		const { io, initSocket } = await loadOn("web")

		initSocket("shop.example.com")
		initSocket("shop.example.com")

		expect(io).toHaveBeenCalledTimes(1)
	})
})

describe.each(["electron", "android"])("on %s", (platform) => {
	it("never opens a connection", async () => {
		const { io, initSocket } = await loadOn(platform)

		const socket = initSocket("shop.example.com")
		socket.connect()

		expect(io).not.toHaveBeenCalled()
		expect(socket).not.toBe(fakeSocket)
	})

	it("gives the code listening for events something to call", async () => {
		const { initSocket } = await loadOn(platform)
		const socket = initSocket("shop.example.com")
		const handler = vi.fn()

		expect(() => {
			socket.on("pos_stock_update", handler)
			socket.off("pos_stock_update", handler)
			socket.emit("anything")
			socket.disconnect()
		}).not.toThrow()
		expect(handler).not.toHaveBeenCalled()
	})

	it("has nothing that could retry", async () => {
		const { useSocket, initSocket } = await loadOn(platform)

		initSocket("shop.example.com")

		expect(useSocket()).toBeNull()
	})
})
