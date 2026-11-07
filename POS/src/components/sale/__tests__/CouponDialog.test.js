/**
 * The real dialog and the real shift state: whether a coupon is checked by the server or by
 * the device depends on whether the server will confirm it now. frappe-ui is faked because
 * it does not load under vitest.
 */
import { flushPromises, mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { shiftState } from "@/composables/useShift"
import { offlineState } from "@/utils/offline/offlineState"
import CouponDialog from "../CouponDialog.vue"

const server = vi.hoisted(() => {
	globalThis.__ = (text) => text
	return { resources: new Map() }
})
const checkCouponOffline = vi.hoisted(() => vi.fn())

vi.mock("frappe-ui", async () => {
	const { reactive } = await import("vue")
	return {
		Button: {
			props: ["disabled", "loading"],
			template: `<button :disabled="disabled" @click="$emit('click')"><slot /></button>`,
		},
		Dialog: { template: `<div><slot name="body-content" /><slot name="actions" /></div>` },
		FormControl: { template: "<input />" },
		Input: { template: "<input />" },
		createResource: (options) => {
			const resource = reactive({ data: null, loading: false, error: null, reload: vi.fn(async () => null) })
			server.resources.set(options.url, resource)
			return resource
		},
	}
})

vi.mock("@/utils/offline/offlineState", () => ({
	offlineState: { isOffline: false, subscribe: () => () => {} },
}))
vi.mock("@/platform/store", () => ({ localStore: {} }))
vi.mock("@/stores/posSync", () => ({ usePOSSyncStore: () => ({ checkCouponOffline }) }))
vi.mock("@/stores/posSettings", () => ({ usePOSSettingsStore: () => ({ offlineCouponsEnabled: true }) }))
vi.mock("@/composables/useInvoice", () => ({ useInvoice: () => ({ calculateDiscountAmount: () => 5 }) }))
vi.mock("@/composables/useToast", () => ({
	useToast: () => ({ showSuccess: vi.fn(), showError: vi.fn(), showWarning: vi.fn() }),
}))

const VALIDATE = "pos_next.api.offers.validate_coupon"
const GIFT_CARDS = "pos_next.api.offers.get_active_coupons"

const openShift = (name) => {
	shiftState.value = {
		pos_opening_shift: { name, user: "a@example.com" },
		pos_profile: { name: "Main" },
		company: { name: "Acme" },
		isOpen: true,
	}
}

describe("the coupon dialog", () => {
	let wrapper

	const open = async () => {
		wrapper = mount(CouponDialog, {
			props: { modelValue: false, subtotal: 100, customer: "CUST-1", company: "Acme", posProfile: "Main" },
			global: { mocks: { __: (text) => text } },
		})
		await wrapper.setProps({ modelValue: true })
		await flushPromises()
	}

	const apply = async (code) => {
		wrapper.vm.couponCode = code
		await wrapper.vm.applyCoupon()
		await flushPromises()
	}

	beforeEach(() => {
		setActivePinia(createPinia())
		vi.clearAllMocks()
		offlineState.isOffline = false
		checkCouponOffline.mockResolvedValue({
			coupon: { coupon_code: "GIFT-1", coupon_type: "Gift Card" },
			problem: "gift_card",
		})
	})

	afterEach(() => {
		wrapper.unmount()
		shiftState.value = { pos_opening_shift: null, pos_profile: null, company: null, isOpen: false }
	})

	describe("with a shift the server does not know yet, and a connection", () => {
		beforeEach(() => {
			openShift("pos_offline_shift-1")
		})

		it("does not take the server's word for a card, since the sale goes through the queue", async () => {
			await open()
			await apply("GIFT-1")

			expect(server.resources.get(VALIDATE).reload).not.toHaveBeenCalled()
			expect(checkCouponOffline).toHaveBeenCalledTimes(1)
		})

		it("refuses a gift card and says why", async () => {
			await open()
			await apply("GIFT-1")

			expect(wrapper.vm.appliedDiscount).toBeNull()
			expect(wrapper.vm.errorMessage).toBe("Gift cards need the server, and it does not know this shift yet.")
		})

		it("offers no gift cards", async () => {
			await open()

			expect(server.resources.get(GIFT_CARDS).reload).not.toHaveBeenCalled()
		})
	})

	it("says a connection is what is missing when it is", async () => {
		offlineState.isOffline = true

		await open()
		await apply("GIFT-1")

		expect(wrapper.vm.errorMessage).toBe("This coupon cannot be checked offline. Gift cards need a connection.")
	})

	it("asks the server while the server knows the shift", async () => {
		openShift("POSA-OS-1")

		await open()
		await apply("GIFT-1")

		expect(server.resources.get(VALIDATE).reload).toHaveBeenCalledTimes(1)
		expect(server.resources.get(GIFT_CARDS).reload).toHaveBeenCalledTimes(1)
		expect(checkCouponOffline).not.toHaveBeenCalled()
	})
})
