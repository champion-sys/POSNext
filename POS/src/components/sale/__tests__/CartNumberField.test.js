import { flushPromises, mount } from "@vue/test-utils"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BARCODE_SCANNED_EVENT } from "@/utils/scanBurst"
import CartNumberField from "../CartNumberField.vue"

const BARCODE = "6281000000017"

describe("a field in the cart", () => {
	let wrapper
	let search
	let scans
	const onScan = (event) => scans.push(event.detail.barcode)

	const mountField = (props = {}) => {
		wrapper = mount(CartNumberField, {
			props: { value: 3, label: "Quantity", ...props },
			attachTo: document.body,
		})
		return wrapper.find("input")
	}

	const typeText = async (input, text) => {
		input.element.value = text
		await input.trigger("input")
	}

	/** A key press at a set moment, so a busy test machine cannot change the timing */
	const pressAt = (input, key, timeStamp) => {
		const event = new KeyboardEvent("keydown", {
			key,
			bubbles: true,
			cancelable: true,
		})
		Object.defineProperty(event, "timeStamp", { value: timeStamp })
		input.element.dispatchEvent(event)
	}

	/** What a wedge scanner does: keys land in the field faster than anyone types */
	const scanInto = async (input, barcode, suffix = "Enter", start = 5000) => {
		let typed = input.element.value
		let at = start
		for (const digit of barcode) {
			pressAt(input, digit, at)
			at += 8
			typed += digit
			input.element.value = typed
			await input.trigger("input")
		}
		if (suffix) pressAt(input, suffix, at)
		return at
	}

	beforeEach(() => {
		scans = []
		window.addEventListener(BARCODE_SCANNED_EVENT, onScan)
		search = document.createElement("input")
		search.id = "item-search"
		document.body.appendChild(search)
	})

	afterEach(() => {
		wrapper?.unmount()
		search.remove()
		window.removeEventListener(BARCODE_SCANNED_EVENT, onScan)
	})

	describe("under a barcode scan", () => {
		it("hands the scan to the item search and keeps its value", async () => {
			const input = mountField()
			input.element.focus()

			await scanInto(input, BARCODE)
			await flushPromises()

			expect(scans).toEqual([BARCODE])
			expect(input.element.value).toBe("3")
			expect(wrapper.emitted("commit")).toBeUndefined()
		})

		it("commits nothing when the scan moves focus away", async () => {
			const input = mountField()
			input.element.focus()

			await scanInto(input, BARCODE)
			await input.trigger("blur")

			expect(wrapper.emitted("commit")).toBeUndefined()
			expect(input.element.value).toBe("3")
		})

		it("keeps what the cashier had already typed", async () => {
			const input = mountField()
			input.element.focus()
			pressAt(input, "7", 1000)
			await typeText(input, "7")

			await scanInto(input, BARCODE)

			expect(input.element.value).toBe("7")
			await input.trigger("blur")
			expect(wrapper.emitted("commit")).toEqual([[7]])
		})

		it("swallows the suffix so the cart's shortcuts never see it", async () => {
			const input = mountField()
			input.element.focus()
			const onWindowKeydown = vi.fn()
			window.addEventListener("keydown", onWindowKeydown)

			const end = await scanInto(input, BARCODE, null)
			onWindowKeydown.mockClear()
			pressAt(input, "Enter", end)

			window.removeEventListener("keydown", onWindowKeydown)
			expect(onWindowKeydown).not.toHaveBeenCalled()
		})

		it("treats a number no quantity could be as a barcode, however slowly it came", async () => {
			const input = mountField()
			input.element.focus()
			await typeText(input, BARCODE)

			await input.trigger("blur")

			expect(scans).toEqual([BARCODE])
			expect(input.element.value).toBe("3")
			expect(wrapper.emitted("commit")).toBeUndefined()
		})

		it("lets a field allow longer figures", async () => {
			const input = mountField({ longestFigure: 11 })
			input.element.focus()
			await typeText(input, "12345678")

			await input.trigger("blur")

			expect(scans).toEqual([])
			expect(wrapper.emitted("commit")).toEqual([[12345678]])
		})

		it("does not take a slow entry for a scan", async () => {
			const input = mountField()
			input.element.focus()
			pressAt(input, "4", 1000)
			await typeText(input, "4")
			pressAt(input, "2", 1120)
			await typeText(input, "42")
			pressAt(input, "Enter", 1240)

			expect(scans).toEqual([])
			expect(wrapper.emitted("commit")).toEqual([[42]])
		})
	})

	describe("on the keyboard", () => {
		it("commits on Enter and returns to the item search", async () => {
			const input = mountField()
			input.element.focus()
			await typeText(input, "5")

			await input.trigger("keydown", { key: "Enter" })

			expect(wrapper.emitted("commit")).toEqual([[5]])
			expect(document.activeElement).toBe(search)
		})

		it("keeps Enter from the window, where it would open the edit dialog", async () => {
			const input = mountField()
			input.element.focus()
			await typeText(input, "5")
			const onWindowKeydown = vi.fn()
			window.addEventListener("keydown", onWindowKeydown)

			await input.trigger("keydown", { key: "Enter" })

			window.removeEventListener("keydown", onWindowKeydown)
			expect(onWindowKeydown).not.toHaveBeenCalled()
		})

		it.each([
			["F8", {}],
			["F9", {}],
			["Enter", { altKey: true }],
		])("saves what was typed and leaves %s to the window", async (key, modifiers) => {
			const input = mountField()
			input.element.focus()
			await typeText(input, "5")
			const onWindowKeydown = vi.fn()
			window.addEventListener("keydown", onWindowKeydown)

			await input.trigger("keydown", { key, ...modifiers })

			window.removeEventListener("keydown", onWindowKeydown)
			expect(wrapper.emitted("commit")).toEqual([[5]])
			expect(onWindowKeydown).toHaveBeenCalledOnce()
			expect(document.activeElement).toBe(input.element)
		})

		it("commits once when Enter moves focus away", async () => {
			const input = mountField()
			input.element.focus()
			await typeText(input, "5")

			await input.trigger("keydown", { key: "Enter" })
			await input.trigger("blur")

			expect(wrapper.emitted("commit")).toHaveLength(1)
		})

		it("restores the old value on Escape and stays put", async () => {
			const input = mountField()
			input.element.focus()
			await typeText(input, "9")

			await input.trigger("keydown", { key: "Escape" })
			await input.trigger("blur")

			expect(input.element.value).toBe("3")
			expect(wrapper.emitted("commit")).toBeUndefined()
		})

		it("commits on blur", async () => {
			const input = mountField()
			input.element.focus()
			await typeText(input, "8")

			await input.trigger("blur")

			expect(wrapper.emitted("commit")).toEqual([[8]])
		})

		it("commits nothing when the value was not touched", async () => {
			const input = mountField()
			input.element.focus()
			await input.trigger("blur")
			expect(wrapper.emitted("commit")).toBeUndefined()
		})

		it("passes on what cannot be read, for the owner to refuse", async () => {
			const input = mountField()
			input.element.focus()
			await typeText(input, "")
			await input.trigger("blur")

			expect(wrapper.emitted("commit")).toEqual([[null]])
			expect(input.element.value).toBe("3")
		})
	})

	describe("on a touch screen", () => {
		it("asks for the number pad", () => {
			const input = mountField()
			expect(input.attributes("inputmode")).toBe("decimal")
			expect(input.attributes("type")).toBe("text")
		})

		it("selects the value on focus, so a tap replaces it", async () => {
			const input = mountField()
			const select = vi.spyOn(input.element, "select")
			await input.trigger("focus")
			expect(select).toHaveBeenCalled()
		})

		it("keeps that selection through the tap that gave focus", async () => {
			const input = mountField()
			await input.trigger("focus")

			const first = new MouseEvent("mouseup", {
				bubbles: true,
				cancelable: true,
			})
			input.element.dispatchEvent(first)
			const second = new MouseEvent("mouseup", {
				bubbles: true,
				cancelable: true,
			})
			input.element.dispatchEvent(second)

			expect(first.defaultPrevented).toBe(true)
			expect(second.defaultPrevented).toBe(false)
		})

		it("shows digits left to right in an Arabic page", () => {
			expect(mountField().attributes("dir")).toBe("ltr")
		})
	})

	it("follows a value changed elsewhere", async () => {
		const input = mountField()
		await wrapper.setProps({ value: 4 })
		expect(input.element.value).toBe("4")
	})

	it("does not overwrite what the cashier is typing", async () => {
		const input = mountField()
		input.element.focus()
		await typeText(input, "9")

		await wrapper.setProps({ value: 4 })

		expect(input.element.value).toBe("9")
	})

	it("shows the prop again when the owner refuses the value", async () => {
		const input = mountField({ format: (value) => value.toFixed(2) })
		input.element.focus()
		await typeText(input, "abc")
		await input.trigger("blur")
		expect(input.element.value).toBe("3.00")
	})
})
