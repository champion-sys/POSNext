/**
 * The closing dialog before and after the cashier counts, on the real component and the
 * real settings store. frappe-ui is faked because it does not load under vitest.
 */
import { flushPromises, mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import ShiftClosingDialog from "../ShiftClosingDialog.vue"

const server = vi.hoisted(() => {
	globalThis.__ = (text) => text
	return { closing: null }
})

vi.mock("frappe-ui", async () => {
	const { reactive } = await import("vue")
	return {
		Button: {
			inheritAttrs: false,
			props: ["disabled", "loading"],
			template: `<button v-bind="$attrs" :disabled="disabled" @click="$emit('click')"><slot /></button>`,
		},
		Dialog: {
			template: `<div><slot name="body-content" /><slot name="actions" /></div>`,
		},
		FeatherIcon: { template: "<i />" },
		Input: {
			props: ["modelValue"],
			emits: ["update:modelValue"],
			template: `<input :value="modelValue" @input="$emit('update:modelValue', $event.target.value)" />`,
		},
		createResource: (options) =>
			reactive({
				data: null,
				loading: false,
				error: null,
				fetch: async () => null,
				reset: () => {},
				submit: async () =>
					options.url.endsWith("get_closing_shift_data")
						? structuredClone(server.closing)
						: null,
			}),
	}
})

vi.mock("@/utils/offline/offlineState", () => ({
	offlineState: { isOffline: false, subscribe: () => () => {} },
}))
vi.mock("@/utils/offline/workerClient", () => ({ offlineWorker: {} }))
vi.mock("@/stores/posSync", () => ({ usePOSSyncStore: () => ({}) }))
vi.mock("@/stores/bootstrap", () => ({
	useBootstrapStore: () => ({
		getPreloadedPOSSettings: () => ({
			pos_profile: "Main",
			hide_expected_amount: 0,
		}),
	}),
}))

const CLOSING = {
	pos_profile: "Main",
	period_start_date: "2026-11-08 08:00:00",
	grand_total: 0,
	pos_transactions: [],
	taxes: [],
	// The server sends a row with nothing counted yet as 0
	payment_reconciliation: [
		{
			mode_of_payment: "Cash",
			opening_amount: 0,
			expected_amount: 0,
			closing_amount: 0,
		},
	],
}

describe("the closing dialog's reconciliation", () => {
	let wrapper

	async function open() {
		wrapper = mount(ShiftClosingDialog, {
			props: { modelValue: false, openingShift: "POS-OS-1" },
			global: {
				mocks: { __: (text) => text },
				stubs: { TranslatedHTML: true },
			},
		})
		await wrapper.setProps({ modelValue: true })
		await flushPromises()
	}

	const closeShift = () => wrapper.find("[data-close-shift]")

	beforeEach(() => {
		setActivePinia(createPinia())
		localStorage.clear()
		server.closing = CLOSING
	})

	afterEach(() => {
		wrapper?.unmount()
	})

	it("says a method is not counted before the cashier types an amount, not that it is balanced", async () => {
		await open()

		expect(wrapper.find("[data-not-counted]").exists()).toBe(true)
		expect(wrapper.text()).toContain("Not counted")
		expect(wrapper.text()).not.toContain("Balanced")
		expect(closeShift().attributes("disabled")).toBeDefined()
	})

	it("compares once an amount is typed, and offers Close Shift plainly", async () => {
		await open()

		await wrapper.find("input").setValue("0")
		await flushPromises()

		expect(wrapper.find("[data-not-counted]").exists()).toBe(false)
		expect(wrapper.text()).toContain("Balanced")
		expect(closeShift().attributes("disabled")).toBeUndefined()
		expect(closeShift().classes()).toContain("!bg-blue-700")
	})

	it("does not call an uncounted method short", async () => {
		server.closing = {
			...CLOSING,
			payment_reconciliation: [
				{
					mode_of_payment: "Cash",
					opening_amount: 100,
					expected_amount: 100,
					closing_amount: 0,
				},
			],
		}

		await open()

		expect(wrapper.text()).toContain("Not counted")
		expect(wrapper.text()).not.toContain("Short")
		expect(wrapper.text()).not.toContain("Cash Short")
	})
})
