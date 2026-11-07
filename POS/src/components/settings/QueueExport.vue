<template>
	<div class="flex flex-col gap-3" data-testid="queue-export">
		<div>
			<h4 class="text-sm font-semibold text-gray-900">{{ __('Export Queue') }}</h4>
			<p class="text-xs text-gray-600 mt-0.5">
				{{ __('Saves every record the server has not confirmed to a file, for a device that cannot reach it. A manager imports the file in the sync center.') }}
			</p>
		</div>

		<div v-if="confirming" role="alertdialog" class="flex flex-col gap-3 p-3 bg-amber-50 border border-amber-300 rounded-lg">
			<p class="text-sm text-amber-900">
				{{ __('This file is not encrypted. It holds customer and sale data, so handle it like a paper receipt book. Anyone who has it can read it.') }}
			</p>
			<p class="text-xs text-amber-900">
				{{ __('Exporting changes nothing on this device. The records stay queued and keep trying to reach the server.') }}
			</p>
			<div class="flex flex-col sm:flex-row gap-2">
				<Button variant="subtle" class="!h-11" @click="confirming = false">{{ __('Cancel') }}</Button>
				<Button variant="solid" class="!h-11" :loading="exporting" @click="confirmExport">{{ __('Export File') }}</Button>
			</div>
		</div>

		<Button v-else variant="subtle" class="self-start !h-11" @click="askToExport">{{ __('Export Queue') }}</Button>

		<p v-if="outcome" role="status" class="text-sm" :class="failed ? 'text-red-700' : 'text-gray-700'">{{ outcome }}</p>
	</div>
</template>

<script setup>
import { Button } from "frappe-ui"
import { ref } from "vue"
import { logger } from "@/utils/logger"
import { exportQueue } from "@/utils/offline/queueFile"

const log = logger.create("QueueExport")

const confirming = ref(false)
const exporting = ref(false)
const outcome = ref("")
const failed = ref(false)

function askToExport() {
	outcome.value = ""
	confirming.value = true
}

function describe({ count, saved }) {
	if (count === 0) return __("Nothing is waiting on this device")
	return saved
		? __("The file with {0} record(s) is ready. Check that it was saved.", [count])
		: __("Export cancelled")
}

async function confirmExport() {
	if (exporting.value) return

	exporting.value = true
	failed.value = false
	try {
		outcome.value = describe(await exportQueue())
	} catch (error) {
		log.error("Failed to export the queue", error)
		failed.value = true
		outcome.value = __("Could not export the queue. No file was written.")
	} finally {
		exporting.value = false
		confirming.value = false
	}
}
</script>
