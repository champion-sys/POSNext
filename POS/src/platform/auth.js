/**
 * Enrolling this device and signing cashiers in on it, for the desktop and Android
 * apps. The browser keeps signing in with cookies and never reaches this module.
 *
 * The device token is sent only to sign a cashier in. The grant it returns goes on
 * every request, through the fetch bridge in platform/http. See pos_next/auth.py.
 *
 * @module platform/auth
 */

import { readIdentity, saveIdentity } from "./identity"
import {
	attemptGate,
	isPinExhausted,
	offlineWindow,
	pinMatches,
	recordFailure,
} from "./offlinePin"
import {
	ELECTRON,
	PLATFORM,
	getDeviceToken,
	getServerUrl,
	setCashierGrant,
	setDeviceToken,
	setServerUrl,
} from "./runtime"
import { openSecretStore } from "./secrets"
import { localStore } from "./store"

export const ENROLL_ROUTE = "DeviceEnroll"
export const SIGN_IN_ROUTE = "CashierSignIn"

const HOME_ROUTE = "POSSale"
const WEB_LOGIN_ROUTE = "Login"

const DEVICE_TOKEN_KEY = "pos_next_device_token"
const GRANT_KEY = "pos_next_cashier_grant"
const CASHIERS_KEY = "pos_next_cashiers"
const DEVICE_ID_KEY = "pos_next_device_id"

const API = "/api/method/pos_next.api"
const DEVICE_TOKEN_HEADER = "X-POS-Device-Token"
const DEVICE_REFUSED = "DeviceAccessError"

const IPV4 = /^\d+\.\d+\.\d+\.\d+$/
const PRIVATE_IPV4 = /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/

const REQUEST_TIMEOUT_MS = 15 * 1000
const PING_TIMEOUT_MS = 3 * 1000
const CONTACT_INTERVAL_MS = 60 * 1000

/** Why an operation failed. `code` is for the page, `message` is the server's own words. */
export class AuthError extends Error {
	/**
	 * @param {"network"|"bad_url"|"insecure_url"|"device_refused"|"refused"|"unsent_sales"|"local_data"} code
	 * @param {string} [message]
	 */
	constructor(code, message = "") {
		super(message)
		this.code = code
	}
}

let secrets = null
let grant = null
let deviceState = emptyDeviceState()
let lastContactAt = 0

function emptyDeviceState() {
	return { cashiers: {}, clockHighWater: 0 }
}

function parseJson(text) {
	try {
		return JSON.parse(text)
	} catch {
		return null
	}
}

/**
 * Read what this device holds into memory. Run before the first request.
 * @param {import("./secrets").SecretStore} [store]
 */
export async function loadCredentials(store = openSecretStore()) {
	secrets = store
	const [deviceToken, savedGrant, savedState] = await Promise.all([
		secrets.get(DEVICE_TOKEN_KEY),
		secrets.get(GRANT_KEY),
		secrets.get(CASHIERS_KEY),
	])

	setDeviceToken(deviceToken)
	grant = parseJson(savedGrant)
	setCashierGrant(grant?.token ?? null)
	deviceState = { ...emptyDeviceState(), ...parseJson(savedState) }
	lastContactAt = 0
}

/** @returns {boolean} */
export function isEnrolled() {
	return Boolean(getServerUrl() && getDeviceToken())
}

function saveDeviceState() {
	return secrets.set(CASHIERS_KEY, JSON.stringify(deviceState))
}

async function saveGrant(value) {
	grant = value
	setCashierGrant(value?.token ?? null)
	if (value) await secrets.set(GRANT_KEY, JSON.stringify(value))
	else await secrets.remove(GRANT_KEY)
}

/**
 * The server's address as the person typed it, reduced to an origin.
 * Plain HTTP would expose passwords, so it is accepted only inside a private network.
 * @param {string} input
 * @returns {string}
 */
export function normalizeServerUrl(input) {
	const text = String(input ?? "").trim()
	let url
	try {
		url = new URL(
			/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`,
		)
	} catch {
		throw new AuthError("bad_url")
	}

	if (url.protocol === "http:" && !isPrivateHost(url.hostname))
		throw new AuthError("insecure_url")
	if (!["http:", "https:"].includes(url.protocol))
		throw new AuthError("bad_url")
	return url.origin
}

function isPrivateHost(hostname) {
	if (hostname === "localhost" || hostname.endsWith(".local")) return true

	// Only a real IPv4 address: 10.example.com is a public name
	return IPV4.test(hostname) && PRIVATE_IPV4.test(hostname)
}

function serverMessage(body) {
	const [first] = parseJson(body._server_messages) || []
	return (
		parseJson(first)?.message ||
		(typeof body.message === "string" ? body.message : "")
	)
}

function serverHeaders(server) {
	return {
		Accept: "application/json",
		"X-Frappe-Site-Name": new URL(server).hostname,
	}
}

/** A call that carries its own credentials, so the bridge adds none. */
async function callServer(server, method, params, headers = {}) {
	let response
	try {
		response = await fetch(`${server}${API}.${method}`, {
			method: "POST",
			headers: {
				...serverHeaders(server),
				"Content-Type": "application/json",
				...headers,
			},
			body: JSON.stringify(params),
			credentials: "omit",
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		})
	} catch {
		throw new AuthError("network")
	}

	const body = await response.json().catch(() => ({}))
	if (response.ok) return body.message

	const code = body.exc_type === DEVICE_REFUSED ? "device_refused" : "refused"
	throw new AuthError(code, serverMessage(body))
}

/** @returns {string} A UUID that stays with this installation */
export function getDeviceId() {
	let id = localStorage.getItem(DEVICE_ID_KEY)
	if (!id) {
		id = crypto.randomUUID()
		localStorage.setItem(DEVICE_ID_KEY, id)
	}
	return id
}

async function assertNothingUnsent() {
	if ((await localStore.getOfflineInvoiceCount()) > 0) {
		throw new AuthError("unsent_sales")
	}
}

/**
 * Leave one server's data behind before moving to another. A sale still queued, or waiting
 * for that server's answer, would never finish on the new one, so it stops the move.
 *
 * A failed read of the queue counts as empty, so it is counted again once clearing has
 * shown that the database answers.
 */
async function prepareForNewServer() {
	await assertNothingUnsent()

	try {
		const { success } = await localStore.clearCachedData()
		if (!success) throw new Error("Could not clear cached data")
		await localStore.clearOffersCache()
		await localStore.clearShift()
	} catch (error) {
		throw new AuthError("local_data", error.message)
	}

	await assertNothingUnsent()
}

/**
 * Enroll this device with a code from a manager.
 * @param {{serverUrl: string, code: string}} details
 * @returns {Promise<object>} The server's reply
 */
export async function enrollDevice({ serverUrl, code }) {
	const server = normalizeServerUrl(serverUrl)

	// The code works once, so find out now if the token could not be kept
	await secrets.set(DEVICE_TOKEN_KEY, getDeviceToken() || "")

	if (server !== getServerUrl()) await prepareForNewServer()

	const id = getDeviceId()
	const result = await callServer(server, "device.enroll", {
		enrollment_code: code,
		device_id: id,
		device_name: `${PLATFORM === ELECTRON ? "Desktop" : "Android"} ${id.slice(0, 8)}`,
		platform: PLATFORM,
		app_version:
			typeof __BUILD_VERSION__ !== "undefined" ? __BUILD_VERSION__ : "",
	})

	// Another server's cashiers mean nothing to this one
	if (server !== getServerUrl()) deviceState = emptyDeviceState()

	await secrets.set(DEVICE_TOKEN_KEY, result.device_token)
	setDeviceToken(result.device_token)
	setServerUrl(server)
	await saveGrant(null)
	await saveDeviceState()
	return result
}

async function forgetDevice() {
	setDeviceToken(null)
	deviceState = emptyDeviceState()
	await saveGrant(null)
	await secrets.remove(DEVICE_TOKEN_KEY)
	await secrets.remove(CASHIERS_KEY)
	saveIdentity(null)
}

/**
 * Sign a cashier in with their password. The server must be reachable.
 * @param {{usr: string, pwd: string}} credentials
 * @returns {Promise<object>} The server's reply, with `pin` empty if they have none yet
 */
export async function signInCashier({ usr, pwd }) {
	let result
	try {
		result = await callServer(
			getServerUrl(),
			"device.cashier_login",
			{ usr, pwd },
			{ [DEVICE_TOKEN_HEADER]: getDeviceToken() },
		)
	} catch (error) {
		if (error.code === "device_refused") await forgetDevice()
		throw error
	}

	const now = Date.now()
	await saveGrant({ token: result.grant, user: result.user })
	deviceState.clockHighWater = now
	deviceState.cashiers[result.user] = {
		user: result.user,
		fullName: result.full_name,
		userImage: result.user_image,
		profiles: result.profiles,
		pin: result.pin,
		maxOfflineHours: result.max_offline_hours,
		lastOnlineAt: now,
		attempts: null,
	}
	await saveDeviceState()
	saveIdentity({
		userId: result.user,
		fullName: result.full_name,
		userImage: result.user_image,
	})
	return result
}

/**
 * Set the signed-in cashier's offline PIN.
 * @param {{pin: string, pwd: string}} details
 */
export async function setCashierPin({ pin, pwd }) {
	const result = await callServer(
		getServerUrl(),
		"device.set_cashier_pin",
		{ pin, pwd },
		{ Authorization: `Bearer ${grant?.token}` },
	)
	deviceState.cashiers[grant.user].pin = result.pin
	await saveDeviceState()
}

/** @returns {Array<{user: string, fullName: string}>} Who can sign in here without the server */
export function knownCashiers() {
	return Object.values(deviceState.cashiers)
		.filter((cashier) => cashier.pin)
		.map(({ user, fullName }) => ({ user, fullName: fullName || user }))
}

/**
 * Check a PIN against what the server sent at the last online sign-in.
 * @param {string} user
 * @param {string} pin
 * @returns {Promise<{ok: boolean, reason?: "no_pin"|"expired"|"locked"|"wrong", retryInSeconds?: number}>}
 */
export async function verifyPin(user, pin) {
	const cashier = deviceState.cashiers[user]
	if (!cashier?.pin) return { ok: false, reason: "no_pin" }

	const now = Date.now()
	if (offlineWindow(cashier, now, deviceState.clockHighWater).expired) {
		return { ok: false, reason: "expired" }
	}

	const gate = attemptGate(cashier.attempts, now)
	if (!gate.allowed)
		return { ok: false, reason: "locked", retryInSeconds: gate.retryInSeconds }

	if (await pinMatches(pin, cashier.pin)) {
		cashier.attempts = null
		deviceState.clockHighWater = Math.max(deviceState.clockHighWater, now)
		await saveDeviceState()
		return { ok: true }
	}

	cashier.attempts = recordFailure(cashier.attempts, now)
	if (isPinExhausted(cashier.attempts)) cashier.pin = null
	await saveDeviceState()
	return { ok: false, reason: "wrong" }
}

/**
 * @param {{reason: string, retryInSeconds?: number}} refusal - From verifyPin or signInWithPin
 * @returns {string} What to tell the cashier
 */
export function pinRefusalMessage({ reason, retryInSeconds }) {
	switch (reason) {
		case "locked":
			return __("Too many attempts. Try again in {0} seconds.", [
				retryInSeconds,
			])
		case "expired":
			return __(
				"This device has been offline too long. Connect it to the server and sign in with your password.",
			)
		case "no_pin":
			return __(
				"No PIN is available for this cashier on this device. Sign in with your password.",
			)
		case "online":
			return __("The server is reachable. Sign in with your password.")
		default:
			return __("Incorrect PIN")
	}
}

/**
 * Sign a cashier in with their PIN. Only while the server is out of reach, because
 * a PIN gives no grant, and without one the server would refuse everything the app asks.
 * @param {{user: string, pin: string}} credentials
 * @returns {Promise<{ok: boolean, reason?: string, retryInSeconds?: number}>}
 */
export async function signInWithPin({ user, pin }) {
	if (await isServerReachable()) return { ok: false, reason: "online" }

	const result = await verifyPin(user, pin)
	if (!result.ok) return result

	// Whoever worked here before must not be acted as once the connection returns
	if (grant?.user !== user) await saveGrant(null)

	const { fullName, userImage } = deviceState.cashiers[user]
	saveIdentity({ userId: user, fullName, userImage })
	return result
}

/** End the sign-in on this device, and on the server if it can be reached. */
export async function signOut() {
	if (grant) {
		const headers = { Authorization: `Bearer ${grant.token}` }
		// Failing is fine: the grant is forgotten here and expires there
		await callServer(
			getServerUrl(),
			"device.cashier_logout",
			{},
			headers,
		).catch(() => {})
	}
	await saveGrant(null)
	saveIdentity(null)
}

/**
 * The server refused a grant. A late reply about an old grant changes nothing.
 * @param {string} token - The grant it refused
 * @returns {Promise<boolean>} Whether the current sign-in ended
 */
export async function dropRejectedGrant(token) {
	if (grant?.token !== token) return false
	await saveGrant(null)
	return true
}

/** @returns {boolean} Whether a sign-in that uses this device's own check is still allowed */
export function isWithinOfflineLimit(now = Date.now()) {
	const cashier = deviceState.cashiers[readIdentity().userId]
	return (
		Boolean(cashier) &&
		!offlineWindow(cashier, now, deviceState.clockHighWater).expired
	)
}

/** Count the server having answered this cashier as time online. */
export async function noteServerContact(now = Date.now()) {
	const cashier = deviceState.cashiers[grant?.user]
	if (!cashier || now - lastContactAt < CONTACT_INTERVAL_MS) return

	lastContactAt = now
	cashier.lastOnlineAt = now
	deviceState.clockHighWater = now
	await saveDeviceState()
}

/** @returns {Promise<boolean>} */
export async function isServerReachable() {
	const server = getServerUrl()
	if (!server) return false

	try {
		const response = await fetch(`${server}${API}.ping`, {
			headers: serverHeaders(server),
			credentials: "omit",
			signal: AbortSignal.timeout(PING_TIMEOUT_MS),
		})
		return response.ok
	} catch {
		return false
	}
}

/** @returns {Promise<boolean>} Whether whoever is signed in must sign in again now */
export async function cashierMustSignIn(now = Date.now()) {
	if (!isWithinOfflineLimit(now)) return true
	deviceState.clockHighWater = Math.max(deviceState.clockHighWater, now)
	await saveDeviceState()

	// A PIN session has no grant, so it can do nothing with a server it can reach
	return !grant && (await isServerReachable())
}

/**
 * Where the desktop and Android apps send a navigation.
 * @param {string} route - The route name being opened
 * @param {{enrolled: boolean, signedIn: boolean}} state
 * @returns {string|null} The route to open instead
 */
export function nativeRedirect(route, { enrolled, signedIn }) {
	if (!enrolled) return route === ENROLL_ROUTE ? null : ENROLL_ROUTE
	if (!signedIn) return route === SIGN_IN_ROUTE ? null : SIGN_IN_ROUTE
	return [ENROLL_ROUTE, SIGN_IN_ROUTE, WEB_LOGIN_ROUTE].includes(route)
		? HOME_ROUTE
		: null
}
