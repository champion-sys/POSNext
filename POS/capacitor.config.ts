import type { CapacitorConfig } from "@capacitor/cli"

// No server.url: the app has to start with no connection, so the frontend ships inside it
const config: CapacitorConfig = {
	appId: "digital.sanad.posnext",
	appName: "POS Next",
	webDir: "dist-android",
	android: {
		// Not 94, which is all the es2022 build target asks for: platform/auth.js calls
		// AbortSignal.timeout, and without it no device can enroll or sign in
		minWebViewVersion: 103,
	},
}

export default config
