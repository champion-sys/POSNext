import { localStore } from "@/platform/store"

/**
 * Read a setting kept on the device.
 * @param {string} key
 * @param {*} [defaultValue=null] - Returned when the key is not stored
 * @returns {Promise<*>}
 */
export const getSetting = (key, defaultValue = null) => localStore.getSetting(key, defaultValue)

/**
 * Keep a setting on the device.
 * @param {string} key
 * @param {*} value
 * @returns {Promise<void>}
 */
export const setSetting = (key, value) => localStore.setSetting(key, value)
