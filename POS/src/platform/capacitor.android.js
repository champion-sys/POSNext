/**
 * The Android build's copy of platform/capacitor. ClassicPrinter and TcpPrinter are the
 * app's own plugins, in android/app/src/main/java.
 *
 * @module platform/capacitor.android
 */

import { BleClient } from "@capacitor-community/bluetooth-le"
import { App } from "@capacitor/app"
import { registerPlugin } from "@capacitor/core"
import { Dialog } from "@capacitor/dialog"

export { App, BleClient, Dialog }
export const ClassicPrinter = registerPlugin("ClassicPrinter")
export const TcpPrinter = registerPlugin("TcpPrinter")
