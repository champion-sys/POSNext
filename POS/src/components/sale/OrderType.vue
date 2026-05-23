<template>
	<div
		class="flex items-center justify-between gap-2 bg-white border border-gray-200 rounded-xl p-1.5 shadow-sm"
		role="group"
		:aria-label="label"
	>
		<p class="text-[11px] font-semibold text-gray-600 select-none px-1.5">
			{{ label }}
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
				@click="emit('update:modelValue', opt.value)"
			>
				{{ opt.label }}
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

// Fetch into shared Pinia store if page was reloaded (store empty) or profile provided.
// The loadOrderTypes() method is idempotent and handles deduping/offline.
watch(
	() => props.posProfile,
	(profile) => {
		if (profile) {
			orderTypesStore.loadOrderTypes(profile)
		}
	},
	{ immediate: true },
)

const normalizedOptions = computed(() => {
	const storeOpts = orderTypesStore.orderTypeOptions.value
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
		}))
})

// Use the shared store to manage the selected order type (especially the
// default that comes from the API after a page reload).
// When options arrive in the store, ask it to pick a default if needed,
// then sync that choice up to the v-model (parent / cartStore) if nothing
// is selected yet.
watch(
	normalizedOptions,
	() => {
		if (props.modelValue) return

		// Let the store decide (it already calls autoPick on load success)
		orderTypesStore.ensureDefaultSelected()

		const storeSelected = orderTypesStore.selectedOrderType.value
		if (storeSelected) {
			emit("update:modelValue", storeSelected)
		}
	},
	{ immediate: true },
)
</script>
