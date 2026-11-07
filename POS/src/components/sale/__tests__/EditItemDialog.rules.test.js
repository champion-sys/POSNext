import { mount } from "@vue/test-utils"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { nextTick } from "vue"
import EditItemDialog from "../EditItemDialog.vue"

const settings = vi.hoisted(() => ({
	allowUserToEditRate: true,
	allowItemDiscount: true,
	maxDiscountAllowed: 0,
}))
const toast = vi.hoisted(() => ({
	showError: vi.fn(),
	showSuccess: vi.fn(),
	showWarning: vi.fn(),
}))

vi.mock("frappe-ui", () => ({
	Button: {
		emits: ["click"],
		template: `<button @click="$emit('click')"><slot /></button>`,
	},
	FeatherIcon: { template: "<i />" },
	createResource: () => ({ submit: vi.fn() }),
}))
vi.mock("@/platform/runtime", () => ({ imageUrl: (path) => path }))
vi.mock("@/composables/useToast", () => ({ useToast: () => toast }))
vi.mock("@/stores/posSettings", () => ({ usePOSSettingsStore: () => settings }))
vi.mock("@/stores/serialNumber", () => ({
	useSerialNumberStore: () => ({ returnSerials: vi.fn() }),
}))
vi.mock("@/utils/stockValidator", () => ({ getItemStock: vi.fn() }))

const translate = (text, values = []) =>
	text.replace(/\{(\d)\}/g, (_match, index) => values[index])

const line = (extra) => ({
	item_code: "ITEM-1",
	item_name: "قهوة",
	uom: "Nos",
	stock_uom: "Nos",
	quantity: 2,
	rate: 50,
	price_list_rate: 50,
	discount_percentage: 0,
	discount_amount: 0,
	...extra,
})

describe("the edit dialog uses the cart's shared rules", () => {
	let wrapper

	const open = async (item, overrides = {}) => {
		Object.assign(settings, overrides)
		wrapper = mount(EditItemDialog, {
			props: { modelValue: true, item, currency: "SAR" },
			global: {
				mocks: { __: translate },
				stubs: { Teleport: true, Transition: false, SelectInput: true },
			},
		})
		await nextTick()
	}

	const rateInput = () => wrapper.find('input[step="0.01"][min="0"]:not([max])')
	const discountInput = () => wrapper.findAll('input[step="0.01"]').at(-1)
	const save = async () => {
		const update = wrapper
			.findAll("button")
			.find((button) => button.text() === "Update Item")
		await update.trigger("click")
		await nextTick()
	}
	const saved = () => wrapper.emitted("update-item")?.[0]?.[0]

	beforeEach(() => {
		vi.stubGlobal("__", translate)
		toast.showError.mockClear()
		Object.assign(settings, {
			allowUserToEditRate: true,
			allowItemDiscount: true,
			maxDiscountAllowed: 0,
		})
	})

	afterEach(() => {
		wrapper?.unmount()
		vi.unstubAllGlobals()
	})

	it("sends the same record of a rate edit as the table", async () => {
		await open(line())
		await rateInput().setValue(45)
		await save()
		expect(saved()).toMatchObject({
			rate: 45,
			price_list_rate: 50,
			is_rate_manually_edited: 1,
			original_rate: 50,
		})
	})

	it("refuses a rate of zero", async () => {
		await open(line())
		await rateInput().setValue(0)
		await save()
		expect(saved()).toBeUndefined()
		expect(toast.showError).toHaveBeenCalledWith(
			"Rate must be greater than zero",
		)
	})

	it("refuses a rate cut beyond the discount limit", async () => {
		await open(line(), { maxDiscountAllowed: 10 })
		await rateInput().setValue(40)
		await save()
		expect(saved()).toBeUndefined()
		expect(toast.showError.mock.calls[0][0]).toContain(
			"exceeds maximum allowed discount of 10%",
		)
	})

	it("locks the rate while an offer sets it", async () => {
		await open(line({ pricing_rules: ["PR-1"] }))
		expect(rateInput().attributes("readonly")).toBeDefined()
		expect(rateInput().attributes("title")).toBe("Locked (offer applied)")
	})

	it("stops a typed discount at the limit", async () => {
		await open(line(), { maxDiscountAllowed: 10 })
		await discountInput().setValue(25)
		await save()
		expect(saved().discount_percentage).toBe(10)
	})

	it("leaves a larger discount from an offer alone", async () => {
		await open(line({ discount_percentage: 50 }), { maxDiscountAllowed: 10 })
		await save()
		expect(saved().discount_percentage).toBe(50)
	})
})
