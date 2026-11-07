<template>
	<div role="group" :aria-label="__('Cart view')" class="flex items-center border border-black bg-white flex-shrink-0">
		<button
			v-for="option in options"
			:key="option.view"
			type="button"
			class="w-11 h-11 flex items-center justify-center transition-colors touch-manipulation"
			:class="option.view === active ? 'bg-black text-white' : 'text-gray-800 hover:bg-gray-100 active:bg-gray-200'"
			:aria-pressed="option.view === active"
			:aria-label="option.label"
			:title="option.label"
			@click="$emit('select', option.view)"
		>
			<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" :d="option.icon" />
			</svg>
		</button>
	</div>
</template>

<script setup>
import { CART_VIEW_CARDS, CART_VIEW_COMPACT, CART_VIEW_TABLE } from "@/composables/useCartView"
import { computed } from "vue"

const props = defineProps({
	active: {
		type: String,
		required: true,
	},
	tableAvailable: {
		type: Boolean,
		default: true,
	},
})

defineEmits(["select"])

const options = computed(() => [
	{
		view: CART_VIEW_CARDS,
		label: __("Cards"),
		icon: "M4 5h16a1 1 0 011 1v4a1 1 0 01-1 1H4a1 1 0 01-1-1V6a1 1 0 011-1zm0 8h16a1 1 0 011 1v4a1 1 0 01-1 1H4a1 1 0 01-1-1v-4a1 1 0 011-1z",
	},
	{
		view: CART_VIEW_COMPACT,
		label: __("Compact"),
		icon: "M4 6h16M4 10h16M4 14h16M4 18h16",
	},
	{
		view: CART_VIEW_TABLE,
		label: props.tableAvailable ? __("Table") : __("Table needs a wider cart"),
		icon: "M3 6a1 1 0 011-1h16a1 1 0 011 1v12a1 1 0 01-1 1H4a1 1 0 01-1-1V6zm0 4h18M3 15h18M9 5v14M15 5v14",
	},
])
</script>
