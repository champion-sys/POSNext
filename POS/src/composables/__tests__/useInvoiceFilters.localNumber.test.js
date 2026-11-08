import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.hoisted(() => {
	globalThis.__ = (text) => text
})
import { computed } from "vue"
import { useInvoiceFilters } from "@/composables/useInvoiceFilters"
import { useInvoiceFiltersStore } from "@/stores/invoiceFilters"

const INVOICES = [
	{ name: "ACC-SINV-2026-00042", posa_local_number: "LACC-SINV-2026-3-00001", customer_name: "Ali" },
	{ name: "ACC-SINV-2026-00043", posa_local_number: "LACC-SINV-2026-3-00002", customer_name: "Sara" },
	{ name: "ACC-SINV-2025-00001", customer_name: "Omar" },
]

describe("invoice history search", () => {
	beforeEach(() => {
		setActivePinia(createPinia())
	})

	const search = (term) => {
		useInvoiceFiltersStore().searchTerm = term
		return useInvoiceFilters(computed(() => INVOICES))
	}

	it("finds an invoice by its local number", () => {
		const { filteredInvoices, matchesFilters } = search("3-00002")
		expect(filteredInvoices.value.map((invoice) => invoice.name)).toEqual(["ACC-SINV-2026-00043"])
		expect(matchesFilters(INVOICES[1])).toBe(true)
		expect(matchesFilters(INVOICES[0])).toBe(false)
	})

	it("still finds an invoice by its server name and its customer", () => {
		expect(search("2025-00001").filteredInvoices.value.map((invoice) => invoice.name)).toEqual([
			"ACC-SINV-2025-00001",
		])
		expect(search("sara").filteredInvoices.value.map((invoice) => invoice.name)).toEqual(["ACC-SINV-2026-00043"])
	})
})
