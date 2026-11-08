/**
 * Handing out local numbers, with the device's storage faked by a Map that outlives the
 * module, as the real storage outlives a restart.
 */
import { beforeEach, describe, expect, it, vi } from "vitest"

const { settings } = vi.hoisted(() => ({ settings: new Map() }))

vi.mock("@/platform/store", () => ({
	localStore: {
		// A little latency, so allocations started together really do overlap
		getSetting: async (key) => {
			await new Promise((resolve) => setTimeout(resolve, 1))
			return settings.has(key) ? structuredClone(settings.get(key)) : null
		},
		setSetting: async (key, value) => {
			await new Promise((resolve) => setTimeout(resolve, 1))
			settings.set(key, structuredClone(value))
		},
	},
}))

const SHIFT = "POSA-OS-26-0000003"
const NUMBERING = {
	sale_series: "ACC-SINV-.YYYY.-",
	return_series: "ACC-SINV-RET-.YYYY.-",
	shift_number: "3",
	next: { sale: 1, return: 1 },
}
const sale = (extra = {}) => ({
	posa_pos_opening_shift: SHIFT,
	pos_profile: "Main",
	posting_date: "2026-11-09",
	...extra,
})

async function load() {
	vi.resetModules()
	return import("../localNumbering")
}

beforeEach(() => {
	settings.clear()
})

describe("handing out local numbers", () => {
	it("numbers sales and returns separately within a shift", async () => {
		const { allocateLocalNumber, rememberLocalNumbering } = await load()
		await rememberLocalNumbering(NUMBERING, { shift: SHIFT, posProfile: "Main" })

		expect(await allocateLocalNumber(sale())).toBe("LACC-SINV-2026-3-00001")
		expect(await allocateLocalNumber(sale())).toBe("LACC-SINV-2026-3-00002")
		expect(await allocateLocalNumber(sale({ is_return: 1 }))).toBe("LACC-SINV-RET-2026-3-00001")
		expect(await allocateLocalNumber(sale())).toBe("LACC-SINV-2026-3-00003")
	})

	it("never hands out a number twice to sales made at once", async () => {
		const { allocateLocalNumber, rememberLocalNumbering } = await load()
		await rememberLocalNumbering(NUMBERING, { shift: SHIFT, posProfile: "Main" })

		const numbers = await Promise.all(Array.from({ length: 25 }, () => allocateLocalNumber(sale())))

		expect(new Set(numbers).size).toBe(25)
		expect([...numbers].sort()).toEqual(
			Array.from({ length: 25 }, (_, i) => `LACC-SINV-2026-3-${String(i + 1).padStart(5, "0")}`),
		)
	})

	it("goes through the Web Locks API where the platform has it, so two tabs share one counter", async () => {
		let held = Promise.resolve()
		const request = vi.fn((name, task) => {
			const run = held.then(() => task())
			held = run.catch(() => {})
			return run
		})
		vi.stubGlobal("navigator", { ...globalThis.navigator, locks: { request } })
		try {
			// Two tabs: two copies of the module, one storage
			const tabA = await load()
			const tabB = await load()
			await tabA.rememberLocalNumbering(NUMBERING, { shift: SHIFT, posProfile: "Main" })

			const numbers = await Promise.all([
				tabA.allocateLocalNumber(sale()),
				tabB.allocateLocalNumber(sale()),
				tabA.allocateLocalNumber(sale()),
				tabB.allocateLocalNumber(sale()),
			])

			expect(new Set(numbers).size).toBe(4)
			expect(request).toHaveBeenCalledWith("pos_next_local_number", expect.any(Function))
		} finally {
			vi.unstubAllGlobals()
		}
	})

	it("carries on after a restart", async () => {
		const first = await load()
		await first.rememberLocalNumbering(NUMBERING, { shift: SHIFT, posProfile: "Main" })
		await first.allocateLocalNumber(sale())
		await first.allocateLocalNumber(sale())

		const restarted = await load()
		expect(await restarted.allocateLocalNumber(sale())).toBe("LACC-SINV-2026-3-00003")
	})

	it("continues from the server's next on a device that starts mid-shift", async () => {
		const { allocateLocalNumber, rememberLocalNumbering } = await load()
		await rememberLocalNumbering({ ...NUMBERING, next: { sale: 41, return: 6 } }, { shift: SHIFT })

		expect(await allocateLocalNumber(sale())).toBe("LACC-SINV-2026-3-00041")
		expect(await allocateLocalNumber(sale({ is_return: 1 }))).toBe("LACC-SINV-RET-2026-3-00006")
	})

	it("keeps its own count when the server's next falls behind it", async () => {
		const { allocateLocalNumber, rememberLocalNumbering } = await load()
		await rememberLocalNumbering(NUMBERING, { shift: SHIFT })
		for (let i = 0; i < 5; i++) await allocateLocalNumber(sale())

		await rememberLocalNumbering({ ...NUMBERING, next: { sale: 3, return: 1 } }, { shift: SHIFT })

		expect(await allocateLocalNumber(sale())).toBe("LACC-SINV-2026-3-00006")
	})

	it("counts each shift on its own", async () => {
		const { allocateLocalNumber, rememberLocalNumbering } = await load()
		await rememberLocalNumbering(NUMBERING, { shift: SHIFT })
		await rememberLocalNumbering({ ...NUMBERING, shift_number: "4" }, { shift: "POSA-OS-26-0000004" })
		await allocateLocalNumber(sale())

		expect(await allocateLocalNumber(sale({ posa_pos_opening_shift: "POSA-OS-26-0000004" }))).toBe(
			"LACC-SINV-2026-4-00001",
		)
	})

	it("works out the shift's number from its name when the server sends none", async () => {
		const { allocateLocalNumber, rememberLocalNumbering } = await load()
		await rememberLocalNumbering({ ...NUMBERING, shift_number: null }, { shift: "POSA-OS-26-0000012" })

		expect(await allocateLocalNumber(sale({ posa_pos_opening_shift: "POSA-OS-26-0000012" }))).toBe(
			"LACC-SINV-2026-12-00001",
		)
	})

	it("numbers a shift opened offline with the profile's series and an OF shift part", async () => {
		const { allocateLocalNumber, rememberLocalNumbering } = await load()
		await rememberLocalNumbering(NUMBERING, { shift: SHIFT, posProfile: "Main" })

		const number = await allocateLocalNumber(sale({ posa_pos_opening_shift: "pos_offline_aaaa-bbbb" }))

		expect(number).toMatch(/^LACC-SINV-2026-OF[0-9A-F]{4}-00001$/)
	})

	it("gives no number when the server never said how to number", async () => {
		const { allocateLocalNumber } = await load()

		expect(await allocateLocalNumber(sale())).toBeNull()
		expect(await allocateLocalNumber({ pos_profile: "Main" })).toBeNull()
	})

	it("ignores an answer without numbering, as an older server sends", async () => {
		const { allocateLocalNumber, rememberLocalNumbering } = await load()
		await rememberLocalNumbering(undefined, { shift: SHIFT, posProfile: "Main" })

		expect(await allocateLocalNumber(sale())).toBeNull()
	})

	it("reads the numbering wherever a shift's answer carries it", async () => {
		const { allocateLocalNumber, rememberShiftNumbering, readLocalNumbering } = await load()
		expect(readLocalNumbering({ shift: { local_numbering: NUMBERING } })).toBe(NUMBERING)

		await rememberShiftNumbering({
			pos_opening_shift: { name: SHIFT, pos_profile: "Main" },
			local_numbering: { ...NUMBERING, next: { sale: 9, return: 1 } },
		})

		expect(await allocateLocalNumber(sale())).toBe("LACC-SINV-2026-3-00009")
	})

	it("lets the sale go on without a number when the storage fails", async () => {
		const { allocateLocalNumber, rememberLocalNumbering } = await load()
		await rememberLocalNumbering(NUMBERING, { shift: SHIFT })
		const { localStore } = await import("@/platform/store")
		const original = localStore.setSetting
		localStore.setSetting = async () => {
			throw new Error("disk full")
		}
		try {
			expect(await allocateLocalNumber(sale())).toBeNull()
		} finally {
			localStore.setSetting = original
		}
		// Nothing was used up
		expect(await allocateLocalNumber(sale())).toBe("LACC-SINV-2026-3-00001")
	})
})
