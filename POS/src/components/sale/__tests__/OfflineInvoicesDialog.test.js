import { flushPromises, mount } from "@vue/test-utils"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const acknowledgeSaleStands = vi.hoisted(() => vi.fn())
const settings = vi.hoisted(() => ({
	allowDeleteOfflineInvoice: true,
	allowEditOfflineInvoice: true,
	allowPrintOfflineInvoice: true,
	allowPrintPreviousInvoices: true,
}))

vi.mock("frappe-ui", () => ({
	Button: {
		props: ["disabled"],
		emits: ["click"],
		template: `<button :disabled="disabled" @click="$emit('click')"><slot /></button>`,
	},
	Dialog: {
		props: ["modelValue", "options"],
		template: `<div v-if="modelValue"><slot name="body-content" /><slot name="actions" /></div>`,
	},
}))
vi.mock("@/stores/posSettings", () => ({ usePOSSettingsStore: () => settings }))
vi.mock("@/stores/posSync", () => ({
	usePOSSyncStore: () => ({ reviewCount: 0, queuedCount: 0, lastSyncedAt: null, acknowledgeSaleStands }),
}))
vi.mock("@/stores/posUI", () => ({ usePOSUIStore: () => ({ lastInvoiceName: null }) }))
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ showWarning: vi.fn() }) }))

const translate = (text, values = []) => text.replace(/\{(\d)\}/g, (_match, index) => values[index])

const REASON = "The customer changed their mind"

const sale = (extra) => ({
	id: 1,
	offline_id: "pos_offline_1",
	entity: "invoice",
	timestamp: Date.now(),
	data: { customer: "CUST-1", grand_total: 24, items: [{ item_code: "A" }], payments: [] },
	...extra,
})

describe("the offline queue", () => {
	let OfflineInvoicesDialog

	const open = (rows, props = {}) =>
		mount(OfflineInvoicesDialog, {
			props: { modelValue: true, pendingInvoices: rows, ...props },
			global: { mocks: { __: translate } },
		})

	const button = (wrapper, label) => wrapper.find(`button[aria-label="${label}"]`)

	const textButton = (wrapper, label) =>
		wrapper.findAll("button").find((candidate) => candidate.text() === label)

	beforeEach(async () => {
		vi.stubGlobal("__", translate)
		vi.clearAllMocks()
		OfflineInvoicesDialog = (await import("../OfflineInvoicesDialog.vue")).default
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	describe("asking to void a record", () => {
		async function ask(rows = [sale()]) {
			const wrapper = open(rows)
			await button(wrapper, "Void").trigger("click")
			return wrapper
		}

		const voidButton = (wrapper) => textButton(wrapper, "Void")

		it("offers a void instead of a delete", () => {
			const wrapper = open([sale()])

			expect(button(wrapper, "Void").exists()).toBe(true)
			expect(button(wrapper, "Delete").exists()).toBe(false)
		})

		it("needs a reason before it can go", async () => {
			const wrapper = await ask()
			expect(voidButton(wrapper).attributes("disabled")).toBeDefined()

			await wrapper.find("textarea").setValue("   ")
			expect(voidButton(wrapper).attributes("disabled")).toBeDefined()

			await wrapper.find("textarea").setValue(REASON)
			expect(voidButton(wrapper).attributes("disabled")).toBeUndefined()
		})

		it("hands over the row and the reason", async () => {
			const wrapper = await ask()

			await wrapper.find("textarea").setValue(`  ${REASON} `)
			await voidButton(wrapper).trigger("click")

			expect(wrapper.emitted("void-invoice")).toEqual([[1, REASON]])
			expect(wrapper.find("textarea").exists()).toBe(false)
		})

		it("starts with an empty reason each time", async () => {
			const wrapper = await ask()
			await wrapper.find("textarea").setValue(REASON)
			await textButton(wrapper, "Cancel").trigger("click")

			await button(wrapper, "Void").trigger("click")

			expect(wrapper.find("textarea").element.value).toBe("")
		})

		it("does not offer it while a sync runs", () => {
			expect(button(open([sale()], { isSyncing: true }), "Void").attributes("disabled")).toBeDefined()
		})

		it("offers it for a customer and a payment too", () => {
			const customer = sale({ entity: "customer", data: { customer_name: "Sara" } })
			const payment = sale({ entity: "payment", data: { invoice_name: "SINV-1", payments: [] } })

			expect(button(open([customer]), "Void").exists()).toBe(true)
			expect(button(open([payment]), "Void").exists()).toBe(true)
		})

		it("does not offer it for a shift close", () => {
			const close = sale({ entity: "shift_close", data: { pos_opening_shift: "SHIFT-1" } })
			expect(button(open([close]), "Void").exists()).toBe(false)
		})

		it("does not offer it for a record the server holds", () => {
			expect(button(open([sale({ server_status: "received" })]), "Void").exists()).toBe(false)
		})

		it("does not offer it where POS Settings forbid it", () => {
			settings.allowDeleteOfflineInvoice = false
			expect(button(open([sale()]), "Void").exists()).toBe(false)
			settings.allowDeleteOfflineInvoice = true
		})
	})

	describe("a record waiting to be voided", () => {
		const waiting = sale({ void_reason: REASON })

		it("says so, with its reason", () => {
			const text = open([waiting]).text()

			expect(text).toContain("Waiting to be voided")
			expect(text).toContain(REASON)
			expect(text).toContain("holds no stock")
		})

		it("says what it waits for while offline", () => {
			expect(open([waiting], { isOffline: true }).text()).toContain("when the connection returns")
		})

		it("cannot be edited, printed or voided again", () => {
			const wrapper = open([waiting])

			expect(button(wrapper, "Edit Invoice").exists()).toBe(false)
			expect(button(wrapper, "Print receipt").exists()).toBe(false)
			expect(button(wrapper, "Void").exists()).toBe(false)
		})

		it("can still be looked at", () => {
			expect(button(open([waiting]), "View Details").exists()).toBe(true)
		})

		it("shows why the server would not take the request", () => {
			const text = open([sale({ void_reason: REASON, error: "No access", sync_failed: true })]).text()

			expect(text).toContain("Waiting to be voided")
			expect(text).toContain("No access")
		})
	})

	describe("a void that came too late", () => {
		const stands = sale({ void_reason: REASON, server_status: "sale_stands", server_invoice: "SINV-1" })

		it("says plainly the sale was already on the server, and under what number", () => {
			const text = open([stands]).text()

			expect(text).toContain("Not voided")
			expect(text).toContain("This sale was already on the server as SINV-1, so it was not voided")
			expect(text).toContain(REASON)
		})

		it("reads right for a sale with no number", () => {
			expect(open([sale({ ...stands, server_invoice: null })]).text()).toContain(
				"This sale was already on the server, so it was not voided",
			)
		})

		it("reads right for a record that is not a sale", () => {
			const customer = sale({ ...stands, entity: "customer", data: { customer_name: "Sara" } })
			expect(open([customer]).text()).toContain("This record was already on the server")
		})

		it("stays until the cashier says they have seen it", async () => {
			const wrapper = open([stands])

			await textButton(wrapper, "I Understand").trigger("click")
			await flushPromises()

			expect(acknowledgeSaleStands).toHaveBeenCalledWith(1)
		})

		it("offers nothing that would act on it as a queued sale", () => {
			const wrapper = open([stands])

			expect(button(wrapper, "Edit Invoice").exists()).toBe(false)
			expect(button(wrapper, "Print receipt").exists()).toBe(false)
			expect(button(wrapper, "Void").exists()).toBe(false)
		})
	})

	it("offers the plain actions on a plain sale", () => {
		const wrapper = open([sale()])

		expect(button(wrapper, "Edit Invoice").exists()).toBe(true)
		expect(button(wrapper, "Print receipt").exists()).toBe(true)
		expect(textButton(wrapper, "I Understand")).toBeUndefined()
	})
})
