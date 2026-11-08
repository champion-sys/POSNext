import { describe, expect, it } from "vitest"
import { errorText } from "../errorHandler"

/** A failed request the way frappe-ui throws it */
function requestError(messages) {
	const error = new Error(
		"/api/method/pos_next.api.invoices.submit_invoice ValidationError",
	)
	error.exc_type = "ValidationError"
	error.messages = messages
	return error
}

describe("errorText", () => {
	it("gives the server's own words for a failed request, not the request path", () => {
		const text = errorText(
			requestError(["<b>Customer</b> is required", "Second message"]),
			"Failed to save",
		)

		expect(text).toBe("Customer is required")
	})

	it("reads raw _server_messages", () => {
		const error = {
			exc_type: "ValidationError",
			_server_messages: JSON.stringify([
				JSON.stringify({ message: "Not enough stock", title: "Message" }),
			]),
		}

		expect(errorText(error, "Failed")).toBe("Not enough stock")
	})

	it("gives the fallback for a failed request that sent no message", () => {
		const error = new Error("/api/method/pos_next.api.x InternalServerError")
		error.exc_type = "InternalServerError"
		error.messages = []

		expect(errorText(error, "Failed to load")).toBe("Failed to load")
	})

	it("keeps a printer error's own text, connection words and all", () => {
		const text = errorText(
			new Error("Bluetooth connection to the printer was lost"),
			"Failed to print",
		)

		expect(text).toBe("Bluetooth connection to the printer was lost")
	})

	it.each([
		["an error with no message", new Error("")],
		["an empty object", {}],
		["nothing", undefined],
		["null", null],
	])("gives the fallback for %s", (_name, error) => {
		expect(errorText(error, "Failed to add payment")).toBe(
			"Failed to add payment",
		)
	})

	it("returns a thrown string as it is", () => {
		expect(errorText("Printer is offline", "Failed")).toBe("Printer is offline")
	})
})
