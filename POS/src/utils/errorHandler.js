/**
 * Common Error Handler for API Exceptions
 * Provides consistent error parsing and user-friendly messages
 *
 * Usage:
 *
 * import { parseError } from '@/utils/errorHandler'
 *
 * try {
 *   await api.submitInvoice()
 * } catch (error) {
 *   const errorContext = parseError(error)
 *   // errorContext = { title, message, type, technicalDetails, retryable }
 *
 *   // Set dialog state
 *   errorTitle.value = errorContext.title
 *   errorMessage.value = errorContext.message
 *   showErrorDialog.value = true
 * }
 */

import { isNetworkFailure } from "./offline/invoicePayload"

/**
 * Clean HTML and extra whitespace from error messages
 */
function cleanErrorMessage(rawMessage) {
	if (!rawMessage) return ""

	if (Array.isArray(rawMessage)) {
		return cleanErrorMessage(rawMessage[0])
	}

	if (typeof rawMessage === "object" && rawMessage !== null) {
		return cleanErrorMessage(
			rawMessage.message || rawMessage.title || rawMessage.value,
		)
	}

	let text = typeof rawMessage === "string" ? rawMessage : String(rawMessage)

	// Remove HTML tags
	if (typeof window !== "undefined" && typeof document !== "undefined") {
		// Not innerHTML: its images load, so an onerror in a message would run
		text = new DOMParser().parseFromString(text, "text/html").body.textContent || ""
	} else {
		text = text.replace(/<[^>]*>/g, " ")
	}

	return text.replace(/\s+/g, " ").trim()
}

const STORAGE_FULL = /quota|disk is full/i

/**
 * The first message the server sent with a failed request, cleaned for the screen
 * @param {Object} error - A frappe-ui request error, or the raw response body
 * @returns {string} The message, or "" when there is none
 */
function serverMessage(error) {
	if (Array.isArray(error.messages) && error.messages.length > 0) {
		return cleanErrorMessage(error.messages[0])
	}
	if (error._server_messages) {
		try {
			const serverMessages = JSON.parse(error._server_messages)
			if (serverMessages && serverMessages.length > 0) {
				const firstMessage = JSON.parse(serverMessages[0])
				return cleanErrorMessage(firstMessage.message || firstMessage.title)
			}
		} catch {
			// Unreadable messages fall through to the caller's fallback
		}
	}
	return ""
}

/**
 * Text a cashier can read for an error.
 *
 * A failed server request carries "/api/method/<path> <ExcType>" in `message`, so its
 * own words come from the server's messages instead. Any other error, such as a printer,
 * Bluetooth, USB or storage error, keeps its own message unchanged.
 * @param {*} error - What was thrown
 * @param {string} [fallback] - Text for an error that says nothing
 * @returns {string}
 */
export function errorText(error, fallback = "") {
	if (!error) return fallback
	if (typeof error === "string") return error || fallback

	const fromServer =
		error.exc_type ||
		error._server_messages ||
		(Array.isArray(error.messages) && error.messages.length > 0)
	if (fromServer) return serverMessage(error) || fallback

	return error.message || fallback
}

/**
 * Parse error and return structured error information
 * @param {Error} error - The error object from API call
 * @returns {Object} - Structured error information
 */
export function parseError(error) {
	const context = {
		title: __("Error"),
		message: __("An unexpected error occurred"),
		type: "error", // error, warning, validation
		// Only a request that may not have reached the server is worth sending again
		retryable: false,
		technicalDetails: null,
	}

	// Stores pass only the text of an error across the worker and the app bridges
	if (STORAGE_FULL.test(`${error.name} ${error.message}`)) {
		context.title = __("Device storage is full")
		context.message = __(
			"Nothing was saved. Free some space on this device, then try again.",
		)
		return context
	}

	// Build technical details
	const detailsParts = []
	if (error.exc_type) detailsParts.push(__('Type: {0}', [error.exc_type]))
	if (error.httpStatus || error.status)
		detailsParts.push(__('Status: {0}', [error.httpStatus || error.status]))
	if (error.exception) detailsParts.push(__('Exception: {0}', [error.exception], "Error"))
	context.technicalDetails =
		detailsParts.length > 0 ? detailsParts.join(" | ") : null

	// Detect error type from status code
	if (error.httpStatus === 417 || error.status === 417) {
		context.type = "validation"
		context.title = __("Validation Error")
	} else if (error.httpStatus === 403 || error.status === 403) {
		context.type = "error"
		context.title = __("Permission Denied")
	} else if (error.httpStatus === 404 || error.status === 404) {
		context.type = "warning"
		context.title = __("Not Found")
	} else if (error.httpStatus >= 500 || error.status >= 500) {
		context.type = "error"
		context.title = __("Server Error")
	}

	// Extract primary message
	if (
		error.messages &&
		Array.isArray(error.messages) &&
		error.messages.length > 0
	) {
		context.message = cleanErrorMessage(error.messages[0])
	} else if (error._server_messages) {
		try {
			const serverMessages = JSON.parse(error._server_messages)
			if (serverMessages && serverMessages.length > 0) {
				const firstMessage = JSON.parse(serverMessages[0])
				context.message = cleanErrorMessage(
					firstMessage.message || firstMessage.title,
				)
				if (firstMessage.title) context.title = firstMessage.title
			}
		} catch (parseError) {
			console.error("Error parsing _server_messages:", parseError)
		}
	} else if (error.message) {
		context.message = cleanErrorMessage(error.message)
	}

	// Categorize by exception type and message content
	const normalizedMessage = (context.message || "").toLowerCase()
	const excType = (error.exc_type || "").toLowerCase()

	// Insufficient Stock
	if (
		excType === "negativestockerror" ||
		normalizedMessage.includes("needed in") ||
		normalizedMessage.includes("insufficient stock") ||
		normalizedMessage.includes("negative stock")
	) {
		context.type = "warning"
		context.title = __("Insufficient Stock")

		// Parse the message to extract item and quantity information
		// Example: "1.0 units of Item IPhone 17-WHI needed in Warehouse Goods In Transit - BrD"
		const match = context.message.match(
			/(\d+\.?\d*)\s+units?\s+of\s+(?:Item\s+)?(.+?)\s+needed\s+in\s+(?:Warehouse\s+)?(.+?)(?:\s+to complete|$)/i,
		)

		if (match) {
			const [, quantity, itemName, warehouse] = match
			const qty = Number.parseFloat(quantity)
			const unit = qty === 1 ? "unit" : "units"
			context.message = `Not enough stock for "${itemName}".\n\nYou need ${qty} ${unit} but the warehouse "${warehouse}" doesn't have enough available.\n\nPlease reduce the quantity or check another warehouse.`
		} else if (
			!context.message ||
			context.message === "An unexpected error occurred"
		) {
			context.message =
				__("Not enough stock available in the warehouse.\n\nPlease reduce the quantity or check stock availability.")
		}

		context.retryable = false
	}
	// Validation Errors
	else if (excType === "validationerror" || context.type === "validation") {
		context.type = "validation"
		context.title = __("Validation Error")
		context.retryable = false
	}
	// Price List Errors
	else if (
		normalizedMessage.includes("price list") ||
		normalizedMessage.includes("price not found")
	) {
		context.type = "warning"
		context.title = __("Pricing Error")
		context.retryable = false
	}
	// Customer/Party Errors
	else if (
		normalizedMessage.includes("customer") ||
		normalizedMessage.includes("party")
	) {
		context.type = "validation"
		context.title = __("Customer Error")
		context.retryable = false
	}
	// Tax Errors
	else if (
		normalizedMessage.includes("tax") ||
		normalizedMessage.includes("account")
	) {
		context.type = "warning"
		context.title = __("Tax Configuration Error")
		context.retryable = false
	}
	// Payment Errors
	else if (
		normalizedMessage.includes("payment") ||
		normalizedMessage.includes("mode of payment")
	) {
		context.type = "validation"
		context.title = __("Payment Error")
		context.retryable = false
	}
	// Series/Naming Errors
	else if (
		normalizedMessage.includes("series") ||
		normalizedMessage.includes("naming")
	) {
		context.type = "error"
		context.title = __("Naming Series Error")
		context.retryable = false
	}
	// Permission Errors
	else if (
		normalizedMessage.includes("permission") ||
		normalizedMessage.includes("not allowed")
	) {
		context.type = "error"
		context.title = __("Permission Denied")
		context.retryable = false
	}
	// Network/Connection Errors
	else if (
		isNetworkFailure(error) ||
		normalizedMessage.includes("network") ||
		normalizedMessage.includes("timeout") ||
		normalizedMessage.includes("timed out") ||
		normalizedMessage.includes("connection") ||
		normalizedMessage.includes("fetch")
	) {
		context.type = "warning"
		context.title = __("Connection Error")
		context.message =
			__("Unable to connect to server. Check your internet connection.")
		context.retryable = true
	}
	// Duplicate Errors
	else if (
		normalizedMessage.includes("duplicate") ||
		normalizedMessage.includes("already exists")
	) {
		context.type = "validation"
		context.title = __("Duplicate Entry")
		context.retryable = false
	}

	return context
}

/**
 * Format error for clipboard (for reporting)
 * @param {Object} errorContext - Parsed error context
 * @param {Object} additionalInfo - Additional context (user, profile, etc)
 * @returns {string} - Formatted error report
 */
export function formatErrorReport(errorContext, additionalInfo = {}) {
	const lines = [
		__("Error Report - POS Next"),
		"=".repeat(40),
		__('Title: {0}', [errorContext.title]),
		__('Type: {0}', [errorContext.type]),
		__('Message: {0}', [errorContext.message]),
		"",
	]

	if (errorContext.technicalDetails) {
		lines.push(__('Technical: {0}', [errorContext.technicalDetails]))
		lines.push("")
	}

	if (additionalInfo.timestamp) {
		lines.push(__('Timestamp: {0}', [additionalInfo.timestamp]))
	}
	if (additionalInfo.user) {
		lines.push(__('User: {0}', [additionalInfo.user]))
	}
	if (additionalInfo.posProfile) {
		lines.push(__('POS Profile: {0}', [additionalInfo.posProfile]))
	}

	return lines.join("\n")
}

/**
 * Get toast icon class based on error type
 * @param {string} errorType - error, warning, or validation
 * @returns {string} - Tailwind CSS class
 */
export function getErrorIconClass(errorType) {
	switch (errorType) {
		case "error":
			return "text-red-600"
		case "warning":
			return "text-orange-600"
		case "validation":
			return "text-yellow-600"
		default:
			return "text-red-600"
	}
}

/**
 * Handle API error with toast notification
 * @param {Error} error - The error object
 * @param {Function} toastFn - Toast creation function
 * @param {Object} options - Additional options
 */
export function handleApiError(error, toastFn, options = {}) {
	const errorContext = parseError(error)

	const toastOptions = {
		title: errorContext.title,
		text: errorContext.message,
		icon: "alert-circle",
		iconClasses: getErrorIconClass(errorContext.type),
		timeout: options.timeout || 6000,
	}

	if (toastFn) {
		toastFn(toastOptions)
	}

	return errorContext
}
