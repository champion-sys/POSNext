/**
 * Puts a queue file where a person can take it from: a download on the web, and on Android
 * the share sheet, because an app's own files are out of reach there.
 *
 * @module platform/queueFile
 */

import { Filesystem, Share } from "@/platform/capacitor"
import { ANDROID, PLATFORM } from "./runtime"

const JSON_TYPE = "application/json"
const CACHE_DIRECTORY = "CACHE"
const EXPORT_FOLDER = "queue-export"
const REVOKE_AFTER_MS = 60 * 1000

function download(name, text) {
	const url = URL.createObjectURL(new Blob([text], { type: JSON_TYPE }))
	const link = document.createElement("a")
	link.href = url
	link.download = name
	document.body.append(link)
	link.click()
	link.remove()
	// The browser reads the address after this returns
	setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS)
	return true
}

/**
 * The file has to outlive the share, because the app it goes to may read it later. So the
 * last export's copy goes here instead, and a new one never lands beside it.
 */
async function share(name, text) {
	await Filesystem.rmdir({
		path: EXPORT_FOLDER,
		directory: CACHE_DIRECTORY,
		recursive: true,
	}).catch(() => {})

	const { uri } = await Filesystem.writeFile({
		path: `${EXPORT_FOLDER}/${name}`,
		directory: CACHE_DIRECTORY,
		data: text,
		encoding: "utf8",
		recursive: true,
	})

	try {
		await Share.share({ title: name, files: [uri], dialogTitle: name })
	} catch (error) {
		if (/cancel/i.test(error?.message)) return false
		throw error
	}
	return true
}

/**
 * @param {string} name - File name
 * @param {string} text - File contents
 * @returns {Promise<boolean>} False when the person backed out
 */
export async function saveQueueFile(name, text) {
	return PLATFORM === ANDROID ? share(name, text) : download(name, text)
}
