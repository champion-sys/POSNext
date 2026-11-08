import { beforeAll, describe, expect, it } from "vitest"
import { parseError } from "../errorHandler"

beforeAll(() => {
	globalThis.__ = (text) => text
})

describe("parseError offers a retry", () => {
	it.each([
		["a dropped connection", new TypeError("Failed to fetch")],
		["a gateway timeout", { httpStatus: 504, message: "Gateway Timeout" }],
		[
			"an aborted request",
			Object.assign(new Error("The user aborted a request."), {
				name: "AbortError",
			}),
		],
		["a timed out request", new Error("Request timed out")],
	])("for %s", (_name, error) => {
		expect(parseError(error).retryable).toBe(true)
	})

	it.each([
		[
			"a validation error",
			{
				httpStatus: 417,
				exc_type: "ValidationError",
				messages: ["Customer is required"],
			},
		],
		[
			"insufficient stock",
			{
				exc_type: "NegativeStockError",
				messages: ["1 units of Item A needed in Warehouse W"],
			},
		],
		["a pricing error", { messages: ["Item price not found"] }],
		["a payment error", { messages: ["Mode of payment Cash is not set"] }],
		[
			"a refused shift",
			{
				httpStatus: 417,
				exc_type: "ShiftConflictError",
				messages: ["POS Profile Main is already open"],
			},
		],
	])("not for %s, which would only fail again", (_name, error) => {
		expect(parseError(error).retryable).toBe(false)
	})
})
