import path from "node:path"
import vue from "@vitejs/plugin-vue"
import frappeui from "frappe-ui/vite"
import { defineConfig } from "vite"
import { dropWebWorker } from "./vite.native.mjs"

/**
 * Frontend build for the Android app. Like desktop/vite.config.electron.mjs it has no
 * PWA, no Frappe proxy and no boot data from Jinja. Unlike it, Capacitor serves the files
 * from the root of https://localhost, and the Capacitor plugins get swapped in.
 */
export default defineConfig({
	base: "/",
	plugins: [
		frappeui({
			frappeProxy: false,
			jinjaBootData: false,
			lucideIcons: true,
			buildConfig: false,
		}),
		vue(),
		dropWebWorker,
	],
	build: {
		outDir: path.resolve(__dirname, "dist-android"),
		emptyOutDir: true,
		chunkSizeWarningLimit: 2000,
		target: "es2022",
	},
	worker: { format: "es" },
	resolve: {
		alias: [
			{
				// Exact, or it would also catch the platform/capacitor folder
				find: /^@\/platform\/capacitor$/,
				replacement: path.resolve(
					__dirname,
					"src/platform/capacitor.android.js",
				),
			},
			{ find: "@", replacement: path.resolve(__dirname, "src") },
			{
				find: "tailwind.config.js",
				replacement: path.resolve(__dirname, "tailwind.config.js"),
			},
		],
	},
	define: {
		__BUILD_VERSION__: JSON.stringify(`android-${Date.now()}`),
		__SOCKETIO_PORT__: 9000,
		"import.meta.env.VITE_PLATFORM": JSON.stringify("android"),
		"import.meta.env.VITE_ROUTER_BASE": JSON.stringify("/"),
	},
})
