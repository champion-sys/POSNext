import { describe, expect, it } from "vitest"
import {
	PIN_PATTERN,
	attemptGate,
	derivePinHash,
	isPinExhausted,
	offlineWindow,
	pinMatches,
	recordFailure,
} from "../offlinePin"

const HOUR = 60 * 60 * 1000
const MINUTE = 60 * 1000
const NOW = Date.UTC(2026, 10, 6, 12)

// Shared with pos_next/api/test_device.py, so both ends are proven to derive the same hash
const VECTOR = {
	pin: "482915",
	salt: "00112233445566778899aabbccddeeff",
	iterations: 1000,
	hash: "f9b42b8f13bdd376be45ffd3d89a6449f121a8ebd055d4bce84f25a68e1415ce",
}

function failures(times, now = NOW) {
	let attempts = null
	for (let index = 0; index < times; index++)
		attempts = recordFailure(attempts, now)
	return attempts
}

describe("derivePinHash", () => {
	it("derives what the server derives", async () => {
		expect(
			await derivePinHash(VECTOR.pin, VECTOR.salt, VECTOR.iterations),
		).toBe(VECTOR.hash)
	})

	it("depends on the salt", async () => {
		const other = "ff112233445566778899aabbccddeeff"
		expect(await derivePinHash(VECTOR.pin, other, VECTOR.iterations)).not.toBe(
			VECTOR.hash,
		)
	})
})

describe("pinMatches", () => {
	it("accepts the right PIN", async () => {
		expect(await pinMatches(VECTOR.pin, VECTOR)).toBe(true)
	})

	it("refuses another PIN", async () => {
		expect(await pinMatches("482916", VECTOR)).toBe(false)
	})
})

describe("PIN_PATTERN", () => {
	it("takes 6 to 8 digits", () => {
		expect(PIN_PATTERN.test("482915")).toBe(true)
		expect(PIN_PATTERN.test("48291576")).toBe(true)
	})

	it("refuses anything else", () => {
		for (const pin of ["48291", "482915761", "48a915", ""]) {
			expect(PIN_PATTERN.test(pin)).toBe(false)
		}
	})
})

describe("attemptGate", () => {
	it("allows the first attempts", () => {
		expect(attemptGate(null, NOW).allowed).toBe(true)
		expect(attemptGate(failures(4), NOW).allowed).toBe(true)
	})

	it("locks after five failures", () => {
		expect(attemptGate(failures(5), NOW + 10 * 1000)).toEqual({
			allowed: false,
			retryInSeconds: 50,
		})
	})

	it("opens again when the lock has passed", () => {
		expect(attemptGate(failures(5), NOW + MINUTE).allowed).toBe(true)
	})

	it("doubles the lock each time it is hit", () => {
		const secondRound = failures(10)
		expect(attemptGate(secondRound, NOW + MINUTE).allowed).toBe(false)
		expect(attemptGate(secondRound, NOW + 2 * MINUTE).allowed).toBe(true)
	})

	it("caps the lock at fifteen minutes", () => {
		const attempts = { count: 5, level: 12, lastAttempt: NOW }
		expect(attemptGate(attempts, NOW + 15 * MINUTE).allowed).toBe(true)
	})

	it("stays locked if the clock is moved back", () => {
		expect(attemptGate(failures(5), NOW - HOUR).allowed).toBe(false)
	})
})

describe("isPinExhausted", () => {
	it("is false below the limit, whatever the clock says", () => {
		expect(isPinExhausted(null)).toBe(false)
		expect(isPinExhausted(failures(19))).toBe(false)
	})

	it("is true at the limit", () => {
		expect(isPinExhausted(failures(20))).toBe(true)
	})
})

describe("offlineWindow", () => {
	const cashier = { lastOnlineAt: NOW, maxOfflineHours: 72 }

	it("is open inside the period", () => {
		expect(offlineWindow(cashier, NOW + 71 * HOUR)).toEqual({
			expired: false,
			remainingMs: HOUR,
		})
	})

	it("closes when the period ends", () => {
		expect(offlineWindow(cashier, NOW + 72 * HOUR)).toEqual({
			expired: true,
			remainingMs: 0,
		})
	})

	it("closes if the clock is moved back to before the last contact", () => {
		expect(offlineWindow(cashier, NOW - HOUR).expired).toBe(true)
	})

	it("closes if the clock is moved back past the latest time seen", () => {
		const highWater = NOW + 50 * HOUR
		expect(offlineWindow(cashier, NOW + HOUR, highWater).expired).toBe(true)
	})

	it("tolerates a small clock correction", () => {
		expect(
			offlineWindow(cashier, NOW + HOUR - MINUTE, NOW + HOUR).expired,
		).toBe(false)
	})

	it("counts missing data as expired", () => {
		expect(offlineWindow({}, NOW).expired).toBe(true)
		expect(offlineWindow({ lastOnlineAt: NOW }, NOW).expired).toBe(true)
	})
})
