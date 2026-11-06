import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { derivePinHash } from "../offlinePin"

const HOUR = 60 * 60 * 1000
const START = Date.UTC(2026, 10, 6, 12)
const SERVER = "https://shop.example.com"
const SALT = "00112233445566778899aabbccddeeff"
const ITERATIONS = 1000
const PIN = "482915"

let auth
let runtime
let identity
let store
let verifier
let online
let replies

function memoryStore() {
	const entries = new Map()
	return {
		entries,
		get: async (key) => entries.get(key) ?? null,
		set: async (key, value) => {
			entries.set(key, value)
		},
		remove: async (key) => {
			entries.delete(key)
		},
	}
}

function json(body, status = 200) {
	return new Response(JSON.stringify(body), { status })
}

function refusal(status, excType, message) {
	const server = JSON.stringify([JSON.stringify({ message })])
	return json({ exc_type: excType, _server_messages: server }, status)
}

function loginReply(user = "a@example.com", overrides = {}) {
	return json({
		message: {
			user,
			full_name: `Cashier ${user}`,
			user_image: null,
			profiles: [{ name: "Main" }],
			grant: `posg_${user}`,
			pin: verifier,
			max_offline_hours: 72,
			...overrides,
		},
	})
}

function serverFetch(url) {
	if (!online) return Promise.reject(new TypeError("Failed to fetch"))

	const method = url.split("/").pop()
	return Promise.resolve(replies[method]?.() ?? json({ message: "pong" }))
}

function lastCall(method) {
	const calls = fetch.mock.calls.filter(([url]) => url.endsWith(method))
	return calls.at(-1)?.[1]
}

async function signIn(user = "a@example.com", overrides = {}) {
	replies["pos_next.api.device.cashier_login"] = () =>
		loginReply(user, overrides)
	return auth.signInCashier({ usr: user, pwd: "secret" })
}

async function enroll() {
	replies["pos_next.api.device.enroll"] = () =>
		json({ message: { device_token: "posd_token", device_code: "ABCDE" } })
	return auth.enrollDevice({ serverUrl: SERVER, code: "abcde-fghjk" })
}

async function restart() {
	vi.resetModules()
	auth = await import("../auth")
	runtime = await import("../runtime")
	await auth.loadCredentials(store)
}

beforeEach(async () => {
	vi.stubEnv("VITE_PLATFORM", "electron")
	vi.resetModules()
	vi.useFakeTimers({ toFake: ["Date"], now: START })
	vi.stubGlobal("fetch", vi.fn(serverFetch))
	vi.stubGlobal("__", (text, values = []) => text.replace("{0}", values[0]))
	localStorage.clear()

	online = true
	replies = {}
	store = memoryStore()
	verifier = {
		salt: SALT,
		iterations: ITERATIONS,
		hash: await derivePinHash(PIN, SALT, ITERATIONS),
	}

	auth = await import("../auth")
	runtime = await import("../runtime")
	identity = await import("../identity")
	await auth.loadCredentials(store)
})

afterEach(() => {
	vi.useRealTimers()
	vi.unstubAllGlobals()
	vi.unstubAllEnvs()
})

describe("normalizeServerUrl", () => {
	it("assumes https and keeps only the origin", () => {
		expect(auth.normalizeServerUrl(" shop.example.com/pos/ ")).toBe(SERVER)
		expect(auth.normalizeServerUrl("https://shop.example.com:8443/")).toBe(
			"https://shop.example.com:8443",
		)
	})

	it("refuses plain http on the internet", () => {
		expect(() => auth.normalizeServerUrl("http://shop.example.com")).toThrow(
			expect.objectContaining({ code: "insecure_url" }),
		)
	})

	it("allows plain http on a private network", () => {
		for (const address of [
			"http://192.168.1.5:8000",
			"http://10.0.0.9",
			"http://172.16.0.1",
			"http://localhost:8000",
			"http://till.local",
		]) {
			expect(auth.normalizeServerUrl(address)).toBe(address)
		}
	})

	it("does not mistake a public address for a private one", () => {
		for (const address of [
			"http://172.32.0.1",
			"http://192.169.1.1",
			"http://10.example.com",
			"http://192.168.example.com",
			"http://172.16.example.com",
			"http://127.0.0.1.example.com",
		]) {
			expect(() => auth.normalizeServerUrl(address)).toThrow(
				expect.objectContaining({ code: "insecure_url" }),
			)
		}
	})

	it("refuses what is not a server address", () => {
		for (const address of [
			"",
			"   ",
			"ftp://shop.example.com",
			"file:///etc/passwd",
		]) {
			expect(() => auth.normalizeServerUrl(address)).toThrow(
				expect.objectContaining({ code: "bad_url" }),
			)
		}
	})
})

describe("nativeRedirect", () => {
	const unenrolled = { enrolled: false, signedIn: false }
	const signedOut = { enrolled: true, signedIn: false }
	const signedIn = { enrolled: true, signedIn: true }

	it("sends an unenrolled device to enrollment from anywhere", () => {
		for (const route of ["POSSale", "Login", auth.SIGN_IN_ROUTE]) {
			expect(auth.nativeRedirect(route, unenrolled)).toBe(auth.ENROLL_ROUTE)
		}
		expect(auth.nativeRedirect(auth.ENROLL_ROUTE, unenrolled)).toBeNull()
	})

	it("sends a device with no cashier to sign-in, including the web login", () => {
		for (const route of ["POSSale", "Login", auth.ENROLL_ROUTE]) {
			expect(auth.nativeRedirect(route, signedOut)).toBe(auth.SIGN_IN_ROUTE)
		}
		expect(auth.nativeRedirect(auth.SIGN_IN_ROUTE, signedOut)).toBeNull()
	})

	it("lets a signed-in cashier through and away from the sign-in pages", () => {
		expect(auth.nativeRedirect("POSSale", signedIn)).toBeNull()
		for (const route of ["Login", auth.ENROLL_ROUTE, auth.SIGN_IN_ROUTE]) {
			expect(auth.nativeRedirect(route, signedIn)).toBe("POSSale")
		}
	})
})

describe("enrollDevice", () => {
	it("sends the code and who is asking", async () => {
		await enroll()

		const { body, headers } = lastCall("device.enroll")
		const params = JSON.parse(body)
		expect(params.enrollment_code).toBe("abcde-fghjk")
		expect(params.device_id).toBe(auth.getDeviceId())
		expect(params.platform).toBe("electron")
		expect(headers.Authorization).toBeUndefined()
	})

	it("keeps the token in the secret store and enrolls the device", async () => {
		await enroll()

		expect(store.entries.get("pos_next_device_token")).toBe("posd_token")
		expect(runtime.getDeviceToken()).toBe("posd_token")
		expect(runtime.getServerUrl()).toBe(SERVER)
		expect(auth.isEnrolled()).toBe(true)
	})

	it("does not spend the code if the token could not be kept", async () => {
		store.set = () => Promise.reject(new Error("keystore unavailable"))

		await expect(enroll()).rejects.toThrow("keystore unavailable")

		expect(fetch).not.toHaveBeenCalled()
	})

	it("stays unenrolled when the server refuses, and shows why", async () => {
		replies["pos_next.api.device.enroll"] = () =>
			refusal(
				401,
				"AuthenticationError",
				"This enrollment code is not valid or has expired",
			)

		await expect(
			auth.enrollDevice({ serverUrl: SERVER, code: "bad" }),
		).rejects.toMatchObject({
			code: "refused",
			message: "This enrollment code is not valid or has expired",
		})

		expect(auth.isEnrolled()).toBe(false)
		expect(runtime.getServerUrl()).toBe("")
	})

	it("forgets the cashiers of another server", async () => {
		await enroll()
		await signIn()

		replies["pos_next.api.device.enroll"] = () =>
			json({ message: { device_token: "posd_other" } })
		await auth.enrollDevice({
			serverUrl: "https://other.example.com",
			code: "x",
		})

		expect(auth.knownCashiers()).toEqual([])
		expect(runtime.getCashierGrant()).toBeNull()
	})

	it("keeps the same device id across enrollments", async () => {
		const id = auth.getDeviceId()
		await enroll()
		expect(auth.getDeviceId()).toBe(id)
	})
})

describe("signInCashier", () => {
	beforeEach(enroll)

	it("proves the device, and sends no grant or cookie", async () => {
		await signIn()

		const { headers, credentials } = lastCall("device.cashier_login")
		expect(headers["X-POS-Device-Token"]).toBe("posd_token")
		expect(headers.Authorization).toBeUndefined()
		expect(credentials).toBe("omit")
	})

	it("signs the cashier in", async () => {
		await signIn()

		expect(runtime.getCashierGrant()).toBe("posg_a@example.com")
		expect(identity.readIdentity().userId).toBe("a@example.com")
		expect(auth.knownCashiers()).toEqual([
			{ user: "a@example.com", fullName: "Cashier a@example.com" },
		])
	})

	it("survives a restart", async () => {
		await signIn()

		await restart()

		expect(runtime.getDeviceToken()).toBe("posd_token")
		expect(runtime.getCashierGrant()).toBe("posg_a@example.com")
		expect(auth.isEnrolled()).toBe(true)
	})

	it("leaves no secret in readable storage", async () => {
		await signIn()

		const readable = JSON.stringify({ ...localStorage })
		expect(readable).not.toContain("posd_token")
		expect(readable).not.toContain("posg_")
		expect(readable).not.toContain(verifier.hash)
	})

	it("gives nothing for a wrong password", async () => {
		replies["pos_next.api.device.cashier_login"] = () =>
			json(
				{
					exc_type: "AuthenticationError",
					message: "Invalid login credentials",
				},
				401,
			)

		await expect(
			auth.signInCashier({ usr: "a@example.com", pwd: "no" }),
		).rejects.toMatchObject({
			code: "refused",
			message: "Invalid login credentials",
		})

		expect(runtime.getCashierGrant()).toBeNull()
		expect(identity.readIdentity().userId).toBeNull()
		expect(auth.isEnrolled()).toBe(true)
	})

	it("forgets everything on a device the server refused", async () => {
		await signIn()
		replies["pos_next.api.device.cashier_login"] = () =>
			refusal(401, "DeviceAccessError", "This device is not enrolled.")

		await expect(
			auth.signInCashier({ usr: "a@example.com", pwd: "secret" }),
		).rejects.toMatchObject({
			code: "device_refused",
		})

		expect(auth.isEnrolled()).toBe(false)
		expect(auth.knownCashiers()).toEqual([])
		expect(runtime.getCashierGrant()).toBeNull()
		expect(identity.readIdentity().userId).toBeNull()
		expect(store.entries.size).toBe(0)
	})

	it("reports a network failure as such", async () => {
		online = false

		await expect(signIn()).rejects.toMatchObject({ code: "network" })
	})
})

describe("setCashierPin", () => {
	beforeEach(async () => {
		await enroll()
		await signIn("a@example.com", { pin: null })
	})

	it("acts as the cashier, and keeps the new verifier", async () => {
		expect(auth.knownCashiers()).toEqual([])
		replies["pos_next.api.device.set_cashier_pin"] = () =>
			json({ message: { pin: verifier } })

		await auth.setCashierPin({ pin: PIN, pwd: "secret" })

		expect(lastCall("device.set_cashier_pin").headers.Authorization).toBe(
			"Bearer posg_a@example.com",
		)
		expect(auth.knownCashiers()).toHaveLength(1)
	})
})

describe("verifyPin", () => {
	const user = "a@example.com"

	beforeEach(async () => {
		await enroll()
		await signIn()
	})

	it("accepts the PIN from the last online sign-in", async () => {
		expect(await auth.verifyPin(user, PIN)).toEqual({ ok: true })
	})

	it("refuses a wrong PIN", async () => {
		expect(await auth.verifyPin(user, "000000")).toEqual({
			ok: false,
			reason: "wrong",
		})
	})

	it("refuses someone who never signed in here online", async () => {
		expect(await auth.verifyPin("b@example.com", PIN)).toEqual({
			ok: false,
			reason: "no_pin",
		})
	})

	it("locks after five failures, even for the right PIN", async () => {
		for (let index = 0; index < 5; index++) await auth.verifyPin(user, "000000")

		const result = await auth.verifyPin(user, PIN)

		expect(result).toEqual({ ok: false, reason: "locked", retryInSeconds: 60 })
	})

	it("keeps counting failures across a restart", async () => {
		for (let index = 0; index < 5; index++) await auth.verifyPin(user, "000000")

		await restart()

		expect((await auth.verifyPin(user, PIN)).reason).toBe("locked")
	})

	it("opens again after the lock, and a success clears the count", async () => {
		for (let index = 0; index < 5; index++) await auth.verifyPin(user, "000000")

		vi.advanceTimersByTime(60 * 1000)

		expect(await auth.verifyPin(user, PIN)).toEqual({ ok: true })
		expect(await auth.verifyPin(user, "000000")).toEqual({
			ok: false,
			reason: "wrong",
		})
	})

	it("stops accepting the PIN after too many failures, until an online sign-in", async () => {
		for (let index = 0; index < 20; index++) {
			await auth.verifyPin(user, "000000")
			vi.advanceTimersByTime(16 * 60 * 1000)
		}

		expect(await auth.verifyPin(user, PIN)).toEqual({
			ok: false,
			reason: "no_pin",
		})
		expect(auth.knownCashiers()).toEqual([])

		await signIn()
		expect(await auth.verifyPin(user, PIN)).toEqual({ ok: true })
	})

	it("stops at the maximum offline period", async () => {
		vi.advanceTimersByTime(71 * HOUR)
		expect((await auth.verifyPin(user, PIN)).ok).toBe(true)

		vi.advanceTimersByTime(HOUR)
		expect(await auth.verifyPin(user, PIN)).toEqual({
			ok: false,
			reason: "expired",
		})
	})

	it("uses the limit the server gave", async () => {
		await signIn(user, { max_offline_hours: 1 })

		vi.advanceTimersByTime(HOUR)

		expect(await auth.verifyPin(user, PIN)).toEqual({
			ok: false,
			reason: "expired",
		})
	})

	it("is not fooled by moving the clock back", async () => {
		vi.advanceTimersByTime(70 * HOUR)
		await auth.verifyPin(user, PIN)

		vi.setSystemTime(START + HOUR)

		expect(await auth.verifyPin(user, PIN)).toEqual({
			ok: false,
			reason: "expired",
		})
	})
})

describe("signInWithPin", () => {
	const user = "a@example.com"

	beforeEach(async () => {
		await enroll()
		await signIn()
	})

	it("signs in while the server is out of reach", async () => {
		online = false
		identity.saveIdentity(null)

		expect(await auth.signInWithPin({ user, pin: PIN })).toEqual({ ok: true })
		expect(identity.readIdentity().userId).toBe(user)
	})

	it("is refused while the server is reachable", async () => {
		expect(await auth.signInWithPin({ user, pin: PIN })).toEqual({
			ok: false,
			reason: "online",
		})
	})

	it("signs nobody in on a wrong PIN", async () => {
		online = false
		identity.saveIdentity(null)

		await auth.signInWithPin({ user, pin: "000000" })

		expect(identity.readIdentity().userId).toBeNull()
	})

	it("keeps this cashier's own grant", async () => {
		online = false

		await auth.signInWithPin({ user, pin: PIN })

		expect(runtime.getCashierGrant()).toBe("posg_a@example.com")
	})

	it("drops the grant of the cashier before, so nobody acts as them", async () => {
		await signIn("b@example.com")
		online = false

		await auth.signInWithPin({ user, pin: PIN })

		expect(runtime.getCashierGrant()).toBeNull()
		expect(store.entries.has("pos_next_cashier_grant")).toBe(false)
	})
})

describe("signOut", () => {
	beforeEach(async () => {
		await enroll()
		await signIn()
	})

	it("ends the grant on the server, and the sign-in here", async () => {
		await auth.signOut()

		expect(lastCall("device.cashier_logout").headers.Authorization).toBe(
			"Bearer posg_a@example.com",
		)
		expect(runtime.getCashierGrant()).toBeNull()
		expect(store.entries.has("pos_next_cashier_grant")).toBe(false)
		expect(identity.readIdentity().userId).toBeNull()
	})

	it("works with no connection", async () => {
		online = false

		await auth.signOut()

		expect(runtime.getCashierGrant()).toBeNull()
		expect(identity.readIdentity().userId).toBeNull()
	})

	it("keeps the device enrolled and the PIN usable", async () => {
		await auth.signOut()

		expect(auth.isEnrolled()).toBe(true)
		expect(auth.knownCashiers()).toHaveLength(1)
	})

	it("asks the server nothing when there is no grant", async () => {
		await auth.signOut()
		fetch.mockClear()

		await auth.signOut()

		expect(fetch).not.toHaveBeenCalled()
	})
})

describe("dropRejectedGrant", () => {
	beforeEach(async () => {
		await enroll()
		await signIn()
	})

	it("ends the sign-in the server refused", async () => {
		expect(await auth.dropRejectedGrant("posg_a@example.com")).toBe(true)
		expect(runtime.getCashierGrant()).toBeNull()
	})

	it("ignores a late reply about an older grant", async () => {
		expect(await auth.dropRejectedGrant("posg_older")).toBe(false)
		expect(runtime.getCashierGrant()).toBe("posg_a@example.com")
	})
})

describe("noteServerContact", () => {
	const user = "a@example.com"

	beforeEach(async () => {
		await enroll()
		await signIn()
	})

	it("extends the offline period", async () => {
		vi.advanceTimersByTime(71 * HOUR)
		await auth.noteServerContact()

		vi.advanceTimersByTime(71 * HOUR)

		expect((await auth.verifyPin(user, PIN)).ok).toBe(true)
	})

	it("does not write on every reply", async () => {
		const set = vi.spyOn(store, "set")
		await auth.noteServerContact()
		await auth.noteServerContact()
		await auth.noteServerContact()

		expect(set).toHaveBeenCalledTimes(1)
	})

	it("counts for nobody without a grant", async () => {
		await auth.signOut()
		vi.advanceTimersByTime(71 * HOUR)
		await auth.noteServerContact()

		vi.advanceTimersByTime(2 * HOUR)

		expect((await auth.verifyPin(user, PIN)).reason).toBe("expired")
	})
})

describe("cashierMustSignIn", () => {
	beforeEach(async () => {
		await enroll()
		await signIn()
	})

	it("is false for a cashier with a grant", async () => {
		expect(await auth.cashierMustSignIn()).toBe(false)
	})

	it("is true once the offline period has passed", async () => {
		online = false
		vi.advanceTimersByTime(72 * HOUR)

		expect(await auth.cashierMustSignIn()).toBe(true)
		expect(auth.isWithinOfflineLimit()).toBe(false)
	})

	it("is false for a PIN session while the server is out of reach", async () => {
		await auth.dropRejectedGrant("posg_a@example.com")
		online = false

		expect(await auth.cashierMustSignIn()).toBe(false)
	})

	it("is true for a PIN session once the server is back", async () => {
		await auth.dropRejectedGrant("posg_a@example.com")

		expect(await auth.cashierMustSignIn()).toBe(true)
	})

	it("is true when nobody known is signed in", async () => {
		identity.saveIdentity({ userId: "unknown@example.com" })

		expect(await auth.cashierMustSignIn()).toBe(true)
	})

	it("remembers the latest time seen, so the clock cannot be moved back", async () => {
		online = false
		vi.advanceTimersByTime(60 * HOUR)
		await auth.cashierMustSignIn()

		vi.setSystemTime(START + HOUR)

		expect(auth.isWithinOfflineLimit()).toBe(false)
	})
})

describe("pinRefusalMessage", () => {
	it("gives the cashier the wait", () => {
		expect(
			auth.pinRefusalMessage({ reason: "locked", retryInSeconds: 30 }),
		).toContain("30")
	})

	it("explains every reason differently", () => {
		const reasons = ["expired", "no_pin", "online", "wrong"]
		const messages = reasons.map((reason) => auth.pinRefusalMessage({ reason }))
		expect(new Set(messages).size).toBe(reasons.length)
	})
})
