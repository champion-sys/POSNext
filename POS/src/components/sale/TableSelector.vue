<template>
	<div class="flex items-center">
		<button
			type="button"
			class="flex items-center gap-2 rounded-xl border px-3 py-1.5 text-xs font-bold shadow-sm transition-all duration-150 active:scale-[0.97] disabled:opacity-50 touch-manipulation h-10 w-full justify-between"
			:class="modelValue
				? 'bg-amber-50 border-amber-300 text-amber-900 font-extrabold ring-1 ring-amber-200/50'
				: 'bg-white border-gray-150 text-gray-700 hover:bg-gray-50'
			"
			:disabled="disabled"
			@click="openPicker"
		>
			<span class="flex items-center gap-1.5">
				<!-- Custom table vector icon -->
				<svg class="h-4 w-4 flex-shrink-0" :class="modelValue ? 'text-amber-500' : 'text-gray-400'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
					<path d="M3 3h18v4H3z" />
					<path d="M5 7v14" />
					<path d="M19 7v14" />
					<path d="M9 7v8" />
					<path d="M15 7v8" />
				</svg>
				<span :class="modelValue ? 'text-amber-800' : 'text-gray-500'">{{ __('Table') }}</span>
			</span>
			
			<span class="flex items-center gap-1">
				<span
					v-if="modelValue"
					class="font-bold bg-amber-500 text-white px-2 py-0.5 rounded-full text-[12px] shadow-sm animate-fade-in"
				>
					#{{ modelValue }}
				</span>
				<span
					v-else
					class="text-gray-400 font-medium"
				>
					{{ __('Select') }}
				</span>
				<FeatherIcon name="chevron-down" class="h-3.5 w-3.5 text-gray-400 flex-shrink-0" />
			</span>
		</button>
	</div>

	<Dialog
		v-model="showDialog"
		:options="{ title: __('Select Dine-In Table'), size: 'md' }"
	>
		<template #body>
			<div class="p-4 flex flex-col h-full max-h-[500px]">
				<!-- Top row with search and optional clear selection -->
				<div class="flex items-center gap-2 mb-3.5">
					<div class="relative flex-1">
						<div class="absolute inset-y-0 start-0 ps-3 flex items-center pointer-events-none">
							<svg class="w-3.5 h-3.5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
							</svg>
						</div>
						<input
							type="text"
							v-model="searchQuery"
							:placeholder="__('Search table number or zone...')"
							class="w-full h-9 ps-9 pe-3 text-xs border border-gray-200 rounded-xl bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-shadow"
						/>
					</div>
					
					<!-- Clear Table Button -->
					<button
						v-if="modelValue"
						type="button"
						@click="selectTable(null)"
						class="h-9 px-3 text-xs font-bold text-red-600 bg-red-50 hover:bg-red-100 rounded-xl transition-all duration-150 flex items-center gap-1 active:scale-[0.97] border border-red-200/50 flex-shrink-0"
						:title="__('Deselect currently selected table')"
					>
						<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5">
							<path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V5a2 2 0 00-2-2h-2a2 2 0 00-2 2v2M4 7h16" />
						</svg>
						<span>{{ __('Clear') }}</span>
					</button>
				</div>

				<div class="mb-3 text-[11px] font-medium text-gray-500 uppercase tracking-wider flex items-center gap-1">
					<span>{{ __('Tables for') }}</span>
					<span class="text-gray-800 font-bold bg-gray-100 px-1.5 py-0.5 rounded">{{ orderType }}</span>
				</div>

				<div v-if="isLoading" class="py-12 text-center text-sm text-gray-500 flex flex-col items-center justify-center gap-2">
					<div class="animate-spin rounded-full h-5 w-5 border-b-2 border-amber-500"></div>
					<span>{{ __('Loading tables...') }}</span>
				</div>

				<div
					v-else-if="tables.length === 0"
					class="rounded-xl border border-dashed border-gray-200 py-12 text-center text-sm text-gray-500 flex flex-col items-center justify-center gap-1.5"
				>
					<svg class="w-8 h-8 text-gray-300" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
						<path d="M3 3h18v4H3z" />
						<path d="M5 7v14" />
						<path d="M19 7v14" />
					</svg>
					<span class="font-medium text-gray-600">{{ __('No tables found for this order type.') }}</span>
				</div>

				<div
					v-else-if="filteredTables.length === 0"
					class="rounded-xl border border-dashed border-gray-200 py-12 text-center text-sm text-gray-500 flex flex-col items-center justify-center"
				>
					<span class="font-medium text-gray-600">{{ __('No matches found for "{0}"', [searchQuery]) }}</span>
				</div>

				<!-- Highly Tactile Grid of Table Cards -->
				<div v-else class="overflow-y-auto pr-1 pb-1 flex-1">
					<div class="grid grid-cols-3 sm:grid-cols-4 gap-2.5">
						<button
							v-for="table in filteredTables"
							:key="table.table_no"
							type="button"
							class="flex flex-col items-center justify-between p-3.5 rounded-2xl border transition-all duration-150 active:scale-[0.96] group relative aspect-square min-h-[95px] touch-manipulation cursor-pointer"
							:class="modelValue === table.table_no
								? 'bg-amber-50 border-amber-400 ring-2 ring-amber-200/50 shadow-sm'
								: 'bg-white border-gray-150 hover:border-blue-400 hover:bg-blue-50/10'
							"
							@click="selectTable(table.table_no)"
						>
							<!-- Selected checkmark indicator -->
							<span
								v-if="modelValue === table.table_no"
								class="absolute top-1.5 right-1.5 bg-amber-500 text-white rounded-full p-0.5 shadow-sm"
							>
								<svg class="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="3">
									<path stroke-linecap="round" stroke-linejoin="round" d="M5 13l4 4L19 7" />
								</svg>
							</span>

							<!-- Table Icon representation -->
							<div 
								class="w-7 h-7 rounded-xl flex items-center justify-center transition-colors"
								:class="modelValue === table.table_no ? 'bg-amber-500 text-white' : 'bg-gray-50 text-gray-400 group-hover:bg-blue-50 group-hover:text-blue-500'"
							>
								<svg class="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
									<path d="M3 3h18v4H3z" />
									<path d="M5 7v14" />
									<path d="M19 7v14" />
								</svg>
							</div>
							
							<!-- Table ID Badge -->
							<div 
								class="text-xs font-black transition-colors mt-2"
								:class="modelValue === table.table_no ? 'text-amber-950 font-black' : 'text-gray-800 font-bold'"
							>
								#{{ table.table_no }}
							</div>
							
							<!-- Subtitle (Cleaned Warehouse) -->
							<div 
								class="text-[9px] truncate w-full text-center mt-1"
								:class="modelValue === table.table_no ? 'text-amber-800/80 font-semibold' : 'text-gray-400'"
								:title="table.warehouse"
							>
								{{ formatWarehouse(table.warehouse) }}
							</div>
						</button>
					</div>
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
const searchQuery = ref("")

// Compute tables matching the search filter
const filteredTables = computed(() => {
	const query = searchQuery.value.trim().toLowerCase()
	if (!query) return tables.value

	return tables.value.filter(t => 
		String(t.table_no).toLowerCase().includes(query) ||
		String(t.warehouse || "").toLowerCase().includes(query)
	)
})

// Clean up warehouse string for short display (e.g. remove order type suffix or company suffix)
function formatWarehouse(wh) {
	if (!wh) return ""
	// Remove pos_order_type and company code suffix if present
	let cleaned = wh.split(" - ")[0]
	return cleaned || wh
}

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
	// Always refresh or load if empty
	if (tables.value.length === 0) {
		fetchTables(props.orderType)
	}
}

function selectTable(tableNo) {
	emit('update:modelValue', tableNo)
	showDialog.value = false
	// Reset search input after selection
	searchQuery.value = ""
}

watch(() => props.orderType, (newType) => {
	tables.value = []
	if (showDialog.value) {
		fetchTables(newType)
	}
})
</script>

