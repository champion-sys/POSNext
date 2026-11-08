/**
 * The offline queue shows each sale's local number, and the server's name once it has one,
 * and finds a sale by either.
 */
import { mount } from "@vue/test-utils"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

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
vi.mock("@/stores/posSettings", () => ({ usePOSSettingsStore: () => ({}) }))
vi.mock("@/stores/posSync", () => ({
	usePOSSyncStore: () => ({ reviewCount: 0, queuedCount: 0, lastSyncedAt: null, refusedVoids: [] }),
}))
vi.mock("@/stores/posUI", () => ({ usePOSUIStore: () => ({ lastInvoiceName: null }) }))
vi.mock("@/composables/useToast", () => ({ useToast: () => ({ showWarning: vi.fn() }) }))

const translate = (text, values = []) => text.replace(/\{(\d)\}/g, (_match, index) => values[index])

const row = (id, data, extra = {}) => ({
	id,
	offline_id: `pos_offline_${id}`,
	entity: "invoice",
	timestamp: Date.now(),
	data: { grand_total: 10, items: [{ item_code: "A" }], payments: [], ...data },
	...extra,
})

const ROWS = [
	row(1, { customer: "CUST-1", posa_local_number: "LACC-SINV-2026-3-00001" }),
	row(2, { customer: "CUST-2", posa_local_number: "LACC-SINV-2026-3-00002" }, {
		server_status: "synced",
		server_invoice: "ACC-SINV-2026-00042",
	}),
	row(3, { customer: "CUST-3" }),
]

describe("the offline queue and local numbers", () => {
	let OfflineInvoicesDialog

	const open = (rows) =>
		mount(OfflineInvoicesDialog, {
			props: { modelValue: true, pendingInvoices: rows },
			global: { mocks: { __: translate } },
		})

	const numbers = (wrapper) => wrapper.findAll('[data-test="queue-number"]').map((node) => node.text())

	beforeEach(async () => {
		vi.stubGlobal("__", translate)
		OfflineInvoicesDialog = (await import("../OfflineInvoicesDialog.vue")).default
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it("shows the local number of a queued sale, and the server's name beside it once synced", () => {
		const shown = numbers(open(ROWS))

		expect(shown).toContain("LACC-SINV-2026-3-00001")
		expect(shown).toContain("ACC-SINV-2026-00042 · LACC-SINV-2026-3-00002")
		expect(shown.join(" ")).not.toContain("pos_offline_")
	})

	it("finds a sale by its local number", async () => {
		const wrapper = open(ROWS)
		await wrapper.find('[data-test="queue-search"]').setValue("3-00001")

		expect(numbers(wrapper)).toEqual(["LACC-SINV-2026-3-00001"])
	})

	it("finds a synced sale by its server name", async () => {
		const wrapper = open(ROWS)
		await wrapper.find('[data-test="queue-search"]').setValue("sinv-2026-00042")

		expect(numbers(wrapper)).toEqual(["ACC-SINV-2026-00042 · LACC-SINV-2026-3-00002"])
	})

	it("says so when nothing matches", async () => {
		const wrapper = open(ROWS)
		await wrapper.find('[data-test="queue-search"]').setValue("LNOPE")

		expect(numbers(wrapper)).toEqual([])
		expect(wrapper.text()).toContain("No invoices found")
	})
})
