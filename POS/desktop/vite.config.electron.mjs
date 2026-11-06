// Adapted from BrainWise-DEV/POSNext, branch feature/electron-desktop, commit 661d32f.
import path from "node:path"
import vue from "@vitejs/plugin-vue"
import frappeui from "frappe-ui/vite"
import { defineConfig } from "vite"

const POS_ROOT = path.resolve(__dirname, "..")

/**
 * The web store is tree-shaken from this build, but its worker asset is emitted while
 * modules load, before that happens. Nothing refers to the file, so it must not ship.
 */
const dropWebWorker = {
	name: "pos-drop-web-worker",
	generateBundle(_options, bundle) {
		for (const fileName of Object.keys(bundle)) {
			if (fileName.includes("offline.worker")) delete bundle[fileName]
		}
	},
}

/**
 * Frontend build for the desktop app. Unlike ../vite.config.js it has no PWA,
 * no Frappe proxy and no boot data from Jinja, and it uses relative asset paths.
 */
export default defineConfig({
	root: POS_ROOT,
	base: "./",
	plugins: [
		frappeui({ frappeProxy: false, jinjaBootData: false, lucideIcons: true, buildConfig: false }),
		vue(),
		dropWebWorker,
	],
	build: {
		outDir: path.resolve(__dirname, "renderer"),
		emptyOutDir: true,
		chunkSizeWarningLimit: 2000,
		target: "es2022",
		// Only the Android build has this plugin
		rollupOptions: { external: ["@capacitor-community/sqlite"] },
	},
	worker: { format: "es" },
	resolve: {
		alias: {
			"@": path.resolve(POS_ROOT, "src"),
			"tailwind.config.js": path.resolve(POS_ROOT, "tailwind.config.js"),
		},
	},
	define: {
		__BUILD_VERSION__: JSON.stringify(`desktop-${Date.now()}`),
		__SOCKETIO_PORT__: 9000,
		"import.meta.env.VITE_PLATFORM": JSON.stringify("electron"),
		"import.meta.env.VITE_ROUTER_BASE": JSON.stringify("/"),
	},
})
