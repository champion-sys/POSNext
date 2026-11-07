/**
 * The real dialog, the real settings store and the real shift composable, offline. frappe-ui
 * is faked because it does not load under vitest.
 */
import { flushPromises, mount } from "@vue/test-utils"
import { createPinia, setActivePinia } from "pinia"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { shiftState } from "@/composables/useShift"
import { offlineState } from "@/utils/offline/offlineState"
import { holdFromSync, releaseFromSync } from "@/utils/offline/sync"
import ShiftOpeningDialog from "../ShiftOpeningDialog.vue"

const device = vi.hoisted(() => {
	globalThis.__ = (text) => text

	return {
		pastLimit: false,
		settings: new Map(),
		shift: null,
		methods: [],
		rows: [],
		save: null,
	}
})

const server = vi.hoisted(() => ({ resources: new Map() }))

vi.mock("frappe-ui", async () => {
	const { reactive } = await import("vue")
	return {
		Button: {
			props: ["disabled", "loading"],
			template: `<button :disabled="disabled" @click="$emit('click')"><slot /></button>`,
		},
		Dialog: { template: `<div><slot name="body-content" /><slot name="actions" /></div>` },
		Input: {
			props: ["modelValue"],
			emits: ["update:modelValue"],
			template: `<input :value="modelValue" @input="$emit('update:modelValue', $event.target.value)" />`,
		},
		createResource: (options) => {
			const resource = reactive({
				data: null,
				loading: false,
				error: null,
				fetch: vi.fn(async () => {
					if (options.url.endsWith("check_opening_shift")) server.check?.()
					return null
				}),
				submit: vi.fn(async () => null),
				reset: vi.fn(),
			})
			server.resources.set(options.url, resource)
			return resource
		},
	}
})

vi.mock("@/utils/offline/offlineState", () => ({
	offlineState: { isOffline: true, subscribe: () => () => {} },
}))

vi.mock("@/platform/store", () => ({
	localStore: {
		getSetting: async (key) => device.settings.get(key) ?? null,
		setSetting: async (key, value) => device.settings.set(key, value),
		getShift: async () => device.shift,
		saveShift: async (data) => {
			device.shift = data
		},
		clearShift: async () => {
			device.shift = null
		},
		getCachedPaymentMethods: async () => device.methods,
		getQueueRows: async () => device.rows,
	},
}))
vi.mock("@/utils/offline/workerClient", async () => ({
	offlineWorker: (await import("@/platform/store")).localStore,
}))
vi.mock("@/platform/auth", () => ({ isPastOfflineSaleLimit: () => device.pastLimit }))
vi.mock("@/stores/posSync", () => ({ usePOSSyncStore: () => ({ saveShiftOpenOffline: device.save }) }))
vi.mock("@/stores/bootstrap", () => ({ useBootstrapStore: () => ({ getPreloadedPOSSettings: () => null }) }))

const CASHIER = "a@example.com"

const MAIN = {
	pos_profile: { name: "Main", company: "Acme", currency: "SAR" },
	company: { name: "Acme" },
}

const button = (wrapper, label) => wrapper.findAll("button").find((found) => found.text() === label)

const allowOffline = (profile = "Main", value = 1) => {
	localStorage.setItem(`pos_next_settings_${profile}`, JSON.stringify({ allow_offline_shift_open: value }))
}

const keepProfiles = (...entries) => {
	device.settings.set(
		`shift_profiles_${CASHIER}`,
		Object.fromEntries(entries.map((entry) => [entry.pos_profile.name, entry])),
	)
}

describe("the shift opening dialog, offline", () => {
	let wrapper

	async function open() {
		wrapper = mount(ShiftOpeningDialog, {
			props: { modelValue: true },
			global: {
				mocks: { __: (text) => text },
				stubs: { ShiftClosingDialog: true, TranslatedHTML: true },
			},
		})
		await flushPromises()
	}

	async function goToAmounts() {
		await open()
		await wrapper.find(".cursor-pointer").trigger("click")
		await button(wrapper, "Next").trigger("click")
		await flushPromises()
	}

	beforeEach(() => {
		setActivePinia(createPinia())
		localStorage.clear()
		document.cookie = `user_id=${CASHIER}; path=/`
		offlineState.isOffline = true
		device.pastLimit = false
		device.settings.clear()
		device.shift = null
		device.rows = []
		device.methods = [
			{ mode_of_payment: "Cash", is_wallet_payment: 0 },
			{ mode_of_payment: "Wallet", is_wallet_payment: 1 },
		]
		device.save = vi.fn(async () => {})
		shiftState.value = { pos_opening_shift: null, pos_profile: null, company: null, isOpen: false }
	})

	afterEach(() => {
		wrapper?.unmount()
		server.check = null
		document.cookie = "user_id=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT"
	})

	describe("with the setting on and a profile kept on the device", () => {
		beforeEach(() => {
			allowOffline()
			keepProfiles(MAIN)
		})

		it("works from what the device has", async () => {
			await open()

			expect(wrapper.text()).toContain("Main")
			expect(wrapper.text()).toContain("You are offline")
			expect(server.resources.get("pos_next.api.pos_profile.get_pos_profiles").fetch).not.toHaveBeenCalled()
		})

		it("asks for the opening amounts of the kept methods, without wallets", async () => {
			await goToAmounts()

			expect(wrapper.text()).toContain("Cash")
			expect(wrapper.text()).not.toContain("Wallet")
			expect(server.resources.get("pos_next.api.shifts.get_opening_dialog_data").fetch).not.toHaveBeenCalled()
		})

		it("opens the shift with what was entered", async () => {
			await goToAmounts()
			await wrapper.find("input").setValue("250")

			await button(wrapper, "Open Shift").trigger("click")
			await flushPromises()

			expect(device.save).toHaveBeenCalledTimes(1)
			const [entry, amounts] = device.save.mock.calls[0]
			expect(entry.pos_profile.name).toBe("Main")
			expect(amounts).toEqual([{ mode_of_payment: "Cash", opening_amount: 250 }])
			expect(wrapper.emitted("shift-opened")).toHaveLength(1)
			expect(server.resources.get("pos_next.api.shifts.create_opening_shift")?.submit ?? vi.fn()).not.toHaveBeenCalled()
		})

		it("opens nothing once the limit has passed while it stood open", async () => {
			await goToAmounts()
			device.pastLimit = true

			await button(wrapper, "Open Shift").trigger("click")
			await flushPromises()

			expect(device.save).not.toHaveBeenCalled()
			expect(wrapper.emitted("shift-opened")).toBeUndefined()
			expect(wrapper.text()).toContain("offline too long")
		})

		it("keeps the shift a failed save did not open from being reported as opened", async () => {
			device.save = vi.fn(async () => {
				throw new Error("A shift is already open on this device")
			})
			await goToAmounts()

			await button(wrapper, "Open Shift").trigger("click")
			await flushPromises()

			expect(wrapper.emitted("shift-opened")).toBeUndefined()
		})

		it("shows the server's words for a refused shift, not the request behind them", async () => {
			await goToAmounts()

			server.resources.get("pos_next.api.shifts.create_opening_shift").error = Object.assign(
				new Error("/api/method/pos_next.api.shifts.create_opening_shift ShiftConflictError"),
				{
					exc_type: "ShiftConflictError",
					messages: ["POS Profile Main is already open by Administrator in shift SHIFT-1."],
				},
			)
			await flushPromises()

			expect(wrapper.text()).toContain("already open by Administrator in shift SHIFT-1")
			expect(wrapper.text()).not.toContain("ShiftConflictError")
		})

		it("offers only the profiles allowed to open offline", async () => {
			keepProfiles(MAIN, { ...MAIN, pos_profile: { ...MAIN.pos_profile, name: "Branch" } })

			await open()

			expect(wrapper.text()).toContain("Main")
			expect(wrapper.text()).not.toContain("Branch")
		})

		it("refuses a device past the offline limit, and says so", async () => {
			device.pastLimit = true

			await open()

			expect(wrapper.text()).toContain("offline too long")
			expect(wrapper.find(".cursor-pointer").exists()).toBe(false)
		})

		it("refuses while another cashier's shift holds the device, and says so", async () => {
			device.shift = { pos_opening_shift: { name: "pos_offline_other", user: "b@example.com" } }

			await open()

			expect(wrapper.text()).toContain("Another cashier's shift")
			expect(wrapper.find(".cursor-pointer").exists()).toBe(false)
		})

		it("offers the shift already open here, and no second one", async () => {
			shiftState.value = {
				pos_opening_shift: { name: "pos_offline_mine", period_start_date: "2026-11-07 08:00:00" },
				pos_profile: { name: "Main" },
				isOpen: true,
			}

			await open()

			expect(wrapper.text()).toContain("Resume Shift")
			expect(button(wrapper, "Close & Open New")).toBeUndefined()
			expect(wrapper.find(".cursor-pointer").exists()).toBe(false)
		})

		it("offers to close it first where closing offline is allowed", async () => {
			const { usePOSSettingsStore } = await import("@/stores/posSettings")
			usePOSSettingsStore().settings.allow_offline_shift_close = 1
			shiftState.value = {
				pos_opening_shift: { name: "pos_offline_mine" },
				pos_profile: { name: "Main" },
				isOpen: true,
			}

			await open()

			expect(button(wrapper, "Close & Open New")).toBeDefined()
		})

		it("will not close it from here while a queued sale is in the cart for editing", async () => {
			const { usePOSSettingsStore } = await import("@/stores/posSettings")
			usePOSSettingsStore().settings.allow_offline_shift_close = 1
			shiftState.value = {
				pos_opening_shift: { name: "pos_offline_mine" },
				pos_profile: { name: "Main" },
				isOpen: true,
			}
			holdFromSync("pos_offline_sale")

			await open()
			await button(wrapper, "Close & Open New").trigger("click")
			await flushPromises()
			releaseFromSync("pos_offline_sale")

			expect(wrapper.findComponent({ name: "ShiftClosingDialog" }).exists()).toBe(true)
			expect(wrapper.vm.showClosingDialog).toBe(false)
		})
	})

	it("says why with the setting off", async () => {
		allowOffline("Main", 0)
		keepProfiles(MAIN)

		await open()

		expect(wrapper.text()).toContain("not allowed for your POS Profile")
		expect(wrapper.find(".cursor-pointer").exists()).toBe(false)
	})

	it("says why with no settings kept for the profile", async () => {
		keepProfiles(MAIN)

		await open()

		expect(wrapper.text()).toContain("has not received that setting")
	})

	it("says why with no profile kept for this cashier", async () => {
		allowOffline()

		await open()

		expect(wrapper.text()).toContain("no POS Profile saved for you")
		expect(wrapper.find(".cursor-pointer").exists()).toBe(false)
	})

	it("does not offer a colleague's profile", async () => {
		allowOffline()
		device.settings.set("shift_profiles_b@example.com", { Main: MAIN })

		await open()

		expect(wrapper.find(".cursor-pointer").exists()).toBe(false)
	})

	it("does not offer a profile with no payment methods kept, which the server would refuse", async () => {
		allowOffline()
		keepProfiles(MAIN)
		device.methods = []

		await open()

		expect(wrapper.find(".cursor-pointer").exists()).toBe(false)
	})

	describe("online, with this cashier's last shift still on its way", () => {
		const OPENING = {
			offline_id: "pos_offline_old",
			entity: "shift_open",
			synced: false,
			data: { cashier: CASHIER, pos_profile: "Main" },
		}
		const CLOSING = {
			offline_id: "pos_offline_close",
			entity: "shift_close",
			synced: false,
			data: { cashier: CASHIER, pos_profile: "Main", pos_opening_shift: "pos_offline_old" },
		}

		const opensOnTheServer = () =>
			server.resources.get("pos_next.api.shifts.create_opening_shift").submit.mock.calls.length > 0

		beforeEach(() => {
			offlineState.isOffline = false
			device.rows = [OPENING, CLOSING]
			allowOffline()
			keepProfiles(MAIN)
		})

		it("opens the next one through the queue, not on the server", async () => {
			await goToAmounts()
			await wrapper.find("input").setValue("250")

			await button(wrapper, "Open Shift").trigger("click")
			await flushPromises()

			expect(device.save).toHaveBeenCalledTimes(1)
			expect(opensOnTheServer()).toBe(false)
			expect(wrapper.emitted("shift-opened")).toHaveLength(1)
		})

		it("says why it opens here, and does not call the cashier offline", async () => {
			await open()

			expect(wrapper.text()).toContain("still on its way to the server")
			expect(wrapper.text()).not.toContain("You are offline")
			expect(server.resources.get("pos_next.api.pos_profile.get_pos_profiles").fetch).not.toHaveBeenCalled()
		})

		it("refuses and says why where opening that way is not allowed", async () => {
			allowOffline("Main", 0)

			await open()

			expect(wrapper.text()).toContain("cannot open a shift until it arrives")
			expect(wrapper.find(".cursor-pointer").exists()).toBe(false)
			expect(server.resources.get("pos_next.api.pos_profile.get_pos_profiles").fetch).not.toHaveBeenCalled()
		})

		it("refuses and says why with no profile kept here", async () => {
			device.settings.clear()

			await open()

			expect(wrapper.text()).toContain("cannot open a shift until it arrives")
		})

		it("refuses a second shift behind one with no close, which would stay open and strand it", async () => {
			device.rows = [OPENING]

			await open()

			expect(wrapper.text()).toContain("so another cannot open yet")
			expect(wrapper.find(".cursor-pointer").exists()).toBe(false)
		})

		it("refuses that offline too", async () => {
			offlineState.isOffline = true
			device.rows = [OPENING]

			await open()

			expect(wrapper.text()).toContain("so another cannot open yet")
			expect(wrapper.find(".cursor-pointer").exists()).toBe(false)
		})

		it("offers the shift the server reports, instead of opening a second", async () => {
			server.check = () => {
				shiftState.value = {
					pos_opening_shift: { name: "POSA-OS-1" },
					pos_profile: { name: "Main" },
					isOpen: true,
				}
			}

			await open()

			expect(wrapper.text()).toContain("Existing Shift Found")
		})

		it("carries on from what it has when the server does not answer", async () => {
			server.check = () => {
				throw new Error("Failed to fetch")
			}

			await open()

			expect(wrapper.find(".cursor-pointer").exists()).toBe(true)
		})

		it("takes the queue after a shift closed in this dialog", async () => {
			device.rows = []
			await open()
			expect(server.resources.get("pos_next.api.pos_profile.get_pos_profiles").fetch).toHaveBeenCalledTimes(1)

			device.rows = [OPENING, CLOSING]
			await wrapper.vm.handleExistingShiftClosed()
			await flushPromises()

			expect(wrapper.text()).toContain("still on its way to the server")
			expect(wrapper.find(".cursor-pointer").exists()).toBe(true)
		})

		describe("when the record is a colleague's", () => {
			const colleagues = (row, pos_profile = "Main") => ({
				...row,
				data: { ...row.data, cashier: "b@example.com", pos_profile },
			})

			const choose = async () => {
				await open()
				server.resources.get("pos_next.api.pos_profile.get_pos_profiles").data = [MAIN.pos_profile]
				await flushPromises()
				await wrapper.find(".cursor-pointer").trigger("click")
				await button(wrapper, "Next").trigger("click")
				await flushPromises()
			}

			it("stays with the server for a POS Profile it has nothing to do with", async () => {
				device.rows = [colleagues(OPENING, "Other"), colleagues(CLOSING, "Other")]

				await choose()

				expect(server.resources.get("pos_next.api.shifts.get_opening_dialog_data").fetch).toHaveBeenCalled()
				expect(wrapper.text()).not.toContain("still on its way")
			})

			it("waits behind a close on this POS Profile, since the server keeps one shift open on it", async () => {
				device.rows = [colleagues(OPENING), colleagues(CLOSING)]

				await choose()
				await button(wrapper, "Open Shift").trigger("click")
				await flushPromises()

				expect(device.save).toHaveBeenCalledTimes(1)
				expect(opensOnTheServer()).toBe(false)
			})

			it("refuses a shift on this POS Profile that has no close to wait behind", async () => {
				device.rows = [colleagues(OPENING)]

				await choose()

				expect(wrapper.text()).toContain("so another cannot open yet")
				expect(button(wrapper, "Open Shift")).toBeUndefined()
			})

			it("refuses a close on this POS Profile where it cannot wait in the queue", async () => {
				device.rows = [colleagues(OPENING), colleagues(CLOSING)]
				allowOffline("Main", 0)

				await choose()

				expect(wrapper.text()).toContain("cannot open a shift until it arrives")
				expect(button(wrapper, "Open Shift")).toBeUndefined()
				expect(opensOnTheServer()).toBe(false)
			})

			it("refuses offline too, where parking left the slot empty", async () => {
				offlineState.isOffline = true
				device.rows = [colleagues(OPENING)]

				await open()

				expect(wrapper.text()).toContain("so another cannot open yet")
				expect(wrapper.find(".cursor-pointer").exists()).toBe(false)
			})

			it("does not get in the way offline on another POS Profile", async () => {
				offlineState.isOffline = true
				device.rows = [colleagues(OPENING, "Other")]

				await open()

				expect(wrapper.find(".cursor-pointer").exists()).toBe(true)
			})
		})

		it("stays with the server once the records have finished", async () => {
			device.rows = [{ ...OPENING, synced: true }, { ...CLOSING, synced: true }]

			await open()

			expect(server.resources.get("pos_next.api.pos_profile.get_pos_profiles").fetch).toHaveBeenCalled()
		})

		it("is not held back by a colleague's shift in the slot, which moves aside", async () => {
			device.shift = { pos_opening_shift: { name: "pos_offline_colleague", user: "b@example.com" } }

			await open()

			expect(wrapper.find(".cursor-pointer").exists()).toBe(true)
		})
	})

	it("uses the server when it is online", async () => {
		offlineState.isOffline = false
		allowOffline()
		keepProfiles(MAIN)

		await open()

		expect(server.resources.get("pos_next.api.pos_profile.get_pos_profiles").fetch).toHaveBeenCalled()
		expect(wrapper.text()).not.toContain("You are offline")
	})
})
