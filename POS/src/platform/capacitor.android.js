/**
 * The Android build's copy of platform/capacitor. ClassicPrinter and TcpPrinter are the
 * app's own plugins, in android/app/src/main/java.
 *
 * @module platform/capacitor.android
 */

import { BleClient } from "@capacitor-community/bluetooth-le"
import { CapacitorSQLite, SQLiteConnection } from "@capacitor-community/sqlite"
import { App } from "@capacitor/app"
import { registerPlugin } from "@capacitor/core"
import { Dialog } from "@capacitor/dialog"
import { Filesystem } from "@capacitor/filesystem"
import { Share } from "@capacitor/share"

export { App, BleClient, CapacitorSQLite, Dialog, Filesystem, SQLiteConnection, Share }
export const ClassicPrinter = registerPlugin("ClassicPrinter")
export const TcpPrinter = registerPlugin("TcpPrinter")
