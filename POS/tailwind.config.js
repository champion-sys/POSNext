import frappeUIPreset from "frappe-ui/tailwind"

export default {
	presets: [frappeUIPreset],
	content: [
		"./index.html",
		"./src/**/*.{vue,js,ts,jsx,tsx}",
		"./node_modules/frappe-ui/src/components/**/*.{vue,js,ts,jsx,tsx}",
	],
	theme: {
		extend: {
			// Density tokens of the selling screen, defined once in src/styles/density.css
			spacing: {
				"pos-bar": "var(--pos-bar)",
				"pos-control": "var(--pos-control)",
				"pos-tap": "var(--pos-tap)",
				"pos-action": "var(--pos-action)",
				"pos-key": "var(--pos-key)",
				"pos-thumb": "var(--pos-thumb)",
				"pos-tile": "var(--pos-tile)",
				"pos-row": "var(--pos-row)",
				"pos-pad": "var(--pos-pad)",
			},
		},
	},
	plugins: [],
}
