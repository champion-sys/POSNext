/**
 * The Android app coming back from the background, and leaving it.
 *
 * Android gives an app no warning when it is swiped away from recent apps, so the back
 * button is the only way out that can be intercepted. The queue survives either way.
 *
 * @module platform/lifecycle
 */

import { App, Dialog } from "@/platform/capacitor"
import { logger } from "@/utils/logger"
import { ANDROID, PLATFORM } from "./runtime"

const log = logger.create("AppLifecycle")

/**
 * @param {Object} hooks
 * @param {() => Promise<void>} hooks.onResume - Runs each time the app returns to the screen
 * @param {() => Promise<number>} hooks.countQueued - Invoices not sent to the server yet
 * @param {(count: number) => Promise<boolean>} hooks.confirmLeave - Whether to leave anyway
 * @param {Object} [app] - The Capacitor App plugin
 */
export function watchAppLifecycle(
	{ onResume, countQueued, confirmLeave },
	app = App,
) {
	let isAsking = false

	app.addListener("resume", () => {
		onResume().catch((error) =>
			log.warn("Refreshing after resume failed", error),
		)
	})

	// Leaves with no regard for canGoBack: the login page and the POS redirect to each
	// other, so going back never gets anywhere
	app.addListener("backButton", async () => {
		if (isAsking) return

		isAsking = true
		try {
			const queued = await countQueued()
			if (queued === 0 || (await confirmLeave(queued))) {
				// Keeps the cart and the sync timers, unlike exitApp
				await app.minimizeApp()
			}
		} catch (error) {
			log.warn("Handling the back button failed", error)
		} finally {
			isAsking = false
		}
	})
}

async function confirmLeave(count) {
	const { value } = await Dialog.confirm({
		title: __("Invoices not sent"),
		message: __(
			"{0} invoice(s) have not reached the server. They stay on this device and sync when the app is online. Leave anyway?",
			[count],
		),
		okButtonTitle: __("Leave"),
		cancelButtonTitle: __("Stay"),
	})
	return value
}

/** Does nothing outside the Android app. Call once the app is mounted. */
export async function installAppLifecycle() {
	if (PLATFORM !== ANDROID) return

	const [{ usePOSSyncStore }, { offlineState }] = await Promise.all([
		import("@/stores/posSync"),
		import("@/utils/offline/offlineState"),
	])

	watchAppLifecycle({
		async onResume() {
			await offlineState.checkConnectivity()
			await usePOSSyncStore().autoSync()
		},
		async countQueued() {
			const syncStore = usePOSSyncStore()
			await syncStore.updatePendingCount()
			return syncStore.pendingInvoicesCount
		},
		confirmLeave,
	})
}
