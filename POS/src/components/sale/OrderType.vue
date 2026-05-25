<template>
    <div
        v-if="normalizedOptions.length"
        class="flex flex-col sm:flex-row sm:items-center justify-between gap-1.5 bg-white border border-black rounded-none p-0 shadow-none w-full"
        role="group"
        :aria-label="label"
    >
        <!-- <p class="text-[10px] font-bold text-gray-500 uppercase tracking-wider select-none px-2 py-1 sm:py-0 whitespace-nowrap shrink-0">
            {{ __(label) }}
        </p> -->

        <div class="flex items-stretch bg-gray-0 rounded-none p-0.5 w-full sm:w-auto min-w-0 overflow-x-auto snap-x snap-mandatory [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
            <button
                v-for="opt in normalizedOptions"
                :key="opt.value"
                type="button"
                class="flex-1 shrink-0 min-w-fit whitespace-nowrap px-3.5 py-2.5 text-xs font-extrabold uppercase tracking-wider rounded-none transition-all duration-75 touch-manipulation snap-center flex items-center justify-center gap-1.5"
                :class="
                    opt.value === modelValue
                        ? 'bg-black text-white font-bold'
                        : 'text-gray-900 bg-white hover:bg-gray-100 border border-transparent'
                "
                :aria-pressed="opt.value === modelValue"
                @click="selectOption(opt.value)"
            >
                <!-- Dynamic SVG Icons based on Order Type -->
                <span class="flex-shrink-0" :class="opt.value === modelValue ? 'text-white' : 'text-gray-700 group-hover:text-gray-600'">
                    <!-- Dine In / In Store -->
                    <svg v-if="getIconType(opt.value) === 'dine-in'" class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2" />
                        <path d="M7 2v20" />
                        <path d="M21 15V2v0a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7" />
                    </svg>
                    
                    <!-- Takeaway / Pickup -->
                    <svg v-else-if="getIconType(opt.value) === 'takeaway'" class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M6 2L3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4z" />
                        <line x1="3" y1="6" x2="21" y2="6" />
                        <path d="M16 10a4 4 0 0 1-8 0" />
                    </svg>

                    <svg v-else-if="getIconType(opt.value) === 'vip'" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" class="icon icon-tabler icons-tabler-outline icon-tabler-crown"><path stroke="none" d="M0 0h24v24H0z" fill="none" /><path d="M12 6l4 6l5 -4l-2 10h-14l-2 -10l5 4l4 -6" /></svg>
                    
                    <!-- Delivery -->
                    <svg v-else-if="getIconType(opt.value) === 'delivery'" class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <rect x="1" y="3" width="15" height="13" rx="2" ry="2" />
                        <polygon points="16 8 20 8 23 11 23 16 16 16 16 8" />
                        <circle cx="5.5" cy="18.5" r="2" />
                        <circle cx="18.5" cy="18.5" r="2" />
                    </svg>
                    
                    <!-- Room Service / Hospitality -->
                    <svg v-else-if="getIconType(opt.value) === 'room-service'" class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M2 17h20" />
                        <path d="M6 17a6 6 0 0 1 12 0" />
                        <path d="M12 11V8" />
                        <path d="M10 8h4" />
                    </svg>
                    
                    <svg v-else class="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2" />
                        <path d="M7 2v20" />
                        <path d="M21 15V2v0a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7" />
                    </svg>
                </span>
                
                <span>{{ __(opt.label) }}</span>
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

// Helper to determine the icon type based on order type option value
const getIconType = (value) => {
	const val = String(value || "").toLowerCase()
	if (val.includes("dine") || val.includes("table") || val.includes("in")) {
		return "dine-in"
	} else if (
		val.includes("take") ||
		val.includes("pick") ||
		val.includes("bag") ||
		val.includes("out")
	) {
		return "takeaway"
	} else if (
		val.includes("deliv") ||
		val.includes("ship") ||
		val.includes("truck") ||
		val.includes("bike")
	) {
		return "delivery"
	} else if (
		val.includes("room") ||
		val.includes("tray") ||
		val.includes("service")
	) {
		return "room-service"
	}
	return "default"
}

// Update both v-model and the store when an option is clicked manually
const selectOption = (value) => {
	orderTypesStore.setSelectedOrderType(value)
	emit("update:modelValue", value)
}

// Fetch order types when posProfile is available.
watch(
	() => props.posProfile,
	(profile) => {
		if (profile) {
			orderTypesStore.loadOrderTypes(profile)
		}
	},
	{ immediate: true },
)

const selectedOrderTypeValue = computed(
	() => orderTypesStore.selectedOrderType ?? null,
)
const orderTypeOptions = computed(() => orderTypesStore.orderTypeOptions ?? [])

// Sync Parent -> Store
watch(
	() => props.modelValue,
	(newVal) => {
		if (newVal && newVal !== selectedOrderTypeValue.value) {
			orderTypesStore.setSelectedOrderType(newVal)
		}
	},
	{ immediate: true },
)

// Sync Store -> Parent (push explicit default from profile)
watch(selectedOrderTypeValue, (storeSel) => {
	if (storeSel && storeSel !== props.modelValue) {
		emit("update:modelValue", storeSel)
	}
})

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