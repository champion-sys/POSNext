<template>
    <div
        v-if="normalizedOptions.length"
        class="flex items-center justify-between gap-3 bg-white border border-gray-200/70 rounded-xl p-1 shadow-sm"
        role="group"
        :aria-label="label"
    >
        <p class="text-[11px] font-semibold text-gray-600  select-none pl-2 pr-1 whitespace-nowrap">
            {{ __(label) }}
        </p>

        <div class="flex items-stretch bg-gray-100/80 rounded-xl p-0.5 flex-shrink-0 shadow-inner">
            <button
                v-for="opt in normalizedOptions"
                :key="opt.value"
                type="button"
                class="flex-1 min-w-[68px] px-3.5 py-1.5 text-[11px] font-semibold rounded-[10px] transition-all duration-150 active:scale-[0.97] touch-manipulation"
                :class="
                    opt.value === modelValue
                        ? 'bg-blue-600 text-white shadow-sm'
                        : 'text-gray-600 hover:text-gray-800 hover:bg-white/70'
                "
                :aria-pressed="opt.value === modelValue"
                @click="selectOption(opt.value)"
            >
                {{ __(opt.label) }}
            </button>
        </div>
    </div>
</template>

<script setup>
import { computed, watch } from "vue"
import { usePOSOrderTypesStore } from "@/stores/posOrderTypes"

const props = defineProps({
    modelValue: {
        type: String,
        default: null,
    },
    options: {
        type: Array,
        default: () => [
            { label: "Dine In", value: "Dine In" },
            { label: "Takeaway", value: "Takeaway" },
        ],
    },
    label: {
        type: String,
        default: "Order Type",
    },
    posProfile: {
        type: String,
        default: null,
    },
})

const emit = defineEmits(["update:modelValue"])
const orderTypesStore = usePOSOrderTypesStore()

// Update both v-model and the store when an option is clicked manually
const selectOption = (value) => {
    orderTypesStore.setSelectedOrderType(value)
    emit("update:modelValue", value)
}

// Fetch order types when posProfile is available (forces refetch on reload)
let isInitialMount = true
watch(
    () => props.posProfile,
    (profile) => {
        if (profile) {
            orderTypesStore.loadOrderTypes(profile, isInitialMount)
            isInitialMount = false
        }
    },
    { immediate: true },
)

// Sync Parent -> Store (handles initial fallback props or external resets)
watch(
    () => props.modelValue,
    (newVal) => {
        // FIX: Removed .value (Pinia auto-unwraps refs)
        if (newVal && newVal !== orderTypesStore.selectedOrderType) {
            orderTypesStore.setSelectedOrderType(newVal)
        }
    },
    { immediate: true }
)

// Sync Store -> Parent (forces update when API finishes fetching the true default)
watch(
    // FIX: Must use a getter function () => ... to watch a primitive value in Pinia
    () => orderTypesStore.selectedOrderType,
    (storeSel) => {
        if (storeSel && storeSel !== props.modelValue) {
            emit("update:modelValue", storeSel)
        }
    }
)

const normalizedOptions = computed(() => {
    // FIX: Removed .value (Pinia auto-unwraps refs)
    const storeOpts = orderTypesStore.orderTypeOptions
    const source =
        Array.isArray(storeOpts) && storeOpts.length > 0
            ? storeOpts
            : props.options || []
            
    return source
        .filter((o) => o && (o.value || o.value === "") && o.label)
        .map((o) => ({
            label: String(o.label),
            value: String(o.value),
            default: Number(o.default || 0),
            has_tables: Boolean(o.has_tables || 0),
        }))
})
</script>