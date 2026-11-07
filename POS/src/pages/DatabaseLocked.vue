<template>
	<div
		:dir="direction"
		class="min-h-screen flex flex-col items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8"
	>
		<div class="max-w-md w-full bg-white py-8 px-6 shadow rounded-lg space-y-4">
			<h1 class="text-xl font-bold text-gray-900">{{ text.title }}</h1>
			<p class="text-sm text-gray-700">{{ text.explanation }}</p>
			<p class="text-sm font-medium text-red-700">{{ text.warning }}</p>
			<p class="text-sm text-gray-700">{{ text.support }}</p>
			<p class="font-mono text-sm text-gray-900" dir="ltr">{{ reason }}</p>
			<button
				type="button"
				class="w-full py-2 px-4 rounded-md shadow-sm text-sm font-medium text-white bg-blue-600 hover:bg-blue-700"
				@click="tryAgain"
			>
				{{ text.retry }}
			</button>
		</div>
	</div>
</template>

<script setup>
import { computed } from "vue"
import { lockedPageText } from "@/platform/lockedPageText"
import { getTextDirection } from "@/utils/textDirection"
import { translationVersion } from "@/utils/translation"

defineProps({
	reason: { type: String, required: true },
})

const text = computed(() => {
	void translationVersion.value
	return lockedPageText()
})
const direction = computed(() => getTextDirection(text.value.title))

// The Keystore or the Windows profile may simply not have been ready
function tryAgain() {
	window.location.reload()
}
</script>
