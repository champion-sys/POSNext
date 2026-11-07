import { flushPromises, mount } from "@vue/test-utils"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => {
	globalThis.__ = (text) => text
	return { signInWithPin: vi.fn() }
})

vi.mock("vue-router", () => ({ useRouter: () => ({ replace: vi.fn() }) }))
vi.mock("frappe-ui", () => ({ FeatherIcon: { template: "<i />" } }))
vi.mock("@/components/common/SignInError.vue", () => ({
	default: { props: ["message"], template: "<p>{{ message }}</p>" },
}))
vi.mock("@/components/settings/QueueExport.vue", () => ({
	default: { template: "<div data-testid='queue-export' />" },
}))
vi.mock("@/data/session", () => ({ session: {}, sessionUser: () => "a@example.com" }))
vi.mock("@/data/user", () => ({ userData: { refresh: vi.fn() } }))
vi.mock("@/platform/auth", () => ({
	ENROLL_ROUTE: "DeviceEnroll",
	isServerReachable: async () => false,
	knownCashiers: () => [
		{ user: "a@example.com", fullName: "Cashier A" },
		{ user: "b@example.com", fullName: "Cashier B" },
	],
	pinRefusalMessage: ({ reason }) => reason,
	setCashierPin: vi.fn(),
	signInCashier: vi.fn(),
	signInWithPin: mocks.signInWithPin,
}))
vi.mock("@/platform/identity", () => ({ readIdentity: () => ({ userId: null }) }))
vi.mock("@/platform/offlinePin", () => ({ PIN_PATTERN: /^\d{6,8}$/ }))
vi.mock("@/utils/sessionCleanup", () => ({ cleanupUserSession: vi.fn() }))

const { default: CashierSignIn } = await import("../CashierSignIn.vue")

async function signInWith(result) {
	mocks.signInWithPin.mockResolvedValue(result)

	const wrapper = mount(CashierSignIn, {
		global: {
			mocks: { __: globalThis.__ },
			stubs: {
				Input: { template: "<input />" },
				Button: { template: "<button type='submit'><slot /></button>" },
			},
		},
	})
	await flushPromises()
	await wrapper.find("form").trigger("submit")
	await flushPromises()
	return wrapper
}

const offersExport = (wrapper) => wrapper.find('[data-testid="queue-export"]').exists()

describe("the way out past the offline limit", () => {
	beforeEach(() => {
		mocks.signInWithPin.mockReset()
	})

	it("opens to a cashier whose PIN is right and whose time is up", async () => {
		const wrapper = await signInWith({ ok: false, reason: "expired" })

		expect(offersExport(wrapper)).toBe(true)
		expect(wrapper.text()).toContain("expired")
	})

	it.each(["wrong", "locked", "no_pin", "online"])("stays shut for %s", async (reason) => {
		expect(offersExport(await signInWith({ ok: false, reason }))).toBe(false)
	})

	it("closes again when the next attempt is wrong", async () => {
		const wrapper = await signInWith({ ok: false, reason: "expired" })

		mocks.signInWithPin.mockResolvedValue({ ok: false, reason: "wrong" })
		await wrapper.find("form").trigger("submit")
		await flushPromises()

		expect(offersExport(wrapper)).toBe(false)
	})

	it("closes, with its message, when another cashier is chosen", async () => {
		const wrapper = await signInWith({ ok: false, reason: "expired" })

		await wrapper.find("select").setValue("b@example.com")

		expect(offersExport(wrapper)).toBe(false)
		expect(wrapper.text()).not.toContain("expired")
	})

	it("closes when they go back to a password", async () => {
		const wrapper = await signInWith({ ok: false, reason: "expired" })

		await wrapper.find("form button[type=button]").trigger("click")

		expect(offersExport(wrapper)).toBe(false)
	})
})
