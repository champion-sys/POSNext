<template>
	<table class="w-full border-collapse border-t border-black bg-white text-sm">
		<thead>
			<tr class="text-[11px] font-bold text-gray-700">
				<th scope="col" :class="[headerClass, 'px-2 text-start']">{{ __('Item') }}</th>
				<th scope="col" :class="[headerClass, 'px-1 w-[9%] text-start']">{{ __('Unit') }}</th>
				<!-- Figures stay right-aligned in both directions, like a ledger -->
				<th scope="col" :class="[headerClass, 'px-1 w-[9%] text-right']">{{ __('Qty') }}</th>
				<th scope="col" :class="[headerClass, 'px-1 w-[12%] text-right']">{{ __('Rate') }}</th>
				<th scope="col" :class="[headerClass, 'px-1 w-[9%] text-right']">{{ __('Discount %') }}</th>
				<th scope="col" :class="[headerClass, 'px-1 w-[13%] text-right']">{{ __('Total') }} <span dir="ltr">({{ currencySymbol }})</span></th>
				<th scope="col" :class="[headerClass, 'w-pos-tap']"><span class="sr-only">{{ __('Remove') }}</span></th>
			</tr>
		</thead>
		<tbody class="divide-y divide-gray-200">
			<tr
				v-for="(item, index) in items"
				:key="item.item_code + '-' + (item.uom || '') + (item.is_free_item ? '-free' : '')"
				class="cart-item-row focus-within:bg-blue-50/40"
				:class="[
					index === focusedIndex ? 'bg-gray-100' : '',
					item.is_free_item ? 'bg-green-50/30' : '',
				]"
				:data-line="index"
				@click.stop="$emit('row-click', index)"
			>
				<td class="w-full max-w-0 px-2 py-0.5 align-middle">
					<div class="line-clamp-2 text-[13px] font-bold leading-tight text-gray-900 [overflow-wrap:anywhere]" :title="item.item_name">
						{{ item.item_name }}
					</div>
					<div v-if="showsItemCode(item)" class="truncate text-[10px] font-mono text-gray-500">{{ item.item_code }}</div>
					<div v-if="!item.is_free_item && item.free_qty > 0" class="text-[10px] font-bold text-green-700">
						{{ __('+{0} FREE', [item.free_qty]) }}
					</div>
				</td>

				<td class="px-0.5 align-middle">
					<select
						v-if="rulesFor(item).unit"
						class="w-full min-w-[60px] h-pos-tap px-1 text-xs font-bold text-gray-900 bg-white border border-gray-400 rounded-none focus:outline-none focus:border-black touch-manipulation"
						:value="item.uom || item.stock_uom"
						:aria-label="__('Unit')"
						:title="__('Unit')"
						@click.stop
						@keydown="handleUnitKeydown"
						@change="handleUnitChange(item, $event)"
					>
						<option v-for="unit in getUnitOptions(item)" :key="unit" :value="unit">{{ unit }}</option>
					</select>
					<span v-else class="block px-1 text-xs text-gray-700 whitespace-nowrap">{{ item.uom || item.stock_uom }}</span>
				</td>

				<td class="px-0.5 align-middle">
					<CartNumberField
						v-if="rulesFor(item).quantity"
						:value="item.quantity"
						:label="__('Quantity')"
						class="!min-w-[52px]"
						:format="formatQuantity"
						@commit="handleQuantity(item, $event)"
					/>
					<button
						v-else-if="rulesFor(item).quantityInDialog"
						type="button"
						class="w-full min-w-[52px] h-pos-tap flex items-center justify-end gap-1 px-1 text-sm font-mono font-bold text-gray-900 bg-white border border-black touch-manipulation"
						:aria-label="__('Edit Item Details')"
						:title="__('Edit Item Details')"
						@click.stop="$emit('open-dialog', item)"
					>
						<FeatherIcon name="edit-2" class="w-3 h-3 flex-shrink-0" />
						<span dir="ltr">{{ formatQuantity(item.quantity) }}</span>
					</button>
					<span v-else dir="ltr" class="block px-1 text-right font-mono font-bold text-gray-700">{{ formatQuantity(item.quantity) }}</span>
				</td>

				<td class="px-0.5 align-middle">
					<CartNumberField
						v-if="rulesFor(item).rate"
						:value="item.rate"
						:label="__('Rate')"
						:format="formatRateForEditing"
						:longest-figure="11"
						@commit="handleRate(item, $event)"
					/>
					<span
						v-else
						dir="ltr"
						class="flex items-center justify-end gap-1 px-1 font-mono text-gray-700"
						:title="getRateLockReason(item, settings)"
					>
						<FeatherIcon v-if="hasPricingRules(item)" name="lock" class="w-3 h-3 text-amber-600 flex-shrink-0" />
						{{ formatAmount(item.rate) }}
					</span>
				</td>

				<td class="px-0.5 align-middle">
					<CartNumberField
						v-if="rulesFor(item).discount"
						:value="getDiscountPercent(item)"
						:label="__('Discount %')"
						class="!min-w-[52px]"
						:format="formatPercent"
						@commit="handleDiscount(item, $event)"
					/>
					<span v-else dir="ltr" class="block px-1 text-right font-mono text-gray-700">{{ formatPercent(getDiscountPercent(item)) }}</span>
				</td>

				<td class="px-1 align-middle text-right">
					<span v-if="item.is_free_item" class="font-bold text-green-700">{{ __('Free') }}</span>
					<span v-else dir="ltr" class="font-mono font-bold whitespace-nowrap text-gray-900">{{ formatAmount(getLineTotal(item, taxInclusive)) }}</span>
				</td>

				<td class="align-middle">
					<button
						v-if="rulesFor(item).remove"
						type="button"
						tabindex="-1"
						class="size-pos-tap flex items-center justify-center text-gray-600 hover:text-red-600 active:text-red-700 touch-manipulation"
						:aria-label="__('Remove {0}', [item.item_name])"
						:title="__('Remove item')"
						@click.stop="$emit('remove', item)"
					>
						<svg class="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2" aria-hidden="true">
							<path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
						</svg>
					</button>
				</td>
			</tr>
		</tbody>
	</table>
</template>

<script setup>
import CartNumberField from "@/components/sale/CartNumberField.vue"
import { useToast } from "@/composables/useToast"
import { getCurrencySymbol } from "@/utils/currency"
import {
	buildRateUpdate,
	capDiscountPercent,
	getLineEditRules,
	getLineTotal,
	getRateError,
	getRateLockReason,
	getUnitOptions,
	hasPricingRules,
	isShortcutKey,
	normalizeQuantity,
	showsItemCode,
} from "@/utils/cartItemEdit"
import { announceScan, createScanBurst } from "@/utils/scanBurst"
import { FeatherIcon } from "frappe-ui"
import { computed, onBeforeUnmount } from "vue"

const props = defineProps({
	items: {
		type: Array,
		required: true,
	},
	settings: {
		type: Object,
		required: true,
	},
	currency: {
		type: String,
		required: true,
	},
	taxInclusive: {
		type: Boolean,
		default: false,
	},
	focusedIndex: {
		type: Number,
		default: -1,
	},
	formatQuantity: {
		type: Function,
		required: true,
	},
	formatAmount: {
		type: Function,
		required: true,
	},
})

const emit = defineEmits(["edit-line", "change-unit", "open-dialog", "remove", "row-click"])

const { showError, showWarning } = useToast()

// The line is a shadow because a collapsed border does not stick with its header
const headerClass = "sticky top-0 z-10 py-1 bg-gray-50 shadow-[inset_0_-1px_0_#000]"

const currencySymbol = computed(() => getCurrencySymbol(props.currency))

const rulesFor = (item) => getLineEditRules(item, props.settings)
// Plain, because a thousands comma in a field reads back as a decimal point
const formatRateForEditing = (value) => Number(value).toFixed(props.settings.decimalPrecision)
const formatPercent = (value) => String(Math.round(Number(value) * 100) / 100)
const getDiscountPercent = (item) => Number(item.discount_percentage) || 0

// A wedge scan would otherwise pick a unit by type-ahead
const unitScanBurst = createScanBurst({ onScan: announceScan })

function handleUnitKeydown(event) {
	if (event.key.length === 1 && event.key !== " ") event.preventDefault()
	if (unitScanBurst.handleKeydown(event)) event.preventDefault()

	// Arrows and Enter belong to this field, not to the cart's row shortcuts
	if (!isShortcutKey(event)) event.stopPropagation()
}

function handleUnitChange(item, event) {
	emit("change-unit", item, event.target.value)
}

function handleQuantity(item, value) {
	const quantity = normalizeQuantity(value)
	if (quantity === null || quantity === item.quantity) return
	emit("edit-line", item, { quantity })
}

function handleRate(item, value) {
	if (value === null || value === item.rate) return

	const listRate = item.price_list_rate || item.rate
	const error = getRateError(value, listRate, props.settings.maxDiscountAllowed)
	if (error) {
		showError(error)
		return
	}
	emit("edit-line", item, buildRateUpdate(value, listRate))
}

function handleDiscount(item, value) {
	const typed = value === null ? 0 : value
	if (typed < 0) return

	const maxDiscount = props.settings.maxDiscountAllowed
	const percent = Math.round(capDiscountPercent(typed, maxDiscount) * 100) / 100
	if (percent < typed) {
		showWarning(__("Maximum allowed discount is {0}%", [percent]))
	}
	if (percent === getDiscountPercent(item)) return

	emit("edit-line", item, { discount_percentage: percent, discount_amount: 0 })
}

onBeforeUnmount(() => unitScanBurst.reset())
</script>
