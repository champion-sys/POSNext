/**
 * The words of the page shown when the database is locked. The translations live in that
 * same database, and the server may be out of reach, so each normal start keeps a copy.
 *
 * @module platform/lockedPageText
 */

import { __ } from "@/utils/translation"

export const LOCKED_TEXT_KEY = "pos_next_locked_text"

function currentText() {
	return {
		title: __("The data on this device is locked"),
		explanation: __(
			"POS Next cannot open the sales saved on this device, because the key that protects them cannot be read. Nothing has been deleted.",
		),
		warning: __(
			"Do not uninstall the app or clear its data. Sales that have not reached the server would be lost for good.",
		),
		support: __(
			"You cannot sell on this device until this is fixed. Call your manager or support and give them this code:",
		),
		retry: __("Try Again"),
	}
}

/** Called on a normal start, when the translations are at hand. */
export function rememberLockedPageText() {
	localStorage.setItem(LOCKED_TEXT_KEY, JSON.stringify(currentText()))
}

/** @returns {Object} What the page says, in the language it was last seen in */
export function lockedPageText() {
	if (window.translatedMessages) return currentText()

	try {
		return JSON.parse(localStorage.getItem(LOCKED_TEXT_KEY)) ?? currentText()
	} catch {
		return currentText()
	}
}
