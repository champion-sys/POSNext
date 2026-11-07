import { describe, expect, it } from "vitest"
import {
	buildClosingDraft,
	buildLocalShift,
	buildShiftOpenPayload,
	ENTITY_SHIFT_CLOSE,
	ENTITY_SHIFT_OPEN,
	getInvoiceDependencies,
	getShiftManifest,
	getShiftOpenProblem,
	getUnfinishedCloses,
} from "../entities"
import { buildSyncEnvelope } from "../invoicePayload"

const LOCAL_SHIFT = "pos_offline_shift-1"

const opened = new Date(2026, 10, 7, 8, 30, 15).getTime()

const payload = (extra = {}) =>
	buildShiftOpenPayload({
		offlineId: LOCAL_SHIFT,
		posProfile: "Main",
		company: "Acme",
		cashier: "a@example.com",
		balanceDetails: [
			{ mode_of_payment: "Cash", opening_amount: "150.5" },
			{ mode_of_payment: "Card", opening_amount: "" },
		],
		timestamp: opened,
		...extra,
	})

const cached = { pos_profile: { name: "Main", warehouse: "W1" }, company: { name: "Acme" } }

describe("getInvoiceDependencies", () => {
	it("makes a sale wait for a shift still in the queue", () => {
		expect(getInvoiceDependencies({ posa_pos_opening_shift: LOCAL_SHIFT })).toEqual([LOCAL_SHIFT])
	})

	it("needs nothing for a shift the server knows", () => {
		expect(getInvoiceDependencies({ posa_pos_opening_shift: "POSA-OS-1" })).toEqual([])
	})
})

describe("buildShiftOpenPayload", () => {
	it("keeps when the shift opened, on the device's clock", () => {
		expect(payload().period_start_date).toBe("2026-11-07 08:30:15")
	})

	it("sends the amounts as the online path takes them", () => {
		expect(payload().balance_details).toEqual([
			{ mode_of_payment: "Cash", opening_amount: 150.5 },
			{ mode_of_payment: "Card", opening_amount: 0 },
		])
	})

	it("names who opened it and where, so the envelope can say", () => {
		const envelope = buildSyncEnvelope({ id: 3, entity: ENTITY_SHIFT_OPEN, depends_on: ["close-1"] }, payload())

		expect(envelope).toMatchObject({
			offline_id: LOCAL_SHIFT,
			entity: "shift_open",
			cashier: "a@example.com",
			pos_profile: "Main",
			depends_on: ["close-1"],
		})
		expect(envelope.payload.doctype).toBe("POS Opening Shift")
	})
})

describe("buildLocalShift", () => {
	const local = buildLocalShift(payload(), cached, opened)

	it("uses the queue record's id as the shift's name until the server gives it one", () => {
		expect(local.pos_opening_shift.name).toBe(LOCAL_SHIFT)
		expect(local.pos_opening_shift.offline_id).toBe(LOCAL_SHIFT)
	})

	it("belongs to its cashier, which is how the sign-out rule finds it", () => {
		expect(local.pos_opening_shift.user).toBe("a@example.com")
	})

	it("carries the documents the POS sells from", () => {
		expect(local.pos_profile).toEqual(cached.pos_profile)
		expect(local.company).toEqual(cached.company)
	})

	it("reads like a server shift to the closing draft", () => {
		const draft = buildClosingDraft(local.pos_opening_shift, [])

		expect(draft.pos_opening_shift).toBe(LOCAL_SHIFT)
		expect(draft.opening_offline_id).toBe(LOCAL_SHIFT)
		expect(draft.pos_profile).toBe("Main")
		expect(draft.user).toBe("a@example.com")
		expect(draft.payment_reconciliation.map((row) => row.mode_of_payment)).toEqual(["Cash", "Card"])
	})

	it("has just started", () => {
		expect(local._initialElapsedMs).toBe(0)
		expect(local._receivedAt).toBe(opened)
	})
})

describe("getShiftOpenProblem", () => {
	const device = { pastLimit: false, slotTaken: false, cached: 1, usable: 1 }

	it("lets a device with a profile allowed to open offline go ahead", () => {
		expect(getShiftOpenProblem(device)).toBeNull()
	})

	it("stops a device past the offline limit, as a sale would be", () => {
		expect(getShiftOpenProblem({ ...device, pastLimit: true })).toBe("past_limit")
	})

	it("keeps to one shift on a device", () => {
		expect(getShiftOpenProblem({ ...device, slotTaken: true })).toBe("slot_taken")
	})

	it("needs a profile kept for this cashier", () => {
		expect(getShiftOpenProblem({ ...device, cached: 0, usable: 0 })).toBe("no_profile")
	})

	it("needs the setting on", () => {
		expect(getShiftOpenProblem({ ...device, usable: 0 })).toBe("not_allowed")
	})

	it("stops a shift behind one of this cashier's that has no close, online or off", () => {
		expect(getShiftOpenProblem({ ...device, unsettled: true })).toBe("shift_unsettled")
		expect(getShiftOpenProblem({ ...device, unsettled: true, online: true })).toBe("shift_unsettled")
	})

	it("says to wait for the last shift when the device could not open one anyway", () => {
		expect(getShiftOpenProblem({ ...device, online: true, usable: 0 })).toBe("shift_finishing")
		expect(getShiftOpenProblem({ ...device, online: true, cached: 0, usable: 0 })).toBe("shift_finishing")
	})

	it("lets the queue take a shift behind the last one's close, online", () => {
		expect(getShiftOpenProblem({ ...device, online: true })).toBeNull()
	})
})

describe("getUnfinishedCloses", () => {
	const close = (offline_id, extra = {}) => ({ offline_id, entity: ENTITY_SHIFT_CLOSE, ...extra })

	it("lists closes the server has not finished", () => {
		expect(getUnfinishedCloses([close("c1"), close("c2", { server_status: "needs_review" })])).toEqual(["c1", "c2"])
	})

	it("leaves out those that ended, voided or not", () => {
		expect(getUnfinishedCloses([close("c1", { synced: true })])).toEqual([])
	})

	it("leaves out everything else", () => {
		expect(getUnfinishedCloses([{ offline_id: "s1", entity: "invoice" }, { offline_id: "s2" }])).toEqual([])
	})
})

describe("getShiftManifest", () => {
	const rows = [
		{ offline_id: "open", entity: ENTITY_SHIFT_OPEN, data: {} },
		{ offline_id: "before", entity: "invoice", data: { posa_pos_opening_shift: LOCAL_SHIFT } },
		{ offline_id: "after", entity: "invoice", data: { posa_pos_opening_shift: "POSA-OS-1" } },
		{ offline_id: "other", entity: "invoice", data: { posa_pos_opening_shift: "POSA-OS-2" } },
	]

	it("finds sales made before the shift got its real name", () => {
		expect(getShiftManifest(rows, "POSA-OS-1", LOCAL_SHIFT)).toEqual(["before", "after"])
	})

	it("finds them by the local name while it is the only one", () => {
		expect(getShiftManifest(rows, LOCAL_SHIFT, LOCAL_SHIFT)).toEqual(["before"])
	})

	it("works as before for a shift that was never local", () => {
		expect(getShiftManifest(rows, "POSA-OS-2")).toEqual(["other"])
	})

	it("does not match a record that names no shift", () => {
		const rows = [
			{ offline_id: "c", entity: "customer", data: {} },
			{ offline_id: "s", entity: "invoice", data: { posa_pos_opening_shift: null } },
		]

		expect(getShiftManifest(rows, "POSA-OS-2")).toEqual([])
		expect(getShiftManifest(rows, "POSA-OS-2", null)).toEqual([])
	})
})
