/**
 * The way out for a queue that cannot reach its server: one file a manager can upload
 * through the sync center. pos_next/services/queue_file.py reads what this writes.
 *
 * @module utils/offline/queueFile
 */

import { saveQueueFile } from "@/platform/queueFile"
import { getServerUrl } from "@/platform/runtime"
import { localStore } from "@/platform/store"
import {
	SYNC_PROTOCOL_VERSION,
	buildPushItem,
	getAppVersion,
	getDeviceId,
} from "./sync"

export const QUEUE_FILE_VERSION = 1

const pad = (value) => String(value).padStart(2, "0")

/**
 * @param {Object} file
 * @param {Array} file.rows - Queue rows
 * @param {string} file.deviceId
 * @param {string|null} file.appVersion
 * @param {string} file.server - Where the device sends its queue
 * @param {Date} file.exportedAt
 * @returns {Object} The file. Each row is exactly what a push sends, because the server
 *   tells the same sale arriving twice from a changed one by its hash.
 */
export function buildQueueFile({
	rows,
	deviceId,
	appVersion,
	server,
	exportedAt,
}) {
	return {
		format_version: QUEUE_FILE_VERSION,
		device_id: deviceId,
		app_version: appVersion,
		server,
		exported_at: exportedAt.toISOString(),
		protocol_version: SYNC_PROTOCOL_VERSION,
		rows: rows.map(buildPushItem),
	}
}

/**
 * @param {string} deviceId
 * @param {Date} exportedAt
 * @returns {string} Names sort by time, and two devices' files never collide
 */
export function getQueueFileName(deviceId, exportedAt) {
	const date = `${exportedAt.getFullYear()}${pad(exportedAt.getMonth() + 1)}${pad(exportedAt.getDate())}`
	const time = `${pad(exportedAt.getHours())}${pad(exportedAt.getMinutes())}${pad(exportedAt.getSeconds())}`
	return `pos-queue-${deviceId.slice(0, 8)}-${date}-${time}.json`
}

/**
 * Write every record the server has not confirmed to a file. The queue itself does not
 * change: the rows stay and keep syncing, and offline_id keeps the server from posting
 * one twice. A failed read is thrown, so a damaged device never gets an empty file.
 * @param {Date} [exportedAt]
 * @returns {Promise<{count: number, saved: boolean}>} How many records there were, and
 *   whether a file was written
 */
export async function exportQueue(exportedAt = new Date()) {
	const rows = await localStore.listUnconfirmedRows()
	if (rows.length === 0) return { count: 0, saved: false }

	const deviceId = getDeviceId()
	const file = buildQueueFile({
		rows,
		deviceId,
		appVersion: getAppVersion(),
		server: getServerUrl() || window.location.origin,
		exportedAt,
	})

	const saved = await saveQueueFile(
		getQueueFileName(deviceId, exportedAt),
		JSON.stringify(file),
	)
	return { count: rows.length, saved }
}
