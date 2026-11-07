import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const SCRIPT = readFileSync(resolve(__dirname, "../../../../pos_next/public/js/queue_import.js"), "utf8")
const CENTER = readFileSync(
	resolve(__dirname, "../../../../pos_next/pos_next/page/pos_sync_center/pos_sync_center.js"),
	"utf8",
)

const escapeHtml = (value) =>
	String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;")

const translate = (text, values = []) =>
	values.reduce((result, value, index) => result.replace(`{${index}}`, value), text)

function loadScript() {
	const frappe = {
		pos_next: {},
		provide: vi.fn(),
		csrf_token: "token-1",
		dom: { freeze: vi.fn(), unfreeze: vi.fn() },
		msgprint: vi.fn(),
		utils: { escape_html: escapeHtml },
	}
	new Function("frappe", "__", "cint", SCRIPT)(frappe, translate, Number)
	return { QueueImport: frappe.pos_next.QueueImport, frappe }
}

const FILE = new File(["{}"], "queue.json", { type: "application/json" })

const RESULT = {
	stored: 2,
	already_known: 1,
	conflicts: 1,
	rejected: 1,
	problems: [],
	device_id: "device-1",
	server: "https://old.example.com",
	exported_at: "2026-11-07T10:00:00.000Z",
}

function respond(status, body, json = async () => body) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({ ok: status < 400, status, json })),
	)
}

describe("importing a queue file from the sync center", () => {
	let frappe
	let finished
	let importer

	beforeEach(() => {
		const loaded = loadScript()
		frappe = loaded.frappe
		finished = vi.fn()
		importer = new loaded.QueueImport(finished)
	})

	afterEach(() => vi.unstubAllGlobals())

	const shown = () => frappe.msgprint.mock.calls[0][0]

	it("posts the file itself, with the session's token", async () => {
		respond(200, { message: RESULT })

		await importer.upload(FILE)

		const [url, request] = fetch.mock.calls[0]
		expect(url).toBe("/api/method/pos_next.api.queue_import.import_queue_file")
		expect(request.method).toBe("POST")
		expect(request.headers["X-Frappe-CSRF-Token"]).toBe("token-1")
		expect(request.body.get("file").name).toBe("queue.json")
	})

	it("shows the four counts", async () => {
		respond(200, { message: { ...RESULT, stored: 12, already_known: 34, conflicts: 56, rejected: 78 } })

		await importer.upload(FILE)

		for (const text of ["Stored", "Already Known", "Conflicts", "Rejected", ">12<", ">34<", ">56<", ">78<"]) {
			expect(shown().message).toContain(text)
		}
	})

	it("is green when every row was taken", async () => {
		respond(200, { message: { ...RESULT, conflicts: 0, rejected: 0 } })
		await importer.upload(FILE)
		expect(shown().indicator).toBe("green")
	})

	it("is orange when a row was refused", async () => {
		respond(200, { message: RESULT })
		await importer.upload(FILE)
		expect(shown().indicator).toBe("orange")
	})

	it("prints nothing from the file as markup", async () => {
		const attack = "<img src=x onerror=alert(1)>"
		respond(200, {
			message: {
				...RESULT,
				device_id: attack,
				server: attack,
				exported_at: attack,
				problems: [{ offline_id: attack, status: "rejected", message: attack }],
			},
		})

		await importer.upload(FILE)

		expect(shown().message).not.toContain("<img")
		expect(shown().message).toContain("&lt;img")
	})

	it("says when the list of refused rows is cut short", async () => {
		respond(200, {
			message: {
				...RESULT,
				conflicts: 150,
				rejected: 50,
				problems: [{ offline_id: "a", status: "rejected", message: "Bad" }],
			},
		})

		await importer.upload(FILE)

		expect(shown().message).toContain("The first 1 of 200")
	})

	it("refreshes the page behind it", async () => {
		respond(200, { message: RESULT })
		await importer.upload(FILE)
		expect(finished).toHaveBeenCalledTimes(1)
	})

	it("passes on the reason the server gave", async () => {
		const message = "This queue file has a format this server cannot read. Nothing was imported."
		respond(417, { _server_messages: JSON.stringify([JSON.stringify({ message })]) })

		await importer.upload(FILE)

		expect(shown()).toMatchObject({ message, indicator: "red" })
	})

	it("explains a file the web server turned away before the app saw it", async () => {
		respond(413, {}, async () => {
			throw new Error("not json")
		})

		await importer.upload(FILE)

		expect(shown().message).toContain("too large")
	})

	it("does not say nothing was stored when it cannot know", async () => {
		respond(502, {}, async () => {
			throw new Error("not json")
		})

		await importer.upload(FILE)

		expect(shown().message).toContain("Upload the file again")
		expect(shown().message).not.toContain("Nothing was imported")
	})

	it("survives the connection dropping", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")))

		await importer.upload(FILE)

		expect(shown().indicator).toBe("red")
		expect(frappe.dom.unfreeze).toHaveBeenCalled()
		expect(finished).toHaveBeenCalledTimes(1)
	})
})

describe("the sync center page", () => {
	it("loads the script before it offers the button, so a click can open the file picker", () => {
		const load = CENTER.indexOf('frappe.require("/assets/pos_next/js/queue_import.js"')
		const button = CENTER.indexOf('add_inner_button(__("Import Queue File")')

		expect(load).toBeGreaterThan(-1)
		expect(button).toBeGreaterThan(load)
	})
})
