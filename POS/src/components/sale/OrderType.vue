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
import { computed } from "vue"

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
})

const emit = defineEmits(["update:modelValue"])

const normalizedOptions = computed(() =>
	(props.options || [])
		.filter((o) => o && (o.value || o.value === "") && o.label)
		.map((o) => ({ label: String(o.label), value: String(o.value) })),
)
</script>
