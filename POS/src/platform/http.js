/**
 * Sends the app's server requests to the right place outside the browser.
 *
 * Every request ends up in fetch: frappe-ui's call and createResource, and our own.
 * Wrapping it here keeps all of them unchanged, on every platform.
 *
 * @module platform/http
 */

import { getCashierGrant, getServerUrl, isNative } from "./runtime"

const SERVER_PATHS = /^\/(api|files|private|printview|assets)(\/|\?|$)/

/**
 * Rewrite a same-origin request for a remote server.
 * @param {string} url - The requested URL
 * @param {RequestInit} init - The request options
 * @param {{serverUrl: string, token: string|null}} target
 * @returns {{url: string, init: RequestInit}}
 */
export function resolveRequest(url, init, { serverUrl, token }) {
	if (!serverUrl || !SERVER_PATHS.test(url)) {
		return { url, init }
	}

	const headers = new Headers(init?.headers)
	headers.set("X-Frappe-Site-Name", new URL(serverUrl).hostname)
	if (token) {
		headers.set("Authorization", `Bearer ${token}`)
	}

	return { url: `${serverUrl}${url}`, init: { ...init, headers, credentials: "omit" } }
}

/**
 * A fetch that goes to the server, and reports how the server took the cashier's grant.
 * @param {typeof fetch} nativeFetch
 * @param {object} options
 * @param {() => {serverUrl: string, token: string|null}} options.getTarget
 * @param {() => void} [options.onAccepted] - The server answered this cashier
 * @param {(token: string) => void} [options.onRejected] - The server refused this grant
 * @returns {typeof fetch}
 */
export function createBridgedFetch(
	nativeFetch,
	{ getTarget, onAccepted, onRejected },
) {
	return async (input, init) => {
		if (typeof input !== "string") return nativeFetch(input, init)

		const target = getTarget()
		const request = resolveRequest(input, init, target)
		const response = await nativeFetch(request.url, request.init)

		if (target.token && request.url !== input) {
			if (response.status === 401) onRejected?.(target.token)
			else if (response.ok) onAccepted?.()
		}
		return response
	}
}

/**
 * Route fetch through the server chosen at enrollment. Does nothing on the web.
 * @param {{onAccepted?: () => void, onRejected?: (token: string) => void}} [callbacks]
 */
export function installHttpBridge(callbacks = {}) {
	if (!isNative) return

	window.fetch = createBridgedFetch(window.fetch.bind(window), {
		...callbacks,
		getTarget: () => ({ serverUrl: getServerUrl(), token: getCashierGrant() }),
	})
}
