<template>
	<div class="flex flex-col gap-4">
		<!-- Master Toggle Checkbox -->
		<CheckboxField
			v-model="store.isEnabled"
			:label="__('Enable Bluetooth Printer')"
			:description="__('Send receipts directly to a thermal printer via Web Bluetooth (no driver/service needed)')"
		/>

		<!-- Bluetooth Printer Settings Container (shown when enabled) -->
		<div v-if="store.isEnabled" class="ps-6 flex flex-col gap-4 border-s-2 border-blue-200">
			
			<!-- Connection Status Indicator -->
			<div class="flex items-center gap-2 py-1">
				<div
					class="w-2.5 h-2.5 rounded-full flex-shrink-0"
					:class="isScanning ? 'bg-yellow-500 animate-pulse' : store.isConnected ? 'bg-green-500' : 'bg-red-500'"
				></div>
				<span
					class="text-xs font-medium"
					:class="isScanning ? 'text-yellow-700' : store.isConnected ? 'text-green-700' : 'text-red-700'"
				>
					{{ isScanning ? __('Scanning/Connecting to Bluetooth...') : store.isConnected ? __(`Bluetooth Connected: ${store.savedPrinterName}`) : __('Bluetooth Printer Disconnected') }}
				</span>
				
				<div class="ms-auto flex gap-2">
					<Button
						v-if="!store.isConnected && store.savedPrinterId"
						@click="handleConnectSaved"
						:loading="isConnecting"
						variant="ghost"
						size="sm"
					>
						{{ __('Connect') }}
					</Button>
					<Button
						v-if="store.isConnected"
						@click="handleDisconnect"
						variant="ghost"
						size="sm"
					>
						{{ __('Disconnect') }}
					</Button>
				</div>
			</div>

			<!-- Paper Size Selection -->
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
				
				<!-- Print Method Selection (Image vs Text) -->
				<SelectField
					v-model="store.printMethod"
					:label="__('Arabic Print Mode')"
					:options="[
						{ label: __('Raster Image (Perfect RTL/Arabic)'), value: 'image' },
						{ label: __('Raw Text (Requires printer CP1256 support)'), value: 'text' }
					]"
					:description="__('Choose how Arabic letters are rendered.')"
				/>
			</div>

			<!-- Device Scanning & Test Utilities -->
			<div class="flex items-center gap-3 pt-2">
				<Button
					@click="handleScan"
					:loading="isScanning"
					variant="subtle"
					theme="blue"
					size="sm"
				>
					<template #prefix>
						<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
						</svg>
					</template>
					{{ store.savedPrinterId ? __('Pair Different Printer') : __('Scan & Pair Printer') }}
				</Button>

				<Button
					v-if="store.savedPrinterId"
					@click="handleRemoveSaved"
					variant="subtle"
					theme="gray"
					size="sm"
				>
					{{ __('Forget Printer') }}
				</Button>

				<Button
					@click="handlePrintTest"
					:disabled="!store.isConnected"
					:loading="isPrintingTest"
					variant="solid"
					theme="blue"
					size="sm"
					class="ms-auto"
				>
					{{ __('Print Test Receipt') }}
				</Button>
			</div>

			<!-- Dynamic Help text based on print mode -->
			<div class="p-3 bg-blue-50 border border-blue-200 rounded-lg text-xs text-blue-800 leading-relaxed">
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
import { PrinterService } from "@/services/printerService"
import { COMMANDS, encodeCP1256, reshapeArabic, renderReceiptToRaster } from "@/utils/escpos"
import CheckboxField from "@/components/settings/CheckboxField.vue"
import SelectField from "@/components/settings/SelectField.vue"

const { showSuccess, showError } = useToast()
const store = useBluetoothPrinterStore()

const isScanning = ref(false)
const isConnecting = ref(false)
const isPrintingTest = ref(false)

onMounted(() => {
	// Auto-check connection state if we have a saved printer
	if (PrinterService.isConnected()) {
		store.setConnected(PrinterService.getConnectedDeviceId(), true)
	}

	// Register disconnection callback
	PrinterService.registerOnDisconnect(() => {
		store.setConnected("", false)
		showError(__("Printer connection lost"))
	})

	// Attempt auto-reconnect if a printer is saved and Bluetooth is enabled
	if (store.isEnabled && !store.isConnected && store.savedPrinterId) {
		PrinterService.tryAutoReconnect(store.savedPrinterId).then((success) => {
			if (success) {
				store.setConnected(PrinterService.getConnectedDeviceId(), true)
				showSuccess(__("Auto-connected to saved printer"))
			}
		})
	}
})

async function handleScan() {
	isScanning.value = true
	try {
		const device = await PrinterService.scanAndConnect()
		store.setSavedPrinter(device.id, device.name || __("Bluetooth Printer"))
		store.setConnected(device.id, true)
		showSuccess(__("Connected and saved printer successfully."))
	} catch (error) {
		console.error("Bluetooth pairing error:", error)
		showError(error.message || __("Bluetooth pairing failed or was cancelled."))
	} finally {
		isScanning.value = false
	}
}

async function handleConnectSaved() {
	if (!store.savedPrinterId) return
	isConnecting.value = true
	try {
		const success = await PrinterService.tryAutoReconnect(store.savedPrinterId)
		if (success) {
			store.setConnected(PrinterService.getConnectedDeviceId(), true)
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

function handleDisconnect() {
	PrinterService.disconnect()
	store.setConnected("", false)
	showSuccess(__("Disconnected from printer."))
}

function handleRemoveSaved() {
	handleDisconnect()
	store.clearSavedPrinter()
	showSuccess(__("Saved printer cleared."))
}

async function handlePrintTest() {
	if (!store.isConnected) return
	isPrintingTest.value = true

	try {
		const timestamp = new Date().toLocaleString("ar-EG")
		const testLines = [
			{ text: "اختبار الطباعة", align: "center", bold: true, size: "large" },
			{ text: "--------------------------------", align: "center" },
			{ text: `التاريخ: ${timestamp}`, align: "right" },
			{ text: "--------------------------------", align: "center" },
			{ text: "المنتجات المحاكاة:", align: "right", bold: true },
			{ text: "شاي أخضر   x1   5.00 ر.س", align: "right" },
			{ text: "قهوة عربية  x2   24.00 ر.س", align: "right" },
			{ text: "--------------------------------", align: "center" },
			{ text: "المجموع: 29.00 ر.س", align: "right", bold: true },
			{ text: "--------------------------------", align: "center" },
			{ text: "شكراً لزيارتكم", align: "center", bold: true }
		]

		// Map paper size value to raster pixel width
		const widthPixels = store.paperSize === "80" ? 576 : 384

		if (store.printMethod === "image") {
			// Canvas Raster printing
			const rasterData = await renderReceiptToRaster(testLines, widthPixels)
			const printData = new Uint8Array([
				...COMMANDS.INITIALIZE,
				...rasterData,
				...COMMANDS.CUT
			])
			await PrinterService.printRaw(printData)
		} else {
			// Legacy text encoding method
			const bytesList = []
			bytesList.push(...COMMANDS.INITIALIZE)
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

			// Add Cut command
			bytesList.push(...COMMANDS.CUT)

			await PrinterService.printRaw(new Uint8Array(bytesList))
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
