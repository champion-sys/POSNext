const { app } = require("electron")
const { autoUpdater } = require("electron-updater")

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

function checkForUpdates() {
	autoUpdater
		.checkForUpdates()
		.catch((error) => console.error("Update check failed:", error.message))
}

/**
 * Downloads in the background and installs when the app next quits, so an update never
 * interrupts a sale. The sales queue is stored per user, outside the installed files.
 * A dev run has no update feed.
 */
function startAutoUpdate() {
	if (!app.isPackaged) return

	autoUpdater.on("error", (error) =>
		console.error("Update failed:", error.message),
	)
	checkForUpdates()
	setInterval(checkForUpdates, CHECK_INTERVAL_MS)
}

module.exports = { startAutoUpdate }
