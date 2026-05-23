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
     * Load order type options for the given POS Profile.
     */
    async function loadOrderTypes(posProfile) {
        if (!posProfile) return false

        if (
            isLoaded.value &&
            loadedForProfile.value === posProfile &&
            orderTypeOptions.value.length > 0
        ) {
            return true
        }

        if (fetchPromise) return fetchPromise

        if (isOffline()) {
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

                // Safely handle payload
                let rows = response?.message || response || []
                if (!Array.isArray(rows)) rows = []

                orderTypeOptions.value = rows
                    .filter((r) => r?.value && r.label)
                    .map((r) => ({
                        label: String(r.label),
                        value: String(r.value),
                        default: Number(r.default || 0),
                        has_tables: Number(r.has_tables || 0),
                    }))

                // IMPORTANT: If the API explicitly marks a default, 
                // we FORCE it here. This overrides legacy fallbacks from the parent component.
                const explicitDefault = orderTypeOptions.value.find((o) => o.default)
                if (explicitDefault) {
                    selectedOrderType.value = explicitDefault.value
                }

                loadedForProfile.value = posProfile
                isLoaded.value = true


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

        // Computed
        hasOrderTypes,
    }
})