/**
 * Sends the app's server requests to the right place outside the browser.
 *
 * Every request ends up in fetch: frappe-ui's call and createResource, and our own.
 * Wrapping it here keeps all of them unchanged, on every platform.
 *
 * @module platform/http
 */

import { getDeviceToken, getServerUrl, isNative } from "./runtime"

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

/** Route fetch through the server chosen at enrollment. Does nothing on the web. */
export function installHttpBridge() {
	if (!isNative) return

	const nativeFetch = window.fetch.bind(window)
	window.fetch = (input, init) => {
		if (typeof input !== "string") return nativeFetch(input, init)

		const request = resolveRequest(input, init, {
			serverUrl: getServerUrl(),
			token: getDeviceToken(),
		})
		return nativeFetch(request.url, request.init)
	}
}
