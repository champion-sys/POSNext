<template>
	<div class="rounded-md bg-red-50 p-4">
		<div class="flex">
			<div class="flex-shrink-0">
				<FeatherIcon name="x-circle" class="h-5 w-5 text-red-400" />
			</div>
			<div class="ms-3">
				<h3 class="text-sm font-medium text-red-800">{{ title }}</h3>
				<div class="mt-2 text-sm text-red-700">
					<p>{{ message }}</p>
				</div>
			</div>
		</div>
	</div>
</template>

<script setup>
import { FeatherIcon } from "frappe-ui"

defineProps({
	title: { type: String, required: true },
	message: { type: String, required: true },
})
</script>
