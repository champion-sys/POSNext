<template>
    <div
        class="flex items-center justify-between gap-2 bg-white border border-gray-200 rounded-xl p-1.5 shadow-sm"
        role="group"
        :aria-label="label"
		v-if="normalizedOptions.length"
    >
        <p class="text-[11px] font-semibold text-gray-600 select-none px-1.5">
            {{ __(label) }}
        </p>

        <div class="flex items-center bg-gray-100 rounded-lg p-0.5 flex-shrink-0">
            <button
                v-for="opt in normalizedOptions"
                :key="opt.value"
                type="button"
                class="px-2.5 py-1.5 text-[11px] font-semibold rounded-md transition-all duration-200 touch-manipulation"
                :class="
                    opt.value === modelValue
                        ? 'bg-white text-blue-600 shadow-sm'
                        : 'text-gray-500 hover:text-gray-700'
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

// Fetch order types when posProfile is available
watch(
    () => props.posProfile,
    (profile) => {
        if (profile) orderTypesStore.loadOrderTypes(profile)
    },
    { immediate: true },
)

// Sync Parent -> Store (handles initial fallback props or external resets)
watch(
    () => props.modelValue,
    (newVal) => {
        if (newVal && newVal !== orderTypesStore.selectedOrderType) {
            orderTypesStore.setSelectedOrderType(newVal)
        }
    },
    { immediate: true }
)

// Sync Store -> Parent (forces update when API finishes fetching the true default)
watch(
    () => orderTypesStore.selectedOrderType,
    (storeSel) => {
        if (storeSel && storeSel !== props.modelValue) {
            emit("update:modelValue", storeSel)
        }
    }
)

const normalizedOptions = computed(() => {
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