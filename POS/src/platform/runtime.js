/**
 * Where the app is running, and how to reach the server from there.
 *
 * The web build is served by Frappe, so its requests stay relative. The desktop and
 * Android builds load from the device, so they talk to a server chosen at enrollment.
 *
 * @module platform/runtime
 */

export const WEB = "web"
export const ELECTRON = "electron"
export const ANDROID = "android"

const SERVER_URL_KEY = "pos_next_server_url"
const DEVICE_TOKEN_KEY = "pos_next_device_token"

export const PLATFORM = import.meta.env.VITE_PLATFORM || WEB
export const isNative = PLATFORM !== WEB

/** @returns {string} The server's origin, empty on the web */
export function getServerUrl() {
	return isNative ? localStorage.getItem(SERVER_URL_KEY) || "" : ""
}

/** @param {string} url - The server's address, from enrollment */
export function setServerUrl(url) {
	localStorage.setItem(SERVER_URL_KEY, String(url).trim().replace(/\/+$/, ""))
}

/** @returns {string|null} The device token, which replaces cookies outside the browser */
export function getDeviceToken() {
	// Moves to the OS keystore with device enrollment in phase 3
	return isNative ? localStorage.getItem(DEVICE_TOKEN_KEY) : null
}

/** @param {string} token */
export function setDeviceToken(token) {
	localStorage.setItem(DEVICE_TOKEN_KEY, token)
}

/**
 * Absolute URL of a server path, for code that needs a full address.
 * @param {string} path - A path such as /files/a.png
 * @returns {string}
 */
export function serverUrl(path) {
	if (/^https?:/.test(path)) return path
	const base = getServerUrl() || (typeof window !== "undefined" ? window.location.origin : "")
	return `${base}${path.startsWith("/") ? "" : "/"}${path}`
}
