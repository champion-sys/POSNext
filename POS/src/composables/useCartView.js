import { computed, onBeforeUnmount, onMounted, ref } from "vue"

export const CART_VIEW_CARDS = "cards"
export const CART_VIEW_COMPACT = "compact"
export const CART_VIEW_TABLE = "table"

/** Below this the table's seven columns cannot show a name and full amounts */
export const TABLE_MIN_WIDTH = 500

const CART_VIEWS = [CART_VIEW_CARDS, CART_VIEW_COMPACT, CART_VIEW_TABLE]

// A device trait like the scanner toggles: one till has room for the table, the next not
const CART_VIEW_KEY = "pos_next_cart_view"

function loadCartView() {
	try {
		const saved = localStorage.getItem(CART_VIEW_KEY)
		return CART_VIEWS.includes(saved) ? saved : CART_VIEW_CARDS
	} catch {
		return CART_VIEW_CARDS
	}
}

function saveCartView(view) {
	try {
		localStorage.setItem(CART_VIEW_KEY, view)
	} catch {
		// localStorage unavailable, the choice lasts until the page reloads
	}
}

/**
 * @param {number} width - The cart's width in pixels, 0 when it is not on screen
 * @returns {boolean}
 */
export function tableFits(width) {
	return width === 0 || width >= TABLE_MIN_WIDTH
}

/**
 * The cashier's choice per device, and what the cart's width lets it show. The choice
 * survives a narrow cart, so widening it brings the table back.
 *
 * @param {import('vue').Ref<HTMLElement|null>} cartRef - The cart's root element
 */
export function useCartView(cartRef) {
	const cartView = ref(loadCartView())
	const cartWidth = ref(0)

	const tableAvailable = computed(() => tableFits(cartWidth.value))
	const activeCartView = computed(() =>
		cartView.value === CART_VIEW_TABLE && !tableAvailable.value
			? CART_VIEW_COMPACT
			: cartView.value,
	)

	function setCartView(view) {
		cartView.value = view
		saveCartView(view)
	}

	let observer = null

	onMounted(() => {
		if (typeof ResizeObserver === "undefined" || !cartRef.value) return
		observer = new ResizeObserver(([entry]) => {
			cartWidth.value = entry.contentRect.width
		})
		observer.observe(cartRef.value)
	})

	onBeforeUnmount(() => observer?.disconnect())

	return { cartView, activeCartView, tableAvailable, setCartView }
}
