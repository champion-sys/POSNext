/**
 * The web store is tree-shaken from the desktop and Android builds, but its worker asset
 * is emitted while modules load, before that happens. Nothing refers to the file, and
 * those apps must not ship Dexie, so it goes here.
 */
export const dropWebWorker = {
	name: "pos-drop-web-worker",
	generateBundle(_options, bundle) {
		for (const fileName of Object.keys(bundle)) {
			if (fileName.includes("offline.worker")) delete bundle[fileName]
		}
	},
}
