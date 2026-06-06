<!--
  InvoiceCart.vue - Shopping Cart Component for POS System

  ============================================================================
  OVERVIEW
  ============================================================================
  This component displays the shopping cart in the POS interface, including:
  - Customer selection/search with instant in-memory filtering
  - Cart items list with quantity controls, UOM selection, and pricing
  - Offers and coupon application buttons
  - Order totals (subtotal, discount, tax, grand total)
  - Checkout and Hold order actions
  - Quick action buttons when cart is empty

  ============================================================================
  COMPONENT STRUCTURE
  ============================================================================

  1. HEADER SECTION (Customer Selection)
     - Shows selected customer info with edit/remove options
     - Search input with instant filtering from cached customer list
     - Dropdown with search results and "Create New Customer" option
     - Works offline using cached customer data

  2. ACTION BUTTONS SECTION (Offers & Coupons)
     - "Offers" button - Shows available promotional offers
     - "Coupon" button - Apply coupon/gift card codes
     - Badge indicators show count of available/applied offers

  3. CART ITEMS SECTION
     - Scrollable list of cart items
     - Each item shows: thumbnail, name, badges (free/discount), price, quantity controls
     - Quantity controls: increment/decrement buttons + manual input
     - UOM (Unit of Measure) dropdown selector
     - Serial item support with edit dialog
     - Empty cart state with quick action buttons

  4. TOTALS SECTION
     - Total Quantity
     - Subtotal
     - Discount (highlighted when applied)
     - Tax
     - Grand Total (emphasized)

  5. ACTION BUTTONS
     - Checkout - Proceed to payment
     - Hold - Save as draft order

  ============================================================================
  FEATURES
  ============================================================================

  - Offline Support: Customer search works offline using cached data
  - Instant Search: In-memory customer filtering for zero-latency results
  - Smart Quantity Steps: Automatically detects decimal precision for +/- buttons
  - UOM Conversion: Change units with automatic price recalculation
  - Serial Number Support: Special handling for serialized inventory items
  - Responsive Design: Adapts to mobile and desktop layouts
  - Touch Optimized: Large tap targets and touch feedback
  - RTL Support: Fully supports right-to-left languages

  ============================================================================
-->
<template>
	<div class="flex flex-col h-full">
		<!-- Header with Customer -->
		 <div v-if="showPosOrderType" class="mb-0 p-2 px-2 bg-gray-200 pb-0 flex items-center gap-2 w-full">
			<div class="flex-1 min-w-0">
				<OrderType
					data-testid="pos-order-type-no-customer"
					:label="__('Order Type')"
					:pos-profile="posProfile"
					v-model="orderTypeModel"
				/>
			</div>
			<transition
				enter-active-class="transition-all duration-300 ease-out"
				enter-from-class="transform translate-x-4 opacity-0 max-w-0 pointer-events-none"
				enter-to-class="transform translate-x-0 opacity-100 max-w-[200px]"
				leave-active-class="transition-all duration-200 ease-in"
				leave-from-class="transform translate-x-0 opacity-100 max-w-[200px]"
				leave-to-class="transform translate-x-4 opacity-0 max-w-0 pointer-events-none"
			>
				<div v-if="showTableSelector" class="w-48 shrink-0 overflow-hidden">
					<TableSelector
						v-model="tableModel"
						:order-type="orderTypeModel"
						:disabled="!orderTypeModel"
					/>
				</div>
			</transition>
		</div>
		<div class="px-2 py-2 border-b border-gray-200 bg-gray-200 pb-2.5">
			<!-- Inline Customer Search/Selection -->
			<div ref="customerSearchContainer" class="relative">
				<!-- Unified Service Control Panel: Order Type + Table Selector -->
				

				<div v-if="customer">
					<!-- Two Cards Layout: Customer Card + Document Type Card -->
					<div class="flex items-stretch gap-2">
						<!-- Customer Card -->
						<div class="flex-1 flex items-center gap-1.5 bg-white  rounded-none p-1.5 min-w-0">
							<!-- Customer Avatar & Info -->
							<div class="flex items-center gap-2 min-w-0 flex-1 px-1.5 py-1">
								<div class="w-8 h-8 bg-black rounded-sm flex items-center justify-center flex-shrink-0">
									<svg class="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
									</svg>
								</div>
								<div class="min-w-0 flex-1">
									<p class="text-xs font-bold text-gray-900 truncate leading-tight">
										{{ customer.customer_name || customer.name }}
									</p>
									<p v-if="customer.mobile_no" class="text-[10px] text-gray-600 truncate leading-tight">
										{{ customer.mobile_no }}
									</p>
								</div>
							</div>

							<!-- Action Buttons -->
							<div class="flex items-center gap-0.5 flex-shrink-0" @click.stop>
								<button
									type="button"
									@click.stop="$emit('edit-customer', customer)"
									class="w-7 h-7 flex items-center justify-center text-blue-600 hover:bg-gray-100 active:bg-gray-200 rounded-none border border-transparent transition-colors touch-manipulation"
									:title="__('Edit customer details')"
								>
									<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
										<path stroke-linecap="round" stroke-linejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
									</svg>
								</button>
								<button
									type="button"
									@click.stop="$emit('create-customer', '')"
									class="w-7 h-7 flex items-center justify-center text-green-700 hover:bg-gray-100 active:bg-gray-200 rounded-none border border-transparent transition-colors touch-manipulation"
									:title="__('Create new customer')"
								>
									<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5">
										<path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4" />
									</svg>
								</button>
								<button
									type="button"
									@click.stop="removeCustomer"
									class="w-7 h-7 flex items-center justify-center text-red-600 hover:bg-gray-100 active:bg-gray-200 rounded-none border border-transparent transition-colors touch-manipulation"
									:title="__('Remove customer')"
								>
									<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2.5">
										<path stroke-linecap="round" stroke-linejoin="round" d="M6 18L18 6M6 6l12 12" />
									</svg>
								</button>
							</div>
						</div>

						<!-- Document Type Card -->
						<div
							v-if="settingsStore.allowSalesOrder"
							class="flex items-center bg-white border border-black rounded-none p-1 flex-shrink-0"
						>
							<div class="flex items-center bg-gray-200 rounded-none p-0.5">
								<button
									type="button"
									@click="selectDocType('Sales Invoice')"
									class="px-2.5 py-1.5 text-[11px] font-bold rounded-none transition-colors flex items-center gap-1"
									:class="cartStore.targetDoctype === 'Sales Invoice'
										? 'bg-black text-white'
										: 'text-gray-900 hover:bg-gray-100 active:bg-gray-200'"
									:title="__('Sales Invoice')"
								>
									<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
									</svg>
									<span>{{ __("Invoice") }}</span>
								</button>
								<button
									type="button"
									@click="selectDocType('Sales Order')"
									class="px-2.5 py-1.5 text-[11px] font-bold rounded-none transition-colors flex items-center gap-1"
									:class="cartStore.targetDoctype === 'Sales Order'
										? 'bg-black text-white'
										: 'text-gray-900 hover:bg-gray-100 active:bg-gray-200'"
									:title="__('Sales Order')"
								>
									<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
									</svg>
									<span>{{ __("Order") }}</span>
								</button>
							</div>
						</div>
					</div>
				</div>

				<div v-else>
					<div class="flex gap-1.5">
						<!-- Search Input -->
						<div class="relative flex-1">
							<!-- Search Icon Prefix -->
							<div
								class="absolute inset-y-0 start-0 ps-3 flex items-center pointer-events-none"
							>
								<svg
									v-if="customersLoaded"
									class="w-4 h-4 text-gray-600"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										stroke-width="2"
										d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z"
									/>
								</svg>
								<div
									v-else
									class="animate-spin rounded-full h-3.5 w-3.5 border-b-2 border-blue-500"
								></div>
							</div>

							<!-- Native Input for Instant Search -->
							<input
								id="cart-customer-search"
								name="cart-customer-search"
								:value="customerSearch"
								@input="handleSearchInput"
								@focus="handleSearchFocus"
								@blur="handleSearchBlur"
								type="text"
								:placeholder="__('Search or add customer...')"
								class="w-full h-[40px] ps-9 pe-3 text-xs rounded-none bg-white focus:outline-none focus:border-blue-600 shadow-none transition-all border border-white"
								:disabled="!customersLoaded"
								@keydown="handleKeydown"
								autocomplete="off"
								:aria-label="__('Search customer in cart')"
							/>
						</div>

						<!-- Quick Create Customer Button -->
						<button
							type="button"
							@click="createNewCustomer"
							class="flex items-center justify-center w-10 h-10 bg-black hover:bg-black active:bg-black rounded-none text-white border border-black transition-colors touch-manipulation flex-shrink-0"
							:title="__('Create new customer')"
							:aria-label="__('Create new customer')"
						>
							<svg
								class="w-5 h-5"
								fill="none"
								stroke="currentColor"
								viewBox="0 0 24 24"
								stroke-width="2"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z"
								/>
							</svg>
						</button>

						<!-- Document Type Toggle (Sales Invoice / Sales Order) -->
						<div
							v-if="settingsStore.allowSalesOrder"
							class="flex items-center bg-gray-200 rounded-none p-0.5 h-10 border border-black"
						>
							<button
								type="button"
								@click="selectDocType('Sales Invoice')"
								class="h-full px-2.5 text-xs font-bold rounded-none transition-colors flex items-center gap-1.5"
								:class="cartStore.targetDoctype === 'Sales Invoice'
									? 'bg-black text-white'
									: 'text-gray-900 hover:bg-gray-100 active:bg-gray-200'"
								:title="__('Sales Invoice')"
							>
								<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
								</svg>
								<span class="hidden sm:inline">{{ __("Invoice") }}</span>
							</button>
							<button
								type="button"
								@click="selectDocType('Sales Order')"
								class="h-full px-2.5 text-xs font-bold rounded-none transition-colors flex items-center gap-1.5"
								:class="cartStore.targetDoctype === 'Sales Order'
									? 'bg-black text-white'
									: 'text-gray-900 hover:bg-gray-100 active:bg-gray-200'"
								:title="__('Sales Order')"
							>
								<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
									<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01" />
								</svg>
								<span class="hidden sm:inline">{{ __("Order") }}</span>
							</button>
						</div>
					</div>
				</div>



				<!-- Customer Dropdown -->
				<div
					v-if="customerSearchFocused || customerSearch.trim().length >= 2"
					class="absolute z-50 mt-0.5 w-full bg-white  rounded-none shadow-md max-h-48 overflow-hidden will-change-transform"
				>
					<!-- Frequent Customers Header (when showing suggestions) -->
					<div
						v-if="customerSearchFocused && customerSearch.trim().length < 2 && customerResults.length > 0"
						class="px-2 py-1 bg-gray-100 border-b border-gray-300"
					>
						<span class="text-[10px] font-bold text-gray-700 uppercase tracking-wide">
							{{ __('Frequent Customers') }}
						</span>
					</div>

					<!-- Customer Results -->
					<div v-if="customerResults.length > 0" class="max-h-48 overflow-y-auto overscroll-contain">
						<button
							type="button"
							v-for="(cust, index) in customerResults"
							:key="cust.name"
							@mousedown.prevent="selectCustomer(cust)"
							:class="[
								'w-full text-start px-2 py-1.5 flex items-center gap-1.5 border-b border-gray-100 last:border-0 touch-manipulation select-none cursor-pointer active:bg-blue-100',
								index === selectedIndex ? 'bg-blue-50 text-blue-700' : 'text-gray-900 hover:bg-gray-50 active:bg-gray-200',
							]"
						>
							<div
								class="w-6 h-6 bg-black rounded-sm flex items-center justify-center flex-shrink-0 pointer-events-none"
							>
								<span class="text-[10px] pt-1 font-bold text-white">{{
									getInitials(cust.customer_name)
								}}</span>
							</div>
							<div class="flex-1 min-w-0 pointer-events-none">
								<p class="text-[11px] font-bold text-gray-900 truncate">
									{{ cust.customer_name }}
								</p>
								<p v-if="cust.mobile_no" class="text-[9px] text-gray-600">
									{{ cust.mobile_no }}
								</p>
							</div>
						</button>
					</div>

					<!-- No Results + Create New Option -->
					<div v-else-if="customerSearch.trim().length >= 2">
						<div
							class="px-2 py-1.5 text-center text-[11px] font-bold text-gray-700 border-b border-gray-100"
						>
							{{ __('No results for "{0}"', [customerSearch]) }}
						</div>
					</div>

					<!-- Create New Customer Option -->
					<button
						type="button"
						v-if="customerSearch.trim().length >= 2"
						@mousedown.prevent="createNewCustomer"
						class="w-full text-start px-2 py-1.5 hover:bg-green-50 active:bg-green-100 flex items-center gap-1.5 border-t border-black touch-manipulation select-none cursor-pointer"
					>
						<div
							class="w-5 h-5 bg-green-600 text-white rounded-none flex items-center justify-center flex-shrink-0 pointer-events-none"
						>
							<svg
								class="w-3 h-3 text-white"
								fill="none"
								stroke="currentColor"
								viewBox="0 0 24 24"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									stroke-width="2"
									d="M12 4v16m8-8H4"
								/>
							</svg>
						</div>
						<div class="flex-1 pointer-events-none">
							<p class="text-[11px] font-bold text-green-700">
								{{ __("Create New Customer") }}
							</p>
							<p class="text-[9px] text-green-600">"{{ customerSearch }}"</p>
						</div>
					</button>
				</div>

			</div>
		</div>

		<!-- Action Buttons Section -->
		<div v-if="items.length > 0" class="px-3 py-2 bg-gray-200">
			<div class="flex items-center justify-between mb-0">
				<h2 class="text-xs font-bold text-gray-900 uppercase tracking-wider">{{ __("Cart Items") }}</h2>
				<div class="flex items-center gap-2">
					<!-- Clear Cart Button -->
					<button
						@click="$emit('clear-cart')"
						class="inline-flex items-center gap-1.5 rounded-none border border-red-600 px-3 py-1.5 text-[10px] sm:text-xs font-bold uppercase tracking-wider text-red-600 hover:bg-red-600 hover:text-white transition-colors touch-manipulation"
						type="button"
						:title="__('Clear all items')"
					>
						<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
							<path stroke-linecap="round" stroke-linejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V5a2 2 0 00-2-2h-2a2 2 0 00-2 2v2M4 7h16"/>
						</svg>
						<span>{{ __("Clear") }}</span>
					</button>
					<!-- Sort Dropdown -->
					<div class="relative" ref="cartSortContainer">
						<button
							@click="toggleCartSortDropdown"
							:class="[
								'inline-flex items-center gap-1.5 rounded-none border px-3 py-1.5 text-[10px] sm:text-xs font-bold uppercase tracking-wider transition-colors touch-manipulation',
								cartSortBy
									? 'text-blue-600 border-blue-600 bg-blue-50 hover:bg-blue-100'
									: 'text-gray-800 border-black hover:bg-gray-100'
							]"
							:title="cartSortBy
								? (cartSortOrder === 'asc'
									? __('Sorted by {0} A-Z', [getCartSortLabel()])
									: __('Sorted by {0} Z-A', [getCartSortLabel()]))
								: __('Sort cart items')"
							:aria-label="__('Sort cart items')"
							type="button"
						>
							<svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" stroke-width="2">
								<path stroke-linecap="round" stroke-linejoin="round" d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4"/>
							</svg>
							<span>{{ __("Sort") }}</span>
						</button>

						<!-- Sort Dropdown Menu -->
						<div
							v-if="showCartSortDropdown"
							@click.stop
							class="absolute end-0 mt-1 w-52 bg-white rounded-none shadow-md border-1 border-black z-[9999]"
						>
							<div class="py-2">
								<div class="px-3 py-2 text-xs font-bold text-gray-900 uppercase border-b border-black tracking-wider">
									{{ __('Sort Cart') }}
								</div>
								<div class="py-1">
									<!-- No Sorting (clear) -->
									<button
										@click="handleCartSortToggle(null)"
										:class="[
											'w-full px-3 py-2 text-sm transition-colors flex items-center justify-between group rounded-none',
											!cartSortBy ? 'bg-blue-50 text-blue-700 font-bold' : 'text-gray-700 hover:bg-gray-100'
										]"
										type="button"
									>
										<span class="flex items-center gap-2.5">
											<svg class="w-4 h-4 text-gray-600 group-hover:text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
												<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
											</svg>
											<span>{{ __('No Sorting') }}</span>
										</span>
									</button>

									<div class="h-px bg-gray-300 my-1"></div>

									<!-- Sort Options Loop -->
									<button
										v-for="option in CART_SORT_OPTIONS"
										:key="option.field"
										@click="handleCartSortToggle(option.field)"
										:class="[
											'w-full px-3 py-2 text-sm transition-colors flex items-center justify-between group rounded-none',
											cartSortBy === option.field ? 'bg-blue-50 text-blue-700 font-bold' : 'text-gray-700 hover:bg-gray-100'
										]"
										type="button"
									>
										<span class="flex items-center gap-2.5">
											<svg class="w-4 h-4 text-gray-600 group-hover:text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
												<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" :d="option.icon"/>
											</svg>
											<span>{{ option.label }}</span>
										</span>
										<!-- Sort direction icon -->
										<svg
											class="w-5 h-5"
											:class="cartSortBy === option.field ? 'text-blue-600' : 'text-gray-300'"
											fill="none"
											stroke="currentColor"
											viewBox="0 0 24 24"
										>
											<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" :d="CART_SORT_ICONS[getCartSortIconState(option.field)]"/>
										</svg>
									</button>
								</div>
							</div>
						</div>
					</div>
				</div>
			</div>

			<!-- Offers & Coupon Buttons -->
			<div v-if="settingsStore.showOffers || settingsStore.showCoupon" class="flex gap-2">
				<!-- View All Offers Button -->
				<button
					type="button"
					v-if="settingsStore.showOffers"
					@click="$emit('show-offers')"
					class="relative flex-1 flex items-center justify-center gap-1.5 px-2.5 py-2 rounded-none bg-green-50 border border-black hover:bg-green-100 hover:shadow-none transition-colors min-w-0 touch-manipulation"
					:aria-label="__('View all available offers')"
				>
					<svg
						class="w-3.5 h-3.5 text-green-600 flex-shrink-0"
						fill="none"
						stroke="currentColor"
						viewBox="0 0 24 24"
						stroke-width="2"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"
						/>
					</svg>
					<span class="text-[10px] sm:text-xs font-bold uppercase tracking-wider text-green-700">{{ __("Offers") }}</span>
					<!-- Badge shows ONLY applied offers count - NOT eligible/pending offers -->
					<!-- This prevents confusion where offers show as "applied" before backend validation -->
					<span
						v-if="appliedOfferCount > 0"
						class="bg-green-600 text-white font-mono text-[9px] font-bold rounded-none px-1.5 py-0.5 flex-shrink-0 min-w-[16px] text-center"
					>
						{{ appliedOfferCount }}
					</span>
				</button>

				<!-- Enter Coupon Code Button -->
				<button
					type="button"
					v-if="settingsStore.showCoupon"
					@click="$emit('apply-coupon')"
					class="relative flex-1 flex items-center justify-center gap-1.5 px-2.5 py-2 rounded-none bg-purple-50 border border-black hover:bg-purple-100 hover:shadow-none transition-colors min-w-0 touch-manipulation"
					:aria-label="__('Apply coupon code')"
				>
					<svg
						class="w-3.5 h-3.5 text-purple-600 flex-shrink-0"
						fill="currentColor"
						viewBox="0 0 20 20"
					>
						<path
							fill-rule="evenodd"
							d="M4 2a2 2 0 00-2 2v11a3 3 0 106 0V4a2 2 0 00-2-2H4zm1 14a1 1 0 100-2 1 1 0 000 2zm5-1.757l4.9-4.9a2 2 0 000-2.828L13.485 5.1a2 2 0 00-2.828 0L10 5.757v8.486zM16 18H9.071l6-6H16a2 2 0 012 2v2a2 2 0 01-2 2z"
							clip-rule="evenodd"
						/>
					</svg>
					<span class="text-[10px] sm:text-xs font-bold uppercase tracking-wider text-purple-700">{{ __("Coupon") }}</span>
					<span
						v-if="availableGiftCards.length > 0"
						class="bg-purple-600 text-white font-mono text-[9px] font-bold rounded-none px-1.5 py-0.5 flex-shrink-0 min-w-[16px] text-center"
					>
						{{ availableGiftCards.length }}
					</span>
				</button>
			</div>
		</div>

		<!-- Cart Items -->
		<div class="flex-1 overflow-y-auto p-0.5 sm:p-1.5 bg-gray-100">
			<div
				v-if="items.length === 0"
				class="flex flex-col items-center justify-center h-full p-3 sm:p-4  max-w-[450px] mx-auto  -mt-[5%]"
			>
				<!-- Enhanced Empty Cart Container -->
				<div class="w-full max-w-lg bg-white p-4 sm:p-4 rounded-none flex flex-row items-center justify-center text-center mb-4 select-none gap-3">
					<div class="w-12 h-12 flex items-center justify-center bg-gray-100  rounded-none">
						<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="icon icon-tabler icons-tabler-outline icon-tabler-shopping-cart-exclamation stroke-gray-600"><path stroke="none" d="M0 0h24v24H0z" fill="none" /><path d="M4 19a2 2 0 1 0 4 0a2 2 0 0 0 -4 0" /><path d="M15 17h-9v-14h-2" /><path d="M6 5l14 1l-.854 5.976m-2.646 1.024h-10.5" /><path d="M19 16v3" /><path d="M19 22v.01" /></svg>
					</div>
					<div class="text-start">
						<h3 class="text-xs sm:text-sm !font-bold uppercase text-gray-900 mb-0">
						{{ __("Cart is Empty") }}
						</h3>
						<p class="text-[10px] sm:text-xs text-gray-500 font-medium max-w-xs leading-relaxed mt-0.5">
							{{ __("Scan a barcode, search items, or select a quick action below to begin.") }}
						</p>
					</div>
				</div>

				<!-- Quick Actions Grid (Pixel-Sharp Square Cells with 1px border lines) -->
				<div class="w-full max-w-lg grid grid-cols-3 gap-1 shadow-sm select-none">
					<!-- View Shift -->
					<button
						type="button"
						@click="$emit('view-shift')"
						data-nav="quick-action"
						class="relative aspect-square w-full flex flex-col items-center justify-center p-2 bg-white hover:bg-blue-50/40 active:bg-blue-100 transition-colors touch-manipulation group rounded-none"
						:title="__('View current shift details')"
					>
						<kbd class="absolute top-1 right-1 px-1 py-0.5 text-[12px] font-mono font-bold tracking-wider text-blue-500 bg-blue-50 border border-blue-100 rounded-none uppercase scale-90 leading-none select-none pointer-events-none">Alt+W</kbd>
						<div class="text-blue-600 mb-1.5 flex justify-center items-center">
							<svg
								class="w-5 h-5"
								fill="none"
								stroke="currentColor"
								viewBox="0 0 24 24"
								stroke-width="2"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"
								/>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"
								/>
							</svg>
						</div>
						<span class="text-[10px] sm:text-xs !font-medium text-center leading-tight px-0.5 group-hover:text-blue-700 transition-colors">
							{{ __("View Shift") }}
						</span>
					</button>

					<!-- Draft Invoices -->
					<button
						type="button"
						@click="$emit('show-drafts')"
						data-nav="quick-action"
						class="relative aspect-square w-full flex flex-col items-center justify-center p-2 bg-white hover:bg-purple-50/40 active:bg-purple-100 transition-colors touch-manipulation group rounded-none"
						:title="__('View draft invoices')"
					>
						<kbd class="absolute top-1 right-1 px-1 py-0.5 text-[12px] font-mono font-bold tracking-wider text-purple-500 bg-purple-50 border border-purple-100 rounded-none uppercase scale-90 leading-none select-none pointer-events-none">Alt+D</kbd>
						<div class="text-purple-600 mb-1.5 flex justify-center items-center">
							<svg
								class="w-5 h-5"
								fill="none"
								stroke="currentColor"
								viewBox="0 0 24 24"
								stroke-width="2"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
								/>
							</svg>
						</div>
						<span class="text-[10px] sm:text-xs !font-medium text-center leading-tight px-0.5 group-hover:text-purple-700 transition-colors">
							{{ __("Drafts") }}
						</span>
					</button>

					<!-- Invoice History -->
					<button
						type="button"
						@click="$emit('show-history')"
						data-nav="quick-action"
						class="relative aspect-square w-full flex flex-col items-center justify-center p-2 bg-white hover:bg-gray-100 active:bg-gray-200 transition-colors touch-manipulation group rounded-none"
						:title="__('View invoice history')"
					>
						<kbd class="absolute top-1 right-1 px-1 py-0.5 text-[12px] font-mono font-bold tracking-wider text-gray-500 bg-gray-100 border border-gray-200 rounded-none uppercase scale-90 leading-none select-none pointer-events-none">Alt+H</kbd>
						<div class="text-gray-600 mb-1.5 flex justify-center items-center">
							<svg
								class="w-5 h-5"
								fill="none"
								stroke="currentColor"
								viewBox="0 0 24 24"
								stroke-width="2"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
								/>
							</svg>
						</div>
						<span class="text-[10px] sm:text-xs !font-medium text-center leading-tight px-0.5 group-hover:text-gray-900 transition-colors">
							{{ __("History") }}
						</span>
					</button>

					<!-- Return Invoice -->
					<button
						type="button"
						@click="settingsStore.allowReturn ? $emit('show-return') : null"
						data-nav="quick-action"
						class="relative aspect-square w-full flex flex-col items-center justify-center p-2 bg-white transition-colors touch-manipulation group rounded-none"
						:class="settingsStore.allowReturn
							? 'hover:bg-red-50/40 active:bg-red-100 cursor-pointer'
							: 'opacity-40 cursor-not-allowed'
						"
						:title="settingsStore.allowReturn ? __('Process return invoice') : __('Return operations restricted for this profile')"
					>
						<kbd class="absolute top-1 right-1 px-1 py-0.5 text-[12px] font-mono font-bold tracking-wider text-red-500 bg-red-50 border border-red-100 rounded-none uppercase scale-90 leading-none select-none pointer-events-none">Alt+R</kbd>
						<div class="text-red-600 mb-1.5 flex justify-center items-center">
							<svg
								class="w-5 h-5"
								fill="none"
								stroke="currentColor"
								viewBox="0 0 24 24"
								stroke-width="2"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6"
								/>
							</svg>
						</div>
						<span class="text-[10px] sm:text-xs !font-medium text-center leading-tight px-0.5 group-hover:text-red-700 transition-colors">
							{{ __("Return") }}
						</span>
					</button>

					<!-- Create Customer -->
					<button
						type="button"
						@click="$emit('create-customer', '')"
						data-nav="quick-action"
						class="relative aspect-square w-full flex flex-col items-center justify-center p-2 bg-white hover:bg-green-50/40 active:bg-green-100 transition-colors touch-manipulation group rounded-none"
						:title="__('Create new customer')"
					>
						<div class="text-green-600 mb-1.5 flex justify-center items-center">
							<svg
								class="w-5 h-5"
								fill="none"
								stroke="currentColor"
								viewBox="0 0 24 24"
								stroke-width="2"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z"
								/>
							</svg>
						</div>
						<span class="text-[10px] sm:text-xs !font-medium text-center leading-tight px-0.5 group-hover:text-green-700 transition-colors">
							{{ __("New Customer") }}
						</span>
					</button>
					
					<!-- Close Shift -->
					<button
						type="button"
						@click="isCloseShiftAllowed ? $emit('close-shift') : null"
						data-nav="quick-action"
						class="relative aspect-square w-full flex flex-col items-center justify-center p-2 bg-white transition-colors touch-manipulation group rounded-none"
						:class="isCloseShiftAllowed
							? 'hover:bg-orange-50/40 active:bg-orange-100 cursor-pointer'
							: 'opacity-40 cursor-not-allowed'
						"
						:title="isCloseShiftAllowed ? __('Close current shift') : __('Close shift restricted to authorized roles')"
					>
						<div class="text-orange-600 mb-1.5 flex justify-center items-center">
							<svg
								class="w-5 h-5"
								fill="none"
								stroke="currentColor"
								viewBox="0 0 24 24"
								stroke-width="2"
							>
								<path
									stroke-linecap="round"
									stroke-linejoin="round"
									d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z"
								/>
							</svg>
						</div>
						<span class="text-[10px] sm:text-xs !font-medium text-center leading-tight px-0.5 group-hover:text-orange-700 transition-colors">
							{{ __("Close Shift") }}
						</span>
					</button>

					
				</div>
			</div>

			<div v-else class="flex flex-col border-t border-black divide-y divide-gray-200">
				<div
					v-for="(item, index) in sortedItems"
					:key="item.item_code + '-' + (item.uom || '') + (item.is_free_item ? '-free' : '')"
					ref="cartItemRefs"
					@click.stop="handleCartItemRowClick(item, index)"
					:class="[
						'cart-item-row p-3 transition-all items-center duration-75 flex gap-3 cursor-pointer group select-none border-l-4',
						index === focusedCartItemIndex
							? 'bg-gray-100/90 border-l-black font-semibold pl-2.5 shadow-sm'
							: 'border-l-transparent',
						item.is_free_item
							? 'bg-green-50/30 cursor-default'
							: 'bg-white hover:bg-gray-50/50'
					]"
				>
					<!-- Item Image Thumbnail -->
					<div
						class="w-12 h-12 sm:w-12 sm:h-12 bg-gray-50 flex-shrink-0 flex items-center justify-center overflow-hidden border border-gray-200"
					>
						<img
							v-if="item.image"
							:src="item.image"
							:alt="item.item_name"
							loading="lazy"
							width="52"
							height="52"
							decoding="async"
							class="w-full h-full object-cover"
						/>
						<svg
							v-else
							class="h-5 w-5 text-gray-300"
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="1.5"
								d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
							/>
						</svg>
					</div>

					<!-- Item Content -->
					<div class="flex-1 min-w-0 flex flex-col justify-between">
						<!-- Header: Item Name, Badges & Delete -->
						<div class="flex items-start justify-between gap-2 mb-0">
							<div class="flex flex-col min-w-0 flex-1">
								<div class="flex items-baseline gap-1.5 flex-wrap">
									<h4 class="text-xs sm:text-[13px] font-bold text-gray-900 truncate leading-tight">
										{{ item.item_name }}
									</h4>
									<span v-if="item.item_code" class="text-[9px] font-semibold text-gray-600 font-mono">
										#{{ item.item_code }}
									</span>
								</div>
								
								<!-- Badges row below title for cleaner spacing -->
								<div class="flex items-center gap-1.5 mt-1 flex-wrap">
									<!-- Free Item Badge -->
									<span
										v-if="item.free_qty && item.free_qty > 0"
										class="inline-flex items-center px-1.5 py-0.5 bg-green-50 text-green-700 rounded-none text-[9px] font-bold font-mono border border-green-200"
										:title="item.is_free_item ? __('Free item') : __('{0} free item(s) included', [item.free_qty])"
									>
										{{ item.is_free_item ? __("FREE") : __("+{0} FREE", [item.free_qty]) }}
									</span>
									<!-- Discount Badge -->
									<div
										v-if="item.discount_amount && item.discount_amount > 0"
										class="inline-flex items-center px-1.5 py-0.5 bg-red-50 text-red-700 rounded-none text-[9px] font-bold border border-red-100 font-mono"
									>
										{{
											__("{0}% OFF", [
												Number(item.discount_percentage).toFixed(0),
											])
										}}
									</div>
								</div>
							</div>

							<!-- Delete Button -->
							<button
								v-if="!item.is_free_item"
								type="button"
								@click.stop="$emit('remove-item', item.item_code, item.uom)"
								class="text-gray-600 hover:text-red-600 active:text-red-700 transition-colors flex-shrink-0 p-0.5 -mt-0.5 touch-manipulation"
								:aria-label="__('Remove {0}', [item.item_name])"
								:title="__('Remove item')"
							>
								<svg
									class="h-4 w-4"
									fill="none"
									stroke="currentColor"
									viewBox="0 0 24 24"
									stroke-width="2"
								>
									<path
										stroke-linecap="round"
										stroke-linejoin="round"
										d="M6 18L18 6M6 6l12 12"
									/>
								</svg>
							</button>
						</div>

						<!-- Single Row: Quantity Counter, UOM, Price & Total -->
						<div class="flex items-center justify-between gap-2 mt-1">
							<div class="flex items-center gap-2 flex-wrap">
								<!-- Quantity Counter -->
								<!-- For free items, show static quantity badge -->
								<div
									v-if="item.is_free_item"
									class="flex items-center bg-green-50 border border-green-200 rounded-none px-2 h-6 sm:h-7 font-mono"
								>
									<span class="text-xs font-bold text-green-700">{{ item.quantity }}</span>
								</div>
								<!-- For serial items, show serial badge with edit button -->
								<div
									v-else-if="item.has_serial_no && item.serial_no"
									class="flex items-center gap-1"
									@click.stop
								>
									<!-- Serial count badge -->
									<div
										class="flex items-center bg-gray-50 border border-black rounded-none px-1.5 h-6 sm:h-7 font-mono"
									>
										<FeatherIcon
											name="hash"
											class="w-3 h-3 text-gray-500 me-0.5"
										/>
										<span class="text-xs font-bold text-gray-900">{{ item.quantity }}</span>
									</div>
									<!-- Edit button -->
									<button
										type="button"
										@click="openEditDialog(item)"
										class="flex items-center justify-center w-6 h-6 sm:w-7 sm:h-7 bg-white hover:bg-gray-50 active:bg-gray-100 text-gray-900 rounded-none border border-black transition-colors"
										:title="__('Edit serials')"
									>
										<FeatherIcon name="edit-2" class="w-3 h-3" />
									</button>
								</div>
								<!-- For non-serial items, show normal quantity controls -->
								<div
									v-else
									:class="[
										'flex items-center bg-white border rounded-none overflow-hidden h-6 sm:h-7',
										item.is_resolved_barcode ? 'border-amber-300' : 'border-black'
									]"
								>
									<button
										type="button"
										@click.stop="decrementQuantity(item)"
										:disabled="item.is_resolved_barcode"
										:class="[
											'w-6 h-full flex items-center justify-center font-bold transition-colors touch-manipulation border-e border-black',
											item.is_resolved_barcode
												? 'bg-gray-50 text-gray-600 cursor-not-allowed border-amber-200'
												: 'bg-white hover:bg-gray-100 text-gray-900'
										]"
										:aria-label="__('Decrease quantity')"
										:title="item.is_resolved_barcode ? __('Quantity locked (barcode item)') : __('Decrease quantity')"
									>
										<svg
											class="w-3 h-3"
											fill="none"
											stroke="currentColor"
											viewBox="0 0 24 24"
											stroke-width="2.5"
										>
											<path
												stroke-linecap="round"
												stroke-linejoin="round"
												d="M20 12H4"
											/>
										</svg>
									</button>
									<input
										:value="formatQuantity(item.quantity)"
										@click.stop
										@input="updateQuantity(item, $event.target.value)"
										@blur="handleQuantityBlur(item)"
										@keydown.enter="$event.target.blur()"
										type="text"
										inputmode="decimal"
										:disabled="item.is_resolved_barcode"
										:class="[
											'w-12 sm:w-14 h-full text-center border-0 text-xs font-mono font-bold focus:outline-none p-0',
											item.is_resolved_barcode
												? 'bg-amber-50/50 text-amber-700 cursor-not-allowed'
												: 'bg-white text-gray-900'
										]"
										:aria-label="__('Quantity')"
										:title="item.is_resolved_barcode ? __('Quantity locked (barcode item)') : ''"
									/>
									<button
										type="button"
										@click.stop="incrementQuantity(item)"
										:disabled="item.is_resolved_barcode"
										:class="[
											'w-6 h-full flex items-center justify-center font-bold transition-colors touch-manipulation border-s border-black',
											item.is_resolved_barcode
												? 'bg-gray-50 text-gray-600 cursor-not-allowed border-amber-200'
												: 'bg-white hover:bg-gray-100 text-gray-900'
										]"
										:aria-label="__('Increase quantity')"
										:title="item.is_resolved_barcode ? __('Quantity locked (barcode item)') : __('Increase quantity')"
									>
										<svg
											class="w-3 h-3"
											fill="none"
											stroke="currentColor"
											viewBox="0 0 24 24"
											stroke-width="2.5"
										>
											<path
												stroke-linecap="round"
												stroke-linejoin="round"
												d="M12 4v16m8-8H4"
											/>
										</svg>
									</button>
								</div>

								<!-- UOM Selector Dropdown -->
								<div class="relative group/uom" @click.stop>
									<button
										type="button"
										@click="toggleUomDropdown(item.item_code, item.uom)"
										:disabled="
											item.is_resolved_barcode || !item.item_uoms || item.item_uoms.length === 0
										"
										:class="[
											'h-6 sm:h-7 text-[10px] sm:text-xs font-bold rounded-none ps-2 pe-5 transition-all touch-manipulation flex items-center justify-center min-w-[45px]',
											item.is_resolved_barcode
												? 'bg-amber-50 text-amber-700 border border-amber-300 cursor-not-allowed'
												: item.item_uoms && item.item_uoms.length > 0
													? 'bg-white hover:bg-gray-50 text-gray-900 border border-black cursor-pointer'
													: 'bg-gray-50 text-gray-600 border border-gray-200 cursor-not-allowed opacity-60',
										]"
										:title="
											item.is_resolved_barcode
												? __('UOM locked (barcode item)')
												: item.item_uoms && item.item_uoms.length > 0
													? __('Click to change unit')
													: __('Only one unit available')
										"
									>
										{{
											item.uom ||
											item.stock_uom ||
											__("Nos", null, "UOM")
										}}
									</button>
									<svg
										:class="[
											'absolute end-1.5 top-1/2 -translate-y-1/2 w-2.5 h-2.5 pointer-events-none transition-transform',
											openUomDropdown === `${item.item_code}-${item.uom}`
												? 'rotate-180'
												: '',
											item.is_resolved_barcode
												? 'text-amber-600'
												: item.item_uoms && item.item_uoms.length > 0
													? 'text-gray-900'
													: 'text-gray-600',
										]"
										fill="none"
										stroke="currentColor"
										viewBox="0 0 24 24"
										stroke-width="2.5"
									>
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											d="M19 9l-7 7-7-7"
										/>
									</svg>
									<div
										v-if="
											openUomDropdown ===
												`${item.item_code}-${item.uom}` &&
											item.item_uoms &&
											item.item_uoms.length > 0
										"
										class="absolute top-full start-0 mt-0.5 bg-white border border-black rounded-none shadow-none z-50 min-w-full overflow-hidden"
									>
										<button
											type="button"
											@click="selectUom(item, item.stock_uom)"
											:class="[
												'w-full text-start px-2 py-1.5 text-[10px] sm:text-xs font-bold uppercase tracking-wider transition-colors border-b border-gray-300 last:border-0 rounded-none',
												(item.uom || item.stock_uom) === item.stock_uom
													? 'bg-gray-100 text-gray-900 font-extrabold'
													: 'text-gray-700 hover:bg-gray-100',
											]"
										>
											{{ item.stock_uom || __("Nos", null, "UOM") }}
										</button>
										<button
											v-for="uomData in item.item_uoms"
											:key="uomData.uom"
											type="button"
											@click="selectUom(item, uomData.uom)"
											:class="[
												'w-full text-start px-2 py-1.5 text-[10px] sm:text-xs font-bold uppercase tracking-wider transition-colors border-b border-gray-300 last:border-0 rounded-none',
												(item.uom || item.stock_uom) === uomData.uom
													? 'bg-gray-100 text-gray-900 font-extrabold'
													: 'text-gray-700 hover:bg-gray-100',
											]"
										>
											{{ uomData.uom }}
										</button>
									</div>
								</div>

								<!-- Price -->
								<span class="text-[10px] sm:text-xs font-mono text-gray-600">
									@ {{ formatCurrency(item.rate) }}
								</span>
							</div>

							<!-- Item Total -->
							<div class="text-end flex-shrink-0 flex flex-col justify-end">
								<div
									class="text-xs sm:text-sm font-mono !font-bold text-gray-900 leading-none"
								>
									{{
										formatCurrency(
											item.amount || item.rate * item.quantity
										)
									}}
								</div>
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>

		<!-- Totals Summary -->
		<div v-if="items.length > 0" class="p-3 bg-white select-none border-t border-gray-300">
			<!-- Summary Details Table -->
			<div class="flex flex-col gap-1.5 !text-[14px] sm:text-xs text-gray-900 mb-3">
				<!-- Total Qty Row -->
				<div class="flex items-center justify-between">
					<span class="text-gray-900 uppercase tracking-wider font-semibold">{{ __("Total Qty") }}</span>
					<span class="text-gray-900 font-bold text-end font-mono">{{
						formatQuantity(totalQuantity)
					}}</span>
				</div>
				
				<!-- Subtotal Row -->
				<div class="flex items-center justify-between">
					<span class="text-gray-900 uppercase tracking-wider font-semibold">{{ __("Subtotal") }}</span>
					<span class="text-gray-900 font-bold text-end font-mono">{{
						formatCurrency(displaySubtotal)
					}}</span>
				</div>

				<!-- Discount Row (if any) -->
				<div
					v-if="discountAmount > 0"
					class="flex items-center justify-between text-red-600 font-semibold"
				>
					<span class="uppercase tracking-wider flex items-center gap-1">
						<span class="w-1.5 h-1.5 rounded-full bg-red-500 inline-block animate-pulse"></span>
						{{ __("Discount") }}
					</span>
					<span class="font-bold text-end font-mono">-{{
						formatCurrency(discountAmount)
					}}</span>
				</div>

				<!-- Tax Row -->
				<div class="flex items-center justify-between">
					<span class="text-gray-900 uppercase tracking-wider font-semibold">{{ __("Tax") }}</span>
					<span class="text-gray-900 font-bold text-end font-mono">{{
						formatCurrency(taxAmount)
					}}</span>
				</div>
			</div>

			<!-- Grand Total Line -->
			<div class="border-t border-black pt-3.5 pb-1 mb-3.5">
				<div class="flex items-baseline justify-between">
					<span class="text-[14px] !font-bold text-gray-900 uppercase tracking-wider font-bold">{{
						__("Total to Pay")
					}}</span>
					<span
						class="text-2xl !font-bold text-black text-end font-mono tracking-tight"
					>
						{{ formatCurrency(displayGrandTotal) }}
					</span>
				</div>
			</div>

			<!-- Action Buttons -->
			<div class="flex gap-2">
				<!-- Checkout Button (Primary) -->
				<button
					type="button"
					@click="handleProceedToPayment"
					:disabled="items.length === 0"
					:class="[
						'flex-1 py-3.5 px-4 rounded-none font-black text-xs transition-all flex items-center justify-center touch-manipulation border border-black uppercase tracking-widest',
						items.length === 0
							? 'bg-gray-100 border-gray-300 text-gray-600 cursor-not-allowed shadow-none'
							: 'bg-black text-white hover:bg-gray-900 active:bg-black',
					]"
					:aria-label="__('Proceed to payment')"
				>
					<svg
						class="w-4 h-4 me-2 flex-shrink-0"
						fill="none"
						stroke="currentColor"
						viewBox="0 0 24 24"
						stroke-width="2.5"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z"
						/>
					</svg>
					<span>{{ __("Checkout") }}</span>
				</button>

				<!-- Hold Order Button (Secondary) -->
				<button
					type="button"
					@click="$emit('save-draft')"
					class="flex-1 py-3.5 px-4 rounded-none font-black text-xs text-orange-600 bg-white border border-black hover:bg-orange-50 active:bg-orange-100 transition-all touch-manipulation flex items-center justify-center uppercase tracking-widest"
					:aria-label="__('Hold order as draft')"
				>
					<svg
						class="w-4 h-4 me-2 flex-shrink-0"
						fill="none"
						stroke="currentColor"
						viewBox="0 0 24 24"
						stroke-width="2.5"
					>
						<path
							stroke-linecap="round"
							stroke-linejoin="round"
							d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4"
						/>
					</svg>
					<span>{{ __("Hold") }}</span>
				</button>
			</div>
		</div>

		<!-- Edit Item Dialog -->
		<EditItemDialog
			v-model="showEditDialog"
			:item="selectedItem"
			:warehouses="warehouses"
			:currency="currency"
			@update-item="handleUpdateItem"
		/>

	</div>
</template>

<script setup>
/**
 * ============================================================================
 * IMPORTS
 * ============================================================================
 */
import { usePOSCartStore } from "@/stores/posCart"
import { usePOSOrderTypesStore } from "@/stores/posOrderTypes"
import { usePOSSettingsStore } from "@/stores/posSettings"
import { usePOSOffersStore } from "@/stores/posOffers"
import { useCustomerSearchStore } from "@/stores/customerSearch"
import { usePOSShiftStore } from "@/stores/posShift"
import { useBootstrapStore } from "@/stores/bootstrap"
import {
	DEFAULT_CURRENCY,
	formatCurrency as formatCurrencyUtil,
} from "@/utils/currency"
import { useFormatters } from "@/composables/useFormatters"
import { useCartSort } from "@/composables/useCartSort"
import { isOffline } from "@/utils/offline"
import { offlineWorker } from "@/utils/offline/workerClient"
import { logger } from "@/utils/logger"
import { FeatherIcon } from "frappe-ui"

const log = logger.create("InvoiceCart")
import { createResource } from "frappe-ui"
import { computed, onBeforeUnmount, onMounted, ref, watch, watchEffect, nextTick } from "vue"
import EditItemDialog from "./EditItemDialog.vue"
import OrderType from "./OrderType.vue"
import TableSelector from "./TableSelector.vue"

/**
 * ============================================================================
 * STORES & COMPOSABLES
 * ============================================================================
 */
const cartStore = usePOSCartStore() // Pinia store for cart state management
const orderTypesStore = usePOSOrderTypesStore() // to know has_tables of current order type
const settingsStore = usePOSSettingsStore() // Pinia store for POS settings
const offersStore = usePOSOffersStore() // Pinia store for offers/promotions
const customerSearchStore = useCustomerSearchStore() // Pinia store for customer search
const shiftStore = usePOSShiftStore() // Pinia store for shift details
const bootstrapStore = useBootstrapStore()
const { formatQuantity } = useFormatters() // Quantity formatting utilities

function handleProceedToPayment() {
	emit("proceed-to-payment")
}

/**
 * ============================================================================
 * PROPS
 * ============================================================================
 * @prop {Array} items - Cart items array with item details (item_code, quantity, rate, etc.)
 * @prop {Object} customer - Selected customer object (name, customer_name, mobile_no)
 * @prop {Number} subtotal - Cart subtotal before tax and discounts
 * @prop {Number} taxAmount - Total tax amount
 * @prop {Number} discountAmount - Total discount amount applied
 * @prop {Number} grandTotal - Final total (subtotal - discount + tax)
 * @prop {String} posProfile - Current POS Profile name
 * @prop {String} currency - Currency code for formatting (e.g., "USD", "EUR")
 * @prop {Array} appliedOffers - List of currently applied promotional offers
 * @prop {Array} warehouses - Available warehouses for item selection
 */
const props = defineProps({
	items: {
		type: Array,
		default: () => [],
	},
	customer: Object,
	subtotal: {
		type: Number,
		default: 0,
	},
	taxAmount: {
		type: Number,
		default: 0,
	},
	discountAmount: {
		type: Number,
		default: 0,
	},
	grandTotal: {
		type: Number,
		default: 0,
	},
	posProfile: String,
	currency: {
		type: String,
		default: DEFAULT_CURRENCY,
	},
	appliedOffers: {
		type: Array,
		default: () => [],
	},
	warehouses: {
		type: Array,
		default: () => [],
	},
	showPosOrderType: {
		type: Boolean,
		default: false,
	},
	defaultPosOrderType: {
		type: String,
		default: "Dine In",
	},
	showPosTableNo: {
		type: Boolean,
		default: false,
	},
})

/**
 * ============================================================================
 * EMITS
 * ============================================================================
 * Events emitted to parent component for cart operations
 */
const emit = defineEmits([
	"update-quantity", // (itemCode, newQty, uom?) - Update item quantity
	"remove-item", // (itemCode, uom?) - Remove item from cart
	"select-customer", // (customer) - Select/change customer
	"edit-customer", // (customer) - Open edit customer dialog
	"create-customer", // (searchText) - Open create customer dialog
	"proceed-to-payment", // () - Navigate to payment screen
	"clear-cart", // () - Clear all items from cart
	"save-draft", // () - Save current cart as draft/hold order
	"apply-coupon", // () - Open coupon application dialog
	"show-coupons", // () - Show available coupons
	"show-offers", // () - Show available offers dialog
	"remove-offer", // (offerId) - Remove applied offer
	"update-uom", // (itemCode, newUom) - Change item's unit of measure
	"edit-item", // (item) - Open item edit dialog
	"view-shift", // () - View current shift details
	"show-drafts", // () - Show draft/held orders
	"show-history", // () - Show invoice history
	"show-return", // () - Open return invoice dialog
	"close-shift", // () - Close current shift
	// "create-sales-order", // () - Create Sales Order // Removed as per instruction
])

// Cart sort composable (must be after defineProps)
const {
	cartSortBy,
	cartSortOrder,
	showCartSortDropdown,
	sortedItems,
	CART_SORT_OPTIONS,
	CART_SORT_ICONS,
	toggleCartSortDropdown,
	handleCartSortToggle,
	getCartSortLabel,
	getCartSortIconState,
} = useCartSort(() => props.items)

/**
 * ============================================================================
 * REACTIVE STATE
 * ============================================================================
 */
// Customer search state
const customerSearch = ref("") // Current search query
const customerSearchContainer = ref(null) // Ref to search container for click-outside detection
const customerSearchFocused = ref(false) // Track if search input is focused
// Use Pinia store for allCustomers (shared with CustomerDialog, synced on customer creation)
const allCustomers = computed(() => customerSearchStore.allCustomers)
// Sticky loaded flag: becomes true as soon as customers are available and never
// resets to false — removing a selected customer must not re-disable the field.
const _customersEverLoaded = ref(customerSearchStore.allCustomers.length > 0)
watchEffect(() => {
	if (
		customerSearchStore.customersLoaded ||
		customerSearchStore.allCustomers.length > 0
	) {
		_customersEverLoaded.value = true
	}
})
/**
 * True once the customer list has been populated for the first time.
 * Used for the search icon/spinner toggle AND for the input disabled state.
 * Deliberately sticky so that removing a customer never re-shows the spinner
 * or re-disables the input.
 */
const customersLoaded = computed(
	() => customerSearchStore.customersLoaded || _customersEverLoaded.value,
)
const selectedIndex = ref(-1) // Keyboard navigation index for search results
const availableGiftCards = ref([]) // Available gift cards for current customer
const previousCustomer = ref(null) // Store previous customer for restore on blur

// Edit item dialog state
const showEditDialog = ref(false) // Controls edit dialog visibility
const selectedItem = ref(null) // Item being edited
const focusedCartItemIndex = ref(-1) // Tracks highlighted cart item index for keyboard shortcuts
const cartItemRefs = ref([]) // Array of DOM element refs for cart item rows

// UOM dropdown state - tracks which item's UOM dropdown is open (by item_code)
const openUomDropdown = ref(null)

// Order type selection model (value is stored in cart/invoice store)
const orderTypeModel = computed({
	get: () => cartStore.posOrderType,
	set: (val) => cartStore.setPosOrderType(val),
})

// Table selector visibility (only when order type supports tables + profile allows it)
const currentOrderTypeOption = computed(() => {
	const opts = orderTypesStore.orderTypeOptions ?? []
	return opts.find((o) => o.value === orderTypeModel.value)
})
const showTableSelector = computed(() => {
	// Must have order type feature enabled + table feature enabled on profile
	if (!props.showPosOrderType || !props.showPosTableNo) return false

	// Must have a selected order type
	if (!orderTypeModel.value) return false

	// Look up the currently selected order type in the loaded list
	const opt = currentOrderTypeOption.value

	// Only show the table picker if the selected order type actually supports tables
	return !!opt?.has_tables
})

const tableModel = computed({
	get: () => cartStore.posTableNo,
	set: (val) => cartStore.setPosTableNo(val),
})

const isCloseShiftAllowed = computed(() => {
	const allowedRole = shiftStore.currentProfile?.role_allowed_to_closing_shift
	if (!allowedRole) return true

	const userRoles = bootstrapStore.getPreloadedRoles()
	return userRoles.includes(allowedRole)
})

// Clear table when the selected order type no longer supports tables
watch(currentOrderTypeOption, (opt) => {
	if (!opt?.has_tables) {
		tableModel.value = null
	}
})

// Keep default order type when showPosOrderType is enabled (user selection not overridden)
watch(
	() => [
		props.showPosOrderType,
		props.defaultPosOrderType,
		cartStore.posProfile,
	],
	([show, def]) => {
		if (!show) {
			return
		}
		// Initialize only when empty to avoid overriding the user selection
		if (!orderTypeModel.value) {
			orderTypeModel.value = def || "Dine In"
		}
	},
	{ immediate: true },
)

// Cart sort dropdown container (template ref for outside-click detection)
const cartSortContainer = ref(null)

/**
 * ============================================================================
 * API RESOURCES
 * ============================================================================
 * These resources handle data fetching from the server with offline support.
 * Data is cached in the service worker for offline access.
 */

/**
 * Customer Loading
 *
 * Uses the shared customerSearchStore for customer data.
 * This ensures customers are synced across all components (InvoiceCart, CustomerDialog).
 * New customers are immediately available after creation without page refresh.
 */
// Load customers via the shared Pinia store (if not already loaded)
watch(
	() => props.posProfile,
	(posProfile) => {
		if (posProfile) {
			customerSearchStore.loadAllCustomers(posProfile)
		}
	},
	{ immediate: true },
)

// Load offers on component init (uses shared store method to prevent duplicate fetches)
// ensureOffersFetched handles both online/offline cases and caching
if (props.posProfile) {
	offersStore.ensureOffersFetched(props.posProfile)
}

/**
 * Gift Cards Resource
 *
 * Fetches active coupon codes and gift cards for the selected customer.
 * - Only fetches when a customer is selected and online
 * - Reloads when customer changes (via watcher)
 * - Used for the "Coupon" button badge count
 *
 * @endpoint pos_next.api.offers.get_active_coupons
 */
const giftCardsResource = createResource({
	url: "pos_next.api.offers.get_active_coupons",
	makeParams() {
		return {
			customer: props.customer?.name || props.customer,
			company: props.posProfile, // Will get company from profile
		}
	},
	auto: false,
	onSuccess(data) {
		availableGiftCards.value = data?.message || data || []
	},
})

/**
 * Watch for customer changes to load their gift cards.
 * Reloads gift cards resource when customer is selected (and online).
 * Clears gift cards when customer is removed or offline.
 */
watch(
	() => props.customer,
	(newCustomer) => {
		if (newCustomer && props.posProfile && !isOffline()) {
			giftCardsResource.reload()
		} else {
			availableGiftCards.value = []
		}
	},
)

/**
 * ============================================================================
 * COMPUTED PROPERTIES
 * ============================================================================
 */

/**
 * Count of currently applied promotional offers.
 * Used for the badge on the "Offers" button.
 * @returns {Number} Count of applied offers
 */
const appliedOfferCount = computed(() => (props.appliedOffers || []).length)

/**
 * Pre-computed customer lookup map for O(1) access by ID.
 * Rebuilt when allCustomers changes.
 */
const customerMap = computed(() => {
	const map = new Map()
	for (const cust of allCustomers.value) {
		map.set(cust.name, cust)
	}
	return map
})

/**
 * Instant customer search results with in-memory filtering.
 *
 * Performs zero-latency filtering on the cached customer list.
 * Searches across customer_name, mobile_no, and customer ID.
 * Returns max 20 results to keep dropdown performant.
 *
 * @returns {Array} Filtered customer objects matching search query
 */
const customerResults = computed(() => {
	const searchValue = customerSearch.value.trim().toLowerCase()

	// When focused with no/short search term, show frequent customers (top 5)
	if (searchValue.length < 2) {
		if (customerSearchFocused.value) {
			// Get frequent customer IDs from the store
			// const frequentIds = customerSearchStore.frequentCustomers.slice(0, 5);
			// if (frequentIds.length > 0) {
			// 	const frequentCustomers = [];
			// 	for (const id of frequentIds) {
			// 		const cust = customerMap.value.get(id);
			// 		if (cust) frequentCustomers.push(cust);
			// 	}
			// 	return frequentCustomers;
			// }
			// If no frequent customers, show first 5 from the list
			return allCustomers.value.slice(0, 10)
		}
		return []
	}

	// Instant in-memory filter
	return allCustomers.value
		.filter((cust) => {
			const name = (cust.customer_name || "").toLowerCase()
			const mobile = (cust.mobile_no || "").toLowerCase()
			const id = (cust.name || "").toLowerCase()

			return (
				name.includes(searchValue) ||
				mobile.includes(searchValue) ||
				id.includes(searchValue)
			)
		})
		.slice(0, 20)
})

/**
 * Reset keyboard selection index when search results change.
 * Ensures the selection doesn't point to a non-existent result.
 */
watch(customerResults, () => {
	selectedIndex.value = -1
})

/**
 * Total quantity of all items in cart (including free items).
 * Sums quantity + free_qty for each cart item.
 * @returns {Number} Total item quantity
 */
const totalQuantity = computed(() => {
	return props.items.reduce((sum, item) => {
		const qty = item.quantity || 0
		// For dedicated free item rows, quantity IS the free qty — don't double-count
		const freeQty = item.is_free_item ? 0 : item.free_qty || 0
		return sum + qty + freeQty
	}, 0)
})

/**
 * Display subtotal adjusted for tax-inclusive mode.
 *
 * When tax is inclusive, the raw subtotal from the store includes tax.
 * For clear cashier display, we show:
 * - Subtotal: Net amount (before tax) = gross - tax
 * - Tax: The extracted tax amount
 * - Grand Total: gross amount = Subtotal + Tax
 *
 * When tax is exclusive, subtotal is already net (before tax).
 *
 * @returns {Number} Subtotal amount to display (net amount before tax)
 */
const displaySubtotal = computed(() => {
	if (cartStore.taxInclusive) {
		// Tax inclusive: subtotal from store is gross (includes tax)
		// Display the net amount (before tax) for clarity
		return props.subtotal - props.taxAmount
	}
	// Tax exclusive: subtotal is already net (before tax)
	return props.subtotal
})

/**
 * Display grand total that visually equals Subtotal + Tax - Discount.
 *
 * This ensures the math is intuitive for cashiers:
 * Grand Total = displaySubtotal + Tax - Discount
 *
 * @returns {Number} Grand total amount to display
 */
const displayGrandTotal = computed(() => {
	// Always: displaySubtotal + tax - discount
	// This makes the display consistent and intuitive
	return displaySubtotal.value + props.taxAmount - props.discountAmount
})

/**
 * ============================================================================
 * FUNCTIONS
 * ============================================================================
 */

// ─────────────────────────────────────────────────────────────────────────────
// Customer Search Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handle customer search input with instant reactivity.
 * Updates the customerSearch ref which triggers computed filtering.
 * @param {Event} event - Input event from search field
 */
function handleSearchInput(event) {
	customerSearch.value = event.target.value
}

// Track if customer history has been loaded this session
const customerHistoryLoaded = ref(false)

/**
 * Handle search input focus - shows frequent customers dropdown.
 */
function announceCustomerSearchActive() {
	focusedCartItemIndex.value = -1
	if (typeof window !== "undefined") {
		window.dispatchEvent(new CustomEvent("pos-next:customer-search-active"))
	}
}

function handleSearchFocus() {
	announceCustomerSearchActive()
	customerSearchFocused.value = true
	// Load customer history only once per session for faster subsequent focuses
	if (!customerHistoryLoaded.value) {
		customerSearchStore.loadCustomerHistory()
		customerHistoryLoaded.value = true
	}
}

/**
 * Handle search input blur - hides dropdown after a short delay.
 * Short delay as fallback for keyboard/tab navigation (mousedown.prevent handles click cases).
 */
function handleSearchBlur() {
	// Reduced delay - mousedown.prevent handles most cases, this is just for keyboard nav
	setTimeout(() => {
		customerSearchFocused.value = false
	}, 100)
}

/**
 * Handle keyboard navigation in customer search dropdown.
 * Supports:
 * - ArrowDown/ArrowUp: Navigate through results
 * - Enter: Select current or auto-select single result
 * - Escape: Clear search
 *
 * @param {KeyboardEvent} event - Keyboard event from search input
 */
function handleKeydown(event) {
	const customerNavigationKeys = ["ArrowDown", "ArrowUp", "Enter", "Escape"]
	if (customerNavigationKeys.includes(event.key)) {
		event.stopPropagation()
	}

	if (customerResults.value.length === 0) {
		if (event.key === "Enter") {
			event.preventDefault()
		}
		return
	}

	if (event.key === "ArrowDown") {
		event.preventDefault()
		announceCustomerSearchActive()
		selectedIndex.value = Math.min(
			selectedIndex.value + 1,
			customerResults.value.length - 1,
		)
	} else if (event.key === "ArrowUp") {
		event.preventDefault()
		announceCustomerSearchActive()
		selectedIndex.value = Math.max(selectedIndex.value - 1, -1)
	} else if (event.key === "Enter") {
		event.preventDefault()
		announceCustomerSearchActive()
		if (
			selectedIndex.value >= 0 &&
			selectedIndex.value < customerResults.value.length
		) {
			selectCustomer(customerResults.value[selectedIndex.value])
		} else if (customerResults.value.length === 1) {
			// Auto-select if only one result
			selectCustomer(customerResults.value[0])
		}
	} else if (event.key === "Escape") {
		announceCustomerSearchActive()
		customerSearch.value = ""
	}
}

/**
 * Select a customer from search results.
 * Emits select-customer event and resets search state.
 * Tracks customer selection for frequency-based suggestions.
 * @param {Object} cust - Customer object to select
 */
function selectCustomer(cust) {
	// Track selection for frequent customers feature
	customerSearchStore.trackCustomerSelection(cust.name)
	emit("select-customer", cust)
	customerSearch.value = ""
	selectedIndex.value = -1
	customerSearchFocused.value = false
	previousCustomer.value = null
}

/**
 * Remove the selected customer.
 * Clears the customer and focuses the search input.
 */
async function removeCustomer() {
	previousCustomer.value = null
	await clearCustomer()
}

/**
 * Clear the currently selected customer.
 * Emits select-customer with null to deselect.
 */
async function clearCustomer() {
	emit("select-customer", null)
	customerSearch.value = ""
	selectedIndex.value = -1
	if (!customerHistoryLoaded.value) {
		customerSearchStore.loadCustomerHistory()
		customerHistoryLoaded.value = true
	}

	// Wait two ticks: first for prop update, second for DOM to switch from
	// customer-card (v-if="customer") to search-input (v-else) branch.
	if (props.posProfile && customerSearchStore.allCustomers.length === 0) {
		customerSearchStore.loadAllCustomers(props.posProfile, true)
	}

	await nextTick()
	await nextTick()
	customerSearchFocused.value = true
	const searchInput = document.getElementById("cart-customer-search")
	if (searchInput) {
		searchInput.focus()
		searchInput.select()
	}
}

/**
 * Open customer creation dialog with current search text.
 * Pre-fills the new customer name with the search query.
 */
function createNewCustomer() {
	const searchValue = customerSearch.value
	// Close dropdown immediately
	customerSearch.value = ""
	customerSearchFocused.value = false
	// Emit event to open customer creation dialog
	emit("create-customer", searchValue)
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get initials from a customer name for avatar display.
 * Returns first letter of first two words, or first two letters if single word.
 *
 * @param {String} name - Customer name
 * @returns {String} 2-letter initials (uppercase)
 */
function getInitials(name) {
	if (!name || !name.trim()) return "?"
	const parts = name.trim().split(/\s+/).filter(Boolean)
	if (parts.length === 0) return "?"
	const first = Array.from(parts[0])[0] || "?"
	if (parts.length >= 2) {
		const second = Array.from(parts[1])[0] || "?"
		return (first + second).toUpperCase()
	}
	return Array.from(parts[0]).slice(0, 2).join("").toUpperCase()
}

/**
 * Format a numeric amount as currency string.
 * Uses the component's currency prop for formatting.
 *
 * @param {Number} amount - Amount to format
 * @returns {String} Formatted currency string (e.g., "$1,234.56")
 */
function formatCurrency(amount) {
	return formatCurrencyUtil(
		Number.parseFloat(amount || 0),
		props.currency,
		undefined,
		settingsStore.decimalPrecision,
	)
}

// ─────────────────────────────────────────────────────────────────────────────
// Quantity Control Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Intelligently determine the step size based on current quantity.
 * - Whole numbers (1, 2, 3): step by 1
 * - Multiples of 0.5 (1.5, 2.5): step by 0.5
 * - Multiples of 0.25 (0.25, 0.75): step by 0.25
 * - Multiples of 0.1 (0.1, 0.3): step by 0.1
 * - Other decimals: step by 0.01
 */
function getSmartStep(quantity) {
	// Check if it's a whole number
	if (quantity === Math.floor(quantity)) {
		return 1
	}

	// Round to 4 decimal places to avoid floating point errors
	const rounded = Math.round(quantity * 10000) / 10000

	// Check if it's a multiple of 0.5
	if (Math.abs(rounded % 0.5) < 0.0001) {
		return 0.5
	}

	// Check if it's a multiple of 0.25
	if (Math.abs(rounded % 0.25) < 0.0001) {
		return 0.25
	}

	// Check if it's a multiple of 0.1
	if (Math.abs(rounded % 0.1) < 0.0001) {
		return 0.1
	}

	// For other decimals, use 0.01 for fine control
	return 0.01
}

/**
 * Increment item quantity using smart step.
 * Uses getSmartStep to determine appropriate increment value.
 *
 * @param {Object} item - Cart item to increment
 */
function incrementQuantity(item) {
	// Prevent editing resolved barcode items
	if (item.is_resolved_barcode) return

	const step = getSmartStep(item.quantity)
	const newQty = Math.round((item.quantity + step) * 10000) / 10000
	emit("update-quantity", item.item_code, newQty, item.uom)
}

/**
 * Decrement item quantity using smart step.
 * Removes item if quantity would become zero or negative.
 *
 * @param {Object} item - Cart item to decrement
 */
function decrementQuantity(item) {
	// Prevent editing resolved barcode items
	if (item.is_resolved_barcode) return

	const step = getSmartStep(item.quantity)
	const newQty = Math.round((item.quantity - step) * 10000) / 10000

	if (newQty <= 0) {
		// If quantity would be 0 or negative, remove the item
		emit("remove-item", item.item_code, item.uom)
	} else {
		emit("update-quantity", item.item_code, newQty, item.uom)
	}
}

/**
 * Update quantity from direct input (manual typing).
 * Allows any positive number during typing without rounding.
 *
 * @param {Object} item - Cart item to update
 * @param {String} value - New quantity value from input
 */

function updateQuantity(item, value) {
	// Prevent editing resolved barcode items
	if (item.is_resolved_barcode) return

	const qty = Number.parseFloat(value)

	// If the input isn't a valid number (e.g., user cleared the field), do nothing
	if (Number.isNaN(qty)) return

	// If quantity is zero or negative, remove the item from the cart
	if (qty <= 0) return emit("remove-item", item.item_code, item.uom)

	// For positive numbers, update quantity immediately (no rounding here while typing)
	emit("update-quantity", item.item_code, qty, item.uom)
}

/**
 * Handle quantity input blur - validate and round.
 * Called when user leaves the quantity input field.
 * - Removes item if quantity is 0 or invalid
 * - Rounds to 4 decimal places for consistency
 *
 * @param {Object} item - Cart item that lost focus
 */
function handleQuantityBlur(item) {
	// When user leaves the input field, round and validate
	if (!item.quantity || item.quantity <= 0) {
		// If quantity is 0 or invalid, remove the item
		emit("remove-item", item.item_code, item.uom)
	} else {
		// Round to 4 decimal places for consistency
		const roundedQty = Math.round(item.quantity * 10000) / 10000
		if (roundedQty !== item.quantity) {
			emit("update-quantity", item.item_code, roundedQty, item.uom)
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// UOM (Unit of Measure) Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Toggle UOM dropdown visibility for an item.
 * Uses unique key combining item_code + uom to handle same item with different UOMs.
 */
function toggleUomDropdown(itemCode, uom) {
	const key = `${itemCode}-${uom}`
	openUomDropdown.value = openUomDropdown.value === key ? null : key
}

/**
 * Select a UOM from dropdown - changes UOM and closes dropdown
 * Handles merging if target UOM already exists in cart
 */
async function selectUom(item, newUom) {
	if (item.uom === newUom) {
		openUomDropdown.value = null
		return
	}

	const currentUom = item.uom || item.stock_uom
	await cartStore.changeItemUOM(item.item_code, newUom, currentUom)
	openUomDropdown.value = null
	emit("update-uom", item.item_code, newUom)
}

// ─────────────────────────────────────────────────────────────────────────────
// Item Edit Dialog Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Open the edit item dialog for an item.
 * Creates a copy of the item to avoid mutating the original.
 * Used for serial number items and advanced editing.
 *
 * @param {Object} item - Cart item to edit
 */
function openEditDialog(item) {
	const idx = sortedItems.value.findIndex(
		(i) => i.item_code === item.item_code && i.uom === item.uom
	)
	if (idx !== -1) {
		focusedCartItemIndex.value = idx
	}
	selectedItem.value = { ...item }
	showEditDialog.value = true
}

/**
 * Handle clicking a cart item row: highlights the item and opens edit dialog (unless free).
 */
function handleCartItemRowClick(item, index) {
	focusedCartItemIndex.value = index
	if (!item.is_free_item) {
		openEditDialog(item)
	}
}

/**
 * Handle item update from edit dialog.
 * Updates item via cart store and emits for parent compatibility.
 *
 * @param {Object} updatedItem - Updated item data from dialog
 */
async function handleUpdateItem(updatedItem) {
	// Get the original UOM from selectedItem (before any changes)
	const originalUom = selectedItem.value?.uom || selectedItem.value?.stock_uom
	// Use store method to update item, passing original UOM to identify correct item
	await cartStore.updateItemDetails(
		updatedItem.item_code,
		updatedItem,
		originalUom,
	)
	// Also emit for parent component compatibility
	emit("edit-item", updatedItem)
}

// ─────────────────────────────────────────────────────────────────────────────
// Event Handlers & Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

function selectDocType(type) {
	cartStore.setTargetDoctype(type)
}

/**
 * Handle clicks outside interactive elements.
 * - Closes customer search dropdown when clicking outside
 * - Closes UOM dropdown when clicking outside
 * - Closes cart sort dropdown when clicking outside
 *
 * @param {MouseEvent} event - Click event
 */
function handleOutsideClick(event) {
	const target = event.target

	// Close customer search if clicking outside
	if (
		customerSearchContainer.value &&
		target instanceof Node &&
		!customerSearchContainer.value.contains(target)
	) {
		customerSearch.value = ""

		// Restore previous customer if set and no customer selected
		if (previousCustomer.value && !props.customer) {
			emit("select-customer", previousCustomer.value)
			previousCustomer.value = null
		}
	}

	// Close UOM dropdown if clicking outside
	if (openUomDropdown.value !== null) {
		// Check if click is outside all UOM dropdowns
		const clickedInsideUomDropdown =
			target instanceof Element && target.closest(".group\\/uom")
		if (!clickedInsideUomDropdown) {
			openUomDropdown.value = null
		}
	}

	// Close cart sort dropdown if clicking outside
	if (
		showCartSortDropdown.value &&
		cartSortContainer.value &&
		target instanceof Node &&
		!cartSortContainer.value.contains(target)
	) {
		showCartSortDropdown.value = false
	}

	// Close cart item focus if clicking outside the items list
	if (focusedCartItemIndex.value !== -1) {
		const clickedInsideCartItem = target instanceof Element && target.closest(".cart-item-row")
		if (!clickedInsideCartItem) {
			focusedCartItemIndex.value = -1
		}
	}
}

function getQuickActionButtons() {
	return Array.from(document.querySelectorAll('[data-nav="quick-action"]'))
}

function handleQuickActionKeyDown(event) {
	if (event.key === "Escape") {
		const activeEl = document.activeElement
		if (activeEl && activeEl.getAttribute("data-nav") === "quick-action") {
			event.preventDefault()
			const searchInput = document.getElementById("item-search")
			searchInput?.focus()
		}
		return
	}

	if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key))
		return

	const activeEl = document.activeElement
	if (!activeEl || activeEl.getAttribute("data-nav") !== "quick-action") return

	const buttons = getQuickActionButtons()
	const index = buttons.indexOf(activeEl)
	if (index === -1) return

	event.preventDefault()
	event.stopPropagation()

	const cols = 3
	const rows = 2
	const total = buttons.length
	const isRtlLayout = typeof document !== "undefined" && document.documentElement.dir === "rtl"

	let row = Math.floor(index / cols)
	let col = index % cols

	if (event.key === "ArrowRight") {
		if (isRtlLayout) {
			col = col > 0 ? col - 1 : cols - 1
		} else {
			col = col < cols - 1 ? col + 1 : 0
		}
	} else if (event.key === "ArrowLeft") {
		if (isRtlLayout) {
			col = col < cols - 1 ? col + 1 : 0
		} else {
			col = col > 0 ? col - 1 : cols - 1
		}
	} else if (event.key === "ArrowDown") {
		row = row < rows - 1 ? row + 1 : 0
	} else if (event.key === "ArrowUp") {
		row = row > 0 ? row - 1 : rows - 1
	}

	const nextIndex = row * cols + col
	if (nextIndex >= 0 && nextIndex < total) {
		buttons[nextIndex]?.focus()
	}
}

function scrollFocusedCartItemIntoView() {
	nextTick(() => {
		const el = cartItemRefs.value[focusedCartItemIndex.value]
		if (el) {
			el.scrollIntoView({ block: "nearest", behavior: "smooth" })
		}
	})
}

function handleGlobalShortcutKeyDown(event) {
	const activeEl = document.activeElement

	// ── Focus-switching shortcuts must fire even when another input is active ──
	// Handle Alt+C (focus customer search) and F6 before the isTyping guard so
	// they always work regardless of which element currently has focus.
	if (event.altKey && event.key.toLowerCase() === "c") {
		event.preventDefault()
		const input = document.getElementById("cart-customer-search")
		if (input) {
			input.focus()
			input.select()
		} else {
			// Customer card is displayed — remove customer to reveal search field
			removeCustomer()
		}
		return
	}
	if (!event.altKey && event.key === "F6") {
		event.preventDefault()
		const input = document.getElementById("cart-customer-search")
		if (input) {
			input.focus()
			input.select()
		} else {
			removeCustomer()
		}
		return
	}

	const isTyping =
		activeEl &&
		(activeEl.tagName === "TEXTAREA" ||
			activeEl.isContentEditable ||
			(activeEl.tagName === "INPUT" &&
				activeEl.id !== "cart-customer-search" &&
				activeEl.id !== "item-search"))

	if (isTyping) return

	const key = event.key.toLowerCase()

	// Reset focused cart item selection when moving focus to items panel or quick actions
	if (event.altKey) {
		if (key === "i" || key === "s" || key === "q") {
			focusedCartItemIndex.value = -1
		}
	} else {
		if (event.key === "F2" || event.key === "F3" || event.key === "F4") {
			focusedCartItemIndex.value = -1
		}
	}

	// 1. Global Actions (both empty and non-empty cart)
	if (event.altKey) {
		// NOTE: Alt+C and F6 are already handled above the isTyping guard
		if (key === "c") {
			return // Already handled
		}
		if (key === "g") {
			event.preventDefault()
			if (props.items && props.items.length > 0) {
				focusedCartItemIndex.value = 0
				scrollFocusedCartItemIntoView()
			}
			return
		}
		if (key === "enter") {
			event.preventDefault()
			event.stopImmediatePropagation()
			if (props.items && props.items.length > 0) {
				handleProceedToPayment()
			}
			return
		}
		if (key === "x") {
			event.preventDefault()
			if (props.items && props.items.length > 0) {
				emit("save-draft")
			}
			return
		}
		if (key === "backspace" || key === "delete") {
			event.preventDefault()
			event.stopPropagation()
			event.stopImmediatePropagation()
			if (props.items && props.items.length > 0) {
				emit("clear-cart")
			}
			return
		}
	} else {
		// Function keys
		if (event.key === "F6") {
			return // Already handled above the isTyping guard
		}
		if (event.key === "F7") {
			event.preventDefault()
			if (props.items && props.items.length > 0) {
				focusedCartItemIndex.value = 0
				scrollFocusedCartItemIntoView()
			}
			return
		}
		if (event.key === "F8") {
			event.preventDefault()
			if (props.items && props.items.length > 0) {
				handleProceedToPayment()
			}
			return
		}
		if (event.key === "F9") {
			event.preventDefault()
			if (props.items && props.items.length > 0) {
				emit("save-draft")
			}
			return
		}
	}

	// 2. Active highlighted Cart Item Controls
	if (focusedCartItemIndex.value !== -1 && props.items && props.items.length > 0) {
		const focusedItem = sortedItems.value[focusedCartItemIndex.value]
		if (focusedItem) {
			if (event.key === "ArrowUp") {
				event.preventDefault()
				if (focusedCartItemIndex.value > 0) {
					focusedCartItemIndex.value--
					scrollFocusedCartItemIntoView()
				}
				return
			}
			if (event.key === "ArrowDown") {
				event.preventDefault()
				if (focusedCartItemIndex.value < sortedItems.value.length - 1) {
					focusedCartItemIndex.value++
					scrollFocusedCartItemIntoView()
				}
				return
			}
			const isRtlLayout = typeof document !== "undefined" && document.documentElement.dir === "rtl"
			const isArrowRight = event.key === "ArrowRight"
			const isArrowLeft = event.key === "ArrowLeft"
			const isPlus = event.key === "+"
			const isMinus = event.key === "-"

			const shouldIncrement = (isArrowRight && !isRtlLayout) || (isArrowLeft && isRtlLayout) || isPlus
			const shouldDecrement = (isArrowLeft && !isRtlLayout) || (isArrowRight && isRtlLayout) || isMinus

			if (shouldIncrement) {
				event.preventDefault()
				if (!focusedItem.is_free_item) {
					incrementQuantity(focusedItem)
				}
				return
			}
			if (shouldDecrement) {
				event.preventDefault()
				if (!focusedItem.is_free_item) {
					decrementQuantity(focusedItem)
				}
				return
			}
			if (event.key === "Delete" || event.key === "Backspace") {
				event.preventDefault()
				if (!focusedItem.is_free_item) {
					emit("remove-item", focusedItem.item_code, focusedItem.uom)
					// Adjust focus index if removed last item
					if (focusedCartItemIndex.value >= sortedItems.value.length - 1) {
						focusedCartItemIndex.value = Math.max(-1, sortedItems.value.length - 2)
					}
				}
				return
			}
			if (event.key === "Enter") {
				if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
				event.preventDefault()
				if (!focusedItem.is_free_item) {
					openEditDialog(focusedItem)
				}
				return
			}
			if (event.key.toLowerCase() === "u" || event.key === " ") {
				event.preventDefault()
				if (!focusedItem.is_resolved_barcode && focusedItem.item_uoms && focusedItem.item_uoms.length > 0) {
					toggleUomDropdown(focusedItem.item_code, focusedItem.uom)
				}
				return
			}
			if (event.key === "Escape") {
				event.preventDefault()
				focusedCartItemIndex.value = -1
				return
			}
		}
	}

	// 3. Only trigger when cart is empty
	if (props.items && props.items.length === 0) {
		if (event.altKey) {
			const key = event.key.toLowerCase()
			if (key === "q") {
				event.preventDefault()
				const buttons = getQuickActionButtons()
				buttons[0]?.focus()
				return
			}
			if (key === "w") {
				event.preventDefault()
				emit("view-shift")
				return
			}
			if (key === "d") {
				event.preventDefault()
				emit("show-drafts")
				return
			}
			if (key === "h") {
				event.preventDefault()
				emit("show-history")
				return
			}
			if (key === "r" && settingsStore.allowReturn) {
				event.preventDefault()
				emit("show-return")
				return
			}
		} else if (event.key === "F4") {
			event.preventDefault()
			const buttons = getQuickActionButtons()
			buttons[0]?.focus()
			return
		}

		// Arrow keys navigation when quick action button is focused
		handleQuickActionKeyDown(event)
	}
}

/**
 * Component mounted - register global listeners.
 */
onMounted(() => {
	if (typeof document === "undefined") return
	// Use mousedown instead of click to catch events before they are swallowed by other handlers
	document.addEventListener("mousedown", handleOutsideClick)
	window.addEventListener("keydown", handleGlobalShortcutKeyDown)
})

/**
 * Component unmounting - cleanup global listeners.
 */
onBeforeUnmount(() => {
	if (typeof document === "undefined") return
	document.removeEventListener("mousedown", handleOutsideClick)
	window.removeEventListener("keydown", handleGlobalShortcutKeyDown)
})
</script>

