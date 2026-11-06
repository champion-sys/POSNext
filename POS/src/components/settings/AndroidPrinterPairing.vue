<template>
	<div class="flex flex-col gap-3 pt-2 border-t border-gray-200">
		<span class="text-xs font-semibold text-gray-700">{{ __('Pair New Printer') }}</span>

		<div class="flex flex-wrap gap-2.5">
			<Button @click="toggleBluetooth" :loading="isListing" variant="subtle" theme="blue" size="sm">
				{{ __('Pair Bluetooth Printer') }}
			</Button>
			<Button @click="showWifi = !showWifi" variant="subtle" theme="teal" size="sm">
				{{ __('Add Wi-Fi Printer') }}
			</Button>
		</div>

		<!-- Bluetooth -->
		<div v-if="showBluetooth" class="flex flex-col gap-2 p-3 bg-gray-50 rounded-xl border border-gray-200">
			<p class="text-xs text-gray-600">
				{{ __('Choose a paired printer. A new printer has to be paired in the Android Bluetooth settings first.') }}
			</p>

			<div
				v-for="device in pairedPrinters"
				:key="device.id"
				class="flex items-center justify-between gap-2 p-2 bg-white rounded-lg border border-gray-200"
			>
				<span class="text-sm font-medium text-gray-900 truncate">{{ device.name }}</span>
				<Button @click="pair(device)" :loading="connectingId === device.id" variant="ghost" size="sm">
					{{ __('Connect') }}
				</Button>
			</div>
			<p v-if="!isListing && pairedPrinters.length === 0" class="text-xs text-gray-500">
				{{ __('No paired Bluetooth devices found.') }}
			</p>

			<div class="flex flex-wrap gap-2.5">
				<Button @click="scanBle" :loading="isScanning" variant="subtle" size="sm">
					{{ __('Scan for BLE Printers') }}
				</Button>
				<Button @click="openBluetoothSettings" variant="ghost" size="sm">
					{{ __('Open Bluetooth Settings') }}
				</Button>
			</div>
		</div>

		<!-- Wi-Fi -->
		<div v-if="showWifi" class="flex flex-col gap-3 p-3 bg-gray-50 rounded-xl border border-gray-200">
			<div class="flex flex-col gap-1.5 max-w-md">
				<label class="text-xs font-semibold text-gray-700">{{ __('Printer Name') }}</label>
				<input
					v-model="wifiForm.name"
					type="text"
					class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
					:placeholder="__('e.g. Kitchen Printer, Checkout 1')"
				/>
				<p v-if="wifiErrors.name" class="text-xs text-red-600">{{ wifiErrors.name }}</p>
			</div>

			<div class="grid grid-cols-3 gap-3 max-w-md">
				<div class="col-span-2 flex flex-col gap-1.5">
					<label class="text-xs font-semibold text-gray-700">{{ __('IP Address') }}</label>
					<input
						v-model="wifiForm.host"
						type="text"
						inputmode="decimal"
						dir="ltr"
						class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
						placeholder="192.168.1.50"
					/>
					<p v-if="wifiErrors.host" class="text-xs text-red-600">{{ wifiErrors.host }}</p>
				</div>
				<div class="flex flex-col gap-1.5">
					<label class="text-xs font-semibold text-gray-700">{{ __('Port') }}</label>
					<input
						v-model="wifiForm.port"
						type="text"
						inputmode="numeric"
						dir="ltr"
						class="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-900 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
					/>
					<p v-if="wifiErrors.port" class="text-xs text-red-600">{{ wifiErrors.port }}</p>
				</div>
			</div>

			<div>
				<Button @click="addWifiPrinter" :loading="isAddingWifi" variant="solid" theme="blue" size="sm">
					{{ __('Add Printer') }}
				</Button>
			</div>
		</div>
	</div>
</template>

<script setup>
import { reactive, ref } from "vue"
import { Button } from "frappe-ui"
import { useToast } from "@/composables/useToast"
import { openBluetoothSettings, wifiDeviceId } from "@/platform/printing/transport"
import {
	ADDRESS_INVALID,
	ADDRESS_TAKEN,
	DEFAULT_WIFI_PORT,
	NAME_MISSING,
	PORT_INVALID,
	validateWifiPrinter,
} from "@/platform/printing/wifiPrinter"
import { printerService } from "@/services/printerService"
import { useBluetoothPrinterStore } from "@/stores/bluetoothPrinter"

const { showSuccess, showError } = useToast()
const store = useBluetoothPrinterStore()

const showBluetooth = ref(false)
const showWifi = ref(false)
const isListing = ref(false)
const isScanning = ref(false)
const isAddingWifi = ref(false)
const connectingId = ref("")
const pairedPrinters = ref([])

const wifiForm = reactive({ name: "", host: "", port: DEFAULT_WIFI_PORT })
const wifiErrors = reactive({ name: "", host: "", port: "" })

function wifiErrorMessage(code) {
	switch (code) {
		case NAME_MISSING:
			return __("Enter a name for the printer.")
		case ADDRESS_INVALID:
			return __("Enter a valid IP address, such as 192.168.1.50.")
		case ADDRESS_TAKEN:
			return __("This printer is already added.")
		case PORT_INVALID:
			return __("Enter a port between 1 and 65535.")
		default:
			return ""
	}
}

function savePrinter(id, name) {
	const saved = store.printers.find((printer) => printer.deviceId === id)
	if (saved) {
		store.setActivePrinter(saved.id)
	} else {
		store.setSavedPrinter(id, name, "bluetooth")
	}
	store.setConnected(id, true)
	showSuccess(__("Connected and saved Bluetooth printer successfully."))
}

async function toggleBluetooth() {
	showBluetooth.value = !showBluetooth.value
	if (!showBluetooth.value) return

	isListing.value = true
	try {
		pairedPrinters.value = await printerService.listPairedPrinters()
	} catch (error) {
		showError(error.message)
	} finally {
		isListing.value = false
	}
}

async function pair(device) {
	connectingId.value = device.id
	try {
		await printerService.connectNative(device.id)
		savePrinter(device.id, device.name)
	} catch (error) {
		showError(error.message)
	} finally {
		connectingId.value = ""
	}
}

async function scanBle() {
	isScanning.value = true
	try {
		const device = await printerService.scanAndConnect()
		if (device) savePrinter(device.id, device.name)
	} catch (error) {
		showError(error.message)
	} finally {
		isScanning.value = false
	}
}

async function addWifiPrinter() {
	const { printer, errors } = validateWifiPrinter(wifiForm, store.printers)
	wifiErrors.name = wifiErrorMessage(errors.name)
	wifiErrors.host = wifiErrorMessage(errors.host)
	wifiErrors.port = wifiErrorMessage(errors.port)
	if (Object.keys(errors).length > 0) return

	isAddingWifi.value = true
	try {
		// The printer has to answer before it is saved, so a typo shows up here and not at checkout
		const deviceId = wifiDeviceId(printer)
		await printerService.connectNative(deviceId)
		store.addNetworkPrinter(printer)
		store.setConnected(deviceId, true)
		showSuccess(__("Connected and saved Wi-Fi printer successfully."))
		Object.assign(wifiForm, { name: "", host: "", port: DEFAULT_WIFI_PORT })
		showWifi.value = false
	} catch (error) {
		showError(error.message)
	} finally {
		isAddingWifi.value = false
	}
}
</script>
