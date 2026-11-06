<template>
	<template v-for="(part, index) in splitMatches(text, query)" :key="index">
		<mark v-if="part.match" :class="markClass">{{ part.text }}</mark>
		<template v-else>{{ part.text }}</template>
	</template>
</template>

<script setup>
import { splitMatches } from "@/utils/highlight"

defineProps({
	text: { type: String, default: "" },
	query: { type: String, default: "" },
	markClass: { type: String, default: "" },
})
</script>
