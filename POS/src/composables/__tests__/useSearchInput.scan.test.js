import { flushPromises, mount } from "@vue/test-utils"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ref } from "vue"
import { announceScan } from "@/utils/scanBurst"
import { useScanWithoutSearch, useSearchInput } from "../useSearchInput"

describe("a scan forwarded from a cart field", () => {
	let wrapper
	let itemStore
	let onItemFound
	let showWarning

	beforeEach(() => {
		localStorage.clear()
		vi.stubGlobal("__", (text, values = []) =>
			text.replace(/\{(\d)\}/g, (_match, index) => values[index]),
		)
		itemStore = {
			searchTerm: "",
			clearSearch: vi.fn(),
			setSearchTerm: vi.fn(),
			searchByBarcode: vi.fn(async () => ({ item_code: "SCANNED" })),
		}
		onItemFound = vi.fn(() => true)
		showWarning = vi.fn()
		wrapper = mount({
			template: "<input />",
			setup() {
				useSearchInput({
					itemStore,
					onItemFound,
					showWarning,
					isAnyDialogOpen: ref(false),
				})
			},
		})
	})

	afterEach(() => {
		wrapper.unmount()
		vi.unstubAllGlobals()
	})

	it("adds the item the way a scan in the search does", async () => {
		announceScan("6281000000017")
		await flushPromises()

		expect(itemStore.searchByBarcode).toHaveBeenCalledWith("6281000000017")
		expect(onItemFound).toHaveBeenCalledWith({ item_code: "SCANNED" }, false)
	})

	it("warns about a barcode it does not know", async () => {
		itemStore.searchByBarcode.mockResolvedValue(null)

		announceScan("000")
		await flushPromises()

		expect(showWarning).toHaveBeenCalledWith(
			"Item Not Found: No item found with barcode: 000",
		)
		expect(onItemFound).not.toHaveBeenCalled()
	})

	it("stops listening when the search goes away", async () => {
		wrapper.unmount()
		wrapper = mount({ template: "<div />" })

		announceScan("6281000000017")
		await flushPromises()

		expect(itemStore.searchByBarcode).not.toHaveBeenCalled()
	})
})

describe("a forwarded scan with no item search on screen", () => {
	let wrapper
	let itemStore
	let onItemFound
	let showWarning
	let hasItemSearch

	beforeEach(() => {
		localStorage.clear()
		vi.stubGlobal("__", (text, values = []) =>
			text.replace(/\{(\d)\}/g, (_match, index) => values[index]),
		)
		itemStore = {
			searchByBarcode: vi.fn(async () => ({ item_code: "SCANNED" })),
		}
		onItemFound = vi.fn()
		showWarning = vi.fn()
		hasItemSearch = vi.fn(() => false)
		wrapper = mount({
			template: "<div />",
			setup() {
				useScanWithoutSearch({
					hasItemSearch,
					itemStore,
					onItemFound,
					showWarning,
				})
			},
		})
	})

	afterEach(() => {
		wrapper.unmount()
		vi.unstubAllGlobals()
	})

	it("still adds the item, for the cart tab of a narrow device", async () => {
		announceScan("6281000000017")
		await flushPromises()
		expect(onItemFound).toHaveBeenCalledWith({ item_code: "SCANNED" }, false)
	})

	it("follows the auto-add setting of the till", async () => {
		localStorage.setItem("pos_auto_add_enabled", "1")
		announceScan("6281000000017")
		await flushPromises()
		expect(onItemFound).toHaveBeenCalledWith({ item_code: "SCANNED" }, true)
	})

	it("leaves the scan to the item search when there is one", async () => {
		hasItemSearch.mockReturnValue(true)
		announceScan("6281000000017")
		await flushPromises()
		expect(itemStore.searchByBarcode).not.toHaveBeenCalled()
	})

	it("warns about a barcode it does not know", async () => {
		itemStore.searchByBarcode.mockResolvedValue(null)
		announceScan("000")
		await flushPromises()
		expect(showWarning).toHaveBeenCalledWith(
			"Item Not Found: No item found with barcode: 000",
		)
	})
})
