import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import config from "../../../capacitor.config"

const POS = resolve(__dirname, "../../..")

// `cap add` regenerates this project from a template with backups on and Capacitor's icon
const MAIN = resolve(POS, "android/app/src/main")

const read = (path) => readFileSync(resolve(MAIN, path))
const parse = (path) =>
	new DOMParser().parseFromString(read(path).toString(), "application/xml")

describe("Android backups", () => {
	const application = parse("AndroidManifest.xml").querySelector("application")

	it("are off, because a copy cannot unwrap its secrets on another phone", () => {
		expect(application.getAttribute("android:allowBackup")).toBe("false")
		expect(application.getAttribute("android:fullBackupContent")).toBe("false")
	})

	it("use extraction rules, because Android 12 ignores allowBackup for device transfer", () => {
		expect(application.getAttribute("android:dataExtractionRules")).toBe(
			"@xml/data_extraction_rules",
		)
	})

	describe.each(["cloud-backup", "device-transfer"])("%s", (section) => {
		const excluded = [
			...parse("res/xml/data_extraction_rules.xml").querySelectorAll(
				`${section} > exclude`,
			),
		]

		it("leaves out every domain, whole", () => {
			expect(
				excluded.map((rule) => rule.getAttribute("domain")).sort(),
			).toEqual(["database", "external", "file", "root", "sharedpref"])
			expect(excluded.every((rule) => rule.getAttribute("path") === ".")).toBe(
				true,
			)
		})
	})

	it("includes nothing back", () => {
		const rules = parse("res/xml/data_extraction_rules.xml")

		expect(rules.querySelector("parsererror")).toBeNull()
		expect(rules.querySelector("include")).toBeNull()
	})
})

describe("Android launcher icons", () => {
	const DENSITIES = { mdpi: 1, hdpi: 1.5, xhdpi: 2, xxhdpi: 3, xxxhdpi: 4 }
	const LEGACY_DP = 48
	const FOREGROUND_DP = 108

	const pngSize = (path) => {
		const file = read(path)
		return [file.readUInt32BE(16), file.readUInt32BE(20)]
	}

	it.each(Object.entries(DENSITIES))(
		"%s has the template's sizes",
		(density, factor) => {
			const folder = `res/mipmap-${density}`
			const legacy = LEGACY_DP * factor
			const foreground = FOREGROUND_DP * factor

			expect(pngSize(`${folder}/ic_launcher.png`)).toEqual([legacy, legacy])
			expect(pngSize(`${folder}/ic_launcher_round.png`)).toEqual([
				legacy,
				legacy,
			])
			expect(pngSize(`${folder}/ic_launcher_foreground.png`)).toEqual([
				foreground,
				foreground,
			])
		},
	)

	it("put the white logo on the logo's colour, not on white", () => {
		const logo = readFileSync(resolve(POS, "public/icon.svg"), "utf8")
		const [, color] = logo.match(/<rect[^>]*fill="(#[0-9A-Fa-f]{6})"/)
		const background = parse("res/values/ic_launcher_background.xml")

		expect(background.querySelector("color").textContent).toBe(color)
	})
})

describe("the minimum WebView", () => {
	const ABORT_SIGNAL_TIMEOUT_CHROME = 103

	it("has what enrolling and signing in call", () => {
		const auth = readFileSync(resolve(POS, "src/platform/auth.js"), "utf8")

		expect(auth).toContain("AbortSignal.timeout")
		expect(config.android.minWebViewVersion).toBeGreaterThanOrEqual(
			ABORT_SIGNAL_TIMEOUT_CHROME,
		)
	})

	it("covers what the es2022 build target may emit", () => {
		const build = readFileSync(resolve(POS, "vite.config.android.mjs"), "utf8")

		expect(build).toContain('target: "es2022"')
		expect(config.android.minWebViewVersion).toBeGreaterThanOrEqual(94)
	})
})
