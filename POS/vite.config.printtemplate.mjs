/**
 * The print template renderer for Desk, as one script that sets window.posPrintTemplate.
 * The POS Print Template form loads it to preview a template with the very code the
 * device prints with. `npm run build` builds it after the POS app.
 */
import path from "node:path"
import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"

const here = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
	publicDir: false,
	resolve: {
		alias: { "@": path.resolve(here, "src") },
	},
	define: {
		"process.env.NODE_ENV": JSON.stringify("production"),
	},
	build: {
		outDir: path.resolve(here, "../pos_next/public/js"),
		// The folder holds hand-written Desk scripts too
		emptyOutDir: false,
		copyPublicDir: false,
		sourcemap: false,
		target: "es2019",
		lib: {
			entry: path.resolve(here, "src/platform/printing/desk.js"),
			name: "posPrintTemplateBundle",
			formats: ["iife"],
			fileName: () => "pos_print_template.js",
		},
	},
})
