/**
 * Text search for the SQLite stores. Cashiers type Arabic without its marks and spell
 * the same word several ways, so both the stored text and the search term go through
 * this before they are compared.
 *
 * @module platform/sql/searchText
 */

// Tashkeel, Quranic marks, superscript alef and the tatweel that only stretches a word
const MARKS = /[ؐ-ؚـً-ٰٟۖ-ۭ]/g
const ALEF_FORMS = /[آأإٱ-ٳ]/g
const ALEF = "ا"
const TAA_MARBUTA = /ة/g
const HEH = "ه"
const ALEF_MAKSURA = /ى/g
const YEH = "ي"

/**
 * @param {*} text
 * @returns {string}
 */
export function normalizeSearchText(text) {
	return String(text ?? "")
		.normalize("NFKC")
		.toLowerCase()
		.replace(MARKS, "")
		.replace(ALEF_FORMS, ALEF)
		.replace(TAA_MARBUTA, HEH)
		.replace(ALEF_MAKSURA, YEH)
		.replace(/\s+/g, " ")
		.trim()
}

/** @returns {string} The fields of a record, normalized. A term can never match across two of them. */
export function buildSearchText(...fields) {
	return fields.map(normalizeSearchText).join("\n")
}

/** The upper bound of a prefix range. A range uses the index, and needs no LIKE escaping. */
export const prefixEnd = (prefix) => `${prefix}￿`

export const placeholders = (list) => list.map(() => "?").join(",")

/** Split a list, so a statement never binds more variables than a device's SQLite allows */
export function chunk(list, size = 500) {
	const chunks = []
	for (let index = 0; index < list.length; index += size) {
		chunks.push(list.slice(index, index + size))
	}
	return chunks
}
