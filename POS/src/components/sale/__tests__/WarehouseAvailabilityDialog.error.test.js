/**
 * A failed stock lookup shows the server's words, not the request path and exception
 * name that frappe-ui puts in the error's message.
 */
import { flushPromises, mount } from "@vue/test-utils"
import { beforeEach, describe, expect, it, vi } from "vitest"
import WarehouseAvailabilityDialog from "../WarehouseAvailabilityDialog.vue"

const server = vi.hoisted(() => {
	globalThis.__ = (text) => text
	return { call: null }
})

vi.mock("frappe-ui", () => ({
	call: (...args) => server.call(...args),
	Dialog: { template: `<div><slot name="body-content" /></div>` },
}))

function requestError() {
	const error = new Error(
		"/api/method/pos_next.api.items.get_item_warehouse_availability PermissionError",
	)
	error.exc_type = "PermissionError"
	error.messages = ["You are not allowed to see stock in this company"]
	return error
}

describe("the stock lookup when the server refuses", () => {
	beforeEach(() => {
		server.call = vi.fn(async (method) => {
			if (method === "pos_next.api.items.get_items") return []
			throw requestError()
		})
	})

	it("shows the server's message", async () => {
		const wrapper = mount(WarehouseAvailabilityDialog, {
			props: { modelValue: true, itemCode: "ITEM-1", company: "Co" },
			global: { mocks: { __: (text) => text } },
		})
		await flushPromises()

		expect(wrapper.text()).toContain(
			"You are not allowed to see stock in this company",
		)
		expect(wrapper.text()).not.toContain("/api/method")
		expect(wrapper.text()).not.toContain("PermissionError")
		wrapper.unmount()
	})
})
