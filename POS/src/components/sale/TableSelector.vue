<template>
	<div class="flex items-center gap-2">
		<button
			type="button"
			class="flex items-center gap-2 rounded-xl border border-gray-200 bg-white px-3 py-1.5 text-sm font-medium shadow-sm transition-all hover:bg-gray-50 active:scale-[0.985] disabled:opacity-50"
			:disabled="disabled"
			@click="openPicker"
		>
			<span class="text-gray-500">Table</span>
			<span
				v-if="modelValue"
				class="font-semibold text-blue-600"
			>
				#{{ modelValue }}
			</span>
			<span
				v-else
				class="text-gray-400"
			>
				Select
			</span>
			<FeatherIcon name="chevron-down" class="h-4 w-4 text-gray-400" />
		</button>
	</div>

	<Dialog
		v-model="showDialog"
		:options="{ title: __('Select Table'), size: 'sm' }"
	>
		<template #body>
			<div class="p-4">
				<div class="mb-3 text-sm text-gray-600">
					{{ __('Tables available for') }} <strong>{{ orderType }}</strong>
				</div>

				<div v-if="isLoading" class="py-8 text-center text-sm text-gray-500">
					{{ __('Loading tables...') }}
				</div>

				<div
					v-else-if="tables.length === 0"
					class="rounded-xl border border-dashed border-gray-200 py-8 text-center text-sm text-gray-500"
				>
					{{ __('No tables found for this order type.') }}
				</div>

				<div v-else class="max-h-[320px] space-y-1 overflow-auto pr-1">
					<button
						v-for="table in tables"
						:key="table.table_no"
						type="button"
						class="flex w-full items-center justify-between rounded-lg px-4 py-2.5 text-left transition-colors hover:bg-gray-100"
						:class="{
							'bg-blue-50 ring-1 ring-blue-200': modelValue === table.table_no,
						}"
						@click="selectTable(table.table_no)"
					>
						<div class="font-medium">#{{ table.table_no }}</div>
						<div v-if="table.warehouse" class="text-xs text-gray-500">
							{{ table.warehouse }}
						</div>
					</button>
				</div>
			</div>
		</template>
	</Dialog>
</template>

<script setup>
import { ref, watch, computed } from 'vue'
import { Dialog, FeatherIcon, call } from 'frappe-ui'

const props = defineProps({
	modelValue: {
		type: String,
		default: null,
	},
	orderType: {
		type: String,
		required: true,
	},
	disabled: {
		type: Boolean,
		default: false,
	},
})

const emit = defineEmits(['update:modelValue'])

const showDialog = ref(false)
const tables = ref([])
const isLoading = ref(false)

async function fetchTables(orderType) {
	if (!orderType) {
		tables.value = []
		return
	}

	isLoading.value = true
	try {
		const res = await call('frappe.client.get_list', {
			doctype: 'POS Table',
			filters: { pos_order_type: orderType },
			fields: ['table_no', 'warehouse'],
			limit_page_length: 100,
		})
		tables.value = res?.message || res || []
	} catch (e) {
		console.error('Failed to load POS Tables', e)
		tables.value = []
	} finally {
		isLoading.value = false
	}
}

function openPicker() {
	if (props.disabled) return
	showDialog.value = true
	if (tables.value.length === 0) {
		fetchTables(props.orderType)
	}
}

function selectTable(tableNo) {
	emit('update:modelValue', tableNo)
	showDialog.value = false
}

watch(() => props.orderType, (newType) => {
	tables.value = []
	if (showDialog.value) {
		fetchTables(newType)
	}
})
</script>
