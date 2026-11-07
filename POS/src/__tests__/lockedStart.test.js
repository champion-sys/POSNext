import { flushPromises } from "@vue/test-utils"
import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
	database: null,
	installRouter: vi.fn(),
	loadCredentials: vi.fn(async () => {}),
	showWarning: vi.fn(),
	getTranslations: vi.fn(async () => null),
}))

vi.mock("frappe-ui", () => {
	const component = { template: "<div />" }
	return {
		Alert: component,
		Badge: component,
		Button: component,
		Dialog: component,
		ErrorMessage: component,
		FormControl: component,
		Input: component,
		TextInput: component,
		call: vi.fn(async () => null),
		createResource: vi.fn(),
		frappeRequest: vi.fn(),
		pageMetaPlugin: { install: vi.fn() },
		resourcesPlugin: { install: vi.fn() },
		setConfig: vi.fn(),
	}
})

vi.mock("@/platform/runtime", async (original) => ({ ...(await original()), isNative: true }))

vi.mock("@/platform/store", () => ({
	checkNativeDatabase: async () => state.database,
	localStore: new Proxy({}, { get: () => state.getTranslations }),
}))

vi.mock("@/platform/auth", async (original) => ({
	...(await original()),
	cashierMustSignIn: async () => false,
	loadCredentials: state.loadCredentials,
}))

vi.mock("@/platform/lifecycle", () => ({ installAppLifecycle: vi.fn() }))
vi.mock("@/router", () => ({ default: { install: state.installRouter } }))
vi.mock("@/App.vue", () => ({ default: { template: "<div>the till</div>" } }))
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ showWarning: state.showWarning }) }))
vi.mock("@/data/session", () => ({ session: {}, sessionUser: () => null }))
vi.mock("@/data/user", () => ({ userResource: {} }))

async function start(database) {
	state.database = database
	document.body.innerHTML = '<div id="app"></div>'
	vi.resetModules()
	await import("@/main.js")
	await vi.waitFor(() => expect(document.querySelector("#app").textContent).not.toBe(""), {
		timeout: 5000,
	})
	await flushPromises()
}

describe("starting the app", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.spyOn(globalThis, "setInterval").mockImplementation(() => 0)
	})

	describe("over a locked database", () => {
		const locked = { locked: "key-missing", encrypted: false }

		it("shows the stop page and its code", async () => {
			await start(locked)

			const page = document.querySelector("#app").textContent
			expect(page).toContain("The data on this device is locked")
			expect(page).toContain("key-missing")
			expect(page).not.toContain("the till")
		})

		it("never reaches the till, nor the sign-in that would follow it", async () => {
			await start(locked)

			expect(state.installRouter).not.toHaveBeenCalled()
			expect(state.loadCredentials).not.toHaveBeenCalled()
		})
	})

	describe("over a database that opened", () => {
		it("goes on to the till", async () => {
			await start({ locked: null, encrypted: true })

			expect(state.installRouter).toHaveBeenCalled()
			expect(document.querySelector("#app").textContent).toContain("the till")
			expect(state.showWarning).not.toHaveBeenCalled()
		})

		it("says so when the data is not encrypted yet", async () => {
			await start({ locked: null, encrypted: false })

			expect(state.showWarning).toHaveBeenCalledWith(expect.stringContaining("not encrypted yet"))
		})
	})
})
