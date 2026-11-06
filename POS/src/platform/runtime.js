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

export const PLATFORM = import.meta.env.VITE_PLATFORM || WEB
export const isNative = PLATFORM !== WEB

// Read on every request, which cannot wait for the OS keystore. platform/auth loads and saves them.
let deviceToken = null
let cashierGrant = null
let accessListener = null

/** @returns {string} The server's origin, empty on the web */
export function getServerUrl() {
	return isNative ? localStorage.getItem(SERVER_URL_KEY) || "" : ""
}

/** @param {string} url - The server's address, from enrollment */
export function setServerUrl(url) {
	localStorage.setItem(SERVER_URL_KEY, String(url).trim().replace(/\/+$/, ""))
	notifyAccessChange()
}

/** @returns {string|null} Proves this device was enrolled. Sent only to sign a cashier in */
export function getDeviceToken() {
	return deviceToken
}

/** @param {string|null} token */
export function setDeviceToken(token) {
	deviceToken = token
}

/** @returns {string|null} The signed-in cashier's grant, which replaces cookies outside the browser */
export function getCashierGrant() {
	return cashierGrant
}

/** @param {string|null} grant */
export function setCashierGrant(grant) {
	cashierGrant = grant
	notifyAccessChange()
}

/**
 * For what reaches the server outside fetch, such as the offline worker.
 * @param {(access: {serverUrl: string, grant: string|null}) => void} listener
 */
export function onAccessChange(listener) {
	accessListener = listener
	notifyAccessChange()
}

function notifyAccessChange() {
	accessListener?.({ serverUrl: getServerUrl(), grant: cashierGrant })
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
