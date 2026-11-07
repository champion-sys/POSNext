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

describe("the database", () => {
	it("has the plugin's encryption on", () => {
		expect(config.plugins.CapacitorSQLite.androidIsEncryption).toBe(true)
	})

	it("does not ask for a fingerprint, which would stop a till with no cashier at it", () => {
		expect(config.plugins.CapacitorSQLite.androidBiometric).toBeUndefined()
	})

	it("keeps plugin calls out of the log, because they carry the database secret", () => {
		expect(config.loggingBehavior).toBe("none")
	})
})

describe("exporting the queue", () => {
	const manifest = JSON.parse(readFileSync(resolve(POS, "package.json"), "utf8"))

	it("has the plugins, pinned as the other Capacitor packages are", () => {
		for (const plugin of ["@capacitor/filesystem", "@capacitor/share"]) {
			expect(manifest.dependencies[plugin]).toMatch(/^\d+\.\d+\.\d+$/)
		}
	})

	it("has the file provider the Share plugin looks for", () => {
		const provider = parse("AndroidManifest.xml").querySelector("provider")

		expect(provider.getAttribute("android:authorities")).toBe("${applicationId}.fileprovider")
		expect(provider.getAttribute("android:exported")).toBe("false")
		expect(provider.getAttribute("android:grantUriPermissions")).toBe("true")
	})

	it("lets that provider reach the cache, where the file is written", () => {
		const cache = parse("res/xml/file_paths.xml").querySelector("cache-path")
		expect(cache.getAttribute("path")).toBe(".")
	})

	it("needs no storage permission", () => {
		const permissions = [...parse("AndroidManifest.xml").querySelectorAll("uses-permission")]
		const names = permissions.map((permission) => permission.getAttribute("android:name"))

		expect(names.filter((name) => /EXTERNAL_STORAGE|MANAGE_/.test(name))).toEqual([])
	})

	it("stays out of the web and desktop builds", () => {
		const shared = readFileSync(resolve(POS, "src/platform/capacitor.js"), "utf8")
		expect(shared).not.toContain("@capacitor/")
	})

	it("reaches the code that calls it through the Android build's copy", () => {
		const android = readFileSync(resolve(POS, "src/platform/capacitor.android.js"), "utf8")

		expect(android).toContain('import { Filesystem } from "@capacitor/filesystem"')
		expect(android).toContain('import { Share } from "@capacitor/share"')
		expect(android).toMatch(/export \{[^}]*\bFilesystem\b[^}]*\bShare\b[^}]*\}/)
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

	it("tells the cashier what to do on an older one, in both languages", () => {
		const page = readFileSync(resolve(POS, "public", config.server.errorPath), "utf8")

		expect(page).toContain("Google Play")
		expect(page).toContain("يلزم تحديث")
	})

	it("covers what the es2022 build target may emit", () => {
		const build = readFileSync(resolve(POS, "vite.config.android.mjs"), "utf8")

		expect(build).toContain('target: "es2022"')
		expect(config.android.minWebViewVersion).toBeGreaterThanOrEqual(94)
	})
})
