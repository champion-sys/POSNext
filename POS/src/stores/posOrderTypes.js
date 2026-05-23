import { defineStore } from "pinia"
import { ref, computed } from "vue"
import { call } from "@/utils/apiWrapper"
import { isOffline } from "@/utils/offline"

export const usePOSOrderTypesStore = defineStore("posOrderTypes", () => {
	// State
	const orderTypeOptions = ref([])
	const isLoading = ref(false)
	const isLoaded = ref(false)
	const loadedForProfile = ref(null)
	// Dedup concurrent fetches
	let fetchPromise = null

	// Selected value (the currently chosen order type)
	const selectedOrderType = ref(null)

	function setSelectedOrderType(value) {
		selectedOrderType.value = value || null
	}

	/**
	 * If no order type is selected yet, automatically pick the one marked as
	 * default (from the POS Profile's allowed_pos_order_type "default" flag).
	 * Falls back to the first available option.
	 */
	function ensureDefaultSelected() {
		if (selectedOrderType.value) return

		const defaultOpt = orderTypeOptions.value.find((o) => o.default)
		if (defaultOpt) {
			selectedOrderType.value = defaultOpt.value
			return
		}

		if (orderTypeOptions.value.length > 0) {
			selectedOrderType.value = orderTypeOptions.value[0].value
		}
	}

	/**
	 * Called after options are loaded to auto-pick a default only if
	 * nothing has been chosen yet.
	 */
	function autoPickDefaultAfterLoad() {
		if (!selectedOrderType.value) {
			ensureDefaultSelected()
		}
	}

	/**
	 * Load order type options for the given POS Profile.
	 * Safe to call multiple times; will no-op if already loaded for this profile.
	 * Handles page reload (store starts empty) by fetching when OrderType component mounts.
	 */
	async function loadOrderTypes(posProfile) {
		if (!posProfile) {
			return false
		}

		if (
			isLoaded.value &&
			loadedForProfile.value === posProfile &&
			orderTypeOptions.value.length > 0
		) {
			return true
		}

		if (fetchPromise) {
			return fetchPromise
		}

		if (isOffline()) {
			// No network fetch possible; prevent repeated attempts
			isLoaded.value = true
			return false
		}

		isLoading.value = true

		fetchPromise = (async () => {
			try {
				const response = await call(
					"pos_next.api.pos_order_type.get_order_types",
					{ pos_profile: posProfile },
				)

				const rows = response?.message || response || []
				orderTypeOptions.value = Array.isArray(rows)
					? rows
							.filter((r) => r?.value && r.label)
							.map((r) => ({
								label: String(r.label),
								value: String(r.value),
								default: Number(r.default || 0),
								has_tables: Number(r.has_tables || 0),
							}))
					: []

				loadedForProfile.value = posProfile
				isLoaded.value = true

				// Automatically select the default (if any) from the freshly loaded data
				autoPickDefaultAfterLoad()

				return true
			} catch (error) {
				console.error("Failed to load POS order types:", error)
				orderTypeOptions.value = []
				isLoaded.value = true
				return false
			} finally {
				isLoading.value = false
				fetchPromise = null
			}
		})()

		return fetchPromise
	}

	function resetOrderTypes() {
		orderTypeOptions.value = []
		selectedOrderType.value = null
		isLoaded.value = false
		loadedForProfile.value = null
		isLoading.value = false
		fetchPromise = null
	}

	const hasOrderTypes = computed(() => orderTypeOptions.value.length > 0)

	return {
		// State
		orderTypeOptions,
		isLoading,
		isLoaded,
		loadedForProfile,
		selectedOrderType,

		// Actions
		loadOrderTypes,
		resetOrderTypes,
		setSelectedOrderType,
		ensureDefaultSelected,
		autoPickDefaultAfterLoad,

		// Computed
		hasOrderTypes,
	}
})
