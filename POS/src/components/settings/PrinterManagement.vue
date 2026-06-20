<template>
	<div class="flex flex-col gap-6">
		<!-- Master Toggle Checkbox -->
		<CheckboxField
			v-model="store.isEnabled"
			:label="__('Enable Receipt Printer')"
			:description="__('Send receipts directly to a thermal printer via Web Bluetooth or WebUSB (no local drivers/services required)')"
		/>

		<!-- Printer Settings Container (shown when enabled) -->
		<div v-if="store.isEnabled" class="ps-6 flex flex-col gap-6 border-s-2 border-blue-200">
			
			<!-- Paired Printers List -->
			<div class="flex flex-col gap-3">
				<h4 class="text-sm font-semibold text-gray-900 flex items-center gap-1.5">
					<svg class="w-4 h-4 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"/>
					</svg>
					{{ __('Paired POS Printers') }}
				</h4>

				<!-- Empty State -->
				<div v-if="store.printers.length === 0" class="flex flex-col items-center justify-center p-6 bg-gray-50 rounded-xl border border-dashed border-gray-300 text-center">
					<svg class="w-10 h-10 text-gray-400 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
					</svg>
					<p class="text-xs text-gray-600 font-medium">{{ __('No printers paired yet') }}</p>
					<p class="text-[11px] text-gray-500 mt-0.5">{{ __('Choose a connection type below to search and pair a thermal printer.') }}</p>
				</div>

				<!-- Printers list -->
				<div v-else class="flex flex-col gap-2">
					<div 
						v-for="printer in store.printers" 
						:key="printer.id" 
						class="flex flex-col md:flex-row md:items-center justify-between p-3.5 bg-white rounded-xl border transition-all duration-200"
						:class="[
							printer.id === store.activePrinterId 
								? 'border-blue-500 shadow-sm ring-1 ring-blue-500' 
								: 'border-gray-200 hover:border-gray-300 hover:bg-gray-50/50'
						]"
					>
						<!-- Left Side: Printer details -->
						<div class="flex items-start gap-3 min-w-0" @click="store.setActivePrinter(printer.id)">
							<!-- Icon changes based on type -->
							<div class="p-2 rounded-lg flex-shrink-0" :class="printer.type === 'usb' ? 'bg-teal-50 text-teal-600' : 'bg-blue-50 text-blue-600'">
								<!-- USB icon -->
								<svg v-if="printer.type === 'usb'" class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v1m0 11v3m0-11a3 3 0 110-6 3 3 0 010 6zm0 11a3 3 0 100-6 3 3 0 000 6z" />
								</svg>
								<!-- Bluetooth icon -->
								<svg v-else class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 18h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2zM12 15h.01M12 12h.01M12 9h.01" />
								</svg>
							</div>

							<div class="min-w-0 flex flex-col gap-0.5 cursor-pointer">
								<div class="flex items-center gap-2">
									<span class="font-semibold text-sm text-gray-900 truncate">{{ printer.name }}</span>
									<span v-if="printer.isDefault" class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-amber-50 border border-amber-300 text-amber-800">
										<svg class="w-2.5 h-2.5 fill-current" viewBox="0 0 24 24">
											<path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/>
										</svg>
										{{ __('Default') }}
									</span>
								</div>
								
								<!-- Badges description -->
								<div class="flex flex-wrap gap-1.5 items-center mt-1">
									<span class="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded bg-gray-100 text-gray-700 border border-gray-200">
										{{ printer.type }}
									</span>
									<span class="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded bg-gray-100 text-gray-700 border border-gray-200">
										{{ printer.paperSize }}mm
									</span>
									<span class="text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded bg-gray-100 text-gray-700 border border-gray-200">
										{{ printer.printMethod === 'image' ? __('Raster') : __('Text') }}
									</span>
								</div>
							</div>
						</div>

						<!-- Right Side: State/Actions -->
						<div class="flex items-center gap-2 mt-3 md:mt-0 justify-end">
							<!-- Connection status indicator -->
							<div v-if="store.connectedDeviceId === printer.id && store.isConnected" class="flex items-center gap-1 px-2 py-0.5 bg-green-50 border border-green-300 text-green-700 text-xs font-semibold rounded-full me-2">
								<div class="w-1.5 h-1.5 bg-green-500 rounded-full animate-pulse"></div>
								{{ __('Connected') }}
							</div>

							<!-- Connect/Disconnect Button -->
							<Button
								v-if="store.connectedDeviceId !== printer.id || !store.isConnected"
								@click="handleConnectPrinter(printer)"
								:loading="isConnecting && store.activePrinterId === printer.id"
								variant="ghost"
								size="sm"
							>
								{{ __('Connect') }}
							</Button>
							<Button
								v-else
								@click="handleDisconnect"
								variant="ghost"
								size="sm"
							>
								{{ __('Disconnect') }}
							</Button>

							<!-- Set Default Button -->
							<Button
								v-if="!printer.isDefault"
								@click="handleSetDefault(printer.id)"
								variant="ghost"
								size="sm"
								:title="__('Set as Default Printer')"
							>
								{{ __('Set Default') }}
							</Button>

							<!-- Forget/Remove Button -->
							<button
								@click="handleForgetPrinter(printer.id)"
								class="p-1.5 text-gray-500 hover:text-red-600 rounded-lg hover:bg-red-50 transition-colors"
								:title="__('Forget Printer')"
							>
								<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
								</svg>
							</button>
						</div>
					</div>
				</div>
			</div>

			<!-- Add Printer Section -->
			<div class="flex flex-col gap-2 pt-2 border-t border-gray-200">
				<span class="text-xs font-semibold text-gray-700">{{ __('Pair New Printer') }}</span>
				<div class="flex flex-wrap gap-2.5">
					<Button
						@click="handleScanBluetooth"
						:loading="isScanning"
						variant="subtle"
						theme="blue"
						size="sm"
					>
						<template #prefix>
							<!-- Bluetooth icon -->
							<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 18h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2zM12 15h.01M12 12h.01M12 9h.01" />
							</svg>
						</template>
						{{ __('Pair Bluetooth Printer') }}
					</Button>

					<Button
						@click="handleScanUsb"
						:loading="isScanning"
						variant="subtle"
						theme="teal"
						size="sm"
					>
						<template #prefix>
							<!-- USB icon -->
							<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v1m0 11v3m0-11a3 3 0 110-6 3 3 0 010 6zm0 11a3 3 0 100-6 3 3 0 000 6z" />
							</svg>
						</template>
						{{ __('Pair USB Printer') }}
					</Button>
				</div>
			</div>

			<!-- Active Printer Details & Config (Shown only if there's an active printer configuration) -->
			<div v-if="store.activePrinter" class="flex flex-col gap-4 border-t border-gray-200 pt-5 mt-2">
				<h4 class="text-sm font-semibold text-gray-900">
					{{ __('Settings for:') }} <span class="text-blue-600 font-bold">{{ store.savedPrinterName }}</span>
				</h4>

				<!-- Custom Name Input -->
				<div class="flex flex-col gap-1.5 max-w-md">
					<label class="text-xs font-semibold text-gray-700">{{ __('Printer Label / Name') }}</label>
					<input 
						v-model="store.savedPrinterName" 
						type="text" 
						class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 transition-colors"
						:placeholder="__('e.g. Kitchen Printer, Checkout 1')"
					/>
				</div>

				<!-- Paper Size & Print Mode -->
				<div class="grid grid-cols-1 md:grid-cols-2 gap-4">
					<SelectField
						v-model="store.paperSize"
						:label="__('Printer Paper Size')"
						:options="[
							{ label: '58mm (384px)', value: '58' },
							{ label: '80mm (576px)', value: '80' }
						]"
						:description="__('Choose paper width matching your thermal rolls.')"
					/>
					
					<SelectField
						v-model="store.printMethod"
						:label="__('Print Mode')"
						:options="[
							{ label: __('Raster Image (Perfect RTL/Arabic)'), value: 'image' },
							{ label: __('Raw Text (Requires printer CP1256 support)'), value: 'text' }
						]"
						:description="__('Choose how Arabic letters are rendered.')"
					/>
				</div>

				<!-- Advanced Settings (Collapsible) -->
				<div class="border border-gray-200 rounded-xl overflow-hidden mt-1">
					<button 
						@click="showAdvanced = !showAdvanced"
						type="button"
						class="w-full flex items-center justify-between px-4 py-3 bg-gray-50 hover:bg-gray-100/75 transition-colors text-left"
					>
						<span class="text-xs font-semibold text-gray-700 uppercase tracking-wider">{{ __('Advanced Printer Settings') }}</span>
						<svg 
							class="w-4 h-4 text-gray-600 transition-transform duration-200" 
							:class="showAdvanced ? 'rotate-180' : ''"
							fill="none" stroke="currentColor" viewBox="0 0 24 24"
						>
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7" />
						</svg>
					</button>

					<div v-show="showAdvanced" class="p-4 flex flex-col gap-4 bg-white border-t border-gray-200">
						<!-- Chunk Size & Write Delay (Only useful/needed for Bluetooth due to low transfer speeds and buffer limits) -->
						<div class="grid grid-cols-1 md:grid-cols-2 gap-4">
							<SelectField
								v-model="store.chunkSize"
								:label="__('Write Chunk Size')"
								:options="[
									{ label: '64 bytes (Compatible)', value: 64 },
									{ label: '128 bytes (Standard)', value: 128 },
									{ label: '256 bytes (Fast)', value: 256 },
									{ label: '512 bytes (Ultra)', value: 512 }
								]"
								:description="__('Size of data packets sent to the printer (primarily for Bluetooth).')"
							/>

							<SelectField
								v-model="store.writeDelay"
								:label="__('Inter-chunk Write Delay')"
								:options="[
									{ label: '0ms (No Delay - Fast)', value: 0 },
									{ label: '5ms (Optimized)', value: 5 },
									{ label: '10ms (Standard)', value: 10 },
									{ label: '20ms (Safe)', value: 20 },
									{ label: '50ms (Slow/Legacy)', value: 50 }
								]"
								:description="__('Delay between packets to prevent printer buffer overflow (primarily for Bluetooth).')"
							/>
						</div>

						<div class="grid grid-cols-1 md:grid-cols-2 gap-4">
							<SelectField
								v-model="store.lineFeedsAfterPrint"
								:label="__('Line Feeds After Print')"
								:options="[
									{ label: '0', value: 0 },
									{ label: '1', value: 1 },
									{ label: '2', value: 2 },
									{ label: '3 (Default)', value: 3 },
									{ label: '4', value: 4 },
									{ label: '5', value: 5 },
									{ label: '6', value: 6 },
									{ label: '7', value: 7 },
									{ label: '8', value: 8 }
								]"
								:description="__('Number of empty lines to feed before cutting the paper.')"
							/>
						</div>
					</div>
				</div>

				<CheckboxField
					v-model="store.enableQueuePersistence"
					:label="__('Enable Offline Print Queue Persistence')"
					:description="__('Saves failed or pending print jobs to IndexedDB so they recover on reload.')"
				/>

				<!-- Utilities -->
				<div class="flex items-center gap-3 pt-3 border-t border-gray-150">
					<Button
						@click="handlePrintTest"
						:disabled="!store.isConnected || store.connectedDeviceId !== store.activePrinterId"
						:loading="isPrintingTest"
						variant="solid"
						theme="blue"
						size="sm"
						class="ms-auto"
					>
						{{ __('Print Test Receipt') }}
					</Button>
				</div>
			</div>

			<!-- Dynamic Help text based on print mode -->
			<div v-if="store.activePrinter" class="p-3.5 bg-blue-50 border border-blue-200 rounded-xl text-xs text-blue-800 leading-relaxed">
				<p v-if="store.printMethod === 'image'">
					<strong>{{ __('Raster Mode:') }}</strong> {{ __('Renders the receipt as an image to guarantee 100% accurate Arabic text shaping and Right-to-Left alignment on any standard printer model.') }}
				</p>
				<p v-else>
					<strong>{{ __('Text Mode:') }}</strong> {{ __('Uses native printer fonts. Sends raw text encoded in Windows-1256. Highly efficient and fast, but requires the printer firmware to support Arabic CP1256 natively.') }}
				</p>
			</div>
		</div>
	</div>
</template>

<script setup>
import { computed, onMounted, ref } from "vue"
import { Button } from "frappe-ui"
import { useToast } from "@/composables/useToast"
import { useBluetoothPrinterStore } from "@/stores/bluetoothPrinter"
import { printerService } from "@/services/printerService"
import { COMMANDS, encodeCP1256, reshapeArabic, renderReceiptToRaster } from "@/utils/escpos"
import CheckboxField from "@/components/settings/CheckboxField.vue"
import SelectField from "@/components/settings/SelectField.vue"

const { showSuccess, showError } = useToast()
const store = useBluetoothPrinterStore()

const isScanning = ref(false)
const isConnecting = ref(false)
const isPrintingTest = ref(false)
const showAdvanced = ref(false)

onMounted(() => {
	// Auto-check connection state if we have a saved printer
	if (printerService.isConnected()) {
		store.setConnected(printerService.getConnectedDeviceId(), true)
	}

	// Register disconnection callback
	printerService.registerOnDisconnect(() => {
		store.setConnected("", false)
		showError(__("Printer connection lost"))
	})

	// Attempt auto-reconnect if a printer is saved and printer integration is enabled
	if (store.isEnabled && !store.isConnected && store.savedPrinterId) {
		const type = store.activePrinter?.type || 'bluetooth'
		printerService.tryAutoReconnect(store.savedPrinterId, type).then((success) => {
			if (success) {
				store.setConnected(printerService.getConnectedDeviceId(), true)
				showSuccess(__("Auto-connected to saved printer"))
			}
		})
	}
})

async function handleConnectPrinter(printer) {
	isConnecting.value = true
	store.setActivePrinter(printer.id)
	try {
		const success = await printerService.tryAutoReconnect(printer.id, printer.type)
		if (success) {
			store.setConnected(printer.id, true)
			showSuccess(__("Connected to printer successfully."))
		} else {
			showError(__("Could not connect automatically. Please turn on printer and scan again."))
		}
	} catch (error) {
		showError(error.message || __("Failed to connect to saved printer."))
	} finally {
		isConnecting.value = false
	}
}

async function handleScanBluetooth() {
	isScanning.value = true
	try {
		const device = await printerService.scanAndConnect()
		store.setSavedPrinter(device.id, device.name || __("Bluetooth Printer"), "bluetooth")
		store.setConnected(device.id, true)
		showSuccess(__("Connected and saved Bluetooth printer successfully."))
	} catch (error) {
		console.error("Bluetooth pairing error:", error)
		showError(error.message || __("Bluetooth pairing failed or was cancelled."))
	} finally {
		isScanning.value = false
	}
}

async function handleScanUsb() {
	isScanning.value = true
	try {
		const device = await printerService.scanAndConnectUsb()
		const id = `usb_${device.vendorId}_${device.productId}_${device.serialNumber || ""}`
		const name = device.productName || __("USB POS Printer")
		store.setSavedPrinter(id, name, "usb")
		store.setConnected(id, true)
		showSuccess(__("Connected and saved USB printer successfully."))
	} catch (error) {
		console.error("USB pairing error:", error)
		showError(error.message || __("USB pairing failed or was cancelled."))
	} finally {
		isScanning.value = false
	}
}

function handleDisconnect() {
	printerService.disconnect()
	store.setConnected("", false)
	showSuccess(__("Disconnected from printer."))
}

function handleForgetPrinter(id) {
	if (store.connectedDeviceId === id) {
		handleDisconnect()
	}
	store.removePrinter(id)
	showSuccess(__("Saved printer cleared."))
}

function handleSetDefault(id) {
	store.setDefaultPrinter(id)
	showSuccess(__("Default printer updated."))
}

async function handlePrintTest() {
	if (!store.isConnected) return
	isPrintingTest.value = true

	try {
		const timestamp = new Date().toLocaleString()
		const testLines = [
			{ text: store.savedPrinterName || "POS Printer", align: "center", bold: true, size: "large" },
			{ text: `Type: ${store.activePrinter?.type?.toUpperCase() || ""}`, align: "center" },
			{ text: "--------------------------------", align: "center" },
			{ text: `Date: ${timestamp}`, align: "right" },
			{ text: "--------------------------------", align: "center" },
			{ text: "TEST PRINT SUCCESSFUL", align: "center", bold: true },
			{ text: "Arabic test: اختبار الطباعة", align: "center" },
			{ text: "--------------------------------", align: "center" },
			{ text: "Thank you for using POS Next", align: "center", bold: true }
		]

		// Map paper size value to raster pixel width
		const widthPixels = store.paperSize === "80" ? 576 : 384

		if (store.printMethod === "image") {
			// Canvas Raster printing
			const rasterData = await renderReceiptToRaster(testLines, widthPixels)
			await printerService.printRaw(rasterData)
		} else {
			// Legacy text encoding method
			const bytesList = []
			bytesList.push(...COMMANDS.INITIALIZE)
			bytesList.push(...COMMANDS.CANCEL_CHINESE)
			bytesList.push(...COMMANDS.SELECT_CP1256)

			for (const line of testLines) {
				// Set bold state
				if (line.bold) {
					bytesList.push(...COMMANDS.BOLD_ON)
				} else {
					bytesList.push(...COMMANDS.BOLD_OFF)
				}

				// Set alignment
				if (line.align === "center") {
					bytesList.push(...COMMANDS.ALIGN_CENTER)
				} else if (line.align === "right") {
					bytesList.push(...COMMANDS.ALIGN_RIGHT)
				} else {
					bytesList.push(...COMMANDS.ALIGN_LEFT)
				}

				// Reshape and encode line text
				const shapedText = reshapeArabic(line.text)
				bytesList.push(...encodeCP1256(shapedText))
				bytesList.push(...COMMANDS.LINE_FEED)
			}

			// Add dynamic lines of spacing before cutting
			const feedsCount = store.lineFeedsAfterPrint !== undefined ? Number(store.lineFeedsAfterPrint) : 3
			for (let i = 0; i < feedsCount; i++) {
				bytesList.push(...COMMANDS.LINE_FEED)
			}

			// Add Cut command
			bytesList.push(...COMMANDS.CUT)

			await printerService.printRaw(new Uint8Array(bytesList))
		}

		showSuccess(__("Test receipt sent successfully."))
	} catch (error) {
		console.error("Printing error:", error)
		showError(error.message || __("Failed to print test receipt."))
	} finally {
		isPrintingTest.value = false
	}
}
</script>
