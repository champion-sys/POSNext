import type { CapacitorConfig } from "@capacitor/cli"

// No server.url: the app has to start with no connection, so the frontend ships inside it
const config: CapacitorConfig = {
	appId: "digital.sanad.posnext",
	appName: "POS Next",
	webDir: "dist-android",
	android: {
		// vite.config.android.mjs targets es2022
		minWebViewVersion: 94,
	},
}

export default config
