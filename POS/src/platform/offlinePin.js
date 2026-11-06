/**
 * The rules for signing a cashier in with a PIN while the server cannot be reached.
 * Pure, so the limits can be tested without a device.
 *
 * @module platform/offlinePin
 */

export const PIN_PATTERN = /^[0-9]{6,8}$/

const FREE_ATTEMPTS = 5
const BASE_LOCK_MS = 60 * 1000
const MAX_LOCK_MS = 15 * 60 * 1000
// Lockouts rest on the device's clock, which a cashier can move. This does not.
const MAX_FAILURES = 20

const HOUR_MS = 60 * 60 * 1000
const CLOCK_TOLERANCE_MS = 5 * 60 * 1000

/**
 * PBKDF2 as in useSessionLock.js. Must match _hash_pin in pos_next/api/device.py.
 * @param {string} pin
 * @param {string} saltHex
 * @param {number} iterations
 * @returns {Promise<string>} The hash, in hex
 */
export async function derivePinHash(pin, saltHex, iterations) {
	const salt = Uint8Array.from(saltHex.match(/../g), (byte) =>
		Number.parseInt(byte, 16),
	)
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(pin),
		"PBKDF2",
		false,
		["deriveBits"],
	)
	const bits = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", salt, iterations, hash: "SHA-256" },
		key,
		256,
	)
	return Array.from(new Uint8Array(bits), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("")
}

/**
 * @param {string} pin
 * @param {{salt: string, hash: string, iterations: number}} verifier - From the server
 * @returns {Promise<boolean>}
 */
export async function pinMatches(pin, verifier) {
	return (
		(await derivePinHash(pin, verifier.salt, verifier.iterations)) ===
		verifier.hash
	)
}

/**
 * May another PIN be tried now?
 * @param {{count: number, level: number, lastAttempt: number}|null} attempts
 * @param {number} now
 * @returns {{allowed: boolean, retryInSeconds?: number}}
 */
export function attemptGate(attempts, now) {
	if (!attempts || attempts.count < FREE_ATTEMPTS) return { allowed: true }

	const lockMs = Math.min(BASE_LOCK_MS * 2 ** (attempts.level - 1), MAX_LOCK_MS)
	const elapsed = now - attempts.lastAttempt
	return elapsed >= lockMs
		? { allowed: true }
		: { allowed: false, retryInSeconds: Math.ceil((lockMs - elapsed) / 1000) }
}

/**
 * @param {{count: number, level: number, total: number}|null} attempts
 * @param {number} now
 * @returns {{count: number, level: number, total: number, lastAttempt: number}}
 */
export function recordFailure(attempts, now) {
	const { count, level, total } = attempts || { count: 0, level: 1, total: 0 }
	const lockServed = count >= FREE_ATTEMPTS
	return {
		count: lockServed ? 1 : count + 1,
		level: lockServed ? level + 1 : level,
		total: total + 1,
		lastAttempt: now,
	}
}

/**
 * @param {{total: number}|null} attempts
 * @returns {boolean} Too many failures: the PIN stops working until an online sign-in
 */
export function isPinExhausted(attempts) {
	return Boolean(attempts) && attempts.total >= MAX_FAILURES
}

/**
 * How much of the allowed offline period is left.
 * @param {{lastOnlineAt: number, maxOfflineHours: number}} cashier
 * @param {number} now
 * @param {number} [clockHighWater] - The latest time this device has seen
 * @returns {{expired: boolean, remainingMs: number}}
 */
export function offlineWindow(
	{ lastOnlineAt, maxOfflineHours },
	now,
	clockHighWater = 0,
) {
	const remainingMs = lastOnlineAt + maxOfflineHours * HOUR_MS - now
	const clockMovedBack =
		now + CLOCK_TOLERANCE_MS < Math.max(lastOnlineAt, clockHighWater)
	return {
		// Written so that missing data counts as expired
		expired: clockMovedBack || !(remainingMs > 0),
		remainingMs: Math.max(remainingMs || 0, 0),
	}
}
