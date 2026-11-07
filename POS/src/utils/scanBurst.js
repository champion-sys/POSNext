/**
 * A wedge barcode scanner types like a keyboard, only far too fast for a person. A cart
 * field cannot tell its first digit from a cashier's, so the keys land as usual and the
 * field puts its value back once the run of keys proves to be a scan.
 *
 * @module utils/scanBurst
 */

/** A pause this long starts a new run of keys, and tells a scanner with no suffix is done */
export const SCAN_QUIET_MS = 200

/**
 * Scanners average a few milliseconds a key, a fast typist about 80. The average, not each
 * gap, because a busy tablet or a Bluetooth scanner can hold up one key of a run.
 */
export const SCAN_MAX_AVERAGE_GAP_MS = 40

/** The shortest code worth treating as a scan */
export const SCAN_MIN_LENGTH = 4

export const BARCODE_SCANNED_EVENT = "pos-next:barcode-scanned"

const SUFFIX_KEYS = new Set(["Enter", "Tab"])

/** A scanner holds Shift for capitals, which must not end the run */
const MODIFIER_KEYS = new Set(["Shift", "CapsLock"])

const isTypedKey = (event) =>
	event.key.length === 1 &&
	!event.ctrlKey &&
	!event.altKey &&
	!event.metaKey &&
	!event.repeat

/**
 * @param {{onBurstStart?: () => void, onScan: (barcode: string) => void}} handlers
 *   onBurstStart runs before the first key of a run lands
 * @returns {{handleKeydown: (event: KeyboardEvent) => boolean, reset: () => void}}
 *   handleKeydown is true when the key ended a scan, so the caller must swallow it
 */
export function createScanBurst({ onBurstStart, onScan }) {
	let buffer = ""
	let firstKeyAt = 0
	let lastKeyAt = 0
	let quietTimer = null

	function reset() {
		clearTimeout(quietTimer)
		quietTimer = null
		buffer = ""
	}

	function isScan() {
		if (buffer.length < SCAN_MIN_LENGTH) return false
		return (
			(lastKeyAt - firstKeyAt) / (buffer.length - 1) <= SCAN_MAX_AVERAGE_GAP_MS
		)
	}

	function finish() {
		const barcode = buffer
		reset()
		onScan(barcode)
	}

	function handleKeydown(event) {
		if (MODIFIER_KEYS.has(event.key)) return false

		if (isTypedKey(event)) {
			if (!buffer || event.timeStamp - lastKeyAt > SCAN_QUIET_MS) {
				buffer = ""
				firstKeyAt = event.timeStamp
				onBurstStart?.()
			}
			buffer += event.key
			lastKeyAt = event.timeStamp

			clearTimeout(quietTimer)
			quietTimer = setTimeout(() => {
				if (isScan()) finish()
				else reset()
			}, SCAN_QUIET_MS)
			return false
		}

		if (SUFFIX_KEYS.has(event.key) && isScan()) {
			finish()
			return true
		}

		reset()
		return false
	}

	return { handleKeydown, reset }
}

/**
 * Hand a barcode to the item search, the one place that knows how to add a scan.
 * @param {string} barcode
 */
export function announceScan(barcode) {
	window.dispatchEvent(
		new CustomEvent(BARCODE_SCANNED_EVENT, { detail: { barcode } }),
	)
}
