import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SCAN_QUIET_MS, createScanBurst } from "../scanBurst"

const key = (value, timeStamp, extra = {}) => ({
	key: value,
	timeStamp,
	...extra,
})

/** Press each key in turn, the given gap apart */
function press(burst, keys, gap, start = 1000) {
	return keys.map((value, index) =>
		burst.handleKeydown(key(value, start + index * gap)),
	)
}

describe("createScanBurst", () => {
	let onScan
	let onBurstStart
	let burst

	beforeEach(() => {
		vi.useFakeTimers()
		onScan = vi.fn()
		onBurstStart = vi.fn()
		burst = createScanBurst({ onScan, onBurstStart })
	})

	afterEach(() => {
		burst.reset()
		vi.useRealTimers()
	})

	it("hears a fast burst that ends in Enter as a scan, and says the key is spent", () => {
		const answers = press(burst, [..."6281000000017", "Enter"], 8)

		expect(onScan).toHaveBeenCalledWith("6281000000017")
		expect(answers.at(-1)).toBe(true)
		expect(answers.slice(0, -1)).not.toContain(true)
	})

	it("accepts Tab as the suffix too", () => {
		press(burst, [..."12345", "Tab"], 8)
		expect(onScan).toHaveBeenCalledWith("12345")
	})

	it("hears a scanner with no suffix when it goes quiet", () => {
		press(burst, [..."12345"], 8)
		expect(onScan).not.toHaveBeenCalled()

		vi.advanceTimersByTime(SCAN_QUIET_MS)
		expect(onScan).toHaveBeenCalledWith("12345")
	})

	it("leaves a person typing alone, however long the number", () => {
		const answers = press(burst, [..."123456", "Enter"], 120)

		vi.advanceTimersByTime(SCAN_QUIET_MS * 2)
		expect(onScan).not.toHaveBeenCalled()
		expect(answers).not.toContain(true)
	})

	it("leaves a quick short entry alone", () => {
		press(burst, [..."12", "Enter"], 8)
		vi.advanceTimersByTime(SCAN_QUIET_MS * 2)
		expect(onScan).not.toHaveBeenCalled()
	})

	it("starts over after a pause", () => {
		press(burst, [..."123"], 8)
		burst.handleKeydown(key("4", 1000 + SCAN_QUIET_MS + 100))
		burst.handleKeydown(key("Enter", 1000 + SCAN_QUIET_MS + 108))
		expect(onScan).not.toHaveBeenCalled()
		expect(onBurstStart).toHaveBeenCalledTimes(2)
	})

	it("survives one key held up by a busy tablet", () => {
		const keys = [..."6281000000017"]
		keys.forEach((value, index) => {
			burst.handleKeydown(key(value, 1000 + index * 8 + (index >= 1 ? 150 : 0)))
		})
		burst.handleKeydown(key("Enter", 1000 + keys.length * 8 + 150))

		expect(onScan).toHaveBeenCalledWith("6281000000017")
		expect(onBurstStart).toHaveBeenCalledTimes(1)
	})

	it("takes the first key of a slow start into the run, so nothing is left behind", () => {
		burst.handleKeydown(key("6", 1000))
		press(burst, [..."281000", "Enter"], 8, 1120)

		expect(onScan).toHaveBeenCalledWith("6281000")
	})

	it("tells the field before the first key lands, once per burst", () => {
		press(burst, [..."12345", "Enter"], 8)
		expect(onBurstStart).toHaveBeenCalledTimes(1)
	})

	it("keeps going through the Shift a scanner holds for capitals", () => {
		burst.handleKeydown(key("Shift", 1000))
		burst.handleKeydown(key("A", 1002, { shiftKey: true }))
		burst.handleKeydown(key("Shift", 1004))
		press(burst, [..."B12", "Enter"], 8, 1006)

		expect(onScan).toHaveBeenCalledWith("AB12")
	})

	it("ignores a held key, which repeats as fast as a scanner", () => {
		for (let index = 0; index < 8; index++) {
			burst.handleKeydown(key("1", 1000 + index * 30, { repeat: index > 0 }))
		}
		burst.handleKeydown(key("Enter", 1300))
		expect(onScan).not.toHaveBeenCalled()
	})

	it("ignores shortcuts", () => {
		burst.handleKeydown(key("c", 1000, { altKey: true }))
		burst.handleKeydown(key("v", 1005, { ctrlKey: true }))
		burst.handleKeydown(key("x", 1010, { metaKey: true }))
		burst.handleKeydown(key("z", 1015, { ctrlKey: true }))
		burst.handleKeydown(key("Enter", 1020))
		expect(onScan).not.toHaveBeenCalled()
	})

	it("drops a run when an editing key interrupts it", () => {
		press(burst, [..."1234", "Backspace"], 8)
		vi.advanceTimersByTime(SCAN_QUIET_MS * 2)
		expect(onScan).not.toHaveBeenCalled()
	})
})
