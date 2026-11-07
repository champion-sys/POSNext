import { createResource } from "frappe-ui"
import { computed, ref } from "vue"
import { readIdentity } from "@/platform/identity"
import { localStore } from "@/platform/store"
import { isLocalName } from "@/utils/offline/entities"

export const shiftState = ref({
	pos_opening_shift: null,
	pos_profile: null,
	company: null,
	isOpen: false,
	/** Initial elapsed ms at the moment shift data was received from server */
	_initialElapsedMs: 0,
	/** Local timestamp (Date.now()) when shift data was received */
	_receivedAt: 0,
})

/** Whether the open shift exists only on this device, so the server cannot take its work yet */
export const hasLocalShift = computed(() => isLocalName(shiftState.value.pos_opening_shift?.name))

let cachedShiftRestore = Promise.resolve()

/** Resolves once the shift kept on the device has been put back after a failed check */
export const whenCachedShiftRestored = () => cachedShiftRestore

/**
 * The shift stays on the device across a sign-out, so its cashier can carry on offline
 * with a PIN. The server's own record says whose it is.
 * @param {Object|null} data - As kept by localStore.saveShift
 * @param {string|null} [user]
 * @returns {boolean}
 */
function isOwnShift(data, user = readIdentity().userId) {
	return Boolean(user) && data?.pos_opening_shift?.user === user
}

function showShift(data) {
	shiftState.value = {
		pos_opening_shift: data.pos_opening_shift,
		pos_profile: data.pos_profile,
		company: data.company,
		isOpen: true,
		_initialElapsedMs: data._initialElapsedMs || 0,
		_receivedAt: data._receivedAt || Date.now(),
	}
}

async function restoreCachedShift() {
	const data = await localStore.getShift()
	if (!isOwnShift(data) || isClosing(data)) return

	showShift(data)
}

/**
 * A shift opened here that the server has not finished with, so its answers say nothing
 * about it yet.
 * @returns {Promise<Object|null>} As kept by localStore.saveShift
 */
async function findUnsettledShift() {
	const data = await localStore.getShift()
	if (!isOwnShift(data) || isClosing(data) || !isLocalName(data.pos_opening_shift.name)) return null

	const row = await localStore.getQueuedInvoice(data.pos_opening_shift.name)
	return row && !row.synced ? data : null
}

const shiftProfilesKey = (user) => `${SHIFT_PROFILES_PREFIX}${user}`

/**
 * Keep what opening a shift offline needs. A closed shift leaves the device, and the
 * server's list of POS Profiles is out of reach then.
 * @param {{pos_profile: Object, company: Object}} data - As the server reports a shift
 */
async function rememberShiftProfile({ pos_profile, company }) {
	const key = shiftProfilesKey(readIdentity().userId)
	const kept = (await localStore.getSetting(key)) || {}
	await localStore.setSetting(key, { ...kept, [pos_profile.name]: { pos_profile, company } })
}

/** @returns {Promise<Array<{pos_profile: Object, company: Object}>>} This cashier's, on this device */
export async function getCachedShiftProfiles() {
	return Object.values((await localStore.getSetting(shiftProfilesKey(readIdentity().userId))) || {})
}

function keepShift(data) {
	localStore.saveShift(data).catch((error) => console.error("Error caching shift data:", error))
	rememberShiftProfile(data).catch((error) => console.error("Error keeping the POS Profile:", error))
}

/** @returns {Promise<boolean>} Whether another cashier's shift holds the one slot on this device */
export async function isShiftSlotTaken() {
	const data = await localStore.getShift()
	return Boolean(data?.pos_opening_shift) && !isOwnShift(data)
}

/**
 * Start selling in a shift the server does not know yet.
 * @param {Object} data - From buildLocalShift
 */
export async function openLocalShift(data) {
	await localStore.saveShift(data)
	showShift(data)
}

/**
 * Give a shift opened offline the name the server gave it. Queued records keep the local
 * name, which the server resolves.
 * @param {string} localName
 * @param {string} serverName
 * @returns {Promise<boolean>} Whether it is the shift this cashier is working in
 */
export async function adoptServerShift(localName, serverName) {
	const renamed = (data) => ({ ...data, pos_opening_shift: { ...data.pos_opening_shift, name: serverName } })

	const kept = await localStore.getShift()
	if (kept?.pos_opening_shift?.name === localName) await localStore.saveShift(renamed(kept))

	const isCurrent = shiftState.value.pos_opening_shift?.name === localName
	if (isCurrent) shiftState.value = renamed(shiftState.value)
	return isCurrent
}

/**
 * A manager voided a shift opened offline, so nothing more may be sold into it.
 * @param {string} localName
 * @returns {Promise<boolean>} Whether it is the shift this cashier is working in
 */
export async function abandonLocalShift(localName) {
	const kept = await localStore.getShift()
	if (kept?.pos_opening_shift?.name === localName) await localStore.clearShift()

	const isCurrent = shiftState.value.pos_opening_shift?.name === localName
	if (isCurrent) resetShiftState()
	return isCurrent
}

async function forgetShift() {
	// Read first: closing a shift can sign the cashier out while the device is being asked
	const user = readIdentity().userId
	try {
		// Another cashier having no shift says nothing about the one kept here
		if (isOwnShift(await localStore.getShift(), user)) await localStore.clearShift()
	} catch (error) {
		console.error("Error clearing cached shift data:", error)
	}
}

const CLOSING_SHIFTS_KEY = "pos_next_closing_shifts"
const SHIFT_PROFILES_PREFIX = "shift_profiles_"

function getClosingShifts() {
	return JSON.parse(localStorage.getItem(CLOSING_SHIFTS_KEY) || "[]")
}

/** @param {Object|null} data - A shift, as the server or the device reports it */
function isClosing(data) {
	const { name, offline_id } = data?.pos_opening_shift || {}
	return getClosingShifts().some((shift) => shift === name || shift === offline_id)
}

/**
 * A shift closed offline stays open on the server until that close arrives, and
 * nothing more may be sold into it on this device meanwhile.
 * @param {string} name - POS Opening Shift
 */
export function markShiftClosing(name) {
	localStorage.setItem(CLOSING_SHIFTS_KEY, JSON.stringify([...getClosingShifts(), name]))
}

/**
 * @param {string} name - POS Opening Shift
 */
export function clearShiftClosing(name) {
	const remaining = getClosingShifts().filter((shift) => shift !== name)
	localStorage.setItem(CLOSING_SHIFTS_KEY, JSON.stringify(remaining))
}

export function resetShiftState() {
	shiftState.value = {
		pos_opening_shift: null,
		pos_profile: null,
		company: null,
		isOpen: false,
		_initialElapsedMs: 0,
		_receivedAt: 0,
	}
	forgetShift()
}

/** @param {Object|null} data - The answer of check_opening_shift */
async function applyServerShift(data) {
	const unsettled = await findUnsettledShift().catch(() => null)
	if (unsettled && data?.pos_opening_shift?.offline_id !== unsettled.pos_opening_shift.name) {
		showShift(unsettled)
		return
	}

	if (data && !isClosing(data)) {
		// Compute initial elapsed time using server timestamps
		// (avoids timezone mismatch between server and browser)
		let initialElapsedMs = 0
		if (data.server_now && data.pos_opening_shift?.period_start_date) {
			const serverNow = new Date(data.server_now).getTime()
			const shiftStart = new Date(data.pos_opening_shift.period_start_date).getTime()
			initialElapsedMs = Math.max(0, serverNow - shiftStart)
		}
		shiftState.value = {
			pos_opening_shift: data.pos_opening_shift,
			pos_profile: data.pos_profile,
			company: data.company,
			isOpen: true,
			_initialElapsedMs: initialElapsedMs,
			_receivedAt: Date.now(),
		}
		// Keep on the device for offline support
		keepShift({
			...data,
			_initialElapsedMs: initialElapsedMs,
			_receivedAt: Date.now(),
		})
	} else {
		resetShiftState()
	}
}

export function useShift() {
	// Check for existing open shift
	const checkOpeningShift = createResource({
		url: "pos_next.api.shifts.check_opening_shift",
		auto: false,
		// false, because frappe-ui keeps the original answer when this returns null
		transform: (data) => (isClosing(data) ? false : data),
		// frappe-ui gives onSuccess the server's answer, not what transform returned
		onSuccess(data) {
			cachedShiftRestore = applyServerShift(data).catch((e) => {
				console.error("Error applying the server's shift:", e)
			})
		},
		onError(error) {
			console.error("Error checking opening shift:", error)
			// Try to load from the device
			cachedShiftRestore = restoreCachedShift().catch((e) => {
				console.error("Error parsing cached shift data:", e)
			})
		},
	})

	// Get opening dialog data (POS profiles, payment methods, etc.)
	const getOpeningDialogData = createResource({
		url: "pos_next.api.shifts.get_opening_dialog_data",
		auto: false,
	})

	// Create new opening shift
	const createOpeningShift = createResource({
		url: "pos_next.api.shifts.create_opening_shift",
		makeParams({ pos_profile, company, balance_details }) {
			return {
				pos_profile,
				company,
				balance_details: JSON.stringify(balance_details),
			}
		},
		onSuccess(data) {
			shiftState.value = {
				pos_opening_shift: data.pos_opening_shift,
				pos_profile: data.pos_profile,
				company: data.company,
				isOpen: true,
				_initialElapsedMs: 0,
				_receivedAt: Date.now(),
			}
			keepShift({
				...data,
				_initialElapsedMs: 0,
				_receivedAt: Date.now(),
			})
		},
		onError(error) {
			console.error("Error creating opening shift:", error)
		},
	})

	// Get closing shift data
	const getClosingShiftData = createResource({
		url: "pos_next.api.shifts.get_closing_shift_data",
		makeParams({ opening_shift }) {
			return { opening_shift }
		},
		auto: false,
	})

	// Submit closing shift
	const submitClosingShift = createResource({
		url: "pos_next.api.shifts.submit_closing_shift",
		makeParams({ closing_shift }) {
			return { closing_shift: JSON.stringify(closing_shift) }
		},
		onSuccess() {
			resetShiftState()
		},
		onError(error) {
			console.error("Error submitting closing shift:", error)
		},
	})

	// Computed properties
	const hasOpenShift = computed(() => shiftState.value.isOpen)
	const currentShift = computed(() => shiftState.value.pos_opening_shift)
	const currentProfile = computed(() => shiftState.value.pos_profile)
	const currentCompany = computed(() => shiftState.value.company)

	return {
		// State
		shiftState,
		hasOpenShift,
		currentShift,
		currentProfile,
		currentCompany,

		// Resources
		checkOpeningShift,
		getOpeningDialogData,
		createOpeningShift,
		getClosingShiftData,
		submitClosingShift,
	}
}
