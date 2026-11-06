import { createResource } from "frappe-ui"
import { computed, ref } from "vue"
import { localStore } from "@/platform/store"

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

let cachedShiftRestore = Promise.resolve()

/** Resolves once the shift kept on the device has been put back after a failed check */
export const whenCachedShiftRestored = () => cachedShiftRestore

async function restoreCachedShift() {
	const data = await localStore.getShift()
	if (!data) return

	shiftState.value = {
		pos_opening_shift: data.pos_opening_shift,
		pos_profile: data.pos_profile,
		company: data.company,
		isOpen: true,
		_initialElapsedMs: data._initialElapsedMs || 0,
		_receivedAt: data._receivedAt || Date.now(),
	}
}

function keepShift(data) {
	localStore.saveShift(data).catch((error) => console.error("Error caching shift data:", error))
}

function forgetShift() {
	localStore.clearShift().catch((error) => console.error("Error clearing cached shift data:", error))
}

const CLOSING_SHIFTS_KEY = "pos_next_closing_shifts"

function getClosingShifts() {
	return JSON.parse(localStorage.getItem(CLOSING_SHIFTS_KEY) || "[]")
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

export function useShift() {
	// Check for existing open shift
	const checkOpeningShift = createResource({
		url: "pos_next.api.shifts.check_opening_shift",
		auto: false,
		// false, because frappe-ui keeps the original answer when this returns null
		transform: (data) => (getClosingShifts().includes(data?.pos_opening_shift?.name) ? false : data),
		onSuccess(data) {
			if (data) {
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
