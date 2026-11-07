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

/**
 * What clearing caches must leave on the apps: what keeps a device enrolled and its
 * cashier signed in, and the printer chosen for it.
 */
const DEVICE_KEYS = [
	SERVER_URL_KEY,
	"pos_next_device_token",
	"pos_next_cashier_grant",
	"pos_next_cashiers",
	"pos_next_cashier",
	"pos_next_device_id",
	"pos_next_system_printer",
	"pos_next_locked_text",
]

/**
 * What it must leave everywhere: a shift closed offline would otherwise take sales again
 * until its close reaches the server.
 */
const UNFINISHED_WORK_KEYS = ["pos_next_closing_shifts"]

// Read on every request, which cannot wait for the OS keystore. platform/auth loads and saves them.
let deviceToken = null
let cashierGrant = null
let accessListener = null

/**
 * @param {string} key - A localStorage key
 * @param {string} [platform]
 * @returns {boolean} Whether this key is not a cache
 */
export function isDeviceKey(key, platform = PLATFORM) {
	return UNFINISHED_WORK_KEYS.includes(key) || (platform !== WEB && DEVICE_KEYS.includes(key))
}

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

/**
 * Where a file stored on the server loads from. Inside an app a path like /files/a.png
 * would point at the app itself, not at the server.
 * @param {string} [path]
 * @returns {string|undefined}
 */
export function imageUrl(path) {
	return path?.startsWith("/") ? serverUrl(path) : path
}
