import { mount } from "@vue/test-utils"
import { describe, expect, it } from "vitest"
import CheckboxField from "@/components/settings/CheckboxField.vue"
import NumberField from "@/components/settings/NumberField.vue"

describe("a setting only a manager may change", () => {
	it("can be read and not ticked", () => {
		const wrapper = mount(CheckboxField, { props: { modelValue: 1, label: "Allow Return", disabled: true } })

		expect(wrapper.find("input").element.checked).toBe(true)
		expect(wrapper.find("input").attributes("disabled")).toBeDefined()
	})

	it("can be read and not typed into", () => {
		const wrapper = mount(NumberField, { props: { modelValue: 10, label: "Max Discount", disabled: true } })

		expect(wrapper.find("input").element.value).toBe("10")
		expect(wrapper.find("input").attributes("disabled")).toBeDefined()
	})

	it("stays open to everyone else", () => {
		const wrapper = mount(CheckboxField, { props: { modelValue: 0, label: "Silent Print" } })
		expect(wrapper.find("input").attributes("disabled")).toBeUndefined()
	})
})
