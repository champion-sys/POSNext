/**
 * How a receipt leaves each platform.
 *
 * - Web: Bluetooth printer, then QZ Tray with its default printer, then Chrome's dialog.
 * - Desktop: the printer saved in settings, or the system dialog when none is saved.
 * - Android: Bluetooth or Wi-Fi printer.
 *
 * @module platform/printing/routes
 */

import { ANDROID, ELECTRON } from "../runtime"

export const THERMAL = "thermal"
export const SILENT = "silent"
export const BROWSER = "browser"
export const NONE = "none"

/**
 * @param {string} platform
 * @param {{thermalReady: boolean, silentPrint: boolean}} settings
 * @returns {string} The route to try first
 */
export function getPrintRoute(platform, { thermalReady, silentPrint }) {
	if (platform === ELECTRON) return SILENT
	if (thermalReady) return THERMAL
	if (platform === ANDROID) return NONE
	return silentPrint ? SILENT : BROWSER
}

/**
 * Whether a failed silent print may fall back to the browser's dialog. Outside the
 * web there is no Frappe print page to open.
 * @param {string} platform
 * @returns {boolean}
 */
export function canUseBrowserPrint(platform) {
	return platform !== ELECTRON && platform !== ANDROID
}
