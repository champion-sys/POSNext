/**
 * Cut a text around what was searched for. The parts stay plain text, so a name that holds
 * markup, as one typed offline can, is shown and never parsed.
 * @param {string} [text]
 * @param {string} [query]
 * @returns {Array<{text: string, match: boolean}>}
 */
export function splitMatches(text, query) {
	const value = String(text ?? "")
	const term = String(query ?? "").trim()
	if (!term) return value ? [{ text: value, match: false }] : []

	const pattern = new RegExp(
		`(${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`,
		"gi",
	)
	return value
		.split(pattern)
		.map((part, index) => ({ text: part, match: index % 2 === 1 }))
		.filter((part) => part.text)
}
