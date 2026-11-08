import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const css = readFileSync(path.resolve(__dirname, "../density.css"), "utf8")
// Read as text: the config pulls in frappe-ui's preset, which needs the build's module paths
const tailwindConfig = readFileSync(
	path.resolve(__dirname, "../../../tailwind.config.js"),
	"utf8",
)

/** The tokens in density.css, in pixels (1rem = 16px) */
function readTokens() {
	const tokens = {}
	for (const [, name, value, unit] of css.matchAll(
		/--(pos-[a-z-]+):\s*([\d.]+)(rem|px);/g,
	)) {
		tokens[name] = unit === "rem" ? Number(value) * 16 : Number(value)
	}
	return tokens
}

// Everything a finger presses on the selling screen is sized by one of these
const TARGETS = ["pos-bar", "pos-control", "pos-tap", "pos-action", "pos-key"]

describe("density tokens", () => {
	const tokens = readTokens()

	it("keeps every touch target at 32px or more, for the Android tablets", () => {
		for (const name of TARGETS) {
			expect(tokens[name], name).toBeGreaterThanOrEqual(32)
		}
	})

	it("makes no target smaller than a row's tap target", () => {
		for (const name of TARGETS) {
			expect(tokens[name], name).toBeGreaterThanOrEqual(tokens["pos-tap"])
		}
	})

	it("is compact by default: controls are under the old 44px", () => {
		expect(tokens["pos-control"]).toBeLessThan(44)
		expect(tokens["pos-bar"]).toBeLessThan(44)
	})

	it("gives every token a Tailwind spacing key of the same name", () => {
		const spacing = Object.fromEntries(
			[...tailwindConfig.matchAll(/"(pos-[a-z-]+)":\s*"([^"]+)"/g)].map(
				([, key, value]) => [key, value],
			),
		)
		expect(Object.keys(spacing).sort()).toEqual(Object.keys(tokens).sort())
		for (const name of Object.keys(tokens)) {
			expect(spacing[name]).toBe(`var(--${name})`)
		}
	})
})
