<template>
	<div
		class="bg-white border-b border-gray-300 sticky top-0 z-[200]"
	>
		<div class="flex py-0 h-[40px] items-stretch">
			<!-- Main Header Content -->
			<div class="flex-1 flex justify-between items-stretch gap-0 pe-0">
				<!-- Left Side: Brand Info -->
				<div class="flex items-stretch gap-0 min-w-0 flex-1 overflow-hidden">
					<!-- Profile Name -->
					<div class="hidden sm:flex items-stretch flex-shrink-0">
						<StatusBadge
							v-if="profileName"
							variant="gray"
							size="xs"
							icon="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
							:text="profileName"
							class="!h-full !border-y-0 !border-e !border-s-0 border-gray-300 flex items-center"
						/>
					</div>

					<!-- Time and Shift Duration - Compact on mobile -->
					<div class="hidden lg:flex items-stretch flex-shrink-0">
						<!-- Current Time -->
						<StatusBadge
							variant="gray"
							size="xs"
							:icon="timeIcon"
							:text="currentTime"
							class="!h-full !border-y-0 !border-e !border-s-0 border-gray-300 flex items-center"
						/>

						<!-- Shift Duration -->
						<StatusBadge
							v-if="hasOpenShift && shiftDuration"
							variant="gray"
							size="xs"
							:icon="shiftIcon"
							:label="__('Shift Open:')"
							:value="shiftDuration"
							class="!h-full !border-y-0 !border-e !border-s-0 border-gray-300 flex items-center"
						/>
					</div>

					<!-- Mobile Time Display - Very compact -->
					<div class="flex lg:hidden items-center text-[10px] text-gray-600 font-medium flex-shrink-0 ms-1">
						<span class="hidden xs:inline whitespace-nowrap">{{ currentTime }}</span>
					</div>
				</div>

				<!-- Right Side: Controls -->
				<div class="flex items-stretch flex-shrink-0">
					<!-- WiFi/Offline Status -->
					<button
						v-if="!disableOfflineMode"
						@click="$emit('sync-click')"
						:class="[
							'px-3 hover:bg-gray-150 active:bg-gray-200 rounded-none border-y-0 border-e-0 border-s border-gray-300 transition-colors relative group touch-manipulation text-gray-600 hover:text-gray-900 h-full flex items-center justify-center',
							isSyncing ? 'animate-pulse' : ''
						]"
						:title="isOffline ? __('Offline ({0} pending)', [pendingInvoicesCount]) : __('Online - Click to sync')"
						:aria-label="isOffline ? __('Offline mode active') : __('Online mode active')"
					>
						<svg
							v-if="!isOffline"
							class="w-4 h-4 sm:w-5 sm:h-5 text-green-600"
							fill="currentColor"
							viewBox="0 0 24 24"
						>
							<path d="M1 9l2 2c4.97-4.97 13.03-4.97 18 0l2-2C16.93 2.93 7.08 2.93 1 9zm8 8l3 3 3-3c-1.65-1.66-4.34-1.66-6 0zm-4-4l2 2c2.76-2.76 7.24-2.76 10 0l2-2C15.14 9.14 8.87 9.14 5 13z"/>
						</svg>
						<svg
							v-else
							class="w-4 h-4 sm:w-5 sm:h-5 text-orange-600"
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
						>
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M18.364 5.636a9 9 0 010 12.728m0 0l-2.829-2.829m2.829 2.829L21 21M15.536 8.464a5 5 0 010 7.072m0 0l-2.829-2.829m-4.243 2.829a4.978 4.978 0 01-1.414-2.83m-1.414 5.658a9 9 0 01-2.167-9.238m7.824 2.167a1 1 0 111.414 1.414m-1.414-1.414L3 3m8.293 8.293l1.414 1.414"/>
						</svg>
						<span
							v-if="pendingInvoicesCount > 0"
							class="absolute top-1.5 end-1.5 bg-orange-600 text-white text-[8px] font-bold rounded-none w-4 h-4 flex items-center justify-center border border-white"
						>
							{{ pendingInvoicesCount }}
						</span>
					</button>

					<!-- Cache Status Indicator -->
					<div class="relative h-full flex items-center">
						<button
							@click="showCacheTooltip = !showCacheTooltip"
							@blur="handleBlur"
							class="px-3 hover:bg-gray-150 active:bg-gray-200 rounded-none border-y-0 border-e-0 border-s border-gray-300 transition-colors relative touch-manipulation text-gray-600 hover:text-gray-900 h-full flex items-center justify-center"
							:aria-label="getCacheAriaLabel()"
						>
							<svg
								class="w-3.5 h-3.5 sm:w-4 sm:h-4 transition-colors"
								:class="getCacheIconColor()"
								fill="currentColor"
								viewBox="0 0 24 24"
							>
								<path d="M12 2C8.13 2 5 3.12 5 4.5V7c0 1.38 3.13 2.5 7 2.5S19 8.38 19 7V4.5C19 3.12 15.87 2 12 2zM5 9v3c0 1.38 3.13 2.5 7 2.5s7-1.12 7-2.5V9c0 1.38-3.13 2.5-7 2.5S5 10.38 5 9zm0 5v3c0 1.38 3.13 2.5 7 2.5s7-1.12 7-2.5v-3c0 1.38-3.13 2.5-7 2.5S5 15.38 5 14z"/>
							</svg>
							<svg
								v-if="cacheSyncing || isRefreshing"
								class="w-3.5 h-3.5 sm:w-4 sm:h-4 absolute top-2.5 start-2.5 animate-spin opacity-70"
								fill="none"
								stroke="currentColor"
								viewBox="0 0 24 24"
								:class="getCacheIconColor()"
							>
								<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
								<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
							</svg>
							<!-- Sync progress badge (visible during sync) -->
							<span
								v-if="cacheSyncing && cacheStats?.items > 0"
								class="absolute bottom-1 end-1 bg-orange-500 text-white text-[7px] font-black rounded-none px-0.5 min-w-[14px] h-3.5 flex items-center justify-center border border-white animate-pulse"
								:title="__('Syncing: {0} items', [formatNumber(cacheStats.items)])"
							>
								{{ formatCompactNumber(cacheStats.items) }}
							</span>
						</button>

						<!-- Tooltip -->
						<div
							v-if="showCacheTooltip"
							@mousedown.prevent
							class="absolute top-full mt-1.5 z-[999] w-[90vw] max-w-[240px] sm:max-w-[260px]"
							:style="{ left: '50%', transform: 'translateX(-50%)' }"
						>
							<div class="bg-white text-gray-900 text-xs rounded-none border border-gray-300 shadow-md py-2 px-2.5 sm:px-3">
								<!-- Arrow -->
								<div class="absolute bottom-full mb-px left-1/2 -translate-x-1/2"
								>
									<div class="border-[5px] sm:border-4 border-transparent border-b-gray-300"></div>
								</div>

								<!-- Header -->
								<div class="flex items-center justify-between mb-1.5 sm:mb-2 pb-1.5 sm:pb-2 border-b border-gray-300">
									<span class="font-bold text-[11px] sm:text-xs uppercase tracking-wider">{{ __('Cache') }}</span>
									<span class="px-1.5 sm:px-2 py-0.5 rounded-none text-[9px] sm:text-[10px] font-bold uppercase border" :class="getCacheStatusBadgeClass()">
										{{ getCacheStatus() }}
									</span>
								</div>

								<!-- Sync Progress Banner (shown during sync) -->
								<div v-if="cacheSyncing" class="mb-2 p-2 bg-orange-50 border border-orange-600 text-orange-900">
									<div class="flex items-center gap-2 mb-1.5">
										<svg class="w-4 h-4 animate-spin text-orange-600" fill="none" viewBox="0 0 24 24">
											<circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
											<path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
										</svg>
										<span class="text-orange-800 font-bold text-[11px] uppercase">{{ __('Syncing...') }}</span>
									</div>
									<div class="text-center">
										<span class="text-orange-950 font-bold text-lg">{{ formatNumber(cacheStats?.items || 0) }}</span>
										<span class="text-orange-800 text-[10px] ms-1">{{ __('items cached') }}</span>
									</div>
								</div>

								<!-- Stats -->
								<div class="flex flex-col gap-1 sm:gap-1.5 text-[10px] sm:text-xs">
									<div class="flex items-center justify-between">
										<span class="text-gray-600">{{ __('Items:') }}</span>
										<span class="font-bold text-gray-900">{{ formatNumber(cacheStats?.items || 0) }}</span>
									</div>
									<div v-if="cacheStats?.lastSync" class="flex items-center justify-between">
										<span class="text-gray-600">{{ __('Last Sync:') }}</span>
										<span class="font-bold text-gray-900 text-[9px] sm:text-[10px]">{{ formatLastSync() }}</span>
									</div>
									<div v-if="!cacheSyncing && stockSyncActive" class="flex items-center justify-between">
										<span class="text-gray-600">{{ __('Auto-Sync:') }}</span>
										<span class="text-green-700 font-bold flex items-center gap-1">
											<div class="w-1.5 h-1.5 bg-green-600 rounded-none animate-pulse"></div>
											{{ __('Active') }}
										</span>
									</div>
								</div>

								<!-- Clear Cache Button -->
								<div class="mt-1.5 sm:mt-2 pt-1.5 sm:pt-2 border-t border-gray-300">
									<button
										@click="handleClearCacheClick"
										:disabled="isOffline"
										:class="[
											'w-full px-2 py-1.5 sm:py-2 rounded-none transition-colors font-bold text-[10px] sm:text-[11px] uppercase tracking-wider flex items-center justify-center gap-1.5',
											isOffline
												? 'border border-gray-200 text-gray-400 cursor-not-allowed bg-gray-50'
												: 'border border-red-600 text-red-600 hover:bg-red-600 hover:text-white bg-white active:scale-95'
										]"
										:title="isOffline ? __('Cannot clear cache while offline') : __('Clear all cached data')"
									>
										<svg class="w-2.5 h-2.5 sm:w-3 sm:h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
											<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
										</svg>
										{{ __('Clear Cache') }}
									</button>
								</div>
							</div>
						</div>
					</div>

					<!-- Printer - Visible only while shift is open -->
					<div v-if="hasOpenShift" class="hidden md:block relative h-full">
						<button
							:title="silentPrintEnabled ? (qzConnected ? __('Silent Print: Connected') : __('Silent Print: Disconnected')) : __('Print Invoice')"
							@click="$emit('printer-click')"
							class="px-3 hover:bg-gray-150 active:bg-gray-200 rounded-none border-y-0 border-e-0 border-s border-gray-300 transition-colors group touch-manipulation text-gray-600 hover:text-gray-900 h-full flex items-center justify-center"
						>
							<svg class="w-3.5 h-3.5 sm:w-4 sm:h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
								<path stroke-linecap="round" stroke-linejoin="round" :d="printerIcon" />
							</svg>
						</button>
						<span
							v-if="silentPrintEnabled"
							class="absolute top-1.5 end-1.5 w-1.5 h-1.5 rounded-none border border-white"
							:class="qzConnected ? 'bg-green-500' : 'bg-red-500'"
						></span>
					</div>

					<!-- Bluetooth Print Queue Indicator -->
					<div v-if="hasOpenShift && btStore.isEnabled" class="relative h-full flex items-center">
						<button
							@click="showQueueTooltip = !showQueueTooltip"
							@blur="handleQueueBlur"
							class="px-3 hover:bg-gray-150 active:bg-gray-200 rounded-none border-y-0 border-e-0 border-s border-gray-300 transition-colors relative touch-manipulation text-gray-600 hover:text-gray-900 h-full flex items-center justify-center"
							:title="__('Bluetooth Print Queue')"
						>
							<svg class="w-3.5 h-3.5 sm:w-4 sm:h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
								<path stroke-linecap="round" stroke-linejoin="round" d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
							</svg>
							
							<span v-if="activeJob" class="w-1.5 h-1.5 rounded-full bg-blue-500 absolute top-1.5 start-1.5 animate-ping"></span>
							
							<span
								v-if="pendingJobsCount > 0 || failedJobsCount > 0"
								class="absolute top-1 end-1 text-[8px] font-bold rounded-full w-3.5 h-3.5 flex items-center justify-center border border-white"
								:class="failedJobsCount > 0 ? 'bg-red-500 text-white' : 'bg-blue-600 text-white'"
							>
								{{ pendingJobsCount + failedJobsCount }}
							</span>
						</button>

						<!-- Print Queue Tooltip Dropdown -->
						<div
							v-if="showQueueTooltip"
							@mousedown.prevent
							class="absolute top-full mt-1.5 z-[999] w-[90vw] max-w-[280px]"
							:style="{ left: '50%', transform: 'translateX(-50%)' }"
						>
							<div class="bg-white text-gray-900 text-xs rounded border border-gray-300 shadow-lg py-2.5 px-3 flex flex-col gap-2">
								<!-- Arrow -->
								<div class="absolute bottom-full mb-px left-1/2 -translate-x-1/2">
									<div class="border-[5px] border-transparent border-b-gray-300"></div>
								</div>

								<!-- Header -->
								<div class="flex items-center justify-between border-b pb-1.5">
									<span class="font-bold text-xs uppercase tracking-wider text-gray-700">{{ __('Print Queue') }}</span>
									<span
										class="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase border"
										:class="activeJob ? 'bg-blue-50 border-blue-500 text-blue-700 font-bold animate-pulse' : failedJobsCount > 0 ? 'bg-red-50 border-red-500 text-red-700' : 'bg-gray-50 border-gray-300 text-gray-600'"
									>
										{{ activeJob ? __('Printing') : failedJobsCount > 0 ? __('Error') : __('Idle') }}
									</span>
								</div>

								<!-- Connection status info -->
								<div class="text-[10px] text-gray-500 flex items-center gap-1.5">
									<div class="w-1.5 h-1.5 rounded-full" :class="btStore.isConnected ? 'bg-green-500' : 'bg-red-500'"></div>
									<span class="font-medium truncate max-w-[220px]">
										{{ btStore.isConnected ? __('Connected: {0}', [btStore.savedPrinterName]) : __('Printer Disconnected') }}
									</span>
								</div>

								<!-- Queue list -->
								<div class="max-h-[160px] overflow-y-auto flex flex-col gap-1.5 pr-0.5 scrollbar-thin">
									<div v-if="queueJobs.length === 0" class="text-center py-4 text-gray-400 italic">
										{{ __('No jobs in queue') }}
									</div>
									<div
										v-for="job in queueJobs"
										:key="job.id"
										class="p-1.5 bg-gray-50 border border-gray-200 rounded flex flex-col gap-1"
									>
										<div class="flex items-center justify-between gap-1 text-[10px]">
											<span class="font-mono text-gray-500">ID: {{ job.id }}</span>
											<span
												class="px-1 py-0.2 rounded text-[8px] font-bold uppercase"
												:class="getJobStatusClass(job.status)"
											>
												{{ __(job.status) }}
											</span>
										</div>
										<p v-if="job.errorMsg" class="text-[9px] text-red-600 leading-tight font-medium">
											{{ job.errorMsg }}
										</p>
										<div class="flex items-center justify-between text-[9px] text-gray-400">
											<span>{{ formatTime(job.createdAt) }}</span>
											<div class="flex items-center gap-1">
												<span v-if="job.retries > 0" class="text-orange-500 font-medium">{{ __('Retry:') }} {{ job.retries }}/{{ job.maxRetries }}</span>
												<span :class="['px-1 rounded font-bold uppercase', getPriorityClass(job.priority)]">{{ __(job.priority) }}</span>
												
												<button
													v-if="job.status === 'pending' || job.status === 'failed'"
													@click="cancelJob(job.id)"
													class="text-red-500 hover:text-red-700 font-bold p-0.5 rounded hover:bg-red-50 transition-colors"
													:title="__('Cancel Job')"
												>
													<svg class="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
														<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M6 18L18 6M6 6l12 12" />
													</svg>
												</button>
											</div>
										</div>
									</div>
								</div>

								<!-- Queue Controls Footer -->
								<div class="border-t pt-1.5 flex items-center justify-between gap-2">
									<button
										@click="clearQueue"
										:disabled="queueJobs.length === 0"
										class="flex-1 py-1 text-[10px] font-bold uppercase tracking-wider text-center text-gray-600 hover:text-red-600 border border-gray-300 rounded bg-white hover:bg-gray-50 disabled:bg-gray-50 disabled:text-gray-300 disabled:border-gray-200 disabled:cursor-not-allowed transition-colors"
									>
										{{ __('Clear All') }}
									</button>
									<button
										@click="retryFailed"
										:disabled="failedJobsCount === 0"
										class="flex-1 py-1 text-[10px] font-bold uppercase tracking-wider text-center text-white bg-blue-600 hover:bg-blue-700 disabled:bg-blue-300 disabled:cursor-not-allowed rounded transition-colors"
									>
										{{ __('Retry Failed') }}
									</button>
								</div>
							</div>
						</div>
					</div>

					<!-- Refresh -->
					<button
						:title="isRefreshing ? __('Refreshing...') : __('Refresh')"
						@click="$emit('refresh-click')"
						class="touch-manipulation px-3 hover:bg-gray-150 active:bg-gray-200 rounded-none border-y-0 border-e-0 border-s border-gray-300 transition-colors text-gray-600 hover:text-gray-900 group h-full flex items-center justify-center"
						:aria-label="isRefreshing ? __('Refreshing...') : __('Refresh items and customers')"
					>
						<svg :class="['w-3.5 h-3.5 sm:w-4 sm:h-4', isRefreshing ? 'animate-spin' : '']" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
							<path stroke-linecap="round" stroke-linejoin="round" :d="refreshIcon" />
						</svg>
					</button>

					<div class="hidden md:block h-full">
						<LanguageSwitcher />
					</div>
				</div>
			</div>
		</div>
	</div>
</template>

<script setup>
import StatusBadge from "@/components/common/StatusBadge.vue"
import LanguageSwitcher from "@/components/common/LanguageSwitcher.vue"
import { DEFAULT_LOCALE } from "@/utils/currency"
import { ref, onMounted, onUnmounted, computed } from "vue"
import { version } from "../../../package.json"
import { useBluetoothPrinterStore } from "@/stores/bluetoothPrinter"
import { printerService } from "@/services/printerService"

const btStore = useBluetoothPrinterStore()
const showQueueTooltip = ref(false)
const queueJobs = ref([])

const pendingJobsCount = computed(() => {
	return queueJobs.value.filter(j => j.status === "pending").length
})

const failedJobsCount = computed(() => {
	return queueJobs.value.filter(j => j.status === "failed").length
})

const activeJob = computed(() => {
	return queueJobs.value.find(j => j.status === "printing")
})

onMounted(() => {
	// Initialize jobs list
	queueJobs.value = printerService.queue.getJobs()
	
	// Reactively update jobs list on any queue events
	const updateJobs = () => {
		queueJobs.value = printerService.queue.getJobs()
	}
	printerService.queue.on("statusChanged", updateJobs)
	printerService.queue.on("added", updateJobs)
	printerService.queue.on("drain", updateJobs)

	onUnmounted(() => {
		printerService.queue.off("statusChanged", updateJobs)
		printerService.queue.off("added", updateJobs)
		printerService.queue.off("drain", updateJobs)
	})
})

function formatTime(timestamp) {
	if (!timestamp) return ""
	const date = new Date(timestamp)
	return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

function getJobStatusClass(status) {
	if (status === "printing") return "bg-blue-100 text-blue-700 border border-blue-200 animate-pulse font-bold"
	if (status === "completed") return "bg-green-100 text-green-700"
	if (status === "failed") return "bg-red-100 text-red-700 border border-red-200 font-bold"
	if (status === "cancelled") return "bg-gray-100 text-gray-500"
	return "bg-yellow-100 text-yellow-700 font-medium" // pending
}

function getPriorityClass(priority) {
	if (priority === "high") return "bg-red-50 text-red-600 font-bold"
	if (priority === "low") return "bg-gray-50 text-gray-500 font-medium"
	return "bg-blue-50 text-blue-600 font-medium"
}

function handleQueueBlur(event) {
	// Prevent immediate blur closure when interacting within the print queue container
	if (event.relatedTarget && event.currentTarget.parentElement.contains(event.relatedTarget)) {
		return
	}
	setTimeout(() => {
		showQueueTooltip.value = false
	}, 200)
}

function cancelJob(jobId) {
	printerService.queue.cancelJob(jobId)
}

function clearQueue() {
	printerService.queue.clear()
}

function retryFailed() {
	printerService.queue.retryFailedJobs()
}

const showCacheTooltip = ref(false)
const appVersion = version

const emit = defineEmits([
	"sync-click",
	"printer-click",
	"refresh-click",
	"menu-click",
	"clear-cache",
])

function handleClearCacheClick() {
	showCacheTooltip.value = false
	emit('clear-cache')
}

function handleBlur(event) {
	// Don't close if clicking inside the tooltip
	if (!event.relatedTarget || !event.currentTarget.parentElement.contains(event.relatedTarget)) {
		setTimeout(() => {
			showCacheTooltip.value = false
		}, 200)
	}
}

const props = defineProps({
	currentTime: {
		type: String,
		required: true,
	},
	shiftDuration: {
		type: String,
		default: null,
	},
	hasOpenShift: {
		type: Boolean,
		default: false,
	},
	profileName: {
		type: String,
		default: null,
	},
	isOffline: {
		type: Boolean,
		default: false,
	},
	isSyncing: {
		type: Boolean,
		default: false,
	},
	pendingInvoicesCount: {
		type: Number,
		default: 0,
	},
	isAnyDialogOpen: {
		type: Boolean,
		default: false,
	},
	cacheSyncing: {
		type: Boolean,
		default: false,
	},
	cacheStats: {
		type: Object,
		default: () => ({ items: 0, lastSync: null }),
	},
	stockSyncActive: {
		type: Boolean,
		default: false,
	},
	isRefreshing: {
		type: Boolean,
		default: false,
	},
	silentPrintEnabled: {
		type: Boolean,
		default: false,
	},
	qzConnected: {
		type: Boolean,
		default: false,
	},
	disableOfflineMode: {
		type: Boolean,
		default: false,
	},
})

// Cache status helpers
function getCacheIconColor() {
	if (!props.cacheStats || props.cacheStats.items === 0) {
		return "text-red-600" // Red: No cache
	}
	if (props.cacheSyncing) {
		return "text-orange-600" // Orange: Syncing in progress
	}
	return "text-green-600" // Green: Cache ready
}

function getCacheStatus() {
	if (!props.cacheStats || props.cacheStats.items === 0) {
		return __("Empty")
	}
	if (props.cacheSyncing) {
		return __("Syncing")
	}
	return __("Ready")
}

function getCacheStatusBadgeClass() {
	if (!props.cacheStats || props.cacheStats.items === 0) {
		return "bg-red-50 border-red-600 text-red-700 font-bold"
	}
	if (props.cacheSyncing) {
		return "bg-orange-50 border-orange-600 text-orange-700 font-bold"
	}
	return "bg-green-50 border-green-600 text-green-700 font-bold"
}

function formatLastSync() {
	if (!props.cacheStats?.lastSync) {
		return __("Never")
	}
	const date = new Date(props.cacheStats.lastSync)
	return date.toLocaleTimeString(DEFAULT_LOCALE, {
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
	})
}

function getCacheAriaLabel() {
	if (!props.cacheStats || props.cacheStats.items === 0) {
		return __("Cache empty")
	}
	if (props.cacheSyncing) {
		return __("Cache syncing")
	}
	return __("Cache ready")
}

function formatNumber(num) {
	if (!num) return '0'
	return num.toLocaleString()
}

function formatCompactNumber(num) {
	if (!num) return '0'
	if (num >= 1000) {
		return (num / 1000).toFixed(num >= 10000 ? 0 : 1) + 'K'
	}
	return num.toString()
}

// SVG Path Icons
const timeIcon = "M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
const shiftIcon =
	"M9 12l2 2 4-4M7.835 4.697a3.42 3.42 0 001.946-.806 3.42 3.42 0 014.438 0 3.42 3.42 0 001.946.806 3.42 3.42 0 013.138 3.138 3.42 3.42 0 00.806 1.946 3.42 3.42 0 010 4.438 3.42 3.42 0 00-.806 1.946 3.42 3.42 0 01-3.138 3.138 3.42 3.42 0 00-1.946.806 3.42 3.42 0 01-4.438 0 3.42 3.42 0 00-1.946-.806 3.42 3.42 0 01-3.138-3.138 3.42 3.42 0 00-.806-1.946 3.42 3.42 0 010-4.438 3.42 3.42 0 00.806-1.946 3.42 3.42 0 013.138-3.138z"
const printerIcon =
	"M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"
const refreshIcon =
	"M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
</script>
