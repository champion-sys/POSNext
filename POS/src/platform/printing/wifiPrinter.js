/**
 * Checks on a Wi-Fi printer before it is saved.
 *
 * @module platform/printing/wifiPrinter
 */

export const DEFAULT_WIFI_PORT = 9100

export const NAME_MISSING = "name_missing"
export const ADDRESS_INVALID = "address_invalid"
export const ADDRESS_TAKEN = "address_taken"
export const PORT_INVALID = "port_invalid"

const IPV4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/

/**
 * @param {string} address
 * @returns {boolean} Whether a printer on the network could have this IPv4 address
 */
export function isPrinterAddress(address) {
	if (!IPV4.test(address)) return false

	const parts = address.split(".")
	if (parts.some((part) => part.length > 1 && part.startsWith("0")))
		return false

	const [first, ...rest] = parts.map(Number)
	if (first === 0 || first === 127 || first >= 224) return false
	return first <= 255 && rest.every((part) => part <= 255)
}

/**
 * @param {{name: string, host: string, port?: string|number}} form
 * @param {Array<{host?: string, port?: number}>} [printers] - The printers already saved
 * @returns {{printer: {name: string, host: string, port: number}, errors: Object<string, string>}}
 *   The cleaned printer, and any error code for its name, host and port
 */
export function validateWifiPrinter({ name, host, port }, printers = []) {
	const printer = {
		name: String(name ?? "").trim(),
		host: String(host ?? "").trim(),
		port: port === "" || port == null ? DEFAULT_WIFI_PORT : Number(port),
	}

	const errors = {}
	if (!printer.name) errors.name = NAME_MISSING
	if (!isPrinterAddress(printer.host)) {
		errors.host = ADDRESS_INVALID
	} else if (
		printers.some(
			(saved) => saved.host === printer.host && saved.port === printer.port,
		)
	) {
		errors.host = ADDRESS_TAKEN
	}
	if (
		!Number.isInteger(printer.port) ||
		printer.port < 1 ||
		printer.port > 65535
	) {
		errors.port = PORT_INVALID
	}

	return { printer, errors }
}
