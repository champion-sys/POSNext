<template>
	<span
		class="inline-flex items-center gap-1 flex-shrink-0 px-2 py-0.5 text-xs font-bold whitespace-nowrap border rounded"
		:class="state.badge"
	>
		<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
			<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" :d="state.icon"/>
		</svg>
		{{ state.label }}
	</span>
</template>

<script setup>
defineProps({
	state: {
		type: Object,
		required: true,
	},
})
</script>
