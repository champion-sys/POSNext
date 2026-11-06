/**
 * Runs the pull engine on the web: requests through the app's API wrapper, storage
 * through the offline worker, and the stores already on screen refreshed afterwards.
 *
 * @module core/sync/webPull
 */

import { useCustomerSearchStore } from "@/stores/customerSearch"
import { useItemSearchStore } from "@/stores/itemSearch"
import { usePOSCartStore } from "@/stores/posCart"
import { usePOSOffersStore } from "@/stores/posOffers"
import { usePOSSettingsStore } from "@/stores/posSettings"
import { call } from "@/utils/apiWrapper"
import { logger } from "@/utils/logger"
import { getSetting, setSetting } from "@/utils/offline/settings"
import { offlineWorker } from "@/utils/offline/workerClient"
import { PULL_ENTITIES, pullStateKey, runPull } from "./pullEngine"

const log = logger.create("PullSync")

const CATALOG_ENTITIES = ["items", "item_prices"]

const server = {
	getManifest: (posProfile) =>
		call("pos_next.api.sync_pull.get_manifest", { pos_profile: posProfile }),
	pull: ({ entity, posProfile, cursor, limit }) =>
		call("pos_next.api.sync_pull.pull", { entity, pos_profile: posProfile, cursor, limit }),
}

const createStore = (posProfile) => ({
	getState: (entity) => getSetting(pullStateKey(entity), null),
	saveState: (entity, state) => setSetting(pullStateKey(entity), state),
	async applyPage(entity, page) {
		await offlineWorker.applyPullPage(entity, page, posProfile)
		if (entity === "items" || entity === "item_prices") {
			useItemSearchStore().applyPulledItems(page.rows, page.deleted)
		}
	},
})

/** Whole sets and customers are read back once, after every page has been stored. */
async function refreshStores(results, posProfile) {
	const changed = (entity) => results[entity]?.pages > 0

	if (changed("customers")) {
		await useCustomerSearchStore().reloadFromCache()
	}
	if (changed("offers")) {
		usePOSOffersStore().setAvailableOffers(await offlineWorker.getCachedOffers(posProfile))
	}

	const settingsStore = usePOSSettingsStore()
	if (changed("pos_profile")) {
		await useItemSearchStore().reloadProfileFromCache(posProfile)
		await settingsStore.reloadSettings()
	}
	// Whether prices include tax is a POS Settings value, so a profile change can move totals too
	if (changed("taxes") || changed("pos_profile")) {
		await usePOSCartStore().loadTaxRules(posProfile, settingsStore.settings)
	}
}

let isPulling = false

/**
 * Pull what changed for a POS Profile. Cheap when nothing did, so any trigger can call it.
 * Web Locks keep it to one tab, because all tabs share the same local tables.
 *
 * @param {string} posProfile
 * @returns {Promise<Object|null>} A result per entity, or null when nothing ran
 */
export async function pullChanges(posProfile) {
	if (!posProfile || isPulling) return null

	// The background sync is downloading every item, so walking them too would be waste
	const entities = useItemSearchStore().cacheSyncing
		? PULL_ENTITIES.filter((entity) => !CATALOG_ENTITIES.includes(entity))
		: PULL_ENTITIES

	const run = async () => {
		const results = await runPull({ server, store: createStore(posProfile), posProfile, entities })

		for (const [entity, result] of Object.entries(results)) {
			if (result.status === "failed") {
				log.warn(`Pull of ${entity} failed, it resumes on the next run`, result.error)
			}
		}

		await refreshStores(results, posProfile)
		return results
	}

	isPulling = true
	try {
		if (!navigator.locks) return await run()
		return await navigator.locks.request("pos_next_pull", { ifAvailable: true }, (lock) =>
			lock ? run() : null,
		)
	} finally {
		isPulling = false
	}
}
