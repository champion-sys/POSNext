import { afterEach, describe, expect, it, vi } from "vitest"

const page = { default: { template: "<div />" } }

vi.mock("@/pages/POSSale.vue", () => page)
vi.mock("@/pages/Login.vue", () => page)
vi.mock("@/pages/DeviceEnroll.vue", () => page)
vi.mock("@/pages/CashierSignIn.vue", () => page)
vi.mock("@/composables/useShift", () => ({ shiftState: {} }))
vi.mock("@/data/user", () => ({ userResource: {} }))
vi.mock("../data/session", () => ({ session: { isLoggedIn: false } }))

async function loadRouter(platform, { loggedIn = false } = {}) {
	vi.resetModules()
	if (platform) vi.stubEnv("VITE_PLATFORM", platform)
	window.history.replaceState({}, "", "/pos/")

	const { session } = await import("../data/session")
	session.isLoggedIn = loggedIn
	const { default: router } = await import("../router")
	return { router }
}

async function open(router, path) {
	await router.push(path)
	return router.currentRoute.value.name
}

afterEach(() => {
	vi.unstubAllEnvs()
})

describe("router on the web", () => {
	it("has no device pages", async () => {
		const { router } = await loadRouter()
		const names = router.getRoutes().map((route) => route.name)

		expect(names).toContain("Login")
		expect(names).not.toContain("CashierSignIn")
		expect(names).not.toContain("DeviceEnroll")
	})

	it("sends a signed-out user to the cookie login", async () => {
		const { router } = await loadRouter()

		expect(await open(router, "/")).toBe("Login")
	})

	it("never lands on a device page, even by address", async () => {
		const { router } = await loadRouter()

		expect(await open(router, "/device/sign-in")).toBe("Login")
		expect(await open(router, "/device/enroll")).toBe("Login")
	})

	it("sends a signed-in user from the login to the sale", async () => {
		const { router } = await loadRouter(undefined, { loggedIn: true })

		expect(await open(router, "/account/login")).toBe("POSSale")
	})

	it("opens the sale for a signed-in user", async () => {
		const { router } = await loadRouter(undefined, { loggedIn: true })

		expect(await open(router, "/")).toBe("POSSale")
	})
})

describe("router on the desktop app", () => {
	it("starts an unenrolled device at enrollment", async () => {
		const { router } = await loadRouter("electron")

		expect(await open(router, "/")).toBe("DeviceEnroll")
	})

	it("never shows the cookie login", async () => {
		const { router } = await loadRouter("electron")

		expect(await open(router, "/account/login")).toBe("DeviceEnroll")
	})

	it("starts an enrolled device at the cashier sign-in", async () => {
		const { router } = await loadRouter("electron")
		const { setDeviceToken, setServerUrl } = await import("@/platform/runtime")
		setServerUrl("https://shop.example.com")
		setDeviceToken("posd_token")

		expect(await open(router, "/")).toBe("CashierSignIn")
	})
})
