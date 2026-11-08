// @vitest-environment node
import Module, { createRequire } from "node:module"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"

const require = createRequire(import.meta.url)
const PRINTER = require.resolve("../../../../desktop/electron/printing/printer.js")

const windows = []

class BrowserWindow {
	constructor(options) {
		this.options = options
		this.loadURL = vi.fn(async () => {})
		this.close = vi.fn()
		this.webContents = {
			// The laid out receipt is 500 CSS pixels tall
			executeJavaScript: vi.fn(async () => 500),
			print: vi.fn((options, callback) => callback(true)),
		}
		windows.push(this)
	}
}

const originalLoad = Module._load
Module._load = function (request, ...rest) {
	if (request === "electron") return { BrowserWindow }
	return originalLoad.call(this, request, ...rest)
}
afterAll(() => {
	Module._load = originalLoad
})

delete require.cache[PRINTER]
const { LEGACY_PAGE_SIZE, printHTML, printJobOptions } = require(PRINTER)

const printed = () => windows.at(-1).webContents.print.mock.calls[0][0]

describe("printing a template on the desktop", () => {
	beforeEach(() => {
		windows.length = 0
		vi.useFakeTimers()
	})

	async function print(html, printer, options) {
		const done = printHTML(html, printer, options)
		await vi.runAllTimersAsync()
		return done
	}

	it("prints 80mm silently to the saved printer, as long as the receipt, with its copies", async () => {
		await print("<p>receipt</p>", "XP-80", { paper: "80mm", copies: 2 })

		expect(windows[0].options.width).toBe(303)
		expect(printed()).toMatchObject({ silent: true, deviceName: "XP-80", copies: 2, margins: { marginType: "none" } })
		expect(printed().pageSize.width).toBe(80000)
		// 500px and a little room, in microns
		expect(printed().pageSize.height).toBe(Math.ceil((508 * 25400) / 96))
	})

	it("prints 58mm at 58mm", async () => {
		await print("<p>ticket</p>", "XP-58", { paper: "58mm", copies: 1 })

		expect(windows[0].options.width).toBe(220)
		expect(printed().pageSize.width).toBe(58000)
		expect(printed().copies).toBe(1)
	})

	it("prints A4 and A5 on their own page sizes", async () => {
		await print("<p>invoice</p>", "Office", { paper: "A4", copies: 1 })
		expect(printed().pageSize).toBe("A4")
		expect(windows[0].options.width).toBe(794)

		await print("<p>invoice</p>", "Office", { paper: "A5", copies: 3 })
		expect(printed()).toMatchObject({ pageSize: "A5", copies: 3 })
	})

	it("keeps the built-in receipt's page when no template asked for one", async () => {
		await print("<p>built-in</p>", "XP-80")

		expect(windows[0].options.width).toBeUndefined()
		expect(windows[0].webContents.executeJavaScript).not.toHaveBeenCalled()
		expect(printed()).toMatchObject({ pageSize: LEGACY_PAGE_SIZE, copies: 1, silent: true })
	})

	it("opens the system dialog when no printer is saved", async () => {
		await print("<p>receipt</p>", "", { paper: "80mm" })

		expect(printed().silent).toBe(false)
	})

	it("loads the page as base64, so Arabic and a logo stay small", async () => {
		await print("<p>شكراً</p>", "XP-80", { paper: "80mm" })

		const url = windows[0].loadURL.mock.calls[0][0]
		expect(url.startsWith("data:text/html;charset=utf-8;base64,")).toBe(true)
		expect(Buffer.from(url.split(",")[1], "base64").toString("utf8")).toBe("<p>شكراً</p>")
	})

	it("passes on nothing else the page sends", () => {
		expect(printJobOptions({ paper: "Letter", copies: 500, deviceName: "evil", silent: false })).toEqual({
			paper: null,
			copies: 10,
		})
		expect(printJobOptions({ paper: "58mm", copies: "0" })).toEqual({ paper: "58mm", copies: 1 })
		expect(printJobOptions(undefined)).toEqual({ paper: null, copies: 1 })
	})

	it("says why a print failed", async () => {
		const done = printHTML("<p>x</p>", "XP-80", { paper: "80mm" })
		await vi.advanceTimersByTimeAsync(0)
		windows[0].webContents.print.mockImplementation((options, callback) => callback(false, "Printer offline"))
		await vi.runAllTimersAsync()

		await expect(done).rejects.toThrow("Printer offline")
		expect(windows[0].close).toHaveBeenCalled()
	})
})
