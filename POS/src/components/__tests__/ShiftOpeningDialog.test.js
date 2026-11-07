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
				fetch: vi.fn(async () => null),
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
		device.methods = [
			{ mode_of_payment: "Cash", is_wallet_payment: 0 },
			{ mode_of_payment: "Wallet", is_wallet_payment: 1 },
		]
		device.save = vi.fn(async () => {})
		shiftState.value = { pos_opening_shift: null, pos_profile: null, company: null, isOpen: false }
	})

	afterEach(() => {
		wrapper?.unmount()
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

	it("uses the server when it is online", async () => {
		offlineState.isOffline = false
		allowOffline()
		keepProfiles(MAIN)

		await open()

		expect(server.resources.get("pos_next.api.pos_profile.get_pos_profiles").fetch).toHaveBeenCalled()
		expect(wrapper.text()).not.toContain("You are offline")
	})
})
