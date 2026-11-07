/**
 * Where a device keeps what must not sit in readable storage: the OS keystore.
 *
 * The browser build has no adapter on purpose. It keeps no secrets, and it signs in
 * with cookies.
 *
 * @module platform/secrets
 *
 * @typedef {object} SecretStore
 * @property {(key: string) => Promise<string|null>} get
 * @property {(key: string, value: string) => Promise<void>} set
 * @property {(key: string) => Promise<void>} remove
 */

import { ANDROID, ELECTRON, PLATFORM } from "./runtime"

const ANDROID_PLUGIN = "SecureStoragePlugin"
const MISSING_ITEM = /does not exist/i

/**
 * Adapter for capacitor-secure-storage-plugin, which keeps its key in the Android Keystore.
 * The plugin rejects when asked for a key it does not hold, and only that means "empty":
 * any other failure must not look like a device that was never enrolled.
 *
 * Its set reports success even when the Keystore failed, so a write counts only once the
 * value reads back.
 * @param {{get: Function, set: Function, remove: Function}} plugin
 * @returns {SecretStore}
 */
export function androidSecretStore(plugin) {
	const ignoreMissing = (error) => {
		if (!MISSING_ITEM.test(error?.message)) throw error
		return null
	}

	const get = (key) => plugin.get({ key }).then(({ value }) => value, ignoreMissing)

	return {
		get,
		set: async (key, value) => {
			await plugin.set({ key, value })
			if ((await get(key)) !== value) {
				throw new Error(__("This system cannot store secrets safely"))
			}
		},
		remove: (key) =>
			plugin.remove({ key }).then(() => undefined, ignoreMissing),
	}
}

// Through the bridge Capacitor injects into the WebView, so that the web and
// desktop bundles do not have to resolve a package only Android has
function capacitorPlugin() {
	const call = (method) => (options) =>
		window.Capacitor.nativePromise(ANDROID_PLUGIN, method, options)
	return { get: call("get"), set: call("set"), remove: call("remove") }
}

/**
 * @param {string} [platform]
 * @returns {SecretStore}
 */
export function openSecretStore(platform = PLATFORM) {
	if (platform === ELECTRON) return window.electronSecrets
	if (platform === ANDROID) return androidSecretStore(capacitorPlugin())
	throw new Error("This platform keeps no secrets")
}
