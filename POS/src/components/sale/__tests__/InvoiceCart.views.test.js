import { flushPromises, mount } from "@vue/test-utils"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { nextTick, reactive } from "vue"
import InvoiceCart from "../InvoiceCart.vue"

const stores = vi.hoisted(() => {
	// The cart's sort options are translated as the module loads
	globalThis.__ = (text) => text
	return { cart: {}, settings: {} }
})

vi.mock("frappe-ui", () => ({
	FeatherIcon: { props: ["name"], template: `<i :data-icon="name" />` },
	createResource: () => ({ reload: vi.fn() }),
}))
vi.mock("@/stores/posCart", () => ({ usePOSCartStore: () => stores.cart }))
vi.mock("@/stores/posSettings", () => ({
	usePOSSettingsStore: () => stores.settings,
}))
vi.mock("@/stores/posOrderTypes", () => ({
	usePOSOrderTypesStore: () => ({ orderTypeOptions: [] }),
}))
vi.mock("@/stores/posOffers", () => ({
	usePOSOffersStore: () => ({ ensureOffersFetched: vi.fn() }),
}))
vi.mock("@/stores/customerSearch", () => ({
	useCustomerSearchStore: () => ({
		allCustomers: [],
		customersLoaded: true,
		loadAllCustomers: vi.fn(),
		loadCustomerHistory: vi.fn(),
		trackCustomerSelection: vi.fn(),
	}),
}))
vi.mock("@/stores/posShift", () => ({
	usePOSShiftStore: () => ({ currentProfile: {} }),
}))
vi.mock("@/stores/bootstrap", () => ({
	useBootstrapStore: () => ({ getPreloadedRoles: () => [] }),
}))
vi.mock("@/composables/useShift", () => ({ hasLocalShift: { value: false } }))
vi.mock("@/composables/useToast", () => ({
	useToast: () => ({ showError: vi.fn(), showWarning: vi.fn() }),
}))
vi.mock("@/utils/offline", () => ({ isOffline: () => false }))
vi.mock("@/utils/offline/workerClient", () => ({ offlineWorker: {} }))

const translate = (text, values = []) =>
	text.replace(/\{(\d)\}/g, (_match, index) => values[index])

const line = (extra) => ({
	item_code: "ITEM-1",
	item_name: "قهوة عربية",
	uom: "Nos",
	stock_uom: "Nos",
	item_uoms: [],
	quantity: 2,
	rate: 50,
	price_list_rate: 50,
	discount_percentage: 0,
	discount_amount: 0,
	amount: 100,
	...extra,
})

const EditItemDialog = {
	name: "EditItemDialog",
	props: ["modelValue", "item"],
	template: `<div v-if="modelValue" data-test="edit-dialog" />`,
}

describe("the cart views", () => {
	let wrapper
	let resize

	const mountCart = async (items = [line()], view = null, props = {}) => {
		if (view) localStorage.setItem("pos_next_cart_view", view)
		wrapper = mount(InvoiceCart, {
			props: {
				items,
				currency: "SAR",
				posProfile: "Main",
				customer: { name: "C", customer_name: "C" },
				...props,
			},
			global: {
				mocks: { __: translate },
				stubs: { EditItemDialog, OrderType: true, TableSelector: true },
			},
			attachTo: document.body,
		})
		await nextTick()
		return wrapper
	}

	const pick = async (label) => {
		await wrapper
			.find(`[role="group"] button[aria-label="${label}"]`)
			.trigger("click")
		await nextTick()
	}

	const pressedView = () =>
		wrapper
			.find('[role="group"] button[aria-pressed="true"]')
			.attributes("aria-label")
	const dialogOpen = () => wrapper.find('[data-test="edit-dialog"]').exists()

	const typeAndBlur = async (input, text) => {
		input.element.value = text
		await input.trigger("input")
		await input.trigger("blur")
		await flushPromises()
	}

	beforeEach(() => {
		localStorage.clear()
		Element.prototype.scrollIntoView = vi.fn()
		vi.stubGlobal("__", translate)
		vi.stubGlobal(
			"ResizeObserver",
			class {
				constructor(callback) {
					resize = (width) => callback([{ contentRect: { width } }])
				}
				observe() {}
				disconnect() {}
			},
		)
		stores.cart = reactive({
			targetDoctype: "Sales Invoice",
			taxInclusive: false,
			posOrderType: null,
			updateItemDetails: vi.fn(async () => true),
			changeItemUOM: vi.fn(async () => {}),
			setPosOrderType: vi.fn(),
			setPosTableNo: vi.fn(),
			setTargetDoctype: vi.fn(),
		})
		stores.settings = reactive({
			allowUserToEditRate: true,
			allowItemDiscount: true,
			maxDiscountAllowed: 0,
			decimalPrecision: 2,
			allowSalesOrder: false,
			invoiceType: "Sales Invoice",
			allowReturn: true,
		})
	})

	afterEach(() => {
		wrapper?.unmount()
		vi.unstubAllGlobals()
	})

	describe.each(["cards", "compact", "table"])("%s, with prices that include tax", (view) => {
		it("shows a line at what the customer pays", async () => {
			stores.cart.taxInclusive = true
			await mountCart([line({ quantity: 2, rate: 115, amount: 200, tax_amount: 30 })], view)

			expect(wrapper.text().replace(/,/g, "")).toContain("230.00")
			expect(wrapper.text()).not.toContain("200.00")
		})
	})

	describe("the keys in a table field", () => {
		const fieldOfRow = () => wrapper.find('input[aria-label="Quantity"]')

		it.each([
			["F8", {}, "proceed-to-payment"],
			["F9", {}, "save-draft"],
			["Enter", { altKey: true }, "proceed-to-payment"],
		])("%s saves the field, then runs the shortcut", async (key, modifiers, emitted) => {
			await mountCart([line()], "table")
			const field = fieldOfRow()
			field.element.focus()
			field.element.value = "5"
			await field.trigger("input")

			await field.trigger("keydown", { key, ...modifiers })
			await flushPromises()

			expect(stores.cart.updateItemDetails).toHaveBeenCalledWith(
				"ITEM-1",
				{ quantity: 5 },
				"Nos",
				{ silent: true },
			)
			expect(wrapper.emitted(emitted)).toHaveLength(1)
		})

		it("leaves a plain letter to the field", async () => {
			await mountCart([line()], "table")
			const field = fieldOfRow()
			field.element.focus()

			await field.trigger("keydown", { key: "x" })

			expect(wrapper.emitted("save-draft")).toBeUndefined()
		})
	})

	describe("the switch", () => {
		it("offers the three views with labels and starts on the cards", async () => {
			await mountCart()
			const buttons = wrapper.findAll('[role="group"] button')
			expect(buttons.map((button) => button.attributes("aria-label"))).toEqual([
				"Cards",
				"Compact",
				"Table",
			])
			expect(buttons.map((button) => button.attributes("title"))).toEqual([
				"Cards",
				"Compact",
				"Table",
			])
			expect(pressedView()).toBe("Cards")
		})

		it("has 44px targets", async () => {
			await mountCart()
			for (const button of wrapper.findAll('[role="group"] button')) {
				expect(button.classes()).toEqual(
					expect.arrayContaining(["w-11", "h-11"]),
				)
			}
		})

		it("keeps the choice across a remount", async () => {
			await mountCart()
			await pick("Table")
			wrapper.unmount()

			await mountCart()

			expect(pressedView()).toBe("Table")
			expect(wrapper.find("table").exists()).toBe(true)
		})
	})

	describe("cards", () => {
		it("keeps today's rows, number and image frame included", async () => {
			await mountCart()
			expect(wrapper.find("table").exists()).toBe(false)
			const row = wrapper.find(".cart-item-row")
			expect(row.text()).toContain("01")
			expect(row.find("div.w-12").exists()).toBe(true)
		})

		it("still opens the dialog when a row is tapped", async () => {
			await mountCart()
			await wrapper.find(".cart-item-row").trigger("click")
			await nextTick()
			expect(dialogOpen()).toBe(true)
		})
	})

	describe("compact", () => {
		it("shows one line with no number or image", async () => {
			await mountCart([line({ image: "/files/a.png" })], "compact")
			const row = wrapper.find(".cart-item-row")
			expect(row.find("img").exists()).toBe(false)
			expect(row.find("div.w-12").exists()).toBe(false)
			expect(row.text()).not.toContain("01")
		})

		it("makes the name the strongest thing and drops a code that repeats it", async () => {
			await mountCart([line({ item_code: "wd", item_name: "wd" })], "compact")
			const name = wrapper.find(".cart-item-row span.font-bold")
			expect(name.text()).toBe("wd")
			expect(
				wrapper.find(".cart-item-row").findAll(".font-mono.text-gray-500"),
			).toHaveLength(0)
		})

		it("steps the quantity like the cards do", async () => {
			await mountCart([line()], "compact")
			await wrapper
				.find('button[aria-label="Increase quantity"]')
				.trigger("click")
			await wrapper
				.find('button[aria-label="Decrease quantity"]')
				.trigger("click")
			expect(wrapper.emitted("update-quantity")).toEqual([
				["ITEM-1", 3, "Nos"],
				["ITEM-1", 1, "Nos"],
			])
		})

		it("refuses a typed zero instead of removing the line", async () => {
			await mountCart([line()], "compact")
			await typeAndBlur(wrapper.find('input[aria-label="Quantity"]'), "0")
			expect(wrapper.emitted("remove-item")).toBeUndefined()
			expect(stores.cart.updateItemDetails).not.toHaveBeenCalled()
		})

		it("saves a typed quantity through the dialog's store action", async () => {
			await mountCart([line()], "compact")
			await typeAndBlur(wrapper.find('input[aria-label="Quantity"]'), "4")
			expect(stores.cart.updateItemDetails).toHaveBeenCalledWith(
				"ITEM-1",
				{ quantity: 4 },
				"Nos",
				{ silent: true },
			)
		})

		it("has no stepper on a line whose quantity is fixed", async () => {
			await mountCart(
				[
					line({ is_free_item: 1 }),
					line({ item_code: "S", has_serial_no: 1, serial_no: "A\nB" }),
				],
				"compact",
			)
			expect(
				wrapper.find('button[aria-label="Increase quantity"]').exists(),
			).toBe(false)
		})

		it("opens the dialog on a tap, except on a free item", async () => {
			await mountCart(
				[line({ is_free_item: 1 }), line({ item_code: "B", uom: "Box" })],
				"compact",
			)
			const rows = wrapper.findAll(".cart-item-row")

			await rows[0].trigger("click")
			await nextTick()
			expect(dialogOpen()).toBe(false)

			await rows[1].trigger("click")
			await nextTick()
			expect(dialogOpen()).toBe(true)
		})
	})

	describe("table", () => {
		it("saves through the dialog's store action, with no toast per field", async () => {
			await mountCart([line()], "table")
			await typeAndBlur(wrapper.find('input[aria-label="Discount %"]'), "5")
			expect(stores.cart.updateItemDetails).toHaveBeenCalledWith(
				"ITEM-1",
				{ discount_percentage: 5, discount_amount: 0 },
				"Nos",
				{ silent: true },
			)
		})

		it("does not open the dialog when a row is tapped", async () => {
			await mountCart([line()], "table")
			await wrapper.find(".cart-item-row").trigger("click")
			await nextTick()
			expect(dialogOpen()).toBe(false)
		})

		it("reaches the dialog from a serial quantity", async () => {
			await mountCart([line({ has_serial_no: 1, serial_no: "A" })], "table")
			await wrapper
				.find('button[aria-label="Edit Item Details"]')
				.trigger("click")
			await nextTick()
			expect(dialogOpen()).toBe(true)
		})

		it("removes a line through the cart's event", async () => {
			await mountCart([line()], "table")
			await wrapper
				.find('button[aria-label="Remove قهوة عربية"]')
				.trigger("click")
			expect(wrapper.emitted("remove-item")).toEqual([["ITEM-1", "Nos"]])
		})

		it("changes a unit through the store and hands focus back", async () => {
			const onDone = vi.fn()
			window.addEventListener("pos-next:dialog-closed", onDone)
			await mountCart([line({ item_uoms: [{ uom: "Box" }] })], "table")

			await wrapper.find("select").setValue("Box")
			await flushPromises()

			window.removeEventListener("pos-next:dialog-closed", onDone)
			expect(stores.cart.changeItemUOM).toHaveBeenCalledWith(
				"ITEM-1",
				"Box",
				"Nos",
			)
			expect(onDone).toHaveBeenCalled()
		})

		it("takes Enter on a marked row into the row, not the dialog", async () => {
			await mountCart([line()], "table")
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "F7" }))
			await nextTick()
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }))
			await nextTick()

			expect(dialogOpen()).toBe(false)
			expect(document.activeElement?.getAttribute("aria-label")).toBe(
				"Quantity",
			)
		})
	})

	it("still opens the dialog from Enter on a marked row in the cards", async () => {
		await mountCart([line()])
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "F7" }))
		await nextTick()
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }))
		await nextTick()
		expect(dialogOpen()).toBe(true)
	})

	describe("a cart too narrow for the table", () => {
		it("shows the compact view and says why through the switch", async () => {
			await mountCart([line()], "table")
			resize(430)
			await nextTick()

			expect(wrapper.find("table").exists()).toBe(false)
			expect(pressedView()).toBe("Compact")
			expect(
				wrapper.find('button[aria-label="Table needs a wider cart"]').exists(),
			).toBe(true)
			expect(wrapper.text()).toContain(
				"The table needs a wider cart, so this is the compact view.",
			)
		})

		it("brings the table back when the cart widens", async () => {
			await mountCart([line()], "table")
			resize(430)
			await nextTick()
			resize(600)
			await nextTick()
			expect(wrapper.find("table").exists()).toBe(true)
		})

		it("says nothing when the table was not chosen", async () => {
			await mountCart([line()], "compact")
			resize(430)
			await nextTick()
			expect(wrapper.text()).not.toContain("wider cart, so")
		})
	})

	describe("other cart states", () => {
		for (const view of ["cards", "compact", "table"]) {
			it(`shows the quick actions for an empty cart in the ${view} view`, async () => {
				await mountCart([], view)
				expect(wrapper.find(".cart-item-row").exists()).toBe(false)
				expect(wrapper.find("table").exists()).toBe(false)
				expect(
					wrapper.findAll('[data-nav="quick-action"]').length,
				).toBeGreaterThan(0)
			})

			it(`shows a sale reopened from the queue in the ${view} view`, async () => {
				const reopened = line({
					item_uoms: undefined,
					pricing_rules: "",
					image: undefined,
					amount: undefined,
				})
				await mountCart([reopened], view)
				expect(wrapper.find(".cart-item-row").text()).toContain("قهوة عربية")
			})

			it(`keeps the Sales Order toggle in the ${view} view`, async () => {
				stores.settings.allowSalesOrder = true
				await mountCart([line()], view)
				await wrapper.find('button[title="Sales Order"]').trigger("click")
				expect(stores.cart.setTargetDoctype).toHaveBeenCalledWith("Sales Order")
			})
		}
	})
})
