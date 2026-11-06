/**
 * Who is signed in. The browser learns it from Frappe's cookies, which do not exist
 * outside it, so the desktop and Android builds keep it from the cashier's sign-in.
 *
 * @module platform/identity
 */

import { isNative } from "./runtime"

const IDENTITY_KEY = "pos_next_cashier"

function readCookies() {
	return new Map(
		document.cookie
			.split("; ")
			.filter(Boolean)
			.map((cookie) => cookie.split("=").map(decodeURIComponent)),
	)
}

/** @returns {{userId: string|null, fullName: string|null, userImage: string|null}} */
export function readIdentity() {
	if (isNative) {
		try {
			return JSON.parse(localStorage.getItem(IDENTITY_KEY)) || emptyIdentity()
		} catch {
			return emptyIdentity()
		}
	}

	const cookies = readCookies()
	const userId = cookies.get("user_id") || null
	return {
		userId: userId === "Guest" ? null : userId,
		fullName: cookies.get("full_name") || null,
		userImage: cookies.get("user_image") || null,
	}
}

/** @param {{userId: string, fullName?: string, userImage?: string}|null} identity */
export function saveIdentity(identity) {
	if (identity) {
		localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity))
	} else {
		localStorage.removeItem(IDENTITY_KEY)
	}
}

function emptyIdentity() {
	return { userId: null, fullName: null, userImage: null }
}
