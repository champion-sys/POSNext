import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it, vi } from "vitest"

const FORM_SCRIPT = resolve(
	__dirname,
	"../../../../../pos_next/pos_next/doctype/offline_invoice_sync/offline_invoice_sync.js",
)

const escapeHtml = (text) =>
	String(text).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")

/** The Desk form script, with the part of Frappe it touches */
function loadForm(call = vi.fn()) {
	const frappe = {
		call,
		ui: { form: { on: vi.fn() } },
		utils: {
			escape_html: escapeHtml,
			get_form_link: (doctype, name) => `<a href="/desk/${doctype}/${encodeURIComponent(name)}">${escapeHtml(name)}</a>`,
		},
	}
	const translate = (text, values = []) => text.replace(/\{(\d)\}/g, (_match, index) => values[index])
	const jquery = () => ({ on: vi.fn() })

	return new Function(
		"frappe",
		"__",
		"$",
		`${readFileSync(FORM_SCRIPT, "utf8")}\nreturn { renderReconciliation, loadReconciliation }`,
	)(frappe, translate, jquery)
}

const entry = (offline_id, state, status = null, invoice = null) => ({
	offline_id,
	state,
	status,
	record: status ? `record-${offline_id}` : null,
	invoice,
	invoice_doctype: invoice ? "Sales Invoice" : null,
})

const reconciliation = (entries, extras = []) => ({
	counts: {
		missing: entries.filter(({ state }) => state === "missing").length,
		finished: entries.filter(({ state }) => state === "finished").length,
		manifest: entries.length,
		extra: extras.length,
	},
	entries,
	extras,
})

function fakeWrapper() {
	const wrapper = { html: vi.fn(() => wrapper), append: vi.fn() }
	return wrapper
}

describe("shift reconciliation table", () => {
	const { renderReconciliation } = loadForm()

	it("links each entry to its record and invoice", () => {
		const html = renderReconciliation(reconciliation([entry("sale-1", "finished", "Synced", "SINV-1")]))

		expect(html).toContain('href="/desk/Offline Invoice Sync/record-sale-1"')
		expect(html).toContain('href="/desk/Sales Invoice/SINV-1"')
		expect(html).toContain("Synced")
	})

	it("names a sale that never arrived, at the top of the list", () => {
		const html = renderReconciliation(
			reconciliation([entry("fine", "finished", "Synced", "SINV-1"), entry("lost", "missing")]),
		)

		expect(html).toContain("Never Arrived")
		expect(html.indexOf("<td dir=\"auto\">lost")).toBeLessThan(html.indexOf("<td dir=\"auto\">fine"))
	})

	it("shows the counts", () => {
		const html = renderReconciliation(reconciliation([entry("lost", "missing")], [entry("online", "finished")]))

		expect(html).toContain("1 listed by the device, 1 more on the server.")
		expect(html).toContain("Never Arrived: 1")
	})

	it("lists what the server holds outside the manifest apart from it", () => {
		const html = renderReconciliation(reconciliation([], [entry("online", "finished", null, "SINV-2")]))

		expect(html).toContain("On The Server, Not Listed By The Device")
		expect(html).not.toContain("<h6 class=\"mt-3\">Listed By The Device")
	})

	it("does not trust an id that came from a device", () => {
		const html = renderReconciliation(reconciliation([entry('<img src=x onerror="alert(1)">', "missing")]))

		expect(html).not.toContain("<img")
		expect(html).toContain("&lt;img")
	})

	it("says so when a close lists nothing", () => {
		expect(renderReconciliation(reconciliation([]))).toContain("does not list any invoices")
	})

	it("renders a very long manifest without trouble", () => {
		const entries = Array.from({ length: 3000 }, (_value, index) => entry(`sale-${index}`, "missing"))

		expect(renderReconciliation(reconciliation(entries)).match(/<tr>/g)).toHaveLength(3001)
	})
})

describe("loading the table", () => {
	const frmOn = (wrapper, name = "close-1") => ({
		doc: { name },
		get_field: () => ({ $wrapper: wrapper }),
	})

	it("asks the server for this record", async () => {
		const call = vi.fn().mockResolvedValue({ message: reconciliation([]) })
		const wrapper = fakeWrapper()

		await loadForm(call).loadReconciliation(frmOn(wrapper))

		expect(call.mock.calls[0][0]).toEqual({
			method: "pos_next.api.sync.get_shift_reconciliation",
			args: { name: "close-1" },
		})
		expect(wrapper.html).toHaveBeenLastCalledWith(expect.stringContaining("does not list any invoices"))
	})

	it("offers to try again when the read fails", async () => {
		const wrapper = fakeWrapper()

		await loadForm(vi.fn().mockRejectedValue(new Error("down"))).loadReconciliation(frmOn(wrapper))

		expect(wrapper.html).toHaveBeenLastCalledWith(expect.stringContaining("Could not load"))
		expect(wrapper.append).toHaveBeenCalledOnce()
	})

	it("keeps an answer out of a form that has moved to another record", async () => {
		const wrapper = fakeWrapper()
		const frm = frmOn(wrapper)
		const call = vi.fn(async () => {
			frm.doc.name = "close-2"
			return { message: reconciliation([]) }
		})

		await loadForm(call).loadReconciliation(frm)

		expect(wrapper.html).toHaveBeenCalledOnce()
	})
})
