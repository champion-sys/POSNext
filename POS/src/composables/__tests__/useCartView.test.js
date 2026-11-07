import { mount } from "@vue/test-utils"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { nextTick, ref } from "vue"
import {
	CART_VIEW_CARDS,
	CART_VIEW_COMPACT,
	CART_VIEW_TABLE,
	TABLE_MIN_WIDTH,
	tableFits,
	useCartView,
} from "../useCartView"

const KEY = "pos_next_cart_view"

function mountView() {
	let view
	const wrapper = mount({
		template: "<div ref='root' />",
		setup() {
			const root = ref(null)
			view = useCartView(root)
			return { root }
		},
	})
	return { view, wrapper }
}

describe("useCartView", () => {
	let resize

	beforeEach(() => {
		localStorage.clear()
		vi.stubGlobal(
			"ResizeObserver",
			class {
				constructor(callback) {
					resize = (width) => callback([{ contentRect: { width } }])
				}
				observe() {}
				disconnect() {}
			},
		)
	})

	afterEach(() => {
		vi.unstubAllGlobals()
		vi.restoreAllMocks()
	})

	it("starts on the cards", () => {
		expect(mountView().view.cartView.value).toBe(CART_VIEW_CARDS)
	})

	it("remembers the choice across a reload", () => {
		mountView().view.setCartView(CART_VIEW_TABLE)
		expect(localStorage.getItem(KEY)).toBe(CART_VIEW_TABLE)
		expect(mountView().view.cartView.value).toBe(CART_VIEW_TABLE)
	})

	it("ignores a value it does not know", () => {
		localStorage.setItem(KEY, "spreadsheet")
		expect(mountView().view.cartView.value).toBe(CART_VIEW_CARDS)
	})

	it("works when storage cannot be read", () => {
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("denied")
		})
		expect(mountView().view.cartView.value).toBe(CART_VIEW_CARDS)
	})

	it("still switches when storage cannot be written", () => {
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("full")
		})
		const { view } = mountView()
		view.setCartView(CART_VIEW_COMPACT)
		expect(view.activeCartView.value).toBe(CART_VIEW_COMPACT)
	})

	it("shows the compact view while the cart is too narrow for the table", async () => {
		const { view } = mountView()
		view.setCartView(CART_VIEW_TABLE)

		resize(TABLE_MIN_WIDTH - 1)
		await nextTick()

		expect(view.activeCartView.value).toBe(CART_VIEW_COMPACT)
		expect(view.tableAvailable.value).toBe(false)
	})

	it("keeps the choice, so widening the cart brings the table back", async () => {
		const { view } = mountView()
		view.setCartView(CART_VIEW_TABLE)
		resize(TABLE_MIN_WIDTH - 1)
		await nextTick()
		expect(view.cartView.value).toBe(CART_VIEW_TABLE)

		resize(TABLE_MIN_WIDTH)
		await nextTick()
		expect(view.activeCartView.value).toBe(CART_VIEW_TABLE)
	})

	it("leaves the other views alone in a narrow cart", async () => {
		const { view } = mountView()
		view.setCartView(CART_VIEW_CARDS)
		resize(320)
		await nextTick()
		expect(view.activeCartView.value).toBe(CART_VIEW_CARDS)
	})

	it("does not judge a cart that is off screen", () => {
		expect(tableFits(0)).toBe(true)
	})
})
