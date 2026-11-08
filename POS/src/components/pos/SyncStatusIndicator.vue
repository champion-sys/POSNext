<template>
	<button
		type="button"
		class="h-full min-w-pos-bar px-2 sm:px-2.5 flex items-center gap-1.5 sm:gap-2 whitespace-nowrap rounded-none border-y-0 border-e-0 border-s border-gray-300 hover:bg-gray-150 active:bg-gray-200 transition-colors touch-manipulation"
		:title="summary"
		:aria-label="summary"
		@click="openQueue"
	>
		<span class="flex items-center gap-1 text-xs font-bold" :class="isOffline ? 'text-orange-700' : 'text-green-700'">
			<svg v-if="isSyncing" class="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24" aria-hidden="true">
				<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
				<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
			</svg>
			<svg v-else-if="isOffline" class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 5.636a9 9 0 010 12.728m0 0l-2.829-2.829m2.829 2.829L21 21M15.536 8.464a5 5 0 010 7.072m0 0l-2.829-2.829m-4.243 2.829a4.978 4.978 0 01-1.414-2.83m-1.414 5.658a9 9 0 01-2.167-9.238m7.824 2.167a1 1 0 111.414 1.414m-1.414-1.414L3 3m8.293 8.293l1.414 1.414"/>
			</svg>
			<svg v-else class="w-4 h-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
				<path d="M1 9l2 2c4.97-4.97 13.03-4.97 18 0l2-2C16.93 2.93 7.08 2.93 1 9zm8 8l3 3 3-3c-1.65-1.66-4.34-1.66-6 0zm-4-4l2 2c2.76-2.76 7.24-2.76 10 0l2-2C15.14 9.14 8.87 9.14 5 13z"/>
			</svg>
			{{ connectionText }}
		</span>

		<span v-if="reviewCount > 0" class="inline-flex items-center gap-1 h-6 px-1.5 text-xs font-bold border border-red-300 bg-red-50 text-red-700">
			<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
			</svg>
			{{ reviewText }}
		</span>
		<span v-if="queuedCount > 0" class="inline-flex items-center h-6 px-1.5 text-xs font-bold border border-orange-300 bg-orange-50 text-orange-800">
			{{ queuedText }}
		</span>
		<span v-if="allSent" class="inline-flex items-center gap-1 h-6 px-1.5 text-xs font-bold border border-green-300 bg-green-50 text-green-800">
			<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 13l4 4L19 7"/>
			</svg>
			{{ __('All sent') }}
		</span>

		<span v-if="lastSyncText" class="hidden md:inline text-xs text-gray-600">{{ lastSyncText }}</span>
	</button>
</template>

<script setup>
import { usePOSSyncStore } from "@/stores/posSync"
import { usePOSUIStore } from "@/stores/posUI"
import { formatSyncTime } from "@/utils/syncQueue"
import { storeToRefs } from "pinia"
import { computed } from "vue"

const syncStore = usePOSSyncStore()
const uiStore = usePOSUIStore()
const { isOffline, isSyncing, queuedCount, reviewCount, lastSyncedAt } = storeToRefs(syncStore)

const allSent = computed(() => queuedCount.value === 0 && reviewCount.value === 0)

const connectionText = computed(() => (isOffline.value ? __("Offline") : __("Online")))
const reviewText = computed(() => __("{0} to review", [reviewCount.value]))
const queuedText = computed(() =>
	isSyncing.value ? __("Sending {0}", [queuedCount.value]) : __("{0} waiting", [queuedCount.value]),
)

const lastSyncText = computed(() => {
	if (lastSyncedAt.value) return __("Last sync {0}", [formatSyncTime(lastSyncedAt.value)])
	// With nothing queued there was simply nothing to sync yet
	return allSent.value ? "" : __("Not synced yet")
})

const summary = computed(() =>
	[
		connectionText.value,
		reviewCount.value > 0 ? reviewText.value : "",
		queuedCount.value > 0 ? queuedText.value : "",
		allSent.value ? __("All sent") : "",
		lastSyncText.value,
	]
		.filter(Boolean)
		.join(" - "),
)

async function openQueue() {
	await syncStore.loadPendingInvoices()
	uiStore.showOfflineInvoicesDialog = true
}
</script>
