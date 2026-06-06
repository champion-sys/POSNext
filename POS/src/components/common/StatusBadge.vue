<template>
	<div
		class="flex items-center gap-1.5 px-2.5 py-1 rounded-none border transition-all duration-150"
		:class="[badgeClasses, sizeClasses]"
	>
		<svg
			v-if="icon"
			class="w-3.5 h-3.5 flex-shrink-0"
			:class="iconClasses"
			:fill="iconFill"
			stroke="currentColor"
			viewBox="0 0 24 24"
		>
			<path
				:stroke-linecap="strokeLinecap"
				:stroke-linejoin="strokeLinejoin"
				:stroke-width="strokeWidth"
				:d="icon"
			/>
		</svg>
		<div v-if="label || value" :class="[textSize, 'flex items-center gap-1']">
			<span v-if="label" class="text-gray-500 font-medium">{{ label }}</span>
			<span v-if="value" class="font-bold text-gray-900">{{ value }}</span>
		</div>
		<span v-else class="font-bold text-gray-900" :class="textSize">{{ text }}</span>
	</div>
</template>

<script setup>
import { computed } from "vue"

const props = defineProps({
	variant: {
		type: String,
		default: "blue", // blue, green, orange, red, gray
		validator: (value) =>
			["blue", "green", "orange", "red", "gray"].includes(value),
	},
	icon: {
		type: String,
		default: null,
	},
	iconFill: {
		type: String,
		default: "none",
	},
	strokeLinecap: {
		type: String,
		default: "round",
	},
	strokeLinejoin: {
		type: String,
		default: "round",
	},
	strokeWidth: {
		type: String,
		default: "2",
	},
	text: {
		type: String,
		default: "",
	},
	label: {
		type: String,
		default: null,
	},
	value: {
		type: String,
		default: null,
	},
	size: {
		type: String,
		default: "sm", // xs, sm, md
		validator: (value) => ["xs", "sm", "md"].includes(value),
	},
})

const badgeClasses = computed(() => {
	const variants = {
		blue: "bg-blue-50 border-blue-600 text-blue-700",
		green: "bg-green-50 border-green-600 text-green-700",
		orange: "bg-orange-50 border-orange-600 text-orange-700",
		red: "bg-red-50 border-red-600 text-red-700",
		gray: "bg-gray-50 border-gray-400 text-gray-700",
	}
	return variants[props.variant] || variants.blue
})

const iconClasses = computed(() => {
	const variants = {
		blue: "text-blue-600",
		green: "text-green-600",
		orange: "text-orange-600",
		red: "text-red-600",
		gray: "text-gray-500",
	}
	return variants[props.variant] || variants.blue
})

const sizeClasses = computed(() => {
	const sizes = {
		xs: "px-2 py-0.5",
		sm: "px-2.5 py-1",
		md: "px-3 py-1.5",
	}
	return sizes[props.size] || sizes.sm
})

const textSize = computed(() => {
	const sizes = {
		xs: "text-[10px] sm:text-xs",
		sm: "text-xs sm:text-sm",
		md: "text-sm sm:text-base",
	}
	return sizes[props.size] || sizes.sm
})
</script>

