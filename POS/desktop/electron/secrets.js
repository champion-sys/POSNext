const fs = require("node:fs")
const path = require("node:path")

const APP_FRAME = "app://pos/"
const SECRETS_FILE = "secrets.json"

/**
 * Secrets on disk, encrypted with a key the operating system holds for this user.
 * The renderer only ever sees the values it asks for, never the key.
 * @param {object} options
 * @param {string} options.filePath
 * @param {{encryptString: Function, decryptString: Function}} options.cipher
 * @param {() => boolean} options.isSecure - Whether the cipher really encrypts here
 * @param {typeof fs} [options.files]
 */
function createSecretStore({ filePath, cipher, isSecure, files = fs }) {
	function read() {
		try {
			return JSON.parse(files.readFileSync(filePath, "utf8"))
		} catch (error) {
			if (error.code === "ENOENT") return {}
			throw error
		}
	}

	// A crash mid-write must not lose the device's enrollment
	function write(entries) {
		const temporary = `${filePath}.tmp`
		files.writeFileSync(temporary, JSON.stringify(entries), { mode: 0o600 })
		files.renameSync(temporary, filePath)
	}

	return {
		get(key) {
			const value = read()[key]
			return value ? cipher.decryptString(Buffer.from(value, "base64")) : null
		},
		set(key, value) {
			if (!isSecure())
				throw new Error("This system cannot store secrets safely")
			write({
				...read(),
				[key]: cipher.encryptString(value).toString("base64"),
			})
		},
		remove(key) {
			const entries = read()
			delete entries[key]
			write(entries)
		},
	}
}

/** Only the app's own page may reach the secrets, not a frame it happens to load. */
function isAppFrame(event) {
	return Boolean(event.senderFrame?.url?.startsWith(APP_FRAME))
}

function registerSecretHandlers() {
	const { app, ipcMain, safeStorage } = require("electron")

	let store = null
	const openStore = () => {
		store ??= createSecretStore({
			filePath: path.join(app.getPath("userData"), SECRETS_FILE),
			cipher: safeStorage,
			// On Linux without a keyring, Electron "encrypts" with a fixed password
			isSecure: () =>
				safeStorage.isEncryptionAvailable() &&
				safeStorage.getSelectedStorageBackend?.() !== "basic_text",
		})
		return store
	}

	for (const method of ["get", "set", "remove"]) {
		ipcMain.handle(`secrets:${method}`, (event, ...args) => {
			if (!isAppFrame(event)) throw new Error("Not allowed")
			return openStore()[method](...args)
		})
	}
}

module.exports = { createSecretStore, isAppFrame, registerSecretHandlers }
