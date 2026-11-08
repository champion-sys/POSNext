<template>
	<Dialog v-model="show" :options="{ title: __('Offline Queue'), size: '2xl' }">
		<template #body-content>
			<div class="flex flex-col gap-3">
				<!-- Are the sales safe? -->
				<div
					class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 p-3 rounded-lg border"
					:class="summaryStyle.panel"
				>
					<div class="flex items-start gap-2 min-w-0">
						<svg class="w-6 h-6 flex-shrink-0" :class="summaryStyle.icon" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" :d="summaryStyle.path"/>
						</svg>
						<div class="min-w-0">
							<h3 class="font-semibold text-gray-900 text-sm sm:text-base">{{ summaryTitle }}</h3>
							<p class="text-sm text-gray-700">{{ summaryText }}</p>
							<p class="mt-0.5 text-xs text-gray-600">
								<span>{{ isOffline ? __('Offline') : __('Online') }}</span>
								<span v-if="lastSyncText"> - {{ lastSyncText }}</span>
							</p>
						</div>
					</div>
					<Button
						v-if="!isOffline && invoices.length > 0"
						@click="syncAll"
						:loading="isSyncing"
						variant="solid"
						class="flex-shrink-0 whitespace-nowrap w-full sm:w-auto text-sm !h-11"
					>
						<template #prefix>
							<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/>
							</svg>
						</template>
						{{ __('Sync All') }}
					</Button>
				</div>

				<!-- Settings needs a role and the server's boot data, which a device cut off lacks -->
				<div v-if="isOffline && invoices.length > 0" class="p-3 rounded-lg border border-gray-200">
					<QueueExport />
				</div>

				<!-- Apart from the list: a refused record may have reached the server and left it -->
				<div
					v-for="note in syncStore.refusedVoids"
					:key="note.offline_id"
					class="border border-gray-200 border-s-4 rounded-lg p-3"
					:class="STATE_STYLES[QUEUE_SALE_STANDS].edge"
				>
					<div class="flex items-start justify-between gap-2">
						<div class="min-w-0 flex flex-wrap items-center gap-x-2 gap-y-1">
							<h4 class="min-w-0 max-w-full font-semibold text-gray-900 text-sm sm:text-base truncate">
								{{ getRowTitle(note) }}
							</h4>
							<span
								v-if="getRowKind(note)"
								class="text-xs px-2 py-0.5 bg-blue-100 text-blue-800 rounded-full"
							>
								{{ getRowKind(note) }}
							</span>
						</div>
						<SyncStateBadge :state="STATE_STYLES[QUEUE_SALE_STANDS]" />
					</div>
					<p class="mt-1 text-sm" :class="STATE_STYLES[QUEUE_SALE_STANDS].note">{{ refusedVoidNote(note) }}</p>
					<p
						:dir="getTextDirection(note.void_reason)"
						class="mt-1 px-2 py-1 text-sm bg-gray-50 text-gray-800 rounded break-words"
					>
						{{ __("Reason: {0}", [note.void_reason]) }}
					</p>
					<div class="mt-1 flex justify-end">
						<Button
							variant="outline"
							class="!h-11"
							@click="syncStore.acknowledgeRefusedVoid(note.offline_id)"
						>
							{{ __("I Understand") }}
						</Button>
					</div>
				</div>

				<!-- Empty State -->
				<p v-if="invoices.length === 0" class="py-6 text-center text-gray-600">
					{{ __('Nothing is waiting on this device') }}
				</p>

				<!-- Either number, the local one or the server's, finds a sale -->
				<input
					v-if="invoices.length > 0"
					v-model="searchTerm"
					type="search"
					data-test="queue-search"
					class="w-full h-11 px-3 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
					:placeholder="__('Search by invoice number or customer...')"
				/>

				<p v-if="invoices.length > 0 && shownInvoices.length === 0" class="py-6 text-center text-gray-600">
					{{ __('No invoices found') }}
				</p>

				<!-- Invoices List -->
				<div v-if="shownInvoices.length > 0" class="flex flex-col gap-2 max-h-[50vh] overflow-y-auto">
					<div
						v-for="invoice in shownInvoices"
						:key="invoice.id"
						class="border border-gray-200 border-s-4 rounded-lg p-3"
						:class="stateOf(invoice).edge"
					>
						<div class="flex items-start justify-between gap-2">
							<div class="min-w-0 flex flex-wrap items-center gap-x-2 gap-y-1">
								<h4 class="min-w-0 max-w-full font-semibold text-gray-900 text-sm sm:text-base truncate">
									{{ getRowTitle(invoice) }}
								</h4>
								<span
									v-if="getRowKind(invoice)"
									class="text-xs px-2 py-0.5 bg-blue-100 text-blue-800 rounded-full"
								>
									{{ getRowKind(invoice) }}
								</span>
								<span
									v-if="hasInvoiceNumber(invoice)"
									class="text-xs text-gray-600"
									dir="ltr"
									data-test="queue-number"
								>
									{{ formatInvoiceNumbers(invoice) }}
								</span>
							</div>
							<SyncStateBadge :state="stateOf(invoice)" />
						</div>

						<div class="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-700">
							<template v-if="isSale(invoice)">
								<span class="font-semibold text-gray-900">{{ formatCurrency(invoice.data.grand_total || 0) }}</span>
								<span>{{ __('{0} items', [invoice.data.items?.length || 0]) }}</span>
							</template>
							<span class="text-xs text-gray-600">{{ formatDate(invoice.timestamp) }}</span>
							<span
								v-if="invoice.data?.was_printed"
								class="text-xs px-2 py-0.5 bg-amber-100 text-amber-800 rounded-full"
								:title="__('Receipt was printed — customer may hold a physical copy')"
							>
								{{ __('Printed') }}
							</span>
						</div>

						<p class="mt-1 text-sm" :class="stateOf(invoice).note">{{ stateNote(invoice) }}</p>
						<p
							v-if="invoice.error"
							:dir="getTextDirection(invoice.error)"
							class="mt-1 px-2 py-1 text-sm bg-gray-50 text-gray-800 rounded break-words"
						>
							{{ invoice.error }}
						</p>
						<p
							v-if="invoice.void_reason"
							:dir="getTextDirection(invoice.void_reason)"
							class="mt-1 px-2 py-1 text-sm bg-gray-50 text-gray-800 rounded break-words"
						>
							{{ __("Reason: {0}", [invoice.void_reason]) }}
						</p>

						<div class="mt-1 flex items-center justify-between gap-2">
							<div class="flex flex-wrap items-center gap-1 min-w-0">
								<span
									v-for="(payment, idx) in invoice.data.payments"
									:key="idx"
									class="text-xs px-2 py-0.5 bg-gray-100 text-gray-700 rounded"
								>
									{{ payment.mode_of_payment }}: {{ formatCurrency(payment.amount) }}
								</span>
							</div>
							<div class="flex items-center flex-shrink-0">
								<Button
									v-if="invoice.server_status === SALE_STANDS"
									variant="outline"
									class="!h-11"
									@click="syncStore.acknowledgeSaleStands(invoice.id)"
								>
									{{ __("I Understand") }}
								</Button>
								<button
									v-if="settingsStore.allowEditOfflineInvoice && !invoice.server_status && !invoice.void_reason && isSale(invoice) && !invoice.data.is_return"
									@click="editInvoice(invoice)"
									:disabled="isSyncing || invoice.data?.was_printed"
									class="w-11 h-11 flex items-center justify-center hover:bg-blue-50 rounded-lg transition-colors touch-manipulation disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
									:title="
										invoice.data?.was_printed
											? __('Printed invoices cannot be edited — use Return to issue a credit note')
											: isSyncing
												? __('Sync in progress — editing disabled')
												: __('Edit Invoice')
									"
									:aria-label="__('Edit Invoice')"
								>
									<svg class="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/>
									</svg>
								</button>
								<button
									v-if="isSale(invoice)"
									@click="viewDetails(invoice)"
									class="w-11 h-11 flex items-center justify-center hover:bg-gray-100 rounded-lg transition-colors touch-manipulation"
									:title="__('View Details')"
									:aria-label="__('View Details')"
								>
									<svg class="w-5 h-5 text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/>
									</svg>
								</button>
								<button
									@click="printInvoice(invoice)"
									v-if="isSale(invoice) && !invoice.void_reason && settingsStore.allowPrintOfflineInvoice && (settingsStore.allowPrintPreviousInvoices || (settingsStore.allowPrintLastInvoice && invoice.offline_id && invoice.offline_id === uiStore.lastInvoiceName))"
									class="w-11 h-11 flex items-center justify-center hover:bg-green-50 rounded-lg transition-colors touch-manipulation"
									:title="invoice.data?.was_printed ? __('Reprint receipt (already printed once)') : __('Print receipt')"
									:aria-label="__('Print receipt')"
								>
									<svg class="w-5 h-5 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"/>
									</svg>
								</button>
								<button
									v-if="settingsStore.allowDeleteOfflineInvoice && !invoice.server_status && !invoice.void_reason && !isShiftRecord(invoice)"
									@click="askToVoid(invoice)"
									:disabled="isSyncing"
									class="w-11 h-11 flex items-center justify-center hover:bg-red-50 rounded-lg transition-colors touch-manipulation disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
									:title="isSyncing ? __('Sync in progress — voiding disabled') : __('Void')"
									:aria-label="__('Void')"
								>
									<svg class="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/>
									</svg>
								</button>
							</div>
						</div>
					</div>
				</div>
			</div>
		</template>
	</Dialog>

	<!-- Details Dialog -->
	<Dialog v-model="showDetails" :options="{ title: __('Invoice Details'), size: 'lg' }">
		<template #body-content>
			<div v-if="selectedInvoice" class="flex flex-col gap-3 sm:gap-4">
				<div class="bg-gray-50 p-3 sm:p-4 rounded-lg">
					<div class="flex items-start justify-between gap-2 mb-2">
						<h4 class="font-semibold text-gray-900 text-sm sm:text-base">{{ __('Customer') }}</h4>
						<SyncStateBadge :state="stateOf(selectedInvoice)" />
					</div>
					<p class="text-sm sm:text-base">{{ selectedInvoice.data.customer || __('Walk-in Customer') }}</p>
					<p v-if="hasInvoiceNumber(selectedInvoice)" class="text-sm text-gray-700" dir="ltr">
						{{ formatInvoiceNumbers(selectedInvoice) }}
					</p>
					<p class="mt-1 text-sm" :class="stateOf(selectedInvoice).note">{{ stateNote(selectedInvoice) }}</p>
					<p
						v-if="selectedInvoice.error"
						:dir="getTextDirection(selectedInvoice.error)"
						class="mt-1 text-sm text-gray-800 break-words"
					>
						{{ selectedInvoice.error }}
					</p>
				</div>

				<div class="bg-gray-50 p-3 sm:p-4 rounded-lg">
					<h4 class="font-semibold text-gray-900 mb-2 text-sm sm:text-base">{{ __('Items') }}</h4>
					<div class="flex flex-col gap-2">
						<div
							v-for="(item, idx) in selectedInvoice.data.items"
							:key="idx"
							class="flex justify-between text-xs sm:text-sm gap-2"
						>
							<span class="truncate">{{ item.item_name || item.item_code }} × {{ item.quantity || item.qty }}</span>
							<span class="font-semibold flex-shrink-0">{{ formatCurrency(item.amount || 0) }}</span>
						</div>
					</div>
				</div>

				<div class="bg-gray-50 p-3 sm:p-4 rounded-lg">
					<div class="flex justify-between mb-1 text-xs sm:text-sm">
						<span class="text-gray-600">{{ __('Subtotal') }}</span>
						<span>{{ formatCurrency(selectedInvoice.data.total || 0) }}</span>
					</div>
					<div v-if="selectedInvoice.data.total_tax" class="flex justify-between mb-1 text-xs sm:text-sm">
						<span class="text-gray-600">{{ __('Tax') }}</span>
						<span>{{ formatCurrency(selectedInvoice.data.total_tax) }}</span>
					</div>
					<div v-if="selectedInvoice.data.total_discount" class="flex justify-between mb-1 text-xs sm:text-sm">
						<span class="text-gray-600">{{ __('Discount') }}</span>
						<span class="text-red-600">-{{ formatCurrency(selectedInvoice.data.total_discount) }}</span>
					</div>
					<div class="flex justify-between font-semibold text-base sm:text-lg pt-2 border-t">
						<span>{{ __('Grand Total') }}</span>
						<span>{{ formatCurrency(selectedInvoice.data.grand_total || 0) }}</span>
					</div>
				</div>

				<div v-if="selectedInvoice.data.payments?.length > 0" class="bg-gray-50 p-3 sm:p-4 rounded-lg">
					<h4 class="font-semibold text-gray-900 mb-2 text-sm sm:text-base">{{ __('Payments') }}</h4>
					<div class="flex flex-col gap-1">
						<div
							v-for="(payment, idx) in selectedInvoice.data.payments"
							:key="idx"
							class="flex justify-between text-xs sm:text-sm"
						>
							<span>{{ payment.mode_of_payment }}</span>
							<span class="font-semibold">{{ formatCurrency(payment.amount) }}</span>
						</div>
					</div>
				</div>
			</div>
		</template>
		<template #actions>
			<Button variant="subtle" @click="showDetails = false" class="w-full sm:w-auto !h-11">{{ __('Close') }}</Button>
		</template>
	</Dialog>

	<!-- Void Request Dialog -->
	<Dialog v-model="showVoidDialog" :options="{ title: __('Void Record'), size: 'md' }">
		<template #body-content>
			<div v-if="invoiceToVoid" class="flex flex-col gap-3 sm:gap-4">
				<div class="flex items-start gap-2 sm:gap-3">
					<svg class="w-5 h-5 sm:w-6 sm:h-6 text-red-600 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"/>
					</svg>
					<div class="min-w-0 flex-1">
						<p class="text-gray-900 font-medium mb-2 text-sm sm:text-base">{{ __('Ask the server to void this record?') }}</p>
						<div class="bg-gray-50 rounded-lg p-2.5 sm:p-3 flex flex-col gap-1 text-xs sm:text-sm">
							<div class="flex justify-between gap-2">
								<span class="text-gray-600">{{ __('Customer:') }}</span>
								<span class="font-semibold truncate">{{ getRowTitle(invoiceToVoid) }}</span>
							</div>
							<template v-if="isSale(invoiceToVoid)">
								<div class="flex justify-between gap-2">
									<span class="text-gray-600">{{ __('Amount:') }}</span>
									<span class="font-semibold">{{ formatCurrency(invoiceToVoid.data.grand_total) }}</span>
								</div>
								<div class="flex justify-between gap-2">
									<span class="text-gray-600">{{ __('Items:') }}</span>
									<span class="font-semibold">{{ invoiceToVoid.data.items?.length || 0 }}</span>
								</div>
							</template>
						</div>
						<label class="block mt-3">
							<span class="block text-gray-900 font-medium text-sm mb-1">{{ __('Reason') }}</span>
							<textarea
								v-model="voidReason"
								rows="2"
								maxlength="500"
								dir="auto"
								required
								class="w-full p-2 text-sm border border-gray-300 rounded-lg focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
							></textarea>
						</label>
						<p class="text-red-600 text-xs sm:text-sm mt-2">
							{{ __('This cannot be undone. It stays in the queue until the server answers. If the server already has it, it stands and you will be told here.') }}
						</p>
					</div>
				</div>
			</div>
		</template>
		<template #actions>
			<Button variant="subtle" @click="showVoidDialog = false" class="w-full sm:w-auto !h-11">{{ __('Cancel') }}</Button>
			<Button
				variant="solid"
				theme="red"
				:disabled="!voidReason.trim()"
				@click="confirmVoid"
				class="w-full sm:w-auto !h-11"
			>
				{{ __('Void') }}
			</Button>
		</template>
	</Dialog>
</template>

<script setup>
import SyncStateBadge from "@/components/sale/SyncStateBadge.vue"
import QueueExport from "@/components/settings/QueueExport.vue"
import { DEFAULT_CURRENCY, formatCurrency as formatCurrencyUtil } from "@/utils/currency"
import { Button, Dialog } from "frappe-ui"
import { computed, ref } from "vue"
import { usePOSSettingsStore } from "@/stores/posSettings"
import { usePOSSyncStore } from "@/stores/posSync"
import { usePOSUIStore } from "@/stores/posUI"
import { useToast } from "@/composables/useToast"
import {
	ENTITY_CUSTOMER,
	ENTITY_INVOICE,
	ENTITY_PAYMENT,
	ENTITY_SHIFT_CLOSE,
	ENTITY_SHIFT_OPEN,
	getEntity,
} from "@/utils/offline/entities"
import { SALE_STANDS } from "@/utils/offline/invoicePayload"
import { getInvoiceNumbers, matchesInvoiceNumber } from "@/utils/offline/localNumber"
import {
	QUEUE_FAILED,
	QUEUE_RECEIVED,
	QUEUE_REVIEW,
	QUEUE_SALE_STANDS,
	QUEUE_SENDING,
	QUEUE_VOIDING,
	QUEUE_WAITING,
	formatSyncTime,
	getQueueRowState,
	sortQueueRows,
} from "@/utils/syncQueue"
import { getTextDirection } from "@/utils/textDirection"

const CHECK_ICON = "M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"
const ALERT_ICON = "M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
const CLOCK_ICON = "M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
const CROSS_ICON = "M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z"
const SEND_ICON = "M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"

const SUMMARY_STYLES = {
	attention: { panel: "bg-red-50 border-red-200", icon: "text-red-600", path: ALERT_ICON },
	pending: { panel: "bg-orange-50 border-orange-200", icon: "text-orange-600", path: CLOCK_ICON },
	safe: { panel: "bg-green-50 border-green-200", icon: "text-green-600", path: CHECK_ICON },
}

const props = defineProps({
	modelValue: Boolean,
	isOffline: {
		type: Boolean,
		default: false,
	},
	pendingInvoices: {
		type: Array,
		default: () => [],
	},
	isSyncing: {
		type: Boolean,
		default: false,
	},
	currency: {
		type: String,
		default: DEFAULT_CURRENCY,
	},
})

const emit = defineEmits([
	"update:modelValue",
	"sync-all",
	"void-invoice",
	"edit-invoice",
	"print-invoice",
	"refresh",
])

const show = computed({
	get: () => props.modelValue,
	set: (val) => emit("update:modelValue", val),
})

const settingsStore = usePOSSettingsStore()
const syncStore = usePOSSyncStore()
const uiStore = usePOSUIStore()
const { showWarning } = useToast()

const invoices = computed(() => sortQueueRows(props.pendingInvoices))
const searchTerm = ref("")
const shownInvoices = computed(() => {
	const term = searchTerm.value.trim().toLowerCase()
	if (!term) return invoices.value
	return invoices.value.filter(
		(row) =>
			matchesInvoiceNumber(row, term) ||
			[row.data?.customer_name, row.data?.customer].some((value) =>
				String(value || "").toLowerCase().includes(term),
			),
	)
})
const selectedInvoice = ref(null)
const showDetails = ref(false)
const showVoidDialog = ref(false)
const invoiceToVoid = ref(null)
const voidReason = ref("")

const STATE_STYLES = {
	[QUEUE_WAITING]: {
		label: __("Waiting to send"),
		badge: "bg-gray-100 text-gray-800 border-gray-300",
		edge: "border-s-gray-400",
		note: "text-gray-700",
		icon: CLOCK_ICON,
	},
	[QUEUE_SENDING]: {
		label: __("Sending"),
		badge: "bg-blue-50 text-blue-800 border-blue-300",
		edge: "border-s-blue-500",
		note: "text-blue-800",
		icon: SEND_ICON,
	},
	[QUEUE_RECEIVED]: {
		label: __("Received by server"),
		badge: "bg-green-50 text-green-800 border-green-300",
		edge: "border-s-green-500",
		note: "text-green-800",
		icon: CHECK_ICON,
	},
	[QUEUE_REVIEW]: {
		label: __("Needs review"),
		badge: "bg-amber-50 text-amber-900 border-amber-400",
		edge: "border-s-amber-500",
		note: "text-amber-900",
		icon: ALERT_ICON,
	},
	[QUEUE_FAILED]: {
		label: __("Failed"),
		badge: "bg-red-50 text-red-800 border-red-300",
		edge: "border-s-red-500",
		note: "text-red-800",
		icon: CROSS_ICON,
	},
	[QUEUE_VOIDING]: {
		label: __("Waiting to be voided"),
		badge: "bg-orange-50 text-orange-800 border-orange-300",
		edge: "border-s-orange-500",
		note: "text-orange-800",
		icon: CLOCK_ICON,
	},
	[QUEUE_SALE_STANDS]: {
		label: __("Not voided"),
		badge: "bg-red-50 text-red-800 border-red-300",
		edge: "border-s-red-500",
		note: "text-red-800 font-semibold",
		icon: ALERT_ICON,
	},
}

function stateOf(invoice) {
	return STATE_STYLES[getQueueRowState(invoice, props.isSyncing)]
}

function stateNote(invoice) {
	const tries = invoice.retry_count || 0
	switch (getQueueRowState(invoice, props.isSyncing)) {
		case QUEUE_SALE_STANDS:
			return saleStandsNote(invoice)
		case QUEUE_VOIDING:
			return props.isOffline
				? __("It holds no stock now. The server will be asked when the connection returns.")
				: __("It holds no stock now. It stays here until the server answers.")
		case QUEUE_REVIEW:
			return __("A manager needs to review it on the server.")
		case QUEUE_FAILED:
			return __("Could not be sent after {0} tries. Check the reason, or ask a manager.", [tries])
		case QUEUE_RECEIVED:
			return __("The server has it and is processing it.")
		case QUEUE_SENDING:
			return __("Sending to the server now.")
		default:
			if (tries > 0) return __("Tried {0} times. It will try again by itself.", [tries])
			return props.isOffline
				? __("Saved on this device. It will be sent when the connection returns.")
				: __("Saved on this device. It will be sent shortly.")
	}
}

function saleStandsNote(invoice) {
	if (!isSale(invoice)) {
		return __("This record was already on the server, so it was not voided. It stands. Tell a manager.")
	}
	return invoice.server_invoice
		? __("This sale was already on the server as {0}, so it was not voided. It stands. Tell a manager.", [
				invoice.server_invoice,
			])
		: __("This sale was already on the server, so it was not voided. It stands. Tell a manager.")
}

function refusedVoidNote(note) {
	return isSale(note)
		? __("Voiding is turned off for this POS Profile, so the server refused this void. The sale stands and is sent as usual. Tell a manager.")
		: __("Voiding is turned off for this POS Profile, so the server refused this void. The record stands and is sent as usual. Tell a manager.")
}

const summaryStyle = computed(() => {
	if (syncStore.reviewCount > 0) return SUMMARY_STYLES.attention
	return syncStore.queuedCount > 0 ? SUMMARY_STYLES.pending : SUMMARY_STYLES.safe
})

const summaryTitle = computed(() => {
	if (syncStore.reviewCount > 0) return __("{0} record(s) need attention", [syncStore.reviewCount])
	if (syncStore.queuedCount > 0) return __("{0} record(s) waiting to send", [syncStore.queuedCount])
	return __("All sales are safe")
})

const summaryText = computed(() => {
	if (syncStore.reviewCount > 0) return __("Other records keep sending.")
	if (syncStore.queuedCount > 0) {
		return props.isOffline
			? __("They are saved on this device and will be sent when the connection returns.")
			: __("They are saved on this device and are on their way to the server.")
	}
	return __("Everything has reached the server.")
})

const lastSyncText = computed(() =>
	syncStore.lastSyncedAt ? __("Last sync {0}", [formatSyncTime(syncStore.lastSyncedAt)]) : "",
)

function formatCurrency(amount) {
	return formatCurrencyUtil(amount, props.currency)
}

function isSale(row) {
	return getEntity(row) === ENTITY_INVOICE
}

function isShiftRecord(row) {
	return [ENTITY_SHIFT_CLOSE, ENTITY_SHIFT_OPEN].includes(getEntity(row))
}

function getRowTitle(row) {
	const data = row.data
	if (getEntity(row) === ENTITY_SHIFT_OPEN) return data.pos_profile
	return (
		data.customer_name ||
		data.pos_opening_shift ||
		data.customer ||
		__("Walk-in Customer")
	)
}

/** A sale with a local number, or one the server has named */
function hasInvoiceNumber(row) {
	return isSale(row) && Boolean(row.data?.posa_local_number || row.server_invoice)
}

/** The local number, and the server's name beside it once it has one */
function formatInvoiceNumbers(row) {
	const { primary, secondary } = getInvoiceNumbers(row)
	return secondary ? `${primary} · ${secondary}` : primary
}

function getRowKind(row) {
	if (row.data.is_return) return __("Return")
	switch (getEntity(row)) {
		case ENTITY_CUSTOMER:
			return __("New Customer")
		case ENTITY_PAYMENT:
			return __("Payment for {0}", [row.data.invoice_name])
		case ENTITY_SHIFT_CLOSE:
			return __("Shift Close")
		case ENTITY_SHIFT_OPEN:
			return __("Shift Opening")
		default:
			return ""
	}
}

function formatDate(timestamp) {
	const date = new Date(timestamp)
	const now = new Date()
	const diffInSeconds = Math.floor((now - date) / 1000)

	if (diffInSeconds < 60) return __("Just now")
	if (diffInSeconds < 3600)
		return __('{0} minutes ago', [Math.floor(diffInSeconds / 60)])
	if (diffInSeconds < 86400)
		return __('{0} hours ago', [Math.floor(diffInSeconds / 3600)])

	return formatSyncTime(timestamp)
}

function viewDetails(invoice) {
	selectedInvoice.value = invoice
	showDetails.value = true
}

function editInvoice(invoice) {
	if (!settingsStore.allowEditOfflineInvoice) {
		showWarning(__("Editing of offline invoices is disabled in POS Settings"))
		return
	}
	if (props.isSyncing) return
	if (invoice.data?.was_printed) return
	emit("edit-invoice", invoice)
	show.value = false
}

function printInvoice(invoice) {
	if (!settingsStore.allowPrintOfflineInvoice) {
		showWarning(__("Printing of offline invoices is disabled in POS Settings"))
		return
	}
	const isLastInvoice = invoice.offline_id && uiStore.lastInvoiceName && invoice.offline_id === uiStore.lastInvoiceName
	const canPrint = settingsStore.allowPrintPreviousInvoices || 
	                 (settingsStore.allowPrintLastInvoice && isLastInvoice)

	if (!canPrint) {
		showWarning(__("Printing previous invoices is disabled in POS Settings"))
		return
	}

	// Emit the offline_id — the parent's handlePrintInvoice hydrates from
	// sessionStorage first, then IndexedDB, so reprinting works across reloads.
	emit("print-invoice", { name: invoice.offline_id })
}

function syncAll() {
	emit("sync-all")
}

function askToVoid(invoice) {
	if (!settingsStore.allowDeleteOfflineInvoice) {
		showWarning(__("Deletion of offline invoices is disabled in POS Settings"))
		return
	}
	if (props.isSyncing) return
	invoiceToVoid.value = invoice
	voidReason.value = ""
	showVoidDialog.value = true
}

function confirmVoid() {
	const reason = voidReason.value.trim()
	if (!invoiceToVoid.value || !reason) return

	showVoidDialog.value = false
	emit("void-invoice", invoiceToVoid.value.id, reason)
	invoiceToVoid.value = null
}
</script>
