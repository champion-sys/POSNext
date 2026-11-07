import type { CapacitorConfig } from "@capacitor/cli"

// No server.url: the app has to start with no connection, so the frontend ships inside it
const config: CapacitorConfig = {
	appId: "digital.sanad.posnext",
	appName: "POS Next",
	webDir: "dist-android",
	// A debug build otherwise logs every plugin call with its arguments, and these carry
	// the database secret, the device token and the cashier's grant
	loggingBehavior: "none",
	server: {
		// Without it Capacitor only logs an old WebView and loads an app that cannot work
		errorPath: "webview-outdated.html",
	},
	android: {
		// Not 94, which is all the es2022 build target asks for: platform/auth.js calls
		// AbortSignal.timeout, and without it no device can enroll or sign in
		minWebViewVersion: 103,
	},
	plugins: {
		CapacitorSQLite: {
			// The plugin's default, spelled out because the app does not start without it
			androidIsEncryption: true,
		},
	},
}

export default config
