// Adapted from BrainWise-DEV/POSNext, branch feature/electron-desktop, commit 661d32f.
import path from "node:path"
import vue from "@vitejs/plugin-vue"
import frappeui from "frappe-ui/vite"
import { defineConfig } from "vite"
import { viteStaticCopy } from "vite-plugin-static-copy"

const POS_ROOT = path.resolve(__dirname, "..")

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
		viteStaticCopy({ targets: [{ src: "src/workers", dest: "." }] }),
	],
	build: {
		outDir: path.resolve(__dirname, "renderer"),
		emptyOutDir: true,
		chunkSizeWarningLimit: 2000,
		target: "es2022",
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
	},
})
