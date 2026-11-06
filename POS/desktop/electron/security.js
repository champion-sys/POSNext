/**
 * What the app's windows may load and where they may go. Nothing here depends on
 * Electron, so it can be tested without launching it.
 */

const { isAppPage } = require("./db/handler")

/**
 * Sent with every app:// response. The server is chosen at enrollment, and inside a shop's
 * network it may be plain http, so connections and images can only be limited by scheme.
 * Scripts are what this holds to the app's own files. Styles have to allow inline, because
 * Vue writes style attributes into its static markup.
 */
const CONTENT_SECURITY_POLICY = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
	"font-src 'self' data: https://fonts.gstatic.com",
	"img-src 'self' data: https: http:",
	"connect-src 'self' https: http: wss: ws:",
	"object-src 'none'",
	"frame-src 'none'",
	"frame-ancestors 'none'",
	"base-uri 'none'",
	"form-action 'self'",
].join("; ")

/** @param {string} url @returns {boolean} Whether the system browser may open this */
function isExternalLink(url) {
	return URL.canParse(url) && new URL(url).protocol === "https:"
}

/**
 * Keep a window on the app's own page. A link that opens a new window goes to the system
 * browser instead, because a second app window would load remote content, or a second
 * sender for the same sales queue.
 * @param {Electron.WebContents} contents
 * @param {Pick<Electron.Shell, "openExternal">} shell
 */
function confineToApp(contents, shell) {
	contents.on("will-navigate", (event, url) => {
		if (!isAppPage(url)) event.preventDefault()
	})

	contents.setWindowOpenHandler(({ url }) => {
		if (isExternalLink(url)) {
			shell
				.openExternal(url)
				.catch((error) => console.error("Could not open link:", error.message))
		}
		return { action: "deny" }
	})
}

module.exports = { CONTENT_SECURITY_POLICY, confineToApp, isExternalLink }
