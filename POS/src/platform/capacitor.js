/**
 * Capacitor plugins, which only the Android app has. vite.config.android.mjs swaps this
 * file for capacitor.android.js, so the web and desktop builds never load Capacitor.
 *
 * @module platform/capacitor
 */

export const App = null
export const BleClient = null
export const CapacitorSQLite = null
export const ClassicPrinter = null
export const Dialog = null
export const SQLiteConnection = null
export const TcpPrinter = null
