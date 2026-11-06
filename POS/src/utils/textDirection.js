/**
 * Direction for a piece of text that may not be in the interface language, such
 * as a server error.
 *
 * dir="auto" looks only at the first letter, so an Arabic sentence that opens with
 * a Latin name turns left-to-right and its full stop lands on the wrong side. The
 * language most of the words are in is the language of the sentence, which also
 * keeps an English error that quotes an Arabic name readable.
 *
 * @module utils/textDirection
 */

const WORDS = /\p{L}[\p{L}\p{M}]*/gu
const RTL_LETTERS = /[֐-ࣿיִ-﷿ﹰ-﻿]/

/**
 * @param {string} text
 * @returns {"rtl"|"ltr"}
 */
export function getTextDirection(text) {
	const words = (text || "").match(WORDS) || []
	const rtlWords = words.filter((word) => RTL_LETTERS.test(word)).length
	return rtlWords > 0 && rtlWords * 2 >= words.length ? "rtl" : "ltr"
}
