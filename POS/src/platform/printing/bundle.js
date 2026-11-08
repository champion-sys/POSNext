/**
 * The print bundle: a profile's templates, its company and its default template. It comes
 * with bootstrap and from get_print_bundle, and the device keeps the last copy of each
 * profile's in its settings, the same on the web, the desktop and Android, so receipts
 * print with no connection.
 *
 * @module platform/printing/bundle
 */

import { call } from "@/utils/apiWrapper"
import { getSetting, setSetting } from "@/utils/offline/settings"
import { logger } from "@/utils/logger"

const log = logger.create("PrintBundle")

/** Asked of the server at most this often */
export const REFRESH_INTERVAL_MS = 5 * 60 * 1000

/** A printer that chose this prints the built-in layouts even when the profile has a template */
export const BUILTIN_LAYOUT = "__builtin__"

/** The template of the device's own printing: the desktop printer, QZ Tray or the browser */
const DEVICE_TEMPLATE_KEY = "pos_next_print_template"

const settingKey = (profile) => `print_bundle:${profile}`

/** profile -> {bundle, fetchedAt} */
const kept = new Map()
const refreshing = new Map()

/**
 * Keep a bundle on the device.
 * @param {Object} bundle - With pos_profile.name
 * @param {string} [profile] - When the bundle does not name its profile
 */
export async function savePrintBundle(bundle, profile = bundle?.pos_profile?.name) {
	if (!bundle || !profile || !Array.isArray(bundle.templates)) return
	const entry = { bundle, fetchedAt: Date.now() }
	kept.set(profile, entry)
	try {
		await setSetting(settingKey(profile), entry)
	} catch (error) {
		log.warn("Could not keep the print bundle:", error)
	}
}

/**
 * @param {string} profile
 * @returns {Promise<{bundle: Object, fetchedAt: number}|null>}
 */
async function readEntry(profile) {
	if (!profile) return null
	if (kept.has(profile)) return kept.get(profile)
	try {
		const entry = await getSetting(settingKey(profile), null)
		if (entry?.bundle) {
			kept.set(profile, entry)
			return entry
		}
	} catch (error) {
		log.warn("Could not read the kept print bundle:", error)
	}
	return null
}

const isOnline = () => typeof navigator === "undefined" || navigator.onLine !== false

/**
 * Ask the server for the bundle when the kept one is older than the interval. Offline,
 * or when the server fails, the kept copy stays.
 * @param {string} profile
 * @param {{force?: boolean}} [options]
 * @returns {Promise<Object|null>} The bundle now kept
 */
export async function refreshPrintBundle(profile, { force = false } = {}) {
	if (!profile) return null
	const entry = await readEntry(profile)
	const fresh = entry && Date.now() - entry.fetchedAt < REFRESH_INTERVAL_MS
	if ((fresh && !force) || !isOnline()) return entry?.bundle || null
	if (refreshing.has(profile)) return refreshing.get(profile)

	const request = call("pos_next.api.print_templates.get_print_bundle", { pos_profile: profile })
		.then(async (bundle) => {
			await savePrintBundle(bundle, profile)
			return kept.get(profile)?.bundle || entry?.bundle || null
		})
		.catch((error) => {
			log.warn("Print bundle not refreshed, keeping the last copy:", error?.message || error)
			return entry?.bundle || null
		})
		.finally(() => refreshing.delete(profile))
	refreshing.set(profile, request)
	return request
}

/**
 * The bundle to print with now. The kept copy is used at once and refreshed behind;
 * only a device that has none yet waits for the server.
 * @param {string} profile
 * @returns {Promise<Object|null>}
 */
export async function getPrintBundle(profile) {
	const entry = await readEntry(profile)
	if (!entry) return refreshPrintBundle(profile)
	refreshPrintBundle(profile).catch(() => {})
	return entry.bundle
}

/**
 * Which template prints: the printer's own, then the profile's default, then none, which
 * means the built-in layouts print as before.
 * @param {Object|null} bundle
 * @param {string} [printerTemplate] - The printer's choice; BUILTIN_LAYOUT opts out
 * @returns {Object|null} The template
 */
export function chooseTemplate(bundle, printerTemplate = "") {
	const templates = bundle?.templates
	if (!Array.isArray(templates) || templates.length === 0) return null
	if (printerTemplate === BUILTIN_LAYOUT) return null
	const find = (name) => (name ? templates.find((template) => template.name === name) : null)
	return find(printerTemplate) || find(bundle.default_template) || null
}

/** @returns {string} The template the device's own printing uses, or empty for the profile's */
export function getDevicePrintTemplate() {
	try {
		return localStorage.getItem(DEVICE_TEMPLATE_KEY) || ""
	} catch {
		return ""
	}
}

/** @param {string} name - A template, BUILTIN_LAYOUT, or empty for the profile's default */
export function saveDevicePrintTemplate(name) {
	try {
		if (name) localStorage.setItem(DEVICE_TEMPLATE_KEY, name)
		else localStorage.removeItem(DEVICE_TEMPLATE_KEY)
	} catch {}
}

/** For tests: forget what was read */
export function forgetKeptBundles() {
	kept.clear()
	refreshing.clear()
}
