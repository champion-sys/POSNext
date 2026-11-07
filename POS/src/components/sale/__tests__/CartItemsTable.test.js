import { flushPromises, mount } from "@vue/test-utils"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BARCODE_SCANNED_EVENT } from "@/utils/scanBurst"
import CartItemsTable from "../CartItemsTable.vue"

const toast = vi.hoisted(() => ({ showError: vi.fn(), showWarning: vi.fn() }))

vi.mock("frappe-ui", () => ({
	FeatherIcon: { props: ["name"], template: `<i :data-icon="name" />` },
}))
vi.mock("@/composables/useToast", () => ({ useToast: () => toast }))
vi.mock("@/utils/currency", () => ({
	getCurrencySymbol: (currency) => currency,
}))

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

const SETTINGS = {
	allowUserToEditRate: true,
	allowItemDiscount: true,
	maxDiscountAllowed: 0,
	decimalPrecision: 2,
}

describe("the cart table", () => {
	let wrapper

	const mountTable = (items, settings = {}) => {
		wrapper = mount(CartItemsTable, {
			props: {
				items,
				settings: { ...SETTINGS, ...settings },
				currency: "SAR",
				formatQuantity: (value) => String(value),
				formatAmount: (value) => Number(value).toFixed(2),
			},
			global: { mocks: { __: translate } },
			attachTo: document.body,
		})
		return wrapper
	}

	const field = (label, row = 0) =>
		wrapper.findAll("tbody tr")[row].find(`input[aria-label="${label}"]`)

	const type = async (input, text) => {
		input.element.value = text
		await input.trigger("input")
		await input.trigger("blur")
	}

	const edits = () => wrapper.emitted("edit-line") ?? []

	beforeEach(() => {
		vi.stubGlobal("__", translate)
		toast.showError.mockClear()
		toast.showWarning.mockClear()
	})

	afterEach(() => wrapper?.unmount())

	describe("columns", () => {
		it("has the seven columns as a real table", () => {
			mountTable([line()])
			const headers = wrapper.findAll("thead th").map((cell) => cell.text())
			expect(headers).toEqual([
				"Item",
				"Unit",
				"Qty",
				"Rate",
				"Discount %",
				"Total (SAR)",
				"Remove",
			])
			expect(wrapper.findAll("tbody td")).toHaveLength(7)
		})

		it("leaves out the line number and any image", () => {
			mountTable([line({ image: "/files/a.png" })])
			expect(wrapper.find("img").exists()).toBe(false)
			expect(wrapper.find("tbody").text()).not.toContain("01")
		})

		it("hides a code that repeats the name and shows one that does not", () => {
			mountTable([
				line(),
				line({ item_code: "SAME", item_name: "same", uom: "Box" }),
			])
			const rows = wrapper.findAll("tbody tr")
			expect(rows[0].text()).toContain("ITEM-1")
			expect(rows[1].find(".font-mono.truncate").exists()).toBe(false)
		})

		it("keeps the currency in the header, not in every cell", () => {
			mountTable([line()])
			expect(wrapper.find("thead").text()).toContain("SAR")
			expect(wrapper.find("tbody").text()).not.toContain("SAR")
		})

		it("keeps figures left to right", () => {
			mountTable([line()])
			expect(field("Rate").attributes("dir")).toBe("ltr")
			expect(field("Rate").classes()).toContain("text-right")
			expect(
				wrapper.findAll("tbody td")[5].find("span").attributes("dir"),
			).toBe("ltr")
			expect(wrapper.findAll("tbody td")[5].classes()).toContain("text-right")
		})
	})

	describe("quantity", () => {
		it("sends a new quantity through the edit event", async () => {
			mountTable([line()])
			await type(field("Quantity"), "3")
			expect(edits()).toHaveLength(1)
			expect(edits()[0][1]).toEqual({ quantity: 3 })
		})

		it("refuses zero, a negative or nothing, and keeps the line", async () => {
			mountTable([line()])
			for (const text of ["0", "-1", "", "abc"]) {
				await type(field("Quantity"), text)
				expect(field("Quantity").element.value).toBe("2")
			}
			expect(edits()).toEqual([])
			expect(wrapper.emitted("remove")).toBeUndefined()
		})

		it("does nothing for the same quantity", async () => {
			mountTable([line()])
			await type(field("Quantity"), "2")
			expect(edits()).toEqual([])
		})

		it("reads Arabic digits", async () => {
			mountTable([line()])
			await type(field("Quantity"), "٣")
			expect(edits()[0][1]).toEqual({ quantity: 3 })
		})
	})

	describe("rate", () => {
		it("is plain text when the setting forbids editing it", () => {
			mountTable([line()], { allowUserToEditRate: false })
			expect(field("Rate").exists()).toBe(false)
			expect(wrapper.findAll("tbody td")[3].text()).toBe("50.00")
		})

		it("is plain text with a lock when an offer set the price", () => {
			mountTable([line({ pricing_rules: ["PR-1"] })])
			expect(field("Rate").exists()).toBe(false)
			const cell = wrapper.findAll("tbody td")[3]
			expect(cell.find('[data-icon="lock"]').exists()).toBe(true)
			expect(cell.find("span").attributes("title")).toBe(
				"Locked (offer applied)",
			)
		})

		it("records an edit the way the dialog does", async () => {
			mountTable([line()])
			await type(field("Rate"), "45")
			expect(edits()[0][1]).toEqual({
				rate: 45,
				price_list_rate: 50,
				is_rate_manually_edited: 1,
				original_rate: 50,
			})
		})

		it("clears the mark when the rate goes back to the list price", async () => {
			mountTable([
				line({ rate: 45, is_rate_manually_edited: 1, original_rate: 50 }),
			])
			await type(field("Rate"), "50")
			expect(edits()[0][1]).toMatchObject({
				rate: 50,
				is_rate_manually_edited: 0,
				original_rate: null,
			})
		})

		it("refuses a rate of zero and says why", async () => {
			mountTable([line()])
			await type(field("Rate"), "0")
			expect(edits()).toEqual([])
			expect(toast.showError).toHaveBeenCalledWith(
				"Rate must be greater than zero",
			)
			expect(field("Rate").element.value).toBe("50.00")
		})

		it("refuses a cut beyond the discount limit", async () => {
			mountTable([line()], { maxDiscountAllowed: 10 })
			await type(field("Rate"), "40")
			expect(edits()).toEqual([])
			expect(toast.showError.mock.calls[0][0]).toContain(
				"exceeds maximum allowed discount of 10%",
			)
		})

		it("edits a plain number, because a comma would read as a decimal point", () => {
			mountTable([line({ rate: 1234.5, price_list_rate: 1234.5 })])
			expect(field("Rate").element.value).toBe("1234.50")
		})
	})

	describe("discount", () => {
		it("is plain text when the setting forbids editing it", () => {
			mountTable([line({ discount_percentage: 5 })], {
				allowItemDiscount: false,
			})
			expect(field("Discount %").exists()).toBe(false)
			expect(wrapper.findAll("tbody td")[4].text()).toBe("5")
		})

		it("is sent as a percentage, clearing any amount", async () => {
			mountTable([line()])
			await type(field("Discount %"), "12.5")
			expect(edits()[0][1]).toEqual({
				discount_percentage: 12.5,
				discount_amount: 0,
			})
		})

		it("stops at the limit and says so", async () => {
			mountTable([line()], { maxDiscountAllowed: 10 })
			await type(field("Discount %"), "25")
			expect(edits()[0][1]).toEqual({
				discount_percentage: 10,
				discount_amount: 0,
			})
			expect(toast.showWarning).toHaveBeenCalledWith(
				"Maximum allowed discount is 10%",
			)
		})

		it("treats a cleared field as no discount", async () => {
			mountTable([line({ discount_percentage: 10 })])
			await type(field("Discount %"), "")
			expect(edits()[0][1]).toEqual({
				discount_percentage: 0,
				discount_amount: 0,
			})
		})

		it("refuses a negative discount", async () => {
			mountTable([line({ discount_percentage: 10 })])
			await type(field("Discount %"), "-5")
			expect(edits()).toEqual([])
			expect(field("Discount %").element.value).toBe("10")
		})

		it("leaves an offer's larger discount alone until someone edits it", async () => {
			mountTable([line({ discount_percentage: 50 })], {
				maxDiscountAllowed: 10,
			})
			const input = field("Discount %")
			input.element.focus()
			await input.trigger("blur")
			expect(input.element.value).toBe("50")
			expect(edits()).toEqual([])
		})
	})

	describe("unit", () => {
		const boxed = { item_uoms: [{ uom: "Box", conversion_factor: 12 }] }

		it("is plain text with one option", () => {
			mountTable([line()])
			expect(wrapper.find("select").exists()).toBe(false)
			expect(wrapper.findAll("tbody td")[1].text()).toBe("Nos")
		})

		it("is a choice with several, and says which was picked", async () => {
			mountTable([line(boxed)])
			const select = wrapper.find("select")
			expect(select.findAll("option").map((option) => option.text())).toEqual([
				"Nos",
				"Box",
			])

			await select.setValue("Box")

			expect(wrapper.emitted("change-unit")[0][1]).toBe("Box")
		})

		it("keeps a wedge scan out of the type-ahead and adds the item instead", async () => {
			const scans = []
			const onScan = (event) => scans.push(event.detail.barcode)
			window.addEventListener(BARCODE_SCANNED_EVENT, onScan)

			mountTable([line(boxed)])
			const select = wrapper.find("select")
			for (const digit of "6281000") {
				const event = new KeyboardEvent("keydown", {
					key: digit,
					bubbles: true,
					cancelable: true,
				})
				select.element.dispatchEvent(event)
				expect(event.defaultPrevented).toBe(true)
			}
			await select.trigger("keydown", { key: "Enter" })

			window.removeEventListener(BARCODE_SCANNED_EVENT, onScan)
			expect(scans).toEqual(["6281000"])
			expect(select.element.value).toBe("Nos")
			expect(wrapper.emitted("change-unit")).toBeUndefined()
		})

		it("keeps its arrow keys from the cart's row shortcuts", async () => {
			mountTable([line(boxed)])
			const onWindowKeydown = vi.fn()
			window.addEventListener("keydown", onWindowKeydown)

			await wrapper.find("select").trigger("keydown", { key: "ArrowDown" })
			await wrapper.find("select").trigger("keydown", { key: "F2" })

			window.removeEventListener("keydown", onWindowKeydown)
			expect(onWindowKeydown).toHaveBeenCalledTimes(1)
			expect(onWindowKeydown.mock.calls[0][0].key).toBe("F2")
		})
	})

	describe("lines that cannot be edited freely", () => {
		it("keeps a free item read-only, with no way to remove it", () => {
			mountTable([
				line({
					is_free_item: 1,
					rate: 0,
					amount: 0,
					item_uoms: [{ uom: "Box" }],
				}),
			])
			expect(wrapper.find("tbody input").exists()).toBe(false)
			expect(wrapper.find("tbody select").exists()).toBe(false)
			expect(wrapper.find("tbody button").exists()).toBe(false)
			expect(wrapper.findAll("tbody td")[5].text()).toBe("Free")
		})

		it("shows free units given with a paid line", () => {
			mountTable([line({ free_qty: 1 })])
			expect(wrapper.find("tbody").text()).toContain("+1 FREE")
		})

		it("sends a serial quantity to the dialog", async () => {
			const item = line({ has_serial_no: 1, serial_no: "S1\nS2" })
			mountTable([item])
			expect(field("Quantity").exists()).toBe(false)

			await wrapper
				.find('button[aria-label="Edit Item Details"]')
				.trigger("click")

			expect(wrapper.emitted("open-dialog")[0][0]).toEqual(item)
		})

		it("sends a batch quantity to the dialog and keeps its unit", () => {
			mountTable([
				line({ has_batch_no: 1, batch_no: "B1", item_uoms: [{ uom: "Box" }] }),
			])
			expect(field("Quantity").exists()).toBe(false)
			expect(
				wrapper.find('button[aria-label="Edit Item Details"]').exists(),
			).toBe(true)
			expect(wrapper.find("select").exists()).toBe(false)
		})

		it("keeps the quantity, unit and rate of a resolved barcode, with no dialog", () => {
			mountTable([
				line({ is_resolved_barcode: true, item_uoms: [{ uom: "Box" }] }),
			])
			expect(field("Quantity").exists()).toBe(false)
			expect(field("Rate").exists()).toBe(false)
			expect(wrapper.find("select").exists()).toBe(false)
			expect(
				wrapper.find('button[aria-label="Edit Item Details"]').exists(),
			).toBe(false)
			expect(field("Discount %").exists()).toBe(true)
		})

		it("still lets a serial line take a discount in the row", () => {
			mountTable([line({ has_serial_no: 1, serial_no: "S1" })])
			expect(field("Discount %").exists()).toBe(true)
			expect(field("Rate").exists()).toBe(true)
		})
	})

	describe("keyboard", () => {
		it("moves through the fields in order and leaves out the remove button", () => {
			mountTable([line({ item_uoms: [{ uom: "Box" }] })])
			const stops = [
				...wrapper
					.find("tbody tr")
					.element.querySelectorAll("input, select, button"),
			].filter((element) => element.tabIndex >= 0)
			expect(
				stops.map((element) => element.getAttribute("aria-label")),
			).toEqual(["Unit", "Quantity", "Rate", "Discount %"])
		})
	})

	it("removes a line through the remove event", async () => {
		const item = line()
		mountTable([item])
		await wrapper
			.find('button[aria-label="Remove قهوة عربية"]')
			.trigger("click")
		expect(wrapper.emitted("remove")[0][0]).toEqual(item)
	})

	it("keeps a scan out of a field and sends it to the search", async () => {
		const scans = []
		const onScan = (event) => scans.push(event.detail.barcode)
		window.addEventListener(BARCODE_SCANNED_EVENT, onScan)

		mountTable([line()])
		const input = field("Quantity")
		input.element.focus()

		let typed = ""
		for (const digit of "6281000000017") {
			const event = new KeyboardEvent("keydown", {
				key: digit,
				bubbles: true,
				cancelable: true,
			})
			Object.defineProperty(event, "timeStamp", {
				value: 1000 + typed.length * 8,
			})
			input.element.dispatchEvent(event)
			typed += digit
			input.element.value = typed
			await input.trigger("input")
		}
		const enter = new KeyboardEvent("keydown", {
			key: "Enter",
			bubbles: true,
			cancelable: true,
		})
		Object.defineProperty(enter, "timeStamp", {
			value: 1000 + typed.length * 8,
		})
		input.element.dispatchEvent(enter)
		await input.trigger("blur")
		await flushPromises()

		window.removeEventListener(BARCODE_SCANNED_EVENT, onScan)
		expect(scans).toEqual(["6281000000017"])
		expect(input.element.value).toBe("2")
		expect(edits()).toEqual([])
	})
})
