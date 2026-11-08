import { describe, expect, it } from "vitest"
import {
	RETURN,
	SALE,
	buildNumberPrefix,
	findByInvoiceNumber,
	formatLocalNumber,
	getInvoiceNumbers,
	getShiftNumber,
	matchesInvoiceNumber,
	resolveNamingSeries,
} from "../localNumber"

describe("a naming series, resolved on the device", () => {
	it("puts the sale's year in ERPNext's sales series", () => {
		expect(resolveNamingSeries("ACC-SINV-.YYYY.-", "2026-11-09")).toBe("ACC-SINV-2026-")
	})

	it("puts the sale's year in the returns series", () => {
		expect(resolveNamingSeries("ACC-SINV-RET-.YYYY.-", "2026-11-09")).toBe("ACC-SINV-RET-2026-")
	})

	it("drops the counter, as the device numbers on its own", () => {
		expect(resolveNamingSeries("SINV-.YY.-.MM.-.#####", "2026-03-05")).toBe("SINV-26-03-")
	})

	it("reads every date part from the sale's date, not today's", () => {
		expect(resolveNamingSeries("S.YYYY.YY.MM.DD.MON.JJJ.WW", "2025-02-01")).toBe("S20252502" + "01FEB03205")
	})

	it("keeps the date of a posting date string on the device's calendar", () => {
		expect(resolveNamingSeries(".DD.", "2026-01-01")).toBe("01")
	})

	it("numbers the first days of January as week 00, the last of December as 53, as Frappe does", () => {
		expect(resolveNamingSeries(".WW.", "2027-01-01")).toBe("00")
		expect(resolveNamingSeries(".WW.", "2024-12-31")).toBe("53")
	})

	it("drops the parts it cannot work out: fields of the document and ERPNext's variables", () => {
		expect(resolveNamingSeries("INV-.{company}.-.FY.-.ABBR.-.pos_profile.-.YYYY.-", "2026-01-01")).toBe(
			"INV-----2026-",
		)
	})

	it("keeps a literal part as Frappe does", () => {
		expect(resolveNamingSeries("POS.YYYY.X-", "2026-01-01")).toBe("POS2026X-")
	})

	it("gives nothing for no series", () => {
		expect(resolveNamingSeries("", "2026-01-01")).toBe("")
		expect(resolveNamingSeries(null)).toBe("")
	})
})

describe("the shift's number", () => {
	it("is the last group of digits of the shift's name", () => {
		expect(getShiftNumber("POSA-OS-26-0000003")).toBe("3")
		expect(getShiftNumber("POS-OPEN-2026-00125-A")).toBe("125")
	})

	it("is the server's when it sends one", () => {
		expect(getShiftNumber("POSA-OS-26-0000003", "7")).toBe("7")
		expect(getShiftNumber("POSA-OS-26-0000003", 7)).toBe("7")
	})

	it("ignores an empty number from the server", () => {
		expect(getShiftNumber("POSA-OS-26-0000003", "")).toBe("3")
		expect(getShiftNumber("POSA-OS-26-0000003", null)).toBe("3")
	})

	it("is OF and four letters for a shift opened offline, never a real shift's number", () => {
		const number = getShiftNumber("pos_offline_0f1e2d3c-4b5a-4968-8776-5a4b3c2d1e0f")
		expect(number).toMatch(/^OF[0-9A-F]{4}$/)
		expect(getShiftNumber("pos_offline_0f1e2d3c-4b5a-4968-8776-5a4b3c2d1e0f")).toBe(number)
		expect(getShiftNumber("pos_offline_11111111-2222-4333-8444-555555555555")).not.toBe(number)
	})

	it("is nothing without a shift", () => {
		expect(getShiftNumber(null)).toBeNull()
	})
})

describe("the local number", () => {
	const series = { saleSeries: "ACC-SINV-.YYYY.-", returnSeries: "ACC-SINV-RET-.YYYY.-", date: "2026-11-09" }

	it("of the first sale of shift 3", () => {
		const prefix = buildNumberPrefix({ ...series, kind: SALE, shiftNumber: "3" })
		expect(formatLocalNumber(prefix, 1)).toBe("LACC-SINV-2026-3-00001")
	})

	it("of the first return of shift 3", () => {
		const prefix = buildNumberPrefix({ ...series, kind: RETURN, shiftNumber: "3" })
		expect(formatLocalNumber(prefix, 1)).toBe("LACC-SINV-RET-2026-3-00001")
	})

	it("of a return whose series is the sales series stays apart from the sales", () => {
		const sale = buildNumberPrefix({ ...series, returnSeries: series.saleSeries, kind: SALE, shiftNumber: "3" })
		const ret = buildNumberPrefix({ ...series, returnSeries: series.saleSeries, kind: RETURN, shiftNumber: "3" })
		expect(ret).toBe("LACC-SINV-2026-RET-3-")
		expect(ret).not.toBe(sale)
		expect(buildNumberPrefix({ ...series, returnSeries: null, kind: RETURN, shiftNumber: "3" })).toBe(ret)
	})

	it("keeps counting past five digits", () => {
		expect(formatLocalNumber("LX-3-", 123456)).toBe("LX-3-123456")
	})

	it("is nothing without a series or a shift", () => {
		expect(buildNumberPrefix({ ...series, saleSeries: null, kind: SALE, shiftNumber: "3" })).toBeNull()
		expect(buildNumberPrefix({ ...series, kind: SALE, shiftNumber: null })).toBeNull()
	})
})

describe("an invoice's numbers on screen", () => {
	it("are the local number alone before the server names the sale", () => {
		expect(
			getInvoiceNumbers({ name: "pos_offline_abc", posa_local_number: "LACC-SINV-2026-3-00001" }),
		).toEqual({ primary: "LACC-SINV-2026-3-00001", secondary: null })
	})

	it("are the server's name and the local number once it has", () => {
		expect(
			getInvoiceNumbers({ name: "ACC-SINV-2026-00042", posa_local_number: "LACC-SINV-2026-3-00001" }),
		).toEqual({ primary: "ACC-SINV-2026-00042", secondary: "LACC-SINV-2026-3-00001" })
	})

	it("read a queued row's server name and its data's local number", () => {
		const row = {
			offline_id: "pos_offline_abc",
			server_invoice: "ACC-SINV-2026-00042",
			data: { posa_local_number: "LACC-SINV-2026-3-00001" },
		}
		expect(getInvoiceNumbers(row)).toEqual({ primary: "ACC-SINV-2026-00042", secondary: "LACC-SINV-2026-3-00001" })
		expect(getInvoiceNumbers({ ...row, server_invoice: null }).primary).toBe("LACC-SINV-2026-3-00001")
	})

	it("are the name alone for an invoice made before local numbers", () => {
		expect(getInvoiceNumbers({ name: "ACC-SINV-2026-00042" })).toEqual({
			primary: "ACC-SINV-2026-00042",
			secondary: null,
		})
	})
})

describe("searching by either number", () => {
	const synced = { name: "ACC-SINV-2026-00042", posa_local_number: "LACC-SINV-2026-3-00001" }
	const queued = {
		offline_id: "pos_offline_abc",
		data: { offline_id: "pos_offline_abc", posa_local_number: "LACC-SINV-2026-3-00002" },
	}

	it("finds a synced invoice by its server name and by its local number", () => {
		expect(matchesInvoiceNumber(synced, "sinv-2026-00042")).toBe(true)
		expect(matchesInvoiceNumber(synced, "LACC-SINV-2026-3-00001")).toBe(true)
		expect(matchesInvoiceNumber(synced, "3-00001")).toBe(true)
	})

	it("finds a queued sale by its local number and by its device id", () => {
		expect(matchesInvoiceNumber(queued, "lacc-sinv-2026-3-00002")).toBe(true)
		expect(matchesInvoiceNumber(queued, "pos_offline_abc")).toBe(true)
		expect(matchesInvoiceNumber(queued, "3-00001")).toBe(false)
	})

	it("matches nothing on an empty search", () => {
		expect(matchesInvoiceNumber(synced, " ")).toBe(false)
	})

	it("picks out the invoice a whole number names", () => {
		expect(findByInvoiceNumber([queued, synced], "LACC-SINV-2026-3-00001")).toBe(synced)
		expect(findByInvoiceNumber([queued, synced], " lacc-sinv-2026-3-00002 ")).toBe(queued)
		expect(findByInvoiceNumber([queued, synced], "LACC-SINV-2026-3-0000")).toBeNull()
	})
})
