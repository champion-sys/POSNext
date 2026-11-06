import { createPinia, setActivePinia } from "pinia"
import { beforeEach, describe, expect, it, vi } from "vitest"

const offlineItems = vi.hoisted(() => ({
	consumeCachedSerials: vi.fn().mockResolvedValue(undefined),
	persistItemBatchSerialData: vi.fn().mockResolvedValue(undefined),
	returnCachedSerials: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("@/utils/offline/items", () => offlineItems)
vi.mock("@/utils/apiWrapper", () => ({ call: vi.fn() }))

import { useSerialNumberStore } from "@/stores/serialNumber"

describe("the serial number store with nothing in memory, as after an offline start", () => {
	let store

	beforeEach(() => {
		setActivePinia(createPinia())
		store = useSerialNumberStore()
		store.setWarehouse("W1")
		vi.clearAllMocks()
	})

	it("still takes a serial off the device cache", () => {
		store.consumeSerials("PHONE", ["S1"])

		expect(offlineItems.consumeCachedSerials).toHaveBeenCalledWith("PHONE", [
			"S1",
		])
	})

	it("still puts a serial back on the device cache", () => {
		store.returnSerials("PHONE", "S1")

		expect(offlineItems.returnCachedSerials).toHaveBeenCalledWith(
			"PHONE",
			"S1",
			"W1",
		)
	})
})

describe("the serial number store with serials in memory", () => {
	let store

	beforeEach(() => {
		setActivePinia(createPinia())
		store = useSerialNumberStore()
		store.setWarehouse("W1")
		store.cache.set("PHONE", {
			serials: [
				{ serial_no: "S1", warehouse: "W1" },
				{ serial_no: "S2", warehouse: "W1" },
			],
			warehouse: "W1",
			timestamp: Date.now(),
		})
		vi.clearAllMocks()
	})

	it("takes a serial out of both", () => {
		store.consumeSerials("PHONE", "S1")

		expect(store.getSerials("PHONE").map((serial) => serial.serial_no)).toEqual(
			["S2"],
		)
		expect(offlineItems.consumeCachedSerials).toHaveBeenCalledTimes(1)
	})

	it("puts a serial back into both, in order and only once", () => {
		store.consumeSerials("PHONE", "S1")
		store.returnSerials("PHONE", ["S1", "S2"])

		expect(store.getSerials("PHONE").map((serial) => serial.serial_no)).toEqual(
			["S1", "S2"],
		)
		expect(offlineItems.returnCachedSerials).toHaveBeenCalledTimes(1)
	})
})
