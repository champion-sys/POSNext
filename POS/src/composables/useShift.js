import { createResource } from "frappe-ui"
import { computed, ref } from "vue"
import { readIdentity } from "@/platform/identity"
import { localStore } from "@/platform/store"
import { PARKED_SHIFTS_KEY, getUnfinishedShiftRecords, isLocalName } from "@/utils/offline/entities"
import { rememberShiftNumbering } from "@/utils/offline/localNumbering"

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

const getParkedShifts = async () => (await localStore.getSetting(PARKED_SHIFTS_KEY)) || {}

/**
 * @param {string} user
 * @param {Object|null} data - As kept by localStore.saveShift, none to forget what is parked
 */
async function setParkedShift(user, data) {
	const { [user]: _replaced, ...others } = await getParkedShifts()
	await localStore.setSetting(PARKED_SHIFTS_KEY, data ? { ...others, [user]: data } : others)
}

/**
 * A shift opened here that the server has not finished with, so its answers say nothing
 * about it yet.
 * @param {Object|null} data - As kept by localStore.saveShift
 * @returns {Promise<boolean>}
 */
async function isUnsettled(data) {
	const name = data?.pos_opening_shift?.name
	if (!isLocalName(name) || isClosing(data)) return false

	const row = await localStore.getQueuedInvoice(name)
	return Boolean(row) && !row.synced
}

/**
 * Put a shift in the one slot. A colleague's that the server has not finished with moves
 * aside for them, and a copy parked for this cashier has done its job.
 * @param {Object} data - As kept by localStore.saveShift
 */
async function takeSlot(data) {
	const user = data.pos_opening_shift.user
	const kept = await localStore.getShift()
	const keptFor = kept?.pos_opening_shift?.user
	if (keptFor !== user && (await isUnsettled(kept))) await setParkedShift(keptFor, kept)

	await localStore.saveShift(data)
	if ((await getParkedShifts())[user]) await setParkedShift(user, null)
}

/** @returns {Promise<Object|null>} This cashier's shift on the device, in the slot or parked */
async function findOwnShift() {
	const user = readIdentity().userId
	const kept = await localStore.getShift()
	if (isOwnShift(kept, user)) return kept

	const parked = (await getParkedShifts())[user]
	return isOwnShift(parked, user) ? parked : null
}

async function restoreCachedShift() {
	const data = await findOwnShift()
	if (data && !isClosing(data)) {
		await takeSlot(data)
		showShift(data)
	} else if (shiftState.value.isOpen && !isOwnShift(shiftState.value)) {
		// A sign-in that skipped the cleanup leaves the last cashier's shift on screen
		resetShiftState()
	}
}

/** @returns {Promise<Object|null>} This cashier's shift that the server has not finished with */
async function findUnsettledShift() {
	const data = await findOwnShift()
	return (await isUnsettled(data)) ? data : null
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
	takeSlot(data).catch((error) => console.error("Error caching shift data:", error))
	rememberShiftProfile(data).catch((error) => console.error("Error keeping the POS Profile:", error))
}

/**
 * @param {string} [posProfile] - The POS Profile to open, with none only this cashier's count
 * @returns {Promise<{closes: string[], unclosed: string[]}>} What a new shift would collide with
 */
export async function getCollidingShiftRecords(posProfile) {
	return getUnfinishedShiftRecords(await localStore.getQueueRows(), readIdentity().userId, posProfile)
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
	await takeSlot(data)
	showShift(data)
}

/** A queue record ends for its shift whoever is signed in, and its cashier may be away */
async function findParkedShift(name) {
	return Object.values(await getParkedShifts()).find((data) => data.pos_opening_shift?.name === name)
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

	const parked = await findParkedShift(localName)
	if (parked) await setParkedShift(parked.pos_opening_shift.user, renamed(parked))

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

	const parked = await findParkedShift(localName)
	if (parked) await setParkedShift(parked.pos_opening_shift.user, null)

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
		if ((await getParkedShifts())[user]) await setParkedShift(user, null)
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
		await takeSlot(unsettled)
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
		rememberShiftNumbering(data)
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
			rememberShiftNumbering(data)
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
