import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ settings: new Map(), call: vi.fn() }))

vi.mock("@/utils/apiWrapper", () => ({ call: mocks.call }))
vi.mock("@/utils/offline/settings", () => ({
	getSetting: vi.fn(async (key, fallback = null) => (mocks.settings.has(key) ? structuredClone(mocks.settings.get(key)) : fallback)),
	setSetting: vi.fn(async (key, value) => mocks.settings.set(key, structuredClone(value))),
}))

import {
	BUILTIN_LAYOUT,
	chooseTemplate,
	forgetKeptBundles,
	getPrintBundle,
	refreshPrintBundle,
	REFRESH_INTERVAL_MS,
	savePrintBundle,
} from "../bundle"
import { bundle } from "./fixtures"

const online = (value) => vi.spyOn(navigator, "onLine", "get").mockReturnValue(value)

describe("choosing the template", () => {
	it("takes the printer's own template first", () => {
		expect(chooseTemplate(bundle, "PT-0002").name).toBe("PT-0002")
	})

	it("then the profile's default", () => {
		expect(chooseTemplate(bundle, "").name).toBe("PT-0001")
		expect(chooseTemplate(bundle, undefined).name).toBe("PT-0001")
	})

	it("falls back to the default when the printer's template is gone", () => {
		expect(chooseTemplate(bundle, "PT-DELETED").name).toBe("PT-0001")
	})

	it("is none for a printer that chose the built-in layout", () => {
		expect(chooseTemplate(bundle, BUILTIN_LAYOUT)).toBeNull()
	})

	it("is none with no default, so the built-in layouts print as before", () => {
		expect(chooseTemplate({ ...bundle, default_template: null }, "")).toBeNull()
		expect(chooseTemplate({ templates: [], default_template: "PT-0001" }, "")).toBeNull()
		expect(chooseTemplate(null, "PT-0001")).toBeNull()
	})
})

describe("keeping the bundle on the device", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] })
		vi.setSystemTime(new Date("2026-11-08T10:00:00Z"))
		mocks.settings.clear()
		mocks.call.mockReset()
		forgetKeptBundles()
		online(true)
	})

	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it("keeps the bootstrap's bundle under its profile", async () => {
		await savePrintBundle(bundle)
		forgetKeptBundles()

		expect(mocks.settings.get("print_bundle:Main POS").bundle.default_template).toBe("PT-0001")
		mocks.call.mockResolvedValue(bundle)
		expect((await getPrintBundle("Main POS")).templates).toHaveLength(3)
	})

	it("asks the server at most every few minutes", async () => {
		mocks.call.mockResolvedValue(bundle)

		await refreshPrintBundle("Main POS")
		await refreshPrintBundle("Main POS")
		expect(mocks.call).toHaveBeenCalledTimes(1)
		expect(mocks.call).toHaveBeenCalledWith("pos_next.api.print_templates.get_print_bundle", { pos_profile: "Main POS" })

		vi.setSystemTime(Date.now() + REFRESH_INTERVAL_MS + 1)
		await refreshPrintBundle("Main POS")
		expect(mocks.call).toHaveBeenCalledTimes(2)
	})

	it("keeps the last copy offline and when the server fails", async () => {
		await savePrintBundle(bundle)
		vi.setSystemTime(Date.now() + REFRESH_INTERVAL_MS + 1)

		online(false)
		expect((await refreshPrintBundle("Main POS")).default_template).toBe("PT-0001")
		expect(mocks.call).not.toHaveBeenCalled()

		online(true)
		mocks.call.mockRejectedValue(new Error("502"))
		expect((await refreshPrintBundle("Main POS")).default_template).toBe("PT-0001")
		expect(mocks.call).toHaveBeenCalledTimes(1)
	})

	it("is the kept copy at once, refreshed behind", async () => {
		await savePrintBundle(bundle)
		vi.setSystemTime(Date.now() + REFRESH_INTERVAL_MS + 1)
		mocks.call.mockResolvedValue({ ...bundle, default_template: "PT-0002" })

		expect((await getPrintBundle("Main POS")).default_template).toBe("PT-0001")
		await vi.waitFor(() => expect(mocks.call).toHaveBeenCalledOnce())
		await vi.waitFor(async () => expect((await getPrintBundle("Main POS")).default_template).toBe("PT-0002"))
	})

	it("asks with the kept copy's stamp, and keeps the copy when nothing changed", async () => {
		await savePrintBundle(bundle)
		vi.setSystemTime(Date.now() + REFRESH_INTERVAL_MS + 1)
		mocks.call.mockResolvedValue({ unchanged: true, modified: bundle.modified })

		const kept = await refreshPrintBundle("Main POS")

		expect(mocks.call).toHaveBeenCalledWith("pos_next.api.print_templates.get_print_bundle", {
			pos_profile: "Main POS",
			since: "2026-11-08 10:00:00",
		})
		expect(kept.templates).toHaveLength(3)
		expect(mocks.settings.get("print_bundle:Main POS").bundle.templates).toHaveLength(3)
		// The unchanged answer counts as fresh: no new request until the interval passes
		await refreshPrintBundle("Main POS")
		expect(mocks.call).toHaveBeenCalledOnce()
	})

	it("takes a changed bundle in place of the kept one, such as a disabled template", async () => {
		await savePrintBundle(bundle)
		vi.setSystemTime(Date.now() + REFRESH_INTERVAL_MS + 1)
		mocks.call.mockResolvedValue({ ...bundle, templates: bundle.templates.slice(1), default_template: null, modified: "2026-11-08 11:00:00" })

		const kept = await refreshPrintBundle("Main POS")

		expect(kept.templates.map((template) => template.name)).toEqual(["PT-0002", "PT-0003"])
		expect(chooseTemplate(kept, "PT-0001")).toBeNull()
	})

	it("waits a minute after a failure before asking again", async () => {
		mocks.call.mockRejectedValue(new Error("timeout"))

		expect(await refreshPrintBundle("Main POS")).toBeNull()
		expect(await refreshPrintBundle("Main POS")).toBeNull()
		expect(mocks.call).toHaveBeenCalledOnce()

		vi.setSystemTime(Date.now() + 61 * 1000)
		mocks.call.mockResolvedValue(bundle)
		expect((await refreshPrintBundle("Main POS")).default_template).toBe("PT-0001")
	})

	it("ignores an answer that is not a bundle", async () => {
		await savePrintBundle(bundle)
		vi.setSystemTime(Date.now() + REFRESH_INTERVAL_MS + 1)
		mocks.call.mockResolvedValue(null)

		expect((await refreshPrintBundle("Main POS")).default_template).toBe("PT-0001")
	})
})
