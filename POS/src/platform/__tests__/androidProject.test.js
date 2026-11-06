import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"

// `cap add` regenerates this project from a template with backups on and Capacitor's icon
const MAIN = resolve(__dirname, "../../../android/app/src/main")

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
			expect(excluded.map((rule) => rule.getAttribute("domain")).sort()).toEqual(
				["database", "external", "file", "root", "sharedpref"],
			)
			expect(excluded.every((rule) => rule.getAttribute("path") === ".")).toBe(true)
		})
	})

	it("includes nothing back", () => {
		const rules = parse("res/xml/data_extraction_rules.xml")

		expect(rules.querySelector("parsererror")).toBeNull()
		expect(rules.querySelector("include")).toBeNull()
	})
})
