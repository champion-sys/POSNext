import { ref, watch, nextTick, onUnmounted } from "vue"
import { QueuedMutex } from "@/utils/mutex"

// ---- localStorage persistence ----
// Scanner/auto-add are device traits, not account settings: one till has a
// barcode gun wired up, the next one doesn't. Keep them local like the QZ
// printer name rather than in the POS Settings DocType.

const SCANNER_ENABLED_KEY = "pos_scanner_enabled"
const AUTO_ADD_ENABLED_KEY = "pos_auto_add_enabled"

function _loadFlag(key) {
	try {
		return localStorage.getItem(key) === "1"
	} catch {
		return false
	}
}

function _saveFlag(key, value) {
	try {
		if (value) {
			localStorage.setItem(key, "1")
		} else {
			localStorage.removeItem(key)
		}
	} catch {
		// localStorage unavailable
	}
}

/**
 * Composable for search input, barcode scanning, and auto-add logic.
 *
 * Owns all search-input state, timers, and event handlers with proper
 * concurrency control.  Extracted from ItemsSelector.vue.
 *
 * Persistence:
 *   - `scannerEnabled` / `autoAddEnabled` are restored from localStorage on
 *     creation and written back whenever they change, so a reload doesn't
 *     silently drop the cashier back into manual mode.
 *
 * Concurrency model:
 *   - On Enter (or auto-add timeout), the barcode is **snapshotted** from the
 *     DOM input immediately, then the input is cleared so the next scan starts
 *     into a clean field.
 *   - The snapshot is pushed into a {@link QueuedMutex}-backed queue
 *     (`processBarcodeScan`), which processes barcode lookups sequentially.
 *   - This guarantees no barcode is ever lost, even when scanning different
 *     items faster than the API can respond (~50 ms between scans).
 *
 * @param {Object} options
 * @param {Object} options.itemStore          - Pinia item-search store
 * @param {(item: Object, autoAdd: boolean) => boolean} options.onItemFound
 *        Component's selectItem(). Returns true if item was accepted.
 * @param {Object} options.showWarning        - useToast().showWarning
 * @param {import('vue').Ref<boolean>} options.isAnyDialogOpen
 */
export function useSearchInput({ itemStore, onItemFound, showWarning, isAnyDialogOpen }) {
	// --- Reactive state (exposed) ---
	const searchInputRef = ref(null)
	const scannerEnabled = ref(_loadFlag(SCANNER_ENABLED_KEY))
	const autoAddEnabled = ref(_loadFlag(AUTO_ADD_ENABLED_KEY))

	// Restored state must satisfy the toggles' invariant: auto-add implies the
	// scanner is on. Guards against a partial/hand-edited localStorage pair.
	if (autoAddEnabled.value) {
		scannerEnabled.value = true
	}

	// --- Internal (non-reactive) ---
	let autoSearchTimer = null
	const barcodeQueue = new QueuedMutex({ timeout: 10000, name: "BarcodeSearch" })

	// ---- Timer helpers ----

	function clearAutoSearchTimer() {
		if (autoSearchTimer) {
			clearTimeout(autoSearchTimer)
			autoSearchTimer = null
		}
	}

	// ---- Focus ----

	function focusSearchInput() {
		nextTick(() => {
			if (searchInputRef.value) {
				searchInputRef.value.focus()
				searchInputRef.value.select()
			}
		})
	}

	// ---- Clear ----

	/** Atomic clear: timer -> store -> DOM input.value -> refocus */
	function clearSearchAndResetInput() {
		clearAutoSearchTimer()
		itemStore.clearSearch()
		if (searchInputRef.value) {
			searchInputRef.value.value = ""
		}
		if (scannerEnabled.value || autoAddEnabled.value) {
			focusSearchInput()
		}
	}

	// ---- Event handlers ----

	function handleKeyDown(event) {
		if (event.key === "Enter") {
			if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
			event.preventDefault()
			clearAutoSearchTimer()

			// Snapshot the barcode NOW from the DOM input, before anything overwrites it
			const barcode = searchInputRef.value?.value?.trim() || itemStore.searchTerm?.trim()
			if (barcode) {
				// Clear input immediately so next scan starts clean
				itemStore.clearSearch()
				if (searchInputRef.value) searchInputRef.value.value = ""

				// Queue the search with the captured barcode
				processBarcodeScan(barcode, autoAddEnabled.value)
			}
			return
		}
		// All other keys: no special handling needed.
		// Dead scanner-speed-detection code removed.
	}

	/**
	 * Handles the `input` event on the search <input>.
	 *
	 * Two independent timers exist by design:
	 *   1. itemStore.setSearchTerm() triggers the store's own debounce for
	 *      updating the displayed item grid.
	 *   2. autoSearchTimer (500 ms) triggers auto-add behaviour — completely
	 *      separate from display.
	 */
	function handleSearchInput(event) {
		const value = event.target.value

		// Guard: ignore stale empty events after search was already cleared
		if (!value && !itemStore.searchTerm) {
			return
		}

		itemStore.setSearchTerm(value)

		clearAutoSearchTimer()

		// Auto-add: after user stops typing for 500 ms, trigger barcode search
		if (autoAddEnabled.value && value.trim().length > 0) {
			autoSearchTimer = setTimeout(() => {
				const barcode = searchInputRef.value?.value?.trim() || itemStore.searchTerm?.trim()
				if (barcode) {
					itemStore.clearSearch()
					if (searchInputRef.value) searchInputRef.value.value = ""
					processBarcodeScan(barcode, true)
				}
			}, 500)
		}
	}

	/** Clicking the search input clears search + timer atomically. */
	function handleSearchClick() {
		clearSearchAndResetInput()
	}

	/**
	 * Queue a barcode scan for sequential processing.
	 *
	 * The barcode string is already captured (snapshotted) by the caller —
	 * it is never read from shared state here. The {@link QueuedMutex}
	 * ensures scans execute one at a time so every scan is resolved before
	 * the next begins, preventing double-adds and lost barcodes.
	 *
	 * Lookup: exact barcode match via `itemStore.searchByBarcode()`.
	 * If the barcode is not found, shows a "not found" warning.
	 *
	 * @param {string}  barcode      - Pre-captured barcode value
	 * @param {boolean} forceAutoAdd - When true, item is added without user click
	 */
	function processBarcodeScan(barcode, forceAutoAdd) {
		const shouldAutoAdd = forceAutoAdd || (scannerEnabled.value && autoAddEnabled.value)

		barcodeQueue.withLock(async () => {
			try {
				const item = await itemStore.searchByBarcode(barcode)
				if (item) {
					onItemFound(item, shouldAutoAdd)
					focusSearchInput()
					return
				}
			} catch (error) {
				console.error("Barcode API error:", error)
			}

			// Barcode not found — show clear "not found" message.
			// Note: we cannot fall back to filteredItems here because
			// clearSearch() was called before the API request, so
			// filteredItems would contain ALL cached items (not search results).
			showWarning(__('Item Not Found: No item found with barcode: {0}', [barcode]))
			focusSearchInput()
		})
	}

	// ---- Toggles ----

	function toggleBarcodeScanner() {
		scannerEnabled.value = !scannerEnabled.value

		if (scannerEnabled.value) {
			autoAddEnabled.value = true
			focusSearchInput()
		} else {
			autoAddEnabled.value = false
		}
	}

	function toggleAutoAdd() {
		autoAddEnabled.value = !autoAddEnabled.value

		if (autoAddEnabled.value && !scannerEnabled.value) {
			scannerEnabled.value = true
		}

		if (!autoAddEnabled.value) {
			clearAutoSearchTimer()
		}

		if (autoAddEnabled.value) {
			focusSearchInput()
		}
	}

	// ---- Persistence watcher ----
	// Both toggles mutate the two refs together; a combined watcher persists
	// the pair once per tick instead of firing twice.
	const stopPersistWatcher = watch(
		[scannerEnabled, autoAddEnabled],
		([scanner, autoAdd]) => {
			_saveFlag(SCANNER_ENABLED_KEY, scanner)
			_saveFlag(AUTO_ADD_ENABLED_KEY, autoAdd)
		},
	)

	// ---- Dialog-close watcher ----
	// Refocuses the search bar when all dialogs close (scanner/auto-add modes)
	const stopDialogWatcher = watch(isAnyDialogOpen, (isOpen, wasOpen) => {
		if (wasOpen && !isOpen && (scannerEnabled.value || autoAddEnabled.value)) {
			focusSearchInput()
		}
	})

	// ---- Cleanup ----
	function cleanup() {
		clearAutoSearchTimer()
		stopPersistWatcher()
		stopDialogWatcher()
	}

	onUnmounted(cleanup)

	return {
		// State
		searchInputRef,
		scannerEnabled,
		autoAddEnabled,

		// Event handlers
		handleSearchInput,
		handleKeyDown,
		handleSearchClick,

		// Toggles
		toggleBarcodeScanner,
		toggleAutoAdd,

		// Utilities
		focusSearchInput,
		clearSearchAndResetInput,
		cleanup,
	}
}
