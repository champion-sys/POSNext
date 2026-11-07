import { computed, onMounted, onUnmounted, ref } from "vue"
import { hasLocalShift } from "@/composables/useShift"
import { offlineState } from "@/utils/offline/offlineState"

export function useOfflineStatus() {
	const isOffline = ref(offlineState.isOffline)
	let unsubscribe = null

	onMounted(() => {
		unsubscribe = offlineState.subscribe((state) => {
			isOffline.value = state.isOffline
		})
	})

	onUnmounted(() => {
		if (unsubscribe) {
			unsubscribe()
			unsubscribe = null
		}
	})

	// The server does not know a shift opened offline, so work done in it waits in the queue
	// behind that shift, even with a connection
	const mustQueue = computed(() => isOffline.value || hasLocalShift.value)

	return { isOffline, mustQueue }
}
