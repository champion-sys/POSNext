import { describe, expect, it, vi } from "vitest"
import { installAppLifecycle, watchAppLifecycle } from "../lifecycle"

function fakeApp() {
	const listeners = {}
	return {
		listeners,
		addListener: vi.fn((event, listener) => {
			listeners[event] = listener
		}),
		minimizeApp: vi.fn().mockResolvedValue(),
	}
}

function hooks(overrides = {}) {
	return {
		onResume: vi.fn().mockResolvedValue(),
		countQueued: vi.fn().mockResolvedValue(0),
		confirmLeave: vi.fn().mockResolvedValue(true),
		...overrides,
	}
}

describe("watchAppLifecycle", () => {
	it("refreshes when the app returns", () => {
		const app = fakeApp()
		const handlers = hooks()

		watchAppLifecycle(handlers, app)
		app.listeners.resume()

		expect(handlers.onResume).toHaveBeenCalledOnce()
	})

	it("survives a failed refresh", async () => {
		const app = fakeApp()
		watchAppLifecycle(
			hooks({ onResume: vi.fn().mockRejectedValue(new Error("offline")) }),
			app,
		)

		expect(() => app.listeners.resume()).not.toThrow()
		await new Promise((resolve) => setTimeout(resolve))
	})

	it("leaves without asking when nothing is queued", async () => {
		const app = fakeApp()
		const handlers = hooks()

		watchAppLifecycle(handlers, app)
		await app.listeners.backButton({ canGoBack: true })

		expect(handlers.confirmLeave).not.toHaveBeenCalled()
		expect(app.minimizeApp).toHaveBeenCalledOnce()
	})

	it("warns with the number of queued invoices", async () => {
		const app = fakeApp()
		const handlers = hooks({ countQueued: vi.fn().mockResolvedValue(3) })

		watchAppLifecycle(handlers, app)
		await app.listeners.backButton({ canGoBack: false })

		expect(handlers.confirmLeave).toHaveBeenCalledWith(3)
		expect(app.minimizeApp).toHaveBeenCalledOnce()
	})

	it("stays when the cashier says so", async () => {
		const app = fakeApp()
		const handlers = hooks({
			countQueued: vi.fn().mockResolvedValue(1),
			confirmLeave: vi.fn().mockResolvedValue(false),
		})

		watchAppLifecycle(handlers, app)
		await app.listeners.backButton({ canGoBack: false })

		expect(app.minimizeApp).not.toHaveBeenCalled()
	})

	it("asks once when back is pressed twice", async () => {
		const app = fakeApp()
		const handlers = hooks({ countQueued: vi.fn().mockResolvedValue(1) })

		watchAppLifecycle(handlers, app)
		await Promise.all([
			app.listeners.backButton({}),
			app.listeners.backButton({}),
		])

		expect(handlers.confirmLeave).toHaveBeenCalledOnce()
	})

	it("can ask again after the first answer", async () => {
		const app = fakeApp()
		const handlers = hooks({
			countQueued: vi.fn().mockResolvedValue(1),
			confirmLeave: vi.fn().mockResolvedValue(false),
		})

		watchAppLifecycle(handlers, app)
		await app.listeners.backButton({})
		await app.listeners.backButton({})

		expect(handlers.confirmLeave).toHaveBeenCalledTimes(2)
	})

	it("stays when the queue cannot be read", async () => {
		const app = fakeApp()
		const handlers = hooks({
			countQueued: vi.fn().mockRejectedValue(new Error("worker gone")),
		})

		watchAppLifecycle(handlers, app)
		await app.listeners.backButton({})

		expect(app.minimizeApp).not.toHaveBeenCalled()
	})
})

describe("installAppLifecycle", () => {
	it("does nothing on the web", async () => {
		await expect(installAppLifecycle()).resolves.toBeUndefined()
	})
})
