import { describe, expect, it } from "vitest"
import { BROWSER, canUseBrowserPrint, getPrintRoute, NONE, SILENT, THERMAL } from "../printing/routes"

describe("getPrintRoute", () => {
	const ready = { thermalReady: true, silentPrint: true }
	const noPrinter = { thermalReady: false, silentPrint: false }

	it("prefers Bluetooth on the web", () => {
		expect(getPrintRoute("web", ready)).toBe(THERMAL)
	})

	it("uses QZ Tray on the web when silent printing is on", () => {
		expect(getPrintRoute("web", { thermalReady: false, silentPrint: true })).toBe(SILENT)
	})

	it("falls back to Chrome's dialog on the web", () => {
		expect(getPrintRoute("web", noPrinter)).toBe(BROWSER)
	})

	it("always goes through the system on desktop", () => {
		expect(getPrintRoute("electron", noPrinter)).toBe(SILENT)
		expect(getPrintRoute("electron", ready)).toBe(SILENT)
	})

	it("needs a paired printer on Android", () => {
		expect(getPrintRoute("android", ready)).toBe(THERMAL)
		expect(getPrintRoute("android", noPrinter)).toBe(NONE)
	})
})

describe("canUseBrowserPrint", () => {
	it("is only for the web", () => {
		expect(canUseBrowserPrint("web")).toBe(true)
		expect(canUseBrowserPrint("electron")).toBe(false)
		expect(canUseBrowserPrint("android")).toBe(false)
	})
})
