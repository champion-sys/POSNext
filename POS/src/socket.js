import { io } from "socket.io-client"
import { isNative } from "@/platform/runtime"
import { logger } from "@/utils/logger"

const log = logger.create("Socket")

let socket = null

/** Stands in when there is no connection, so code that listens for events needs no branch. */
const noSocket = {
	on: () => {},
	off: () => {},
	emit: () => {},
	connect: () => {},
	disconnect: () => {},
}

export function initSocket(siteNameOverride) {
	// Frappe's realtime server has no way in for a Bearer grant from a page on another origin.
	// Directly it refuses the origin. Behind nginx, which rewrites Origin, a WebSocket from a
	// page cannot carry the grant, and polling's CORS reply names the rewritten origin, so the
	// page may not read it. Pull sync covers these apps instead, except stock from other tills,
	// which needs the stock sync setting.
	if (isNative) return noSocket

	// Don't reinitialize if socket already exists
	if (socket) {
		return socket
	}

	try {
		// Try to get site name from various sources, prioritizing override
		const siteName =
			siteNameOverride ||
			window.site_name ||
			(window.frappe && window.frappe.boot && window.frappe.boot.sitename) ||
			window.location.hostname

		const host = window.location.hostname
		const port = window.location.port ? `:${__SOCKETIO_PORT__}` : ""
		const protocol = port ? "http" : "https"
		const url = `${protocol}://${host}${port}/${siteName}`

		log.debug("Initializing socket (lazy connection):", url)

		socket = io(url, {
			withCredentials: true,
			reconnectionAttempts: 3,
			autoConnect: false, // Lazy connect - only connect when explicitly needed
		})

		// Connect with error handling
		socket.on("connect_error", (error) => {
			console.warn("Socket connection error:", error.message)
		})

		socket.on("connect", () => {
			log.debug("Socket connected successfully")
		})

		// Don't auto-connect - let components connect when they need realtime features
		// Components can call socket.connect() when they need realtime functionality

		return socket
	} catch (error) {
		console.error("Failed to initialize socket:", error)
		return noSocket
	}
}

export function disconnectSocket() {
	if (socket) {
		socket.disconnect()
		socket = null
		log.debug("Socket disconnected and cleared")
	}
}

export function useSocket() {
	return socket
}
