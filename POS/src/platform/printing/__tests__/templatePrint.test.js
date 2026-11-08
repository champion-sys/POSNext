import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
	bundle: { current: null },
	call: vi.fn(),
	history: vi.fn(async () => []),
	showError: vi.fn(),
}))

vi.mock("@/utils/apiWrapper", () => ({ call: mocks.call }))
vi.mock("@/utils/offline/sync", () => ({ getCachedInvoiceHistory: mocks.history }))
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ showError: mocks.showError }) }))
vi.mock("../bundle", async (importOriginal) => ({
	...(await importOriginal()),
	getPrintBundle: vi.fn(async () => mocks.bundle.current),
}))

import { buildOfflinePrintDoc } from "@/utils/offline/offlinePrintDoc"
import { BUILTIN_LAYOUT } from "../bundle"
import { prepareTemplatePrint, withCopies } from "../templatePrint"
import { bundle, queuedSale, saleTotals } from "./fixtures"

const offlineReceipt = buildOfflinePrintDoc({
	invoiceData: queuedSale,
	totals: saleTotals,
	doctype: "Sales Invoice",
	posProfile: "Main POS",
	customerLabel: "Sara",
	cashier: { user: "lina@example.com", full_name: "Lina" },
})

beforeAll(() => {
	globalThis.__ = (text, args) =>
		args ? String(text).replace(/\{(\d+)\}/g, (match, index) => args[index] ?? match) : text
})

beforeEach(() => {
	vi.clearAllMocks()
	mocks.bundle.current = structuredClone(bundle)
	vi.spyOn(navigator, "onLine", "get").mockReturnValue(true)
})

describe("printing from a template", () => {
	it("renders an offline sale with the profile's default template", async () => {
		const job = await prepareTemplatePrint(offlineReceipt, {})

		expect(job.template.name).toBe("PT-0001")
		expect(job.paper).toBe("80mm")
		expect(job.copies).toBe(2)
		expect(job.html).toContain("ضريبة القيمة المضافة VAT (15%)")
		expect(mocks.call).not.toHaveBeenCalled()
	})

	it("uses the printer's own template", async () => {
		const job = await prepareTemplatePrint(offlineReceipt, { printerTemplate: "PT-0002" })

		expect(job.paper).toBe("58mm")
		expect(job.copies).toBe(1)
	})

	it("is nothing when no template applies, so the built-in layout prints", async () => {
		mocks.bundle.current.default_template = null
		expect(await prepareTemplatePrint(offlineReceipt, {})).toBeNull()

		mocks.bundle.current = null
		expect(await prepareTemplatePrint(offlineReceipt, {})).toBeNull()

		mocks.bundle.current = structuredClone(bundle)
		expect(await prepareTemplatePrint(offlineReceipt, { printerTemplate: BUILTIN_LAYOUT })).toBeNull()
	})

	it("says what is wrong with a broken template and falls back, without throwing", async () => {
		mocks.bundle.current.templates[0].html = "{% if doc.name %}never closed"
		const onError = vi.fn()

		await expect(prepareTemplatePrint(offlineReceipt, { onError })).resolves.toBeNull()
		expect(onError).toHaveBeenCalledOnce()
		expect(onError.mock.calls[0][0]).toMatch(/Receipt 80mm/)
		expect(onError.mock.calls[0][0]).toMatch(/standard receipt was printed instead/)
	})

	it("tells the cashier through a toast when nobody else listens", async () => {
		mocks.bundle.current.templates[0].html = "{{ broken( }}"

		await prepareTemplatePrint(offlineReceipt, {})
		expect(mocks.showError).toHaveBeenCalledOnce()
	})

	it("asks the server for a posted invoice's context when online", async () => {
		mocks.call.mockResolvedValue({
			doc: { name: "ACC-SINV-2026-00042", doctype: "Sales Invoice", items: [{ item_name: "Tea", qty: 1, rate: 5, amount: 5 }], grand_total: 5, currency: "SAR" },
			company: { tax_id: "399999999999993" },
			cashier: { user: "amal@example.com", full_name: "Amal" },
			customer: { customer_name: "Walk-in" },
			pos_profile: { name: "Main POS" },
		})

		const job = await prepareTemplatePrint({ name: "ACC-SINV-2026-00042", doctype: "Sales Invoice", pos_profile: "Main POS" }, { reprint: true })

		expect(mocks.call).toHaveBeenCalledWith("pos_next.api.print_templates.get_print_context", {
			invoice: "ACC-SINV-2026-00042",
			doctype: "Sales Invoice",
		})
		expect(job.html).toContain("399999999999993")
		expect(job.html).toContain("Amal")
		expect(job.html).toContain("Reprint")
	})

	it("reprints a posted invoice offline from the device's copy", async () => {
		vi.spyOn(navigator, "onLine", "get").mockReturnValue(false)
		mocks.history.mockResolvedValue([
			{ name: "ACC-SINV-2026-00041", items: [{ item_name: "Kept Tea", qty: 1, rate: 5, amount: 5 }], grand_total: 5 },
		])

		const job = await prepareTemplatePrint({ name: "ACC-SINV-2026-00041", pos_profile: "Main POS" }, {})

		expect(mocks.call).not.toHaveBeenCalled()
		expect(job.html).toContain("Kept Tea")
	})

	it("falls back to the device's copy when the server fails", async () => {
		mocks.call.mockRejectedValue(new Error("timeout"))

		const job = await prepareTemplatePrint(
			{ name: "ACC-SINV-2026-00040", pos_profile: "Main POS", items: [{ item_name: "Row Tea", qty: 1, rate: 5 }] },
			{},
		)

		expect(job.html).toContain("Row Tea")
	})

	it("is nothing for an invoice the device knows nothing of", async () => {
		vi.spyOn(navigator, "onLine", "get").mockReturnValue(false)

		expect(await prepareTemplatePrint({ name: "ACC-SINV-1", pos_profile: "Main POS" }, {})).toBeNull()
	})
})

describe("copies for the browser's dialog", () => {
	it("repeats the body on its own pages", () => {
		const html = withCopies("<html><body class=\"x\"><p>$1 total $&</p></body></html>", 3)

		expect(html.match(/<p>\$1 total \$&<\/p>/g)).toHaveLength(3)
		expect(html.match(/break-after:page/g)).toHaveLength(2)
		expect(html).toContain('<body class="x">')
	})

	it("leaves one copy alone", () => {
		expect(withCopies("<body>a</body>", 1)).toBe("<body>a</body>")
	})
})
