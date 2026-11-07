import { flushPromises, mount } from "@vue/test-utils"
import { beforeEach, describe, expect, it, vi } from "vitest"
import QueueExport from "../QueueExport.vue"

const mocks = vi.hoisted(() => ({ exportQueue: vi.fn() }))

vi.mock("frappe-ui", () => ({
	Button: { template: "<button @click=\"$emit('click')\"><slot /></button>", emits: ["click"] },
}))
vi.mock("@/utils/offline/queueFile", () => ({ exportQueue: mocks.exportQueue }))

globalThis.__ = (text, values = []) => text.replace("{0}", values[0])

function mountIt() {
	return mount(QueueExport, { global: { mocks: { __: globalThis.__ } } })
}

const buttonNamed = (wrapper, label) => wrapper.findAll("button").find((button) => button.text() === label)

async function askToExport() {
	const wrapper = mountIt()
	await buttonNamed(wrapper, "Export Queue").trigger("click")
	return wrapper
}

async function confirm() {
	const wrapper = await askToExport()
	await buttonNamed(wrapper, "Export File").trigger("click")
	await flushPromises()
	return wrapper
}

describe("QueueExport", () => {
	beforeEach(() => {
		mocks.exportQueue.mockReset().mockResolvedValue({ count: 3, saved: true })
	})

	it("writes nothing on the first click", async () => {
		await askToExport()
		expect(mocks.exportQueue).not.toHaveBeenCalled()
	})

	it("says the file is not encrypted before writing it", async () => {
		const warning = (await askToExport()).find('[role="alertdialog"]').text()

		expect(warning).toContain("not encrypted")
		expect(warning).toContain("customer and sale data")
		expect(warning).toContain("paper receipt book")
	})

	it("says the records stay queued", async () => {
		expect((await askToExport()).find('[role="alertdialog"]').text()).toContain("stay queued")
	})

	it("can be called off", async () => {
		const wrapper = await askToExport()

		await buttonNamed(wrapper, "Cancel").trigger("click")

		expect(mocks.exportQueue).not.toHaveBeenCalled()
		expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false)
	})

	it("exports once confirmed", async () => {
		const wrapper = await confirm()

		expect(mocks.exportQueue).toHaveBeenCalledTimes(1)
		expect(wrapper.find('[role="status"]').text()).toContain("3 record(s)")
		expect(wrapper.find('[role="alertdialog"]').exists()).toBe(false)
	})

	it("does not claim the file was saved", async () => {
		expect((await confirm()).find('[role="status"]').text()).toContain("Check that it was saved")
	})

	it("says when there was nothing to export", async () => {
		mocks.exportQueue.mockResolvedValue({ count: 0, saved: false })
		expect((await confirm()).find('[role="status"]').text()).toBe("Nothing is waiting on this device")
	})

	it("says when the person backed out of saving", async () => {
		mocks.exportQueue.mockResolvedValue({ count: 3, saved: false })
		expect((await confirm()).find('[role="status"]').text()).toBe("Export cancelled")
	})

	it("says so when the queue cannot be exported", async () => {
		mocks.exportQueue.mockRejectedValue(new Error("database disk image is malformed"))

		const status = (await confirm()).find('[role="status"]')

		expect(status.text()).toBe("Could not export the queue. No file was written.")
		expect(status.classes()).toContain("text-red-700")
	})

	it("forgets the last result when asked again", async () => {
		const wrapper = await confirm()

		await buttonNamed(wrapper, "Export Queue").trigger("click")

		expect(wrapper.find('[role="status"]').exists()).toBe(false)
	})
})
