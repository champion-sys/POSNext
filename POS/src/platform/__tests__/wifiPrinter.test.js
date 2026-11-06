import { describe, expect, it } from "vitest"
import {
	ADDRESS_INVALID,
	ADDRESS_TAKEN,
	DEFAULT_WIFI_PORT,
	NAME_MISSING,
	PORT_INVALID,
	isPrinterAddress,
	validateWifiPrinter,
} from "../printing/wifiPrinter"

describe("isPrinterAddress", () => {
	it.each(["192.168.1.50", "10.0.0.1", "172.16.5.9", "8.8.8.8"])(
		"accepts %s",
		(address) => {
			expect(isPrinterAddress(address)).toBe(true)
		},
	)

	it.each([
		["", "empty"],
		["printer.local", "a name"],
		["192.168.1", "too short"],
		["192.168.1.50.1", "too long"],
		["192.168.1.256", "out of range"],
		["192.168.01.50", "a leading zero"],
		["0.0.0.0", "unspecified"],
		["127.0.0.1", "this device"],
		["224.0.0.1", "multicast"],
		["255.255.255.255", "broadcast"],
		[" 192.168.1.50", "surrounding space"],
	])("rejects %s (%s)", (address) => {
		expect(isPrinterAddress(address)).toBe(false)
	})
})

describe("validateWifiPrinter", () => {
	const form = { name: "Kitchen", host: "192.168.1.50", port: 9100 }

	it("accepts a complete form", () => {
		expect(validateWifiPrinter(form)).toEqual({ printer: form, errors: {} })
	})

	it("trims what was typed and reads the port as a number", () => {
		const { printer, errors } = validateWifiPrinter({
			name: " Kitchen ",
			host: " 192.168.1.50 ",
			port: "9101",
		})

		expect(printer).toEqual({
			name: "Kitchen",
			host: "192.168.1.50",
			port: 9101,
		})
		expect(errors).toEqual({})
	})

	it("uses the raw printing port when none is given", () => {
		expect(validateWifiPrinter({ ...form, port: "" }).printer.port).toBe(
			DEFAULT_WIFI_PORT,
		)
		expect(validateWifiPrinter({ ...form, port: undefined }).printer.port).toBe(
			DEFAULT_WIFI_PORT,
		)
	})

	it("needs a name", () => {
		expect(validateWifiPrinter({ ...form, name: "   " }).errors).toEqual({
			name: NAME_MISSING,
		})
	})

	it("needs a valid address", () => {
		expect(validateWifiPrinter({ ...form, host: "kitchen" }).errors).toEqual({
			host: ADDRESS_INVALID,
		})
	})

	it.each([0, 65536, -1, 91.5, "abc"])("rejects port %s", (port) => {
		expect(validateWifiPrinter({ ...form, port }).errors).toEqual({
			port: PORT_INVALID,
		})
	})

	it("refuses a printer that is already saved", () => {
		const saved = [{ host: "192.168.1.50", port: 9100 }]

		expect(validateWifiPrinter(form, saved).errors).toEqual({
			host: ADDRESS_TAKEN,
		})
	})

	it("allows a second printer on another port of the same address", () => {
		const saved = [{ host: "192.168.1.50", port: 9100 }]

		expect(validateWifiPrinter({ ...form, port: 9101 }, saved).errors).toEqual(
			{},
		)
	})

	it("reports every problem at once", () => {
		const { errors } = validateWifiPrinter({ name: "", host: "", port: 0 })

		expect(errors).toEqual({
			name: NAME_MISSING,
			host: ADDRESS_INVALID,
			port: PORT_INVALID,
		})
	})
})
