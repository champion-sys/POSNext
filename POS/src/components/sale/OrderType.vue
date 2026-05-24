<template>
    <div
        v-if="normalizedOptions.length"
        class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 sm:gap-3 bg-white border border-gray-200/70 rounded-xl p-1.5 shadow-sm w-full"
        role="group"
        :aria-label="label"
    >
        <p class="text-[11px] font-semibold text-gray-600 select-none px-1.5 sm:pl-2 sm:pr-1 whitespace-nowrap shrink-0">
            {{ __(label) }}
        </p>

        <!-- 
          Added min-w-0, overflow-x-auto, and scrollbar hiding classes.
          min-w-0 allows the flex-child to shrink and trigger the scrollbar 
          instead of pushing outside the parent boundary.
        -->
        <div class="flex items-stretch bg-gray-100 rounded-lg p-0.5 w-full sm:w-auto min-w-0 overflow-x-auto snap-x snap-mandatory [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
            <button
                v-for="opt in normalizedOptions"
                :key="opt.value"
                type="button"
                class="flex-1 shrink-0 min-w-fit whitespace-nowrap px-3.5 py-1.5 text-[11px] font-semibold rounded-[10px] transition-all duration-150 touch-manipulation snap-center"
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

// Fetch order types when posProfile is available.
// Store handles deduping and offline.
watch(
    () => props.posProfile,
    (profile) => {
        if (profile) {
            orderTypesStore.loadOrderTypes(profile)
        }
    },
    { immediate: true },
)

// Safe accessors (protects against HMR / transient store state during dev)
// FIX: Removed .value because Pinia automatically unwraps refs on the store instance
const selectedOrderTypeValue = computed(() => orderTypesStore.selectedOrderType ?? null)
const orderTypeOptions = computed(() => orderTypesStore.orderTypeOptions ?? [])

// Sync Parent -> Store
watch(
    () => props.modelValue,
    (newVal) => {
        if (newVal && newVal !== selectedOrderTypeValue.value) {
            orderTypesStore.setSelectedOrderType(newVal)
        }
    },
    { immediate: true }
)

// Sync Store -> Parent (push explicit default from profile)
watch(
    selectedOrderTypeValue,
    (storeSel) => {
        if (storeSel && storeSel !== props.modelValue) {
            emit("update:modelValue", storeSel)
        }
    }
)

const normalizedOptions = computed(() => {
    const source =
        Array.isArray(orderTypeOptions.value) && orderTypeOptions.value.length > 0
            ? orderTypeOptions.value
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