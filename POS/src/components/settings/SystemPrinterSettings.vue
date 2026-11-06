<template>
	<div class="p-2 rounded hover:bg-gray-50 transition-colors">
		<label class="block text-sm font-medium text-gray-900 mb-1" for="system-printer">{{ __('Default Printer') }}</label>
		<div class="flex items-center gap-2">
			<select
				id="system-printer"
				v-model="selected"
				class="flex-1 min-w-0 px-2.5 py-1.5 text-sm border border-gray-300 rounded focus:ring-1 focus:ring-blue-500 focus:border-transparent bg-white cursor-pointer"
				@change="saveSystemPrinter(selected)"
			>
				<option value="">{{ __('Ask each time') }}</option>
				<option v-for="printer in printers" :key="printer.name" :value="printer.name">
					{{ printer.displayName || printer.name }}
				</option>
			</select>
			<button
				type="button"
				class="px-2 py-2 bg-gray-100 hover:bg-gray-200 rounded transition-colors"
				:disabled="loading"
				:title="__('Refresh printer list')"
				:aria-label="__('Refresh printer list')"
				@click="loadPrinters"
			>
				<svg
					class="w-4 h-4 text-gray-600"
					:class="loading ? 'animate-spin' : ''"
					fill="none"
					stroke="currentColor"
					viewBox="0 0 24 24"
					aria-hidden="true"
				>
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
				</svg>
			</button>
		</div>
		<p class="text-xs text-gray-500 mt-0.5 leading-tight">
			{{ __('Receipts go straight to this printer. Without one, the system printer dialog opens.') }}
		</p>
	</div>
</template>

<script setup>
import { getSystemPrinter, listSystemPrinters, saveSystemPrinter } from "@/platform/printing/system"
import { onMounted, ref } from "vue"

const printers = ref([])
const selected = ref(getSystemPrinter())
const loading = ref(false)

async function loadPrinters() {
	loading.value = true
	try {
		printers.value = await listSystemPrinters()
	} finally {
		loading.value = false
	}
}

onMounted(loadPrinters)
</script>
