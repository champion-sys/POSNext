const fs = require("node:fs")
const path = require("node:path")
const { DATABASE_KEY } = require("./db/encryption")

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

let deviceSecrets = null

function openDeviceSecrets() {
	const { app, safeStorage } = require("electron")

	deviceSecrets ??= createSecretStore({
		filePath: path.join(app.getPath("userData"), SECRETS_FILE),
		cipher: safeStorage,
		// On Linux without a keyring, Electron "encrypts" with a fixed password
		isSecure: () =>
			safeStorage.isEncryptionAvailable() &&
			safeStorage.getSelectedStorageBackend?.() !== "basic_text",
	})
	return deviceSecrets
}

/**
 * The database key lives here too, and it is the one secret no page may ask for. An
 * array would cross IPC and still read that entry, so only a plain string gets through.
 */
function isAllowed(event, key) {
	return isAppFrame(event) && typeof key === "string" && key !== DATABASE_KEY
}

function registerSecretHandlers() {
	const { ipcMain } = require("electron")

	for (const method of ["get", "set", "remove"]) {
		ipcMain.handle(`secrets:${method}`, (event, ...args) => {
			if (!isAllowed(event, args[0])) throw new Error("Not allowed")
			return openDeviceSecrets()[method](...args)
		})
	}
}

module.exports = {
	createSecretStore,
	isAllowed,
	isAppFrame,
	openDeviceSecrets,
	registerSecretHandlers,
}
