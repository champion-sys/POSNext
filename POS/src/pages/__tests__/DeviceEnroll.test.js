import { flushPromises, mount } from "@vue/test-utils"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { reactive } from "vue"

const mocks = vi.hoisted(() => {
	globalThis.__ = (text, values = []) => text.replace("{0}", values[0])
	return { enrollDevice: vi.fn(), replace: vi.fn(), serverUrl: { current: "" } }
})

vi.mock("vue-router", () => ({
	useRoute: () => ({ query: {} }),
	useRouter: () => ({ replace: mocks.replace }),
}))
vi.mock("@/components/common/SignInError.vue", () => ({
	default: { props: ["message"], template: "<p>{{ message }}</p>" },
}))
vi.mock("@/platform/auth", () => ({
	SIGN_IN_ROUTE: "CashierSignIn",
	enrollDevice: mocks.enrollDevice,
}))
vi.mock("@/platform/runtime", () => ({
	getServerUrl: () => mocks.serverUrl.current,
}))

const { default: DeviceEnroll } = await import("../DeviceEnroll.vue")

const OLD = "https://old.example.com"
const NEW = "https://new.example.com"

async function submit() {
	const wrapper = mount(DeviceEnroll, {
		global: {
			mocks: { __: globalThis.__ },
			stubs: {
				Input: { template: "<input />" },
				Button: { template: "<button type='submit'><slot /></button>" },
			},
		},
	})
	await wrapper.find("form").trigger("submit")
	await flushPromises()
	return wrapper
}

describe("DeviceEnroll", () => {
	let location

	beforeEach(() => {
		location = reactive({ assign: vi.fn() })
		vi.stubGlobal("location", location)
		mocks.replace.mockClear()
		mocks.enrollDevice.mockReset()
		mocks.serverUrl.current = OLD
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it("names the server that still holds the device's sales", async () => {
		mocks.enrollDevice.mockRejectedValue(
			Object.assign(new Error(""), { code: "unsent_sales" }),
		)

		const wrapper = await submit()

		expect(wrapper.text()).toContain(`waiting to sync with ${OLD}`)
		expect(location.assign).not.toHaveBeenCalled()
		expect(mocks.replace).not.toHaveBeenCalled()
	})

	it("still makes sense when the old address is gone", async () => {
		mocks.serverUrl.current = ""
		mocks.enrollDevice.mockRejectedValue(
			Object.assign(new Error(""), { code: "unsent_sales" }),
		)

		expect((await submit()).text()).toContain(
			"waiting to sync with its previous server",
		)
	})

	it("says so when the old data could not be cleared", async () => {
		mocks.enrollDevice.mockRejectedValue(
			Object.assign(new Error("disk full"), { code: "local_data" }),
		)

		expect((await submit()).text()).toContain(
			"Could not clear the previous server's data",
		)
	})

	it("says so when it could not tell whether sales are waiting", async () => {
		mocks.enrollDevice.mockRejectedValue(
			Object.assign(new Error("database closed"), { code: "queue_unreadable" }),
		)

		expect((await submit()).text()).toContain(
			"Could not check this device for unsent sales",
		)
	})

	it("says so when secure storage did not keep the enrollment", async () => {
		mocks.enrollDevice.mockRejectedValue(
			Object.assign(new Error("Secure storage did not keep it"), { code: "secret_store" }),
		)

		expect((await submit()).text()).toContain(
			"could not save its enrollment in secure storage",
		)
	})

	it("starts over after moving, so nothing from the old server stays in memory", async () => {
		mocks.enrollDevice.mockImplementation(async () => {
			mocks.serverUrl.current = NEW
		})

		await submit()

		expect(location.assign).toHaveBeenCalledWith("/")
		expect(mocks.replace).not.toHaveBeenCalled()
	})

	it("goes straight to sign-in on the same server", async () => {
		mocks.enrollDevice.mockResolvedValue({})

		await submit()

		expect(mocks.replace).toHaveBeenCalledWith({ name: "CashierSignIn" })
		expect(location.assign).not.toHaveBeenCalled()
	})

	it("goes straight to sign-in on a first enrollment", async () => {
		mocks.serverUrl.current = ""
		mocks.enrollDevice.mockImplementation(async () => {
			mocks.serverUrl.current = NEW
		})

		await submit()

		expect(mocks.replace).toHaveBeenCalledWith({ name: "CashierSignIn" })
		expect(location.assign).not.toHaveBeenCalled()
	})
})
