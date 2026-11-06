<template>
	<div class="flex flex-col gap-2">
		<label class="text-sm font-semibold text-gray-900" for="system-printer">{{ __('Default Printer') }}</label>
		<div class="flex items-center gap-2">
			<select
				id="system-printer"
				v-model="selected"
				class="flex-1 rounded-lg border border-gray-300 px-3 py-2 text-sm"
				@change="saveSystemPrinter(selected)"
			>
				<option value="">{{ __('Ask each time') }}</option>
				<option v-for="printer in printers" :key="printer.name" :value="printer.name">
					{{ printer.displayName || printer.name }}
				</option>
			</select>
			<button
				type="button"
				class="rounded-lg border border-gray-300 px-3 py-2 text-sm"
				:disabled="loading"
				@click="loadPrinters"
			>
				{{ __('Refresh') }}
			</button>
		</div>
		<p class="text-xs text-gray-600">
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
