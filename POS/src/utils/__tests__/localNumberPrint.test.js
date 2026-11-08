/**
 * Receipts print the local number where they printed the device's id, and both numbers
 * once the server has named the sale.
 */
import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.hoisted(() => {
	globalThis.__ = (text, args) =>
		Array.isArray(args) ? text.replace(/\{(\d+)\}/g, (_, i) => args[i]) : text
})

vi.mock("@/platform/store", () => ({ localStore: { listPrintJobs: async () => [] } }))
vi.mock("@/utils/apiWrapper", () => ({ call: vi.fn() }))
vi.mock("../apiWrapper", () => ({ call: vi.fn() }))
vi.mock("@/utils/offline/offlineReceiptCache", () => ({}))
vi.mock("@/utils/offline/sync", () => ({}))
vi.mock("@/utils/offline/workerClient", () => ({ offlineWorker: {} }))
vi.mock("@/utils/qzTray", () => ({ printHTML: vi.fn() }))
vi.mock("@/stores/posSettings", () => ({ usePOSSettingsStore: () => ({}) }))
vi.mock("../../stores/posSettings", () => ({ usePOSSettingsStore: () => ({}) }))

import { buildPrintContext, normalizePrintDoc } from "@/platform/printing/context"
import { renderTemplate } from "@/platform/printing/template"
import { buildOfflinePrintDoc } from "@/utils/offline/offlinePrintDoc"
import { formatInvoiceToReceiptLines } from "../escpos"
import { buildReceiptHTML } from "../printInvoice"

const OFFLINE_ID = "pos_offline_6a1d2c3b-0000-4000-8000-000000000001"
const LOCAL_NUMBER = "LACC-SINV-2026-3-00001"

const queuedSale = {
	offline_id: OFFLINE_ID,
	posa_local_number: LOCAL_NUMBER,
	posa_pos_opening_shift: "POSA-OS-26-0000003",
	customer: "Walk-In",
	posting_date: "2026-11-09",
	posting_time: "10:00:00",
	items: [{ item_code: "COFFEE", item_name: "Coffee", qty: 1, rate: 10 }],
	payments: [{ mode_of_payment: "Cash", amount: 10 }],
}

const offlineDoc = () =>
	buildOfflinePrintDoc({
		invoiceData: queuedSale,
		paymentData: { paid_amount: 10 },
		totals: { grandTotal: 10, roundedTotal: 10, totalTax: 0 },
		doctype: "Sales Invoice",
		posProfile: "Main",
		customerLabel: "Walk-In",
	})

const syncedDoc = {
	name: "ACC-SINV-2026-00042",
	posa_local_number: LOCAL_NUMBER,
	company: "Acme",
	items: [{ item_code: "COFFEE", item_name: "Coffee", qty: 1, rate: 10 }],
	payments: [{ mode_of_payment: "Cash", amount: 10 }],
	grand_total: 10,
}

beforeEach(() => {
	setActivePinia(createPinia())
})

describe("the receipt kept for a sale saved offline", () => {
	it("carries the local number, and keeps the device id as its name to find it by", () => {
		const doc = offlineDoc()
		expect(doc.posa_local_number).toBe(LOCAL_NUMBER)
		expect(doc.name).toBe(OFFLINE_ID)
		expect(doc.offline_id).toBe(OFFLINE_ID)
	})
})

describe("a print template's doc", () => {
	it("is named by the local number before the server names the sale", () => {
		const doc = normalizePrintDoc(offlineDoc())
		expect(doc.name).toBe(LOCAL_NUMBER)
		expect(doc.posa_local_number).toBe(LOCAL_NUMBER)
		expect(doc.offline_id).toBe(OFFLINE_ID)
	})

	it("prints the local number where the template prints the name", () => {
		const context = buildPrintContext({ doc: offlineDoc() })
		const html = renderTemplate({ html: "<p>{{ doc.name }}|{{ doc.posa_local_number }}</p>" }, context)
		expect(html).toContain(`${LOCAL_NUMBER}|${LOCAL_NUMBER}`)
		expect(html).not.toContain(OFFLINE_ID)
	})

	it("keeps the server's name once it has one, with the local number beside it", () => {
		const doc = normalizePrintDoc(syncedDoc)
		expect(doc.name).toBe("ACC-SINV-2026-00042")
		expect(doc.posa_local_number).toBe(LOCAL_NUMBER)
		expect(doc.offline_id).toBeNull()
	})

	it("keeps the device id for a sale made before local numbers", () => {
		const doc = normalizePrintDoc({ ...offlineDoc(), posa_local_number: undefined })
		expect(doc.name).toBe(OFFLINE_ID)
		expect(doc.posa_local_number).toBe("")
	})
})

describe("the built-in receipt", () => {
	it("prints the local number, not the device id, before the server names the sale", () => {
		const html = buildReceiptHTML(offlineDoc())
		expect(html).toContain(LOCAL_NUMBER)
		expect(html).not.toContain(OFFLINE_ID)
	})

	it("prints the server's name and the local number once synced", () => {
		const html = buildReceiptHTML(syncedDoc)
		expect(html).toContain("ACC-SINV-2026-00042")
		expect(html).toContain(LOCAL_NUMBER)
		expect(html).toContain("Local No.:")
	})
})

describe("the ESC/POS receipt", () => {
	const texts = (doc) => formatInvoiceToReceiptLines(doc).map((line) => line.text)

	it("prints the local number, not the device id, before the server names the sale", () => {
		const lines = texts(offlineDoc())
		expect(lines.some((text) => text.includes(LOCAL_NUMBER))).toBe(true)
		expect(lines.some((text) => text.includes(OFFLINE_ID))).toBe(false)
	})

	it("prints the server's name and the local number once synced", () => {
		const lines = texts(syncedDoc)
		expect(lines).toContain("Invoice #: ACC-SINV-2026-00042")
		expect(lines).toContain(`Local No.: ${LOCAL_NUMBER}`)
	})
})
