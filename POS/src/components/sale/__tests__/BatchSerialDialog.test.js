import { flushPromises, mount } from "@vue/test-utils"
import { describe, expect, it, vi } from "vitest"

const setWarehouse = vi.hoisted(() => vi.fn())

vi.mock("frappe-ui", () => ({
	Button: { template: "<button />" },
	Dialog: { template: "<div />" },
	createResource: () => ({ reload: vi.fn() }),
}))
vi.mock("@/stores/serialNumber", () => ({
	useSerialNumberStore: () => ({
		setWarehouse,
		fetchSerials: vi.fn().mockResolvedValue([]),
	}),
}))
vi.mock("@/stores/posCart", () => ({
	usePOSCartStore: () => ({ invoiceItems: [] }),
}))
vi.mock("@/utils/offline/items", () => ({
	getCachedBatchData: vi.fn(),
	getCachedSerialData: vi.fn().mockResolvedValue([]),
	persistItemBatchSerialData: vi.fn(),
}))
vi.mock("@/utils/offline", () => ({ isOffline: () => true }))

import BatchSerialDialog from "../BatchSerialDialog.vue"

describe("the serial dialog, offline", () => {
	it("tells the store the warehouse, which it needs to give a serial back", async () => {
		const wrapper = mount(BatchSerialDialog, {
			props: {
				modelValue: false,
				item: { item_code: "PHONE", has_serial_no: 1 },
				warehouse: "W1",
			},
			global: { mocks: { __: (message) => message } },
		})

		await wrapper.setProps({ modelValue: true })
		await flushPromises()

		expect(setWarehouse).toHaveBeenCalledWith("W1")
	})
})
