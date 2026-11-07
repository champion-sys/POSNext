/**
 * Keeps the device's copy of server data current by pulling only what changed.
 *
 * Knows nothing about the platform: the server and the local store are passed in, so
 * the web, Electron and Android share this logic.
 *
 * @module core/sync/pullEngine
 */

/**
 * A stale tax or payment method is worse than a stale catalog row, so those come first.
 * Prices come before items: a device's first price pull only records where to start,
 * and the item rows read after it already carry every price from that point on.
 * Stock comes after items, because a row of an item the device has not stored yet is dropped.
 */
export const PULL_ENTITIES = [
	"pos_profile",
	"taxes",
	"payment_methods",
	"item_prices",
	"items",
	"stock",
	"customers",
	"offers",
]

/** What moves between two full pulls on a device with no socket */
export const STOCK_ENTITIES = ["stock"]

export const PAGE_SIZE = 500

/** @param {string} entity @returns {string} Settings key of the entity's saved state */
export const pullStateKey = (entity) => `pull_state:${entity}`

/**
 * @param {Object|null} state - Saved state of the items entity
 * @param {string} posProfile
 * @returns {boolean} Whether a walk of this profile's catalog has finished
 */
export const isCatalogWalked = (state, posProfile) =>
	Boolean(state?.version) && state.posProfile === posProfile

async function pullEntity(entity, version, scope, { server, store, posProfile, pageSize }) {
	const result = { status: "unchanged", pages: 0, rows: 0, deleted: 0 }

	const state = await store.getState(entity)
	const sameScope = state?.scope === scope
	if (sameScope && state.version === version) return result

	result.status = "updated"
	let cursor = sameScope ? state.cursor : null

	while (true) {
		const page = await server.pull({ entity, posProfile, cursor, limit: pageSize })
		await store.applyPage(entity, page)

		// The version stays empty until the walk ends, so one cut short resumes instead of looking done
		await store.saveState(entity, {
			posProfile,
			scope,
			cursor: page.next_cursor,
			version: page.has_more ? null : version,
		})

		result.pages += 1
		result.rows += page.rows.length
		result.deleted += page.deleted.length

		if (!page.has_more) return result
		if (page.next_cursor === cursor) {
			throw new Error(`Pull of ${entity} stopped advancing`)
		}
		cursor = page.next_cursor
	}
}

/**
 * Compare the server's manifest with the device and pull every entity that moved.
 * One entity failing leaves the others to finish, and it resumes on the next run.
 *
 * @param {Object} options
 * @param {{getManifest: Function, pull: Function}} options.server
 * @param {{getState: Function, saveState: Function, applyPage: Function}} options.store
 * @param {string} options.posProfile
 * @param {string[]} [options.entities]
 * @param {number} [options.pageSize]
 * @returns {Promise<Object>} A result per entity
 */
export async function runPull({
	server,
	store,
	posProfile,
	entities = PULL_ENTITIES,
	pageSize = PAGE_SIZE,
}) {
	const manifest = await server.getManifest(posProfile, entities)
	const results = {}

	for (const entity of entities) {
		if (manifest[entity] === undefined) continue

		try {
			results[entity] = await pullEntity(entity, manifest[entity], manifest.scopes?.[entity] ?? null, {
				server,
				store,
				posProfile,
				pageSize,
			})
		} catch (error) {
			results[entity] = { status: "failed", error }
		}
	}

	return results
}
