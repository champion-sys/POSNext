<template>
	<div class="flex flex-col h-full bg-gray-50">
		<!-- Item Groups Filter Tabs -->
		<div class="bg-gray-200 border-b border-gray-400 max-h-[135px] overflow-y-auto">
			<div class="grid grid-cols-[repeat(auto-fit,minmax(110px,1fr))] gap-[1px]">
				<button
					@click="handleAllFilterClick"
					data-nav="filter"
					:class="[
						'flex items-center justify-center gap-1.5 px-2 py-2.5 rounded-none text-[10px] sm:text-[11px] font-bold uppercase tracking-wider transition-colors duration-75 touch-manipulation text-center truncate min-w-0 w-full',
						!activeFilterValue
							? 'bg-black text-white border-none'
							: 'bg-white text-gray-900 border-none hover:bg-gray-100 active:bg-gray-200',
					]"
				>
					<svg class="w-3.5 h-3.5 text-current flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
						<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6h16M4 12h16M4 18h16"/>
					</svg>
					<span class="truncate">{{ isBrandSortActive ? __('All Brands') : __('All Items') }}</span>
				</button>
				<button
					v-for="option in activeFilterOptions"
					:key="option.value"
					@click="handleFilterClick(option.value)"
					data-nav="filter"
					:class="[
						'flex items-center justify-center gap-1.5 px-2 py-2.5 rounded-none text-[10px] sm:text-[11px] font-bold uppercase tracking-wider transition-colors duration-75 touch-manipulation text-center truncate min-w-0 w-full',
						activeFilterValue === option.value
							? 'bg-black text-white border-none'
							: 'bg-white text-gray-900 border-none hover:bg-gray-100 active:bg-gray-200',
					]"
				>
					<span class="truncate">{{ __(option.label) }}</span>
				</button>
			</div>
		</div>

		<!-- Cache Sync Indicator -->
		<div v-if="cacheSyncing" class="px-0 sm:px-0 py-1 bg-blue-50 border-b border-blue-200">
			<div class="flex items-center justify-center gap-2 text-[10px] sm:text-xs text-blue-700">
				<div class="animate-spin rounded-full h-3 w-3 border-b-2 border-blue-600"></div>
				<span>{{ __('Syncing catalog in background... {0} items cached', [cacheStats.items]) }}</span>
			</div>
		</div>

		<!-- Search Bar with Barcode Scanner and View Controls -->
		<div class="px-0 sm:px-0 py-0 sm:py-0 bg-white border-b border-gray-400">
			<div class="flex items-center gap-0 sm:gap-0">
				<div class="flex-1 relative min-w-0">
					<!-- Search Icon -->
					<div class="absolute inset-y-0 start-0 ps-2 sm:ps-3 flex items-center pointer-events-none">
						<svg
							class="h-3.5 w-3.5 sm:h-4 sm:w-4 text-gray-500"
							fill="none"
							stroke="currentColor"
							viewBox="0 0 24 24"
						>
							<path
								stroke-linecap="round"
								stroke-linejoin="round"
								stroke-width="2"
								d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
							/>
						</svg>
					</div>
					<!-- Search Input -->
					<input
						id="item-search"
						name="item-search"
						data-nav="search-bar"
						ref="searchInputRef"
						:value="searchTerm"
						@input="handleSearchInput"
						@keydown="handleInputKeyDown"
						@click="handleSearchClick"
						type="text"
						:placeholder="searchPlaceholder"
						:class="[
							'w-full text-[11px] h-[40px] sm:text-sm border-1 px-2 sm:px-3 py-2 ps-7 sm:ps-10 pe-16 sm:pe-24 focus:outline-none transition-all rounded-none border-white',
							autoAddEnabled
								? 'border-blue-600 bg-blue-50 focus:border-blue-700'
								: scannerEnabled
								? 'border-green-600 bg-green-50 focus:border-green-700'
								: 'border-black focus:border-blue-600'
						]"
						:aria-label="__('Search items')"
					/>
					<!-- Barcode Scan Icon and Auto-Add Toggle -->
					<div class="absolute inset-y-0 end-0 pe-0 sm:pe-0 flex items-center gap-0">
						<button
							@click="toggleBarcodeScanner"
							data-nav="search-bar"
							:class="[
								'w-[40px] h-[40px] p-1 sm:p-1.5 rounded-none border border-transparent transition-all touch-manipulation flex justify-center items-center',
								scannerEnabled
									? 'bg-green-500 hover:bg-green-700 text-white border-green-700'
									: 'hover:bg-gray-100 active:bg-gray-200 text-gray-800'
							]"
							:title="scannerEnabled ? __('Barcode Scanner: ON (Click to disable)') : __('Barcode Scanner: OFF (Click to enable)')"
							:aria-label="scannerEnabled ? __('Disable barcode scanner') : __('Enable barcode scanner')"
						>
							<svg class="w-3.5 h-3.5 sm:w-5 sm:h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v1m6 11h2m-6 0h-2v4m0-11v3m0 0h.01M12 12h4.01M16 20h4M4 12h4m12 0h.01M5 8h2a1 1 0 001-1V5a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1zm12 0h2a1 1 0 001-1V5a1 1 0 00-1-1h-2a1 1 0 00-1 1v2a1 1 0 001 1zM5 20h2a1 1 0 001-1v-2a1 1 0 00-1-1H5a1 1 0 00-1 1v2a1 1 0 001 1z"/>
							</svg>
						</button>
						<button
							@click="toggleAutoAdd"
							data-nav="search-bar"
							:class="[
								'w-[40px] h-[40px] p-1 sm:p-1.5 rounded-none border border-transparent transition-all flex items-center gap-0.5 text-[9px] sm:text-xs font-bold uppercase tracking-wider px-1 sm:px-2 touch-manipulation justify-center items-center',
								autoAddEnabled
									? 'bg-blue-500 hover:bg-blue-500 text-white border-blue-500 text-blue-500'
									: 'hover:bg-gray-100 active:bg-gray-200 text-gray-800'
							]"
							:title="autoAddEnabled ? __('Auto-Add: ON - Press Enter to add items to cart') : __('Auto-Add: OFF - Click to enable automatic cart addition on Enter')"
							:aria-label="autoAddEnabled ? __('Disable auto-add') : __('Enable auto-add')"
						>
							<svg class="w-3 h-3 sm:w-4 sm:h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
								<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 4v16m8-8H4"/>
							</svg>
							<span class="hidden xs:inline">{{ __('Auto') }}</span>
						</button>
					</div>
				</div>
				<div class="flex items-center gap-0.5 border-r border-l border-gray-400 flex-shrink-0">
					<button
						@click="setViewMode('grid')"
						data-nav="search-bar"
						:class="[
							'p-1.5 sm:p-2 rounded-none transition-colors duration-75 touch-manipulation w-[40px] h-[40px] flex justify-center items-center',
							viewMode === 'grid' ? 'bg-black text-white' : 'text-gray-800 hover:bg-gray-300 active:bg-gray-400'
						]"
						:title="__('Grid View')"
						:aria-label="__('Switch to grid view')"
					>
						<svg class="w-4 h-4 sm:w-4.5 sm:h-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z"/>
						</svg>
					</button>
					<button
						@click="setViewMode('list')"
						data-nav="search-bar"
						:class="[
							'p-1.5 sm:p-2 rounded-none transition-colors duration-75 touch-manipulation w-[40px] h-[40px] flex justify-center items-center',
							viewMode === 'list' ? 'bg-black text-white' : 'text-gray-800 hover:bg-gray-300 active:bg-gray-400'
						]"
						:title="__('List View')"
						:aria-label="__('Switch to list view')"
					>
						<svg class="w-4 h-4 sm:w-4.5 sm:h-4.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M4 6h16M4 12h16M4 18h16"/>
						</svg>
					</button>
				</div>
 
				<!-- Sort Dropdown -->
				<div class="relative z-50">
					<button
						@click="toggleSortDropdown"
						data-sort-button
						data-nav="search-bar"
						:class="[
							'p-1.5 sm:p-1.5 h-[40px] w-[40px] rounded-none transition-[background-color,box-shadow] duration-75 touch-manipulation border-1 flex items-center justify-center',
							sortBy
								? 'bg-blue-50 border-blue-600 text-blue-700 shadow-none'
								: 'bg-white border-black text-gray-800 hover:bg-gray-100 active:bg-gray-200'
						]"
						:title="sortBy
							? (sortOrder === 'asc'
								? __('Sorted by {0} A-Z', [getSortLabel(sortBy)])
								: __('Sorted by {0} Z-A', [getSortLabel(sortBy)]))
							: __('Sort items')"
						:aria-label="__('Sort items')"
					>
						<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
							<path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4"/>
						</svg>
					</button>
 
					<!-- Dropdown Menu -->
					<div
						v-if="showSortDropdown"
						@click.stop
						class="absolute end-0 mt-1 w-56 bg-white rounded-none shadow-md border-1 border-black z-[9999]"
						style="box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);"
					>
						<div class="">
							<div class="px-3 py-2 text-xs font-semibold text-gray-500 uppercase border-b border-gray-100">
								{{ __('Sort Items') }}
							</div>
							<div class="py-1">
								<!-- Clear Sort -->
								<button
									@click="handleSortToggle(null)"
									:class="[
										'w-full px-3 py-2 text-sm transition-colors flex items-center justify-between group',
										!sortBy ? 'bg-blue-50 text-blue-700' : 'text-gray-700 hover:bg-gray-50'
									]"
								>
									<span class="flex items-center gap-2.5">
										<svg class="w-4 h-4 text-gray-400 group-hover:text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
											<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12"/>
										</svg>
										<span>{{ __('No Sorting') }}</span>
									</span>
								</button>

								<div class="h-px bg-gray-100 my-1"></div>

								<!-- Sort Options Loop -->
								<button
									v-for="option in sortOptions"
									:key="option.field"
									@click="handleSortToggle(option.field)"
									:class="[
										'w-full px-3 py-2 text-sm transition-colors flex items-center justify-between group',
										sortBy === option.field ? 'bg-blue-50 text-blue-700' : 'text-gray-700 hover:bg-gray-50'
									]"
								>
									<span class="flex items-center gap-2.5">
										<svg class="w-4 h-4 text-gray-400 group-hover:text-gray-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
											<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" :d="option.icon"/>
										</svg>
										<span>{{ option.label }}</span>
									</span>
									<!-- Sort direction icon -->
									<svg
										class="w-5 h-5"
										:class="sortBy === option.field ? 'text-blue-600' : 'text-gray-300'"
										fill="none"
										stroke="currentColor"
										viewBox="0 0 24 24"
									>
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" :d="SORT_ICONS[getSortIconState(option.field)]"/>
									</svg>
								</button>
							</div>
						</div>
					</div>
				</div>
			</div>
		</div>

		<!-- Initial Loading State - Show spinner while fetching items -->
		<div v-if="loading && (!filteredItems || filteredItems.length === 0)" class="flex-1 flex items-center justify-center p-3">
			<div class="text-center py-8">
				<div class="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-500 mx-auto"></div>
				<p class="mt-3 text-xs text-gray-500">{{ __('Loading items...') }}</p>
			</div>
		</div>

		<!-- Empty State - Only show when NOT loading and truly no items -->
		<div
			v-else-if="!loading && (!filteredItems || filteredItems.length === 0)"
			class="flex-1 flex items-center justify-center p-3"
		>
			<div class="text-center py-8">
				<svg
					class="mx-auto h-8 w-8 text-gray-400"
					fill="none"
					stroke="currentColor"
					viewBox="0 0 24 24"
				>
					<path
						stroke-linecap="round"
						stroke-linejoin="round"
						stroke-width="2"
						d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"
					/>
				</svg>
				<p v-if="searchTerm || selectedFilterLabel" class="mt-2 text-xs font-medium text-gray-700">
					<span v-if="searchTerm && selectedFilterLabel">{{ __('No results for {0} in {1}', [searchTerm, selectedFilterLabel]) }}</span>
					<span v-else-if="selectedFilterLabel">{{ __('No results in {0}', [selectedFilterLabel]) }}</span>
					<span v-else>{{ __('No results for {0}', [searchTerm]) }}</span>
				</p>
				<p v-else class="mt-2 text-xs text-gray-500">{{ __('No items available') }}</p>
			</div>
		</div>

		<!-- Grid View -->
		<div v-if="viewMode === 'grid'" key="grid" class="flex-1 flex flex-col overflow-hidden min-h-0">
			<div
				ref="gridScrollContainer"
				class="flex-1 overflow-y-auto bg-gray-200"
				style="min-height: 0;"
			>
				<div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-[2px]">
					<div
						v-for="(item, index) in displayedItems"
						:key="item.item_code"
						:data-item-index="index"
						@touchstart.passive="getOptimizedClickHandler(item).touchstart"
						@touchmove.passive="getOptimizedClickHandler(item).touchmove"
						@touchend.passive="getOptimizedClickHandler(item).touchend"
						@click="getOptimizedClickHandler(item).click"
						:class="[
							'group relative bg-white rounded-none p-1 sm:p-1.5 touch-manipulation transition-all duration-75 cursor-pointer hover:bg-amber-50/50',
							focusedItemIndex === index ? 'ring-2 ring-blue-600 ring-inset scale-[0.98] bg-blue-50/50 z-20' : ''
						]"
					>
						<!-- In-Cart Quantity Badge -->
						<div
							v-if="getCartItemQty(item.item_code) > 0"
							class="absolute top-1.5 start-1.5 z-10 rounded-none bg-blue-600 text-white px-1.5 py-0.5 text-[11px] sm:text-[13px] font-mono font-bold shadow-[0_2px_4px_rgba(0,0,0,0.3)]"
						>
							x{{ Math.floor(getCartItemQty(item.item_code)) }}
						</div>

						<!-- Stock Badge - Tap to select, long press to view warehouse availability -->
						<div
							v-if="(item.is_stock_item || item.is_bundle) && !item.has_variants && !settingsStore.hideQuantity"
							@pointerdown="onLongPressStart(item)"
							@pointerup="onLongPressEnd"
							@pointercancel="clearLongPress"
							@pointerleave="clearLongPress"
							:class="[
								'absolute top-1.5 end-1.5 z-10 rounded-none',
								'px-1.5 py-0.5 text-[11px] sm:text-[13px] font-mono font-bold cursor-pointer select-none',
								getStockStatus((item.actual_qty ?? item.stock_qty ?? 0)).color,
								getStockStatus((item.actual_qty ?? item.stock_qty ?? 0)).textColor
							]"
							:title="__('Check availability in other warehouses')"
						>
							{{ Math.floor((item.actual_qty ?? item.stock_qty ?? 0)) }}
						</div>
 
						<!-- Item Image -->
						<div class="relative aspect-[4/3] bg-gray-100 rounded-none mb-1 overflow-hidden border-b border-gray-100">
							<!-- Image with conditional blur on hover -->
							<div :class="[
								'w-full h-full transition-all duration-300',
								(item.is_stock_item || item.is_bundle) && (item.actual_qty ?? item.stock_qty ?? 0) <= 0 ? 'group-hover:blur-sm group-hover:brightness-75' : ''
							]">
								<LazyImage
									v-if="item.image"
									:src="item.image"
									:alt="item.item_name"
									container-class="relative w-full h-full"
									img-class="w-full h-full object-cover"
									root-margin="100px"
								>
									<template #error>
										<svg
											class="h-8 w-8 sm:h-10 sm:w-10 text-gray-300"
											fill="none"
											stroke="currentColor"
											viewBox="0 0 24 24"
										>
											<path
												stroke-linecap="round"
												stroke-linejoin="round"
												stroke-width="2"
												d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
											/>
										</svg>
									</template>
								</LazyImage>
								<div v-else class="w-full h-full flex items-center justify-center">
									<svg
										class="h-8 w-8 sm:h-10 sm:w-10 text-gray-300"
										fill="none"
										stroke="currentColor"
										viewBox="0 0 24 24"
									>
										<path
											stroke-linecap="round"
											stroke-linejoin="round"
											stroke-width="2"
											d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
										/>
									</svg>
								</div>
							</div>
 
							<!-- Info Icon Overlay - Tap to select, long press to show warehouse availability -->
							<div
								v-if="(item.is_stock_item || item.is_bundle) && (item.actual_qty ?? item.stock_qty ?? 0) <= 0"
								@pointerdown="onLongPressStart(item)"
								@pointerup="onLongPressEnd"
								@pointercancel="clearLongPress"
								@pointerleave="clearLongPress"
								class="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity duration-300 z-10 cursor-pointer select-none"
								:title="__('Check availability in other warehouses')"
							>
								<div class="p-2 bg-white/95 rounded-none border border-gray-300 pointer-events-none">
									<svg class="w-6 h-6 sm:w-7 sm:h-7 text-blue-600" fill="currentColor" viewBox="0 0 20 20">
										<path fill-rule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z" clip-rule="evenodd" />
									</svg>
								</div>
							</div>
						</div>
 
						<!-- Item Details -->
						<div class="min-w-0 flex flex-col justify-between pt-0.5">
							<div>
								<h3 class="text-[9px] sm:text-[12px] font-bold text-gray-900 truncate leading-tight">
									{{ item.item_name }}
								</h3>
								<p v-if="item.item_code" class="text-[8px] sm:text-[11px] font-mono text-gray-700 truncate leading-none mt-0.5">
									{{ item.item_code }}
								</p>
							</div>
							<div class="mt-2 flex items-baseline justify-between gap-1 flex-wrap">
								<span class="text-[9px] sm:text-[11px] font-bold text-blue-700 tracking-tight">{{ formatCurrency(item.rate || item.price_list_rate || 0) }}</span>
								<span class="text-[8px] sm:text-[9px] font-medium text-gray-400 uppercase tracking-wider truncate">/ {{ item.uom || item.stock_uom || __('Nos', null, 'UOM') }}</span>
							</div>
						</div>
					</div>
				</div>

				<!-- Loading More Indicator for Grid View -->
				<div v-if="loadingMore" class="flex justify-center items-center py-4">
					<div class="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-500"></div>
					<p class="ms-2 text-xs text-gray-500">{{ __('Loading more items...') }}</p>
				</div>

				<!-- End of Results Indicator - Show on last page when no more data -->
				<div v-else-if="filteredItems.length > 0 && !searchTerm && currentPage === totalPages && totalPages >= 1" class="flex justify-center items-center py-3">
					<p class="text-xs text-gray-400">{{ __('All items loaded') }}</p>
				</div>

				<!-- Search Results Count -->
				<div v-else-if="searchTerm && filteredItems.length > 0" class="flex justify-center items-center py-3">
					<p class="text-xs text-gray-500">{{ __('{0} items found', [filteredItems.length]) }}</p>
				</div>
			</div>

			<!-- Pagination Controls for Grid View -->
			<div v-if="totalPages > 1" class="px-2 sm:px-3 py-2 bg-white border-t border-gray-200">
				<div class="flex flex-col sm:flex-row items-center justify-between gap-2">
					<div class="text-[10px] sm:text-xs text-gray-600 order-2 sm:order-1">
						{{ __('{0} - {1} of {2}', [
							(((currentPage - 1) * itemsPerPage) + 1),
							Math.min(currentPage * itemsPerPage, paginationTotal),
							paginationTotal
						]) }}
					</div>
					<div class="flex items-center gap-0.5 order-1 sm:order-2">
						<button
							@click="goToPage(1)"
							data-nav="pagination"
							:disabled="currentPage === 1"
							:class="[
								'px-2 sm:px-3 py-1.5 text-[10px] sm:text-xs font-bold uppercase tracking-wider rounded-none border transition-colors duration-75 touch-manipulation',
								currentPage === 1
									? 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed'
									: 'bg-white text-gray-900 border-black hover:bg-gray-100 active:bg-gray-200'
							]"
							:aria-label="__('Go to first page')"
						>
							<span class="hidden xs:inline">{{ __('First') }}</span>
							<span class="xs:hidden">&laquo;</span>
						</button>
						<button
							@click="previousPage"
							data-nav="pagination"
							:disabled="currentPage === 1"
							:class="[
								'px-2 sm:px-3 py-1.5 text-[10px] sm:text-xs font-bold uppercase tracking-wider rounded-none border transition-colors duration-75 touch-manipulation',
								currentPage === 1
									? 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed'
									: 'bg-white text-gray-900 border-black hover:bg-gray-100 active:bg-gray-200'
							]"
							:aria-label="__('Go to previous page')"
						>
							<span class="hidden xs:inline">{{ __('Previous') }}</span>
							<span class="xs:hidden">&lsaquo;</span>
						</button>
						<div class="flex items-center gap-0.5">
							<button
								v-for="page in getPaginationRange()"
								:key="page"
								@click="goToPage(page)"
								data-nav="pagination"
								:class="[
									'min-w-[28px] sm:min-w-[32px] px-1.5 sm:px-2.5 py-1.5 text-[10px] sm:text-xs font-bold rounded-none border transition-colors duration-75 touch-manipulation',
									currentPage === page
										? 'bg-black text-white border-black'
										: 'bg-white text-gray-900 border-gray-300 hover:bg-gray-100 active:bg-gray-200'
								]"
								:aria-label="__('Go to page {0}', [page])"
							>
								{{ page }}
							</button>
						</div>
						<button
							@click="nextPage"
							data-nav="pagination"
							:disabled="currentPage === totalPages"
							:class="[
								'px-2 sm:px-3 py-1.5 text-[10px] sm:text-xs font-bold uppercase tracking-wider rounded-none border transition-colors duration-75 touch-manipulation',
								currentPage === totalPages
									? 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed'
									: 'bg-white text-gray-900 border-black hover:bg-gray-100 active:bg-gray-200'
							]"
							:aria-label="__('Go to next page')"
						>
							<span class="hidden xs:inline">{{ __('Next') }}</span>
							<span class="xs:hidden">&rsaquo;</span>
						</button>
						<button
							@click="goToPage(totalPages)"
							data-nav="pagination"
							:disabled="currentPage === totalPages"
							:class="[
								'px-2 sm:px-3 py-1.5 text-[10px] sm:text-xs font-bold uppercase tracking-wider rounded-none border transition-colors duration-75 touch-manipulation',
								currentPage === totalPages
									? 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed'
									: 'bg-white text-gray-900 border-black hover:bg-gray-100 active:bg-gray-200'
							]"
							:aria-label="__('Go to last page')"
						>
							<span class="hidden xs:inline">{{ __('Last') }}</span>
							<span class="xs:hidden">&raquo;</span>
						</button>
					</div>
				</div>
			</div>
		</div>

		<!-- Table View -->
		<div v-if="viewMode === 'list'" key="list" class="flex-1 flex flex-col overflow-hidden min-h-0">
			<div
				ref="listScrollContainer"
				class="flex-1 overflow-x-auto overflow-y-auto"
				style="min-height: 0;"
			>
				<table v-if="displayedItems.length > 0" class="min-w-full divide-y divide-gray-200">
					<thead class="bg-gray-50 sticky top-0 z-10">
						<tr>
							<th scope="col" class="px-2 sm:px-3 py-2 sm:py-2.5 text-start text-[10px] sm:text-xs font-semibold text-gray-700 uppercase tracking-wider bg-gray-50 border-b-2 border-gray-200 sticky top-0 z-10 w-[50px] sm:w-[60px]">{{ __('Image') }}</th>
							<th scope="col" class="px-2 sm:px-3 py-2 sm:py-2.5 text-start text-[10px] sm:text-xs font-semibold text-gray-700 uppercase tracking-wider bg-gray-50 border-b-2 border-gray-200 sticky top-0 z-10 max-w-[120px] sm:max-w-[180px] md:max-w-[200px]">{{ __('Name') }}</th>
							<th scope="col" class="hidden sm:table-cell px-2 sm:px-3 py-2 sm:py-2.5 text-start text-[10px] sm:text-xs font-semibold text-gray-700 uppercase tracking-wider bg-gray-50 border-b-2 border-gray-200 sticky top-0 z-10 sm:max-w-[150px]">{{ __('Code') }}</th>
							<th scope="col" class="px-2 sm:px-3 py-2 sm:py-2.5 text-start text-[10px] sm:text-xs font-semibold text-gray-700 uppercase tracking-wider bg-gray-50 border-b-2 border-gray-200 sticky top-0 z-10 w-[70px] sm:w-[100px]">{{ __('Rate') }}</th>
							<th scope="col" class="px-2 sm:px-3 py-2 sm:py-2.5 text-start text-[10px] sm:text-xs font-semibold text-gray-700 uppercase tracking-wider bg-gray-50 border-b-2 border-gray-200 sticky top-0 z-10 w-[70px] sm:w-[100px]" v-if="!settingsStore.hideQuantity">{{ __('Qty') }}</th>
							<th scope="col" class="hidden md:table-cell px-2 sm:px-3 py-2 sm:py-2.5 text-start text-[10px] sm:text-xs font-semibold text-gray-700 uppercase tracking-wider bg-gray-50 border-b-2 border-gray-200 sticky top-0 z-10 md:w-[80px]">{{ __('UOM') }}</th>
						</tr>
					</thead>
					<tbody class="bg-white divide-y divide-gray-200">
						<tr
							v-for="(item, index) in displayedItems"
							:key="item.item_code"
							:data-item-index="index"
							@touchstart.passive="getOptimizedClickHandler(item).touchstart"
							@touchmove.passive="getOptimizedClickHandler(item).touchmove"
							@touchend.passive="getOptimizedClickHandler(item).touchend"
							@click="getOptimizedClickHandler(item).click"
							:class="[
								'group cursor-pointer hover:bg-blue-50 hover:shadow-md transition-[background-color,box-shadow,outline] duration-100 touch-manipulation active:bg-blue-100',
								focusedItemIndex === index ? 'bg-blue-50 ring-2 ring-blue-600 ring-inset' : ''
							]"
						>
							<td class="px-2 sm:px-3 py-2 whitespace-nowrap w-[50px] sm:w-[60px]">
								<div class="w-8 h-8 sm:w-10 sm:h-10 bg-gray-100 rounded-none flex items-center justify-center overflow-hidden border border-gray-200">
									<LazyImage
										v-if="item.image"
										:src="item.image"
										:alt="item.item_name"
										container-class="relative w-full h-full"
										img-class="w-full h-full object-cover"
										root-margin="100px"
									>
										<template #error>
											<svg class="h-4 w-4 sm:h-5 sm:w-5 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
												<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
											</svg>
										</template>
									</LazyImage>
									<svg v-else class="h-4 w-4 sm:h-5 sm:w-5 text-gray-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
										<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
									</svg>
								</div>
							</td>
							<td class="px-2 sm:px-3 py-2 max-w-[120px] sm:max-w-[180px] md:max-w-[200px]">
								<div class="flex items-center gap-1.5">
									<span class="text-xs sm:text-sm font-bold uppercase tracking-tight text-gray-900 truncate" :title="item.item_name">
										{{ item.item_name }}
									</span>
									<span
										v-if="getCartItemQty(item.item_code) > 0"
										class="bg-blue-600 text-white px-1 py-0.5 rounded-none font-mono font-bold text-[9px] sm:text-[10px]"
									>
										x{{ Math.floor(getCartItemQty(item.item_code)) }}
									</span>
								</div>
								<div v-if="item.attributes" class="text-[8px] sm:text-[9px] text-gray-400 truncate leading-tight">
									{{ Object.values(item.attributes).join(' / ') }}
								</div>
							</td>
							<td class="hidden sm:table-cell px-2 sm:px-3 py-2 whitespace-nowrap sm:max-w-[150px]">
								<div class="text-xs sm:text-sm font-mono text-gray-500 truncate" :title="item.item_code">{{ item.item_code }}</div>
							</td>
							<td class="px-2 sm:px-3 py-2 whitespace-nowrap w-[70px] sm:w-[100px]">
								<div class="text-xs sm:text-sm font-bold text-blue-700 tracking-tight">{{ formatCurrency(item.rate || item.price_list_rate || 0) }}</div>
							</td>
							<td class="px-2 sm:px-3 py-2 whitespace-nowrap w-[70px] sm:w-[100px]" v-if="!settingsStore.hideQuantity">
								<!-- Stock Badge - Tap to select, long press to view warehouse availability -->
								<div
									v-if="(item.is_stock_item || item.is_bundle) && !item.has_variants && !settingsStore.hideQuantity"
									@pointerdown="onLongPressStart(item)"
									@pointerup="onLongPressEnd"
									@pointercancel="clearLongPress"
									@pointerleave="clearLongPress"
									:class="[
										'inline-block px-1.5 sm:px-2.5 py-0.5 rounded-none border border-gray-300 font-mono font-bold cursor-pointer select-none',
										getStockStatus((item.actual_qty ?? item.stock_qty ?? 0)).color,
										getStockStatus((item.actual_qty ?? item.stock_qty ?? 0)).textColor
									]"
									:title="__('Check availability in other warehouses')"
								>
									{{ Math.floor((item.actual_qty ?? item.stock_qty ?? 0)) }}
								</div>
								<span
									v-else
									class="text-xs sm:text-sm text-gray-400 italic"
								>
									{{ __('N/A') }}
								</span>
							</td>
							<td class="hidden md:table-cell px-2 sm:px-3 py-2 whitespace-nowrap md:w-[80px]">
								<div class="text-xs sm:text-sm text-gray-500">{{ item.uom || item.stock_uom || __('Nos', null, 'UOM') }}</div>
							</td>
						</tr>
						<!-- Loading More Indicator Row -->
						<tr v-if="loadingMore">
							<td colspan="6" class="px-2 sm:px-3 py-4 text-center bg-white">
								<div class="flex justify-center items-center">
									<div class="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-500"></div>
									<p class="ms-2 text-xs text-gray-500">{{ __('Loading more items...') }}</p>
								</div>
							</td>
						</tr>

						<!-- End of Results Indicator Row - Show on last page when no more data -->
						<tr v-else-if="filteredItems.length > 0 && !searchTerm && currentPage === totalPages && totalPages >= 1">
							<td colspan="6" class="px-2 sm:px-3 py-3 text-center bg-white">
								<p class="text-xs text-gray-400">{{ __('All items loaded') }}</p>
							</td>
						</tr>

						<!-- Search Results Count Row -->
						<tr v-else-if="searchTerm && filteredItems.length > 0">
							<td colspan="6" class="px-2 sm:px-3 py-3 text-center bg-white">
								<p class="text-xs text-gray-500">{{ __('{0} items found', [filteredItems.length]) }}</p>
							</td>
						</tr>
					</tbody>
				</table>
			</div>

			<!-- Pagination Controls for List View -->
			<div v-if="totalPages > 1" class="px-2 sm:px-3 py-2 bg-white border-t border-gray-200">
				<div class="flex flex-col sm:flex-row items-center justify-between gap-2">
					<div class="text-[10px] sm:text-xs text-gray-600 order-2 sm:order-1">
						{{ __('{0} - {1} of {2}', [
							(((currentPage - 1) * itemsPerPage) + 1),
							Math.min(currentPage * itemsPerPage, paginationTotal),
							paginationTotal
						]) }}
					</div>
					<div class="flex items-center gap-0.5 order-1 sm:order-2">
						<button
							@click="goToPage(1)"
							data-nav="pagination"
							:disabled="currentPage === 1"
							:class="[
								'px-2 sm:px-3 py-1.5 text-[10px] sm:text-xs font-bold uppercase tracking-wider rounded-none border transition-colors duration-75 touch-manipulation',
								currentPage === 1
									? 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed'
									: 'bg-white text-gray-900 border-black hover:bg-gray-100 active:bg-gray-200'
							]"
							:aria-label="__('Go to first page')"
						>
							<span class="hidden xs:inline">{{ __('First') }}</span>
							<span class="xs:hidden">&laquo;</span>
						</button>
						<button
							@click="previousPage"
							data-nav="pagination"
							:disabled="currentPage === 1"
							:class="[
								'px-2 sm:px-3 py-1.5 text-[10px] sm:text-xs font-bold uppercase tracking-wider rounded-none border transition-colors duration-75 touch-manipulation',
								currentPage === 1
									? 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed'
									: 'bg-white text-gray-900 border-black hover:bg-gray-100 active:bg-gray-200'
							]"
							:aria-label="__('Go to previous page')"
						>
							<span class="hidden xs:inline">{{ __('Previous') }}</span>
							<span class="xs:hidden">&lsaquo;</span>
						</button>
						<div class="flex items-center gap-0.5">
							<button
								v-for="page in getPaginationRange()"
								:key="page"
								@click="goToPage(page)"
								data-nav="pagination"
								:class="[
									'min-w-[28px] sm:min-w-[32px] px-1.5 sm:px-2.5 py-1.5 text-[10px] sm:text-xs font-bold rounded-none border transition-colors duration-75 touch-manipulation',
									currentPage === page
										? 'bg-black text-white border-black'
										: 'bg-white text-gray-900 border-gray-300 hover:bg-gray-100 active:bg-gray-200'
								]"
								:aria-label="__('Go to page {0}', [page])"
							>
								{{ page }}
							</button>
						</div>
						<button
							@click="nextPage"
							data-nav="pagination"
							:disabled="currentPage === totalPages"
							:class="[
								'px-2 sm:px-3 py-1.5 text-[10px] sm:text-xs font-bold uppercase tracking-wider rounded-none border transition-colors duration-75 touch-manipulation',
								currentPage === totalPages
									? 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed'
									: 'bg-white text-gray-900 border-black hover:bg-gray-100 active:bg-gray-200'
							]"
							:aria-label="__('Go to next page')"
						>
							<span class="hidden xs:inline">{{ __('Next') }}</span>
							<span class="xs:hidden">&rsaquo;</span>
						</button>
						<button
							@click="goToPage(totalPages)"
							data-nav="pagination"
							:disabled="currentPage === totalPages"
							:class="[
								'px-2 sm:px-3 py-1.5 text-[10px] sm:text-xs font-bold uppercase tracking-wider rounded-none border transition-colors duration-75 touch-manipulation',
								currentPage === totalPages
									? 'bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed'
									: 'bg-white text-gray-900 border-black hover:bg-gray-100 active:bg-gray-200'
							]"
							:aria-label="__('Go to last page')"
						>
							<span class="hidden xs:inline">{{ __('Last') }}</span>
							<span class="xs:hidden">&raquo;</span>
						</button>
					</div>
				</div>
			</div>
		</div>

		<!-- Keyboard Shortcuts Bar -->
		<div class="shortcuts-bar">
			<!-- Gradient Fades to suggest horizontal scrollability -->
			<div class="fade-overlay fade-left"></div>
			<div class="fade-overlay fade-right"></div>
			
			<div class="shortcuts-wrapper scrollbar-hide">
				<div class="shortcuts-list">
					<div v-for="(shortcut, idx) in KEYBOARD_SHORTCUTS" :key="idx" class="shortcut-item">
						<template v-for="(key, keyIdx) in shortcut.keys" :key="keyIdx">
							<kbd class="shortcut-key">{{ key }}</kbd>
							<span v-if="keyIdx < shortcut.keys.length - 1" class="shortcut-join">{{ shortcut.join || '+' }}</span>
						</template>
						<span class="shortcut-label">{{ shortcut.label }}</span>
					</div>
				</div>
			</div>
		</div>
	</div>

	<!-- Warehouse Availability Dialog -->
	<WarehouseAvailabilityDialog
		v-if="warehouseDialogItem"
		v-model="showWarehouseDialog"
		:item-code="warehouseDialogItem.itemCode"
		:item-name="warehouseDialogItem.itemName"
		:uom="warehouseDialogItem.uom"
		:company="warehouseDialogItem.company"
	/>
</template>

<script setup>
import LazyImage from "@/components/common/LazyImage.vue"
import WarehouseAvailabilityDialog from "@/components/sale/WarehouseAvailabilityDialog.vue"
import { useItemSearchStore } from "@/stores/itemSearch"
import { usePOSSettingsStore } from "@/stores/posSettings"
import { usePOSCartStore } from "@/stores/posCart"
import { useStock } from "@/composables/useStock"
import { useDialogState } from "@/composables/useDialogState"
import { useSearchInput } from "@/composables/useSearchInput"
import {
	DEFAULT_CURRENCY,
	formatCurrency as formatCurrencyUtil,
} from "@/utils/currency"
import { useToast } from "@/composables/useToast"
import { storeToRefs } from "pinia"
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue"
import {
	createOptimizedClickHandler,
	throttleRAF,
	addPassiveListener,
	runWhenIdle,
} from "@/utils/lowEndOptimizations"
import { performanceConfig } from "@/utils/performanceConfig"
import { shouldValidateItemStock } from "@/utils/stockValidator"

const props = defineProps({
	posProfile: String,
	cartItems: {
		type: Array,
		default: () => [],
	},
	currency: {
		type: String,
		default: DEFAULT_CURRENCY,
	},
})

const emit = defineEmits(["item-selected"])

// Use composables
const { getStockStatus } = useStock()
const settingsStore = usePOSSettingsStore()
const cartStore = usePOSCartStore()
const { showError, showWarning } = useToast()
const { isAnyDialogOpen } = useDialogState()
const focusedItemIndex = ref(-1)

// Use Pinia store
const itemStore = useItemSearchStore()
const {
	filteredItems,
	searchTerm,
	selectedItemGroup,
	selectedBrand,
	itemGroups,
	brands,
	loading,
	loadingMore,
	hasMore,
	cacheSyncing,
	cacheStats,
	sortBy,
	sortOrder,
	totalServerItems,
} = storeToRefs(itemStore)

// Search input composable — owns search/scanner state, timers, concurrency
const {
	searchInputRef,
	scannerEnabled,
	autoAddEnabled,
	handleSearchInput,
	handleKeyDown,
	handleSearchClick,
	toggleBarcodeScanner,
	toggleAutoAdd,
	focusSearchInput,
	clearSearchAndResetInput,
	cleanup: cleanupSearchInput,
} = useSearchInput({
	itemStore,
	onItemFound: selectItem,
	showWarning,
	isAnyDialogOpen,
})

// Local state
const viewMode = settingsStore.defaultCardView ? ref("grid") : ref("list") // 'grid' or 'list'
const itemThreshold = ref(50) // Threshold for auto-switching to list view
const userManuallySetView = ref(false) // Track if user manually changed view mode
const lastAutoSwitchCount = ref(0)
const showSortDropdown = ref(false) // Sort dropdown visibility
const skipPageReset = ref(false) // Skip page reset when navigating via pagination

// Warehouse availability dialog state
const showWarehouseDialog = ref(false)
const warehouseDialogItem = ref(null)

// Infinite scroll refs
const gridScrollContainer = ref(null)
const listScrollContainer = ref(null)

// Store scroll listener cleanup functions
const scrollCleanupFns = ref([])

// Pagination state (for client-side display)
const currentPage = ref(1)
const itemsPerPage = ref(performanceConfig.get("itemsPerPage") || 100)
const lastFilterSignature = ref("")

// Computed paginated items — server fetches one page at a time,
// so filteredItems already contains only the current page's items.
const displayedItems = computed(() => {
	if (!filteredItems.value) return []
	return filteredItems.value
})

// Total item count for pagination display
const paginationTotal = computed(() => {
	if (searchTerm.value?.trim()) return filteredItems.value?.length || 0
	return totalServerItems.value || filteredItems.value?.length || 0
})

// Total pages is based on server-side total count (not local array length).
// During search, fall back to local results since server count is for browsing.
const totalPages = computed(() => {
	if (searchTerm.value?.trim()) {
		// During search, we don't paginate server-side — show all results
		return 1
	}
	if (totalServerItems.value > 0) {
		return Math.ceil(totalServerItems.value / itemsPerPage.value)
	}
	if (!filteredItems.value) return 0
	return Math.ceil(filteredItems.value.length / itemsPerPage.value)
})

const SEARCH_PLACEHOLDERS = Object.freeze({
	auto: __("Auto-Add ON - Type or scan barcode"),
	scanner: __("Scanner ON - Enable Auto for automatic addition"),
	default: __("Search by item code, name, item group or scan barcode"),
})

const KEYBOARD_SHORTCUTS = Object.freeze([
	{ keys: ["Alt", "S"], join: "+", label: __("Search") },
	{ keys: ["Alt", "I"], join: "+", label: __("Focus Items") },
	{ keys: ["Arrow Keys"], label: __("Navigate") },
	{ keys: ["Enter"], label: __("Add/Select") },
	{ keys: ["+", "-"], join: "/", label: __("Qty +/-") },
	{ keys: ["[", "]"], join: "/", label: __("Group Prev/Next") },
	{ keys: ["Alt", "B"], join: "+", label: __("Scanner") },
	{ keys: ["Alt", "A"], join: "+", label: __("Auto-Add") },
	{ keys: ["Alt", "V"], join: "+", label: __("Grid/List") },
	{ keys: ["Alt", "O"], join: "+", label: __("Sort") },
])

// Sort configuration
const BASE_SORT_OPTIONS = Object.freeze([
	{
		field: "name",
		label: __("Name"),
		icon: "M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z",
	},
	{
		field: "quantity",
		label: __("Quantity"),
		icon: "M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4",
	},
	{
		field: "price",
		label: __("Price"),
		icon: "M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z",
	},
	{
		field: "item_code",
		label: __("Item Code"),
		icon: "M7 20l4-16m2 16l4-16M6 9h14M4 15h14",
	},
])

const CONTEXT_SORT_OPTIONS = Object.freeze({
	brand: {
		field: "brand",
		label: __("Brand"),
		icon: "M20 13V7a2 2 0 00-2-2h-4V3H10v2H6a2 2 0 00-2 2v6M8 21h8a2 2 0 002-2v-5H6v5a2 2 0 002 2z",
	},
	item_group: {
		field: "item_group",
		label: __("Item Group"),
		icon: "M9 12l2 2 4-4m5.586 1.414l-6.172 6.172a2 2 0 01-2.828 0L3.414 9.414a2 2 0 010-2.828l6.172-6.172a2 2 0 012.828 0l8.172 8.172a2 2 0 010 2.828z",
	},
})

const SORT_ICONS = Object.freeze({
	ascending: "M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12",
	descending: "M3 4h13M3 8h9m-9 4h9m5-4v12m0 0l-4-4m4 4l4-4",
	inactive: "M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4",
})

const searchMode = computed(() => {
	if (autoAddEnabled.value) {
		return "auto"
	}

	if (scannerEnabled.value) {
		return "scanner"
	}

	return "default"
})

const searchPlaceholder = computed(() => SEARCH_PLACEHOLDERS[searchMode.value])
const isBrandSortActive = computed(() => sortBy.value === "brand")
const sortOptions = computed(() => {
	// Context switcher:
	// - In Item Group mode, offer Brand.
	// - In Brand mode, offer Item Group.
	const contextSort = isBrandSortActive.value
		? CONTEXT_SORT_OPTIONS.item_group
		: CONTEXT_SORT_OPTIONS.brand

	return [
		BASE_SORT_OPTIONS[0],
		contextSort,
		BASE_SORT_OPTIONS[1],
		BASE_SORT_OPTIONS[2],
		BASE_SORT_OPTIONS[3],
	]
})
const activeFilterValue = computed(() =>
	isBrandSortActive.value ? selectedBrand.value : selectedItemGroup.value,
)
const activeFilterOptions = computed(() =>
	isBrandSortActive.value
		? (brands.value || []).map((b) => ({ value: b.brand, label: b.brand }))
		: (itemGroups.value || []).map((g) => ({
				value: g.item_group,
				label: g.item_group_name || g.item_group,
			})),
)
const selectedFilterLabel = computed(
	() => selectedBrand.value || selectedItemGroup.value || null,
)

// Watch for cart items and pos profile changes (optimized - uses length + hash instead of deep watch)
// Tracks: length, item_code, quantity, and amount to detect all cart changes including array replacements
watch(
	() =>
		`${props.cartItems.length}-${props.cartItems.map((i) => `${i.item_code}:${i.quantity || 0}:${i.amount || 0}`).join("|")}`,
	() => {
		itemStore.setCartItems(props.cartItems)
	},
	{ immediate: true, flush: "sync" }, // Synchronous to ensure immediate stock updates
)

watch(
	() => props.posProfile,
	(newProfile) => {
		if (newProfile) {
			itemStore.setPosProfile(newProfile)
		}
	},
	{ immediate: true },
)

// Reset to page 1 when filtered items meaningfully change (group switch, search, etc.)
// Skip reset when the change is from pagination navigation (fetchPage)
watch(
	filteredItems,
	(newItems) => {
		if (!newItems) {
			focusedItemIndex.value = -1
			return
		}

		// Calculate signature of item codes to detect actual list changes
		const signature = newItems.map((item) => item.item_code).join("|")
		const hasListChanged = signature !== lastFilterSignature.value

		if (hasListChanged || skipPageReset.value) {
			focusedItemIndex.value = -1
		}

		// Skip page reset for pagination-driven changes
		if (skipPageReset.value) {
			skipPageReset.value = false
			lastFilterSignature.value = signature
			return
		}

		const itemCount = newItems.length

		if (hasListChanged) {
			currentPage.value = 1
			lastFilterSignature.value = signature
		}

		// Only auto-switch if user hasn't manually set a preference
		// and we're in grid view with many items
		if (
			!userManuallySetView.value &&
			viewMode.value === "grid" &&
			itemCount > itemThreshold.value
		) {
			if (lastAutoSwitchCount.value !== itemCount) {
				viewMode.value = "list"
				lastAutoSwitchCount.value = itemCount
			}
		} else if (itemCount <= itemThreshold.value) {
			lastAutoSwitchCount.value = 0
		}
	},
	{ immediate: false },
)

// Throttle scroll handler for better performance
let scrollTimeout = null

// Scroll handler — pagination controls handle page navigation now.
// Scroll is only used for scrolling within the current page.
const handleScrollRAF = throttleRAF(() => {
	// No-op: pagination handles page navigation via goToPage/nextPage/previousPage
})

function handleScroll(event) {
	handleScrollRAF(event)
}

const getColumnsCount = () => {
	const width = window.innerWidth
	if (width < 640) return 2
	if (width < 768) return 3
	if (width < 1024) return 3
	if (width < 1280) return 4
	return 5
}

const scrollFocusedItemIntoView = () => {
	nextTick(() => {
		const container =
			viewMode.value === "grid"
				? gridScrollContainer.value
				: listScrollContainer.value
		if (!container) return

		const itemElement = container.querySelector(
			`[data-item-index="${focusedItemIndex.value}"]`,
		)
		if (!itemElement) return

		const containerRect = container.getBoundingClientRect()
		const itemRect = itemElement.getBoundingClientRect()

		if (itemRect.bottom > containerRect.bottom) {
			container.scrollTop += itemRect.bottom - containerRect.bottom + 10
		} else if (itemRect.top < containerRect.top) {
			container.scrollTop -= containerRect.top - itemRect.top + 10
		}
	})
}

function adjustFocusedItemQty(adjustment) {
	const focusedItem = displayedItems.value[focusedItemIndex.value]
	if (!focusedItem) return

	const cartItem = props.cartItems.find(
		(i) => i.item_code === focusedItem.item_code,
	)
	if (cartItem) {
		const currentQty = cartItem.qty || cartItem.quantity || 0
		const newQty = Math.max(0, currentQty + adjustment)
		if (newQty === 0) {
			cartStore.removeItem(focusedItem.item_code, cartItem.uom)
			playNotificationSound("add")
		} else {
			try {
				cartStore.updateItemQuantity(
					focusedItem.item_code,
					newQty,
					cartItem.uom,
				)
				playNotificationSound("add")
			} catch (error) {
				showError(error.message || __("Failed to update quantity"))
				playNotificationSound("error")
			}
		}
	} else if (adjustment > 0) {
		selectItem(focusedItem)
	}
}

function navigateItemGroups(direction) {
	const totalOptions = activeFilterOptions.value.length
	let currentIndex = -1 // -1 represents 'All'

	if (activeFilterValue.value) {
		currentIndex = activeFilterOptions.value.findIndex(
			(opt) => opt.value === activeFilterValue.value,
		)
	}

	let nextIndex = currentIndex + direction
	if (nextIndex < -1) {
		nextIndex = totalOptions - 1
	} else if (nextIndex >= totalOptions) {
		nextIndex = -1
	}

	if (nextIndex === -1) {
		handleAllFilterClick()
	} else {
		handleFilterClick(activeFilterOptions.value[nextIndex].value)
	}

	// Reset focus when group changes
	focusedItemIndex.value = -1
}

function handleInputKeyDown(event) {
	if (event.key === "ArrowDown") {
		event.preventDefault()
		event.stopPropagation()
		if (displayedItems.value.length > 0) {
			focusedItemIndex.value = 0
			scrollFocusedItemIntoView()
			if (searchInputRef.value) {
				searchInputRef.value.blur()
			}
		}
		return
	}

	if (event.key === "Escape") {
		event.preventDefault()
		event.stopPropagation()
		clearSearchAndResetInput()
		focusedItemIndex.value = -1
		return
	}

	handleKeyDown(event)
}

function getCartItemQty(itemCode) {
	if (!props.cartItems) return 0
	const cartItem = props.cartItems.find((i) => i.item_code === itemCode)
	if (!cartItem) return 0
	return cartItem.qty || cartItem.quantity || 0
}

function playNotificationSound(type) {
	try {
		const AudioContextClass = window.AudioContext || window.webkitAudioContext
		if (!AudioContextClass) return

		const ctx = new AudioContextClass()

		if (type === "add") {
			const osc = ctx.createOscillator()
			const gain = ctx.createGain()

			osc.type = "sine"
			osc.frequency.setValueAtTime(880, ctx.currentTime)
			osc.frequency.exponentialRampToValueAtTime(1200, ctx.currentTime + 0.1)

			gain.gain.setValueAtTime(0.05, ctx.currentTime)
			gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15)

			osc.connect(gain)
			gain.connect(ctx.destination)

			osc.start()
			osc.stop(ctx.currentTime + 0.15)
		} else if (type === "error") {
			const osc = ctx.createOscillator()
			const gain = ctx.createGain()

			osc.type = "sawtooth"
			osc.frequency.setValueAtTime(150, ctx.currentTime)

			gain.gain.setValueAtTime(0.08, ctx.currentTime)
			gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3)

			osc.connect(gain)
			gain.connect(ctx.destination)

			osc.start()
			osc.stop(ctx.currentTime + 0.3)
		}
	} catch (e) {
		console.warn("AudioContext failed to play sound:", e)
	}
}

function setFocusedItemQty(qty) {
	const focusedItem = displayedItems.value[focusedItemIndex.value]
	if (!focusedItem) return

	const cartItem = props.cartItems.find(
		(i) => i.item_code === focusedItem.item_code,
	)
	if (cartItem) {
		try {
			cartStore.updateItemQuantity(
				focusedItem.item_code,
				qty,
				cartItem.uom,
			)
			playNotificationSound("add")
		} catch (error) {
			showError(error.message || __("Failed to update quantity"))
			playNotificationSound("error")
		}
	} else {
		try {
			cartStore.addItem(focusedItem, qty, false, settingsStore.posProfile)
			playNotificationSound("add")
		} catch (error) {
			showError(error.message || __("Failed to add item"))
			playNotificationSound("error")
		}
	}
}

function getNavElements(type) {
	return Array.from(document.querySelectorAll(`[data-nav="${type}"]`)).filter(
		(el) => !el.disabled && el.offsetParent !== null,
	)
}

function handleNavigationKeys(event) {
	const activeEl = document.activeElement
	if (!activeEl) return

	const navType = activeEl.getAttribute("data-nav")

	// 1. FILTERS ZONE
	if (navType === "filter") {
		const elements = getNavElements("filter")
		const index = elements.indexOf(activeEl)

		if (event.key === "ArrowRight") {
			event.preventDefault()
			const nextEl = elements[index + 1] || elements[0]
			nextEl?.focus()
		} else if (event.key === "ArrowLeft") {
			event.preventDefault()
			const prevEl = elements[index - 1] || elements[elements.length - 1]
			prevEl?.focus()
		} else if (event.key === "ArrowDown") {
			event.preventDefault()
			// Focus search input
			const searchInput = document.getElementById("item-search")
			searchInput?.focus()
		}
		return
	}

	// 2. SEARCH BAR ZONE
	if (navType === "search-bar") {
		const elements = getNavElements("search-bar")
		const index = elements.indexOf(activeEl)

		if (event.key === "ArrowRight") {
			// If in search input, only move focus if cursor is at the end
			if (activeEl.id === "item-search") {
				const isAtEnd = activeEl.selectionEnd === activeEl.value.length
				if (!isAtEnd) return
			}
			event.preventDefault()
			const nextEl = elements[index + 1]
			nextEl?.focus()
		} else if (event.key === "ArrowLeft") {
			// If in search input, only move focus if cursor is at the start
			if (activeEl.id === "item-search") {
				const isAtStart = activeEl.selectionStart === 0
				if (!isAtStart) return
			}
			event.preventDefault()
			const prevEl = elements[index - 1]
			prevEl?.focus()
		} else if (event.key === "ArrowUp") {
			event.preventDefault()
			// Focus active or first filter tab
			const filters = getNavElements("filter")
			const activeFilter = filters.find((el) => el.classList.contains("bg-black")) || filters[0]
			activeFilter?.focus()
		} else if (event.key === "ArrowDown") {
			event.preventDefault()
			// Move focus to items list if available
			if (displayedItems.value.length > 0) {
				focusedItemIndex.value = 0
				scrollFocusedItemIntoView()
				activeEl.blur()
			}
		}
		return
	}

	// 3. PAGINATION ZONE
	if (navType === "pagination") {
		const elements = getNavElements("pagination")
		const index = elements.indexOf(activeEl)

		if (event.key === "ArrowRight") {
			event.preventDefault()
			const nextEl = elements[index + 1] || elements[0]
			nextEl?.focus()
		} else if (event.key === "ArrowLeft") {
			event.preventDefault()
			const prevEl = elements[index - 1] || elements[elements.length - 1]
			prevEl?.focus()
		} else if (event.key === "ArrowUp") {
			event.preventDefault()
			// Focus the bottom item in the list
			if (displayedItems.value.length > 0) {
				focusedItemIndex.value = displayedItems.value.length - 1
				scrollFocusedItemIntoView()
				activeEl.blur()
			}
		}
		return
	}
}

function handleGlobalKeyDown(event) {
	if (isAnyDialogOpen.value) return

	const activeEl = document.activeElement
	const isSearchFocused = activeEl && activeEl.id === "item-search"
	const isTyping =
		activeEl &&
		((activeEl.tagName === "INPUT" && !isSearchFocused) ||
			activeEl.tagName === "TEXTAREA" ||
			activeEl.isContentEditable)

	// Alt + S or F2: Focus Search input
	if ((event.altKey && event.key.toLowerCase() === "s") || event.key === "F2") {
		event.preventDefault()
		focusedItemIndex.value = -1
		focusSearchInput()
		return
	}

	// Alt + I or F3: Focus items
	if ((event.altKey && event.key.toLowerCase() === "i") || event.key === "F3") {
		event.preventDefault()
		if (displayedItems.value.length > 0) {
			focusedItemIndex.value = 0
			scrollFocusedItemIntoView()
			if (isSearchFocused && searchInputRef.value) {
				searchInputRef.value.blur()
			}
		}
		return
	}

	// Alt + B: Toggle barcode scanner
	if (event.altKey && event.key.toLowerCase() === "b") {
		event.preventDefault()
		toggleBarcodeScanner()
		return
	}

	// Alt + A: Toggle auto-add
	if (event.altKey && event.key.toLowerCase() === "a") {
		event.preventDefault()
		toggleAutoAdd()
		return
	}

	// Alt + V: Toggle view mode
	if (event.altKey && event.key.toLowerCase() === "v") {
		event.preventDefault()
		setViewMode(viewMode.value === "grid" ? "list" : "grid")
		return
	}

	// Alt + O: Toggle sort dropdown
	if (event.altKey && event.key.toLowerCase() === "o") {
		event.preventDefault()
		toggleSortDropdown()
		return
	}

	// Escape: Blur items focus and focus search
	if (event.key === "Escape") {
		if (focusedItemIndex.value >= 0) {
			event.preventDefault()
			focusedItemIndex.value = -1
			focusSearchInput()
		}
		return
	}

	// If typing in another input, do not intercept following keys
	if (isTyping) return

	// Spatial navigation for filter buttons, search bar buttons, and pagination buttons
	if (
		["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key) &&
		activeEl &&
		activeEl.getAttribute("data-nav")
	) {
		handleNavigationKeys(event)
		return
	}

	// Navigation keys when item results are navigated:
	if (focusedItemIndex.value >= 0) {
		if (
			["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)
		) {
			if (isSearchFocused) return

			event.preventDefault()
			const len = displayedItems.value.length
			if (len === 0) return

			if (viewMode.value === "list") {
				if (event.key === "ArrowDown") {
					if (focusedItemIndex.value === len - 1) {
						// Focus pagination if available
						const paginationBtns = getNavElements("pagination")
						if (paginationBtns.length > 0) {
							focusedItemIndex.value = -1
							paginationBtns[0].focus()
						}
					} else {
						focusedItemIndex.value = Math.min(len - 1, focusedItemIndex.value + 1)
					}
				} else if (event.key === "ArrowUp") {
					if (focusedItemIndex.value === 0) {
						focusedItemIndex.value = -1
						focusSearchInput()
					} else {
						focusedItemIndex.value = Math.max(0, focusedItemIndex.value - 1)
					}
				}
			} else {
				const cols = getColumnsCount()
				if (event.key === "ArrowRight") {
					focusedItemIndex.value = Math.min(len - 1, focusedItemIndex.value + 1)
				} else if (event.key === "ArrowLeft") {
					focusedItemIndex.value = Math.max(0, focusedItemIndex.value - 1)
				} else if (event.key === "ArrowDown") {
					if (focusedItemIndex.value + cols >= len) {
						// Focus pagination if available
						const paginationBtns = getNavElements("pagination")
						if (paginationBtns.length > 0) {
							focusedItemIndex.value = -1
							paginationBtns[0].focus()
						}
					} else {
						focusedItemIndex.value = Math.min(
							len - 1,
							focusedItemIndex.value + cols,
						)
					}
				} else if (event.key === "ArrowUp") {
					if (focusedItemIndex.value - cols < 0) {
						focusedItemIndex.value = -1
						focusSearchInput()
					} else {
						focusedItemIndex.value = Math.max(0, focusedItemIndex.value - cols)
					}
				}
			}
			scrollFocusedItemIntoView()
			return
		}

		if (/^[1-9]$/.test(event.key)) {
			event.preventDefault()
			const qty = parseInt(event.key, 10)
			setFocusedItemQty(qty)
			return
		}

		if (event.key === "Enter") {
			event.preventDefault()
			const item = displayedItems.value[focusedItemIndex.value]
			if (item) {
				selectItem(item)
			}
			return
		}

		if (event.key === "+" || event.key === "=") {
			event.preventDefault()
			adjustFocusedItemQty(1)
			return
		}
		if (event.key === "-") {
			event.preventDefault()
			adjustFocusedItemQty(-1)
			return
		}
	}

	if (event.key === "[" || event.key === "]") {
		if (!isSearchFocused) {
			event.preventDefault()
			navigateItemGroups(event.key === "]" ? 1 : -1)
		}
	}
}

onMounted(() => {
	// Items are now loaded automatically by setPosProfile() in the watcher
	// This ensures item group filters are loaded BEFORE fetching items

	// Add passive scroll listeners for better performance
	// Only bind to the currently active view
	if (viewMode.value === "grid" && gridScrollContainer.value) {
		const cleanup = addPassiveListener(
			gridScrollContainer.value,
			"scroll",
			handleScroll,
			{ passive: true },
		)
		scrollCleanupFns.value.push(cleanup)
	} else if (viewMode.value === "list" && listScrollContainer.value) {
		const cleanup = addPassiveListener(
			listScrollContainer.value,
			"scroll",
			handleScroll,
			{ passive: true },
		)
		scrollCleanupFns.value.push(cleanup)
	}

	// Add click outside listener for sort dropdown
	document.addEventListener("click", handleClickOutside)

	// Add global keydown listener for keyboard shortcuts
	window.addEventListener("keydown", handleGlobalKeyDown)
})

onUnmounted(() => {
	// Cleanup background sync when component unmounts
	itemStore.cleanup()

	// Clear scroll timeout
	if (scrollTimeout) {
		clearTimeout(scrollTimeout)
		scrollTimeout = null
	}

	// Cleanup passive listeners
	scrollCleanupFns.value.forEach((cleanup) => cleanup())
	scrollCleanupFns.value = []

	// Clear handlers and timers
	optimizedClickHandlers.clear()
	clearLongPress()
	cleanupSearchInput()

	// Remove click outside listener for sort dropdown
	document.removeEventListener("click", handleClickOutside)

	// Remove global keydown listener
	window.removeEventListener("keydown", handleGlobalKeyDown)
})

// Create optimized click handlers for better touch response
const optimizedClickHandlers = new Map()

function getOptimizedClickHandler(item) {
	const key = item.item_code
	if (!optimizedClickHandlers.has(key)) {
		const handler = createOptimizedClickHandler(
			() => {
				handleItemClick(item.item_code)
			},
			{
				feedback: true,
			},
		)
		optimizedClickHandlers.set(key, handler)
	}
	return optimizedClickHandlers.get(key)
}

// Long press handler for stock badge/info icon
// Short tap = select item (with validation), Long press = show warehouse availability
let longPressTimer = null
let longPressItem = null
let longPressTriggered = false
let itemHandledByLongPress = false // Flag to prevent double handling

function onLongPressStart(item) {
	clearTimeout(longPressTimer)
	longPressItem = item
	longPressTriggered = false
	longPressTimer = setTimeout(() => {
		longPressTriggered = true
		itemHandledByLongPress = true
		showWarehouseAvailability(item)
	}, 500)
}

function onLongPressEnd() {
	clearTimeout(longPressTimer)
	// If not a long press, trigger item selection
	if (!longPressTriggered && longPressItem) {
		itemHandledByLongPress = true
		selectItem(longPressItem)
	}
	longPressTimer = null
	longPressItem = null
	longPressTriggered = false
}

function clearLongPress() {
	clearTimeout(longPressTimer)
	longPressTimer = null
	longPressItem = null
	longPressTriggered = false
}

/**
 * Validates stock and emits item-selected if valid
 * @param {Object} item - Item to select
 * @param {boolean} autoAdd - Auto-add flag for barcode scanning
 * @returns {boolean} - True if item was emitted, false if blocked
 */
function selectItem(item, autoAdd = false) {
	if (!item) return false

	// Early out-of-stock guard — full qty validation happens in cartStore.addItem()
	if (
		!item.has_variants &&
		settingsStore.shouldEnforceStockValidation() &&
		shouldValidateItemStock(item)
	) {
		const qty = item.actual_qty ?? item.stock_qty ?? 0
		if (qty <= 0) {
			showError(
				__('"{0}" is out of stock in warehouse "{1}".', [
					item.item_name,
					item.warehouse || "",
				]),
			)
			playNotificationSound("error")
			return false
		}
	}

	emit("item-selected", item, autoAdd)
	playNotificationSound("add")
	return true
}

function handleItemClick(itemCode) {
	// Skip if already handled by long press handler (prevents double-add)
	if (itemHandledByLongPress) {
		itemHandledByLongPress = false
		return
	}
	const item = filteredItems.value.find((i) => i.item_code === itemCode)
	selectItem(item)
}

function formatCurrency(amount) {
	return formatCurrencyUtil(Number.parseFloat(amount || 0), props.currency)
}

// Show warehouse availability dialog
function showWarehouseAvailability(item) {
	warehouseDialogItem.value = {
		itemCode: item.item_code,
		itemName: item.item_name,
		uom: item.uom || item.stock_uom || "Nos",
		company: settingsStore.company,
	}
	showWarehouseDialog.value = true
}

// Expose methods for parent component
defineExpose({
	loadItems: () => itemStore.loadAllItems(props.posProfile),
	loadItemGroups: () => itemStore.loadItemGroups(),
	loadMoreItems: () => itemStore.loadMoreItems(),
	focusSearchInput,
})

// Watch for view mode changes and rebind scroll listeners
watch(viewMode, async () => {
	// Wait for DOM to update
	await nextTick()

	// Clean up existing listeners
	scrollCleanupFns.value.forEach((cleanup) => cleanup())
	scrollCleanupFns.value = []

	// Rebind listeners to the new active container
	if (viewMode.value === "grid" && gridScrollContainer.value) {
		const cleanup = addPassiveListener(
			gridScrollContainer.value,
			"scroll",
			handleScroll,
			{ passive: true },
		)
		scrollCleanupFns.value.push(cleanup)
	} else if (viewMode.value === "list" && listScrollContainer.value) {
		const cleanup = addPassiveListener(
			listScrollContainer.value,
			"scroll",
			handleScroll,
			{ passive: true },
		)
		scrollCleanupFns.value.push(cleanup)
	}
})

// View mode functions
function setViewMode(mode) {
	viewMode.value = mode
	userManuallySetView.value = true
}

function handleAllFilterClick() {
	if (isBrandSortActive.value) {
		itemStore.setSelectedBrand(null)
		return
	}
	itemStore.setSelectedItemGroup(null)
}

function handleFilterClick(value) {
	if (isBrandSortActive.value) {
		itemStore.setSelectedBrand(value)
		return
	}
	itemStore.setSelectedItemGroup(value)
}

// Pagination functions — each page fetches fresh data from server
function goToPage(page) {
	if (page >= 1 && page <= totalPages.value && page !== currentPage.value) {
		skipPageReset.value = true
		currentPage.value = page
		itemStore.fetchPage(page)
	}
}

function nextPage() {
	if (currentPage.value < totalPages.value) {
		skipPageReset.value = true
		currentPage.value++
		itemStore.fetchPage(currentPage.value)
	}
}

function previousPage() {
	if (currentPage.value > 1) {
		skipPageReset.value = true
		currentPage.value--
		itemStore.fetchPage(currentPage.value)
	}
}

function getPaginationRange() {
	const range = []
	const total = totalPages.value
	const current = currentPage.value
	const delta = 2 // Number of pages to show on each side of current page

	if (total <= 7) {
		// Show all pages if total is small
		for (let i = 1; i <= total; i++) {
			range.push(i)
		}
	} else {
		// Show smart range with ellipsis
		if (current <= 3) {
			for (let i = 1; i <= 5; i++) {
				range.push(i)
			}
		} else if (current >= total - 2) {
			for (let i = total - 4; i <= total; i++) {
				range.push(i)
			}
		} else {
			for (let i = current - delta; i <= current + delta; i++) {
				range.push(i)
			}
		}
	}

	return range
}

// Sort dropdown functions
function toggleSortDropdown() {
	showSortDropdown.value = !showSortDropdown.value
}

function handleSortToggle(field) {
	if (!field) {
		// Clear sorting
		itemStore.clearSortFilter()
		showSortDropdown.value = false
		return
	}

	// If clicking the same field, toggle between asc/desc
	if (sortBy.value === field) {
		const newOrder = sortOrder.value === "asc" ? "desc" : "asc"
		itemStore.setSortFilter(field, newOrder)
	} else {
		// New field - start with ascending
		itemStore.setSortFilter(field, "asc")
	}
}

watch(sortBy, async (newSortBy, oldSortBy) => {
	if (newSortBy === "brand") {
		await itemStore.loadBrands()
		if (selectedItemGroup.value) {
			await itemStore.setSelectedItemGroup(null)
		}
		return
	}

	if (oldSortBy === "brand" && selectedBrand.value) {
		await itemStore.setSelectedBrand(null)
	}
})

function getSortLabel(sortByValue) {
	return (
		CONTEXT_SORT_OPTIONS[sortByValue]?.label ||
		BASE_SORT_OPTIONS.find((opt) => opt.field === sortByValue)?.label ||
		sortByValue
	)
}

function getSortIconState(field) {
	if (sortBy.value !== field) return "inactive"
	return sortOrder.value === "asc" ? "ascending" : "descending"
}

// Close dropdown when clicking outside
function handleClickOutside(event) {
	if (showSortDropdown.value) {
		const dropdown = event.target.closest(".relative")
		if (
			!dropdown ||
			!dropdown
				.querySelector("button[data-sort-button]")
				?.contains(event.target)
		) {
			showSortDropdown.value = false
		}
	}
}

// Check if an item can be added to cart based on stock
</script>

<style scoped>
/* Hide scrollbar for Chrome, Safari and Opera */
.scrollbar-hide::-webkit-scrollbar {
    display: none;
}

/* Hide scrollbar for IE, Edge and Firefox */
.scrollbar-hide {
    -ms-overflow-style: none;  /* IE and Edge */
    scrollbar-width: none;  /* Firefox */
}

/* Performance optimizations for low-end devices */
[class*="grid-cols-"] > div {
	/* Tell browser which properties will change */
	will-change: opacity;
	/* Use GPU acceleration for transforms */
	transform: translateZ(0);
	/* Optimize for speed over quality */
	backface-visibility: hidden;
}

/* Optimize scroll containers */
.overflow-y-auto, .overflow-x-auto {
	/* Enable smooth scrolling with GPU acceleration */
	-webkit-overflow-scrolling: touch;
	/* Create stacking context for better compositing */
	transform: translateZ(0);
	will-change: scroll-position;
}

/* Reduce paint areas */
.relative {
	/* Isolate paint regions */
	isolation: isolate;
}

/* Optimize images */
img {
	/* Use browser's image optimization */
	image-rendering: -webkit-optimize-contrast;
	image-rendering: crisp-edges;
}

/* Minimal transitions for performance */

/* Performance hints for list rows */
tbody tr {
	/* Optimize for compositing */
	will-change: opacity, background-color;
	/* Create rendering layer */
	contain: layout style paint;
}

/* Remove will-change when not hovering to save resources */
tbody tr:not(:hover):not(:active) {
	will-change: auto;
}

/* Keyboard Shortcuts Bar Styling - Enhancing with beautiful dark graphite colors & 3D keycaps */
.shortcuts-bar {
	position: relative;
	background-color: #0f172a; /* Slate 900 */
	border-top: 1px solid #1e293b; /* Slate 800 */
	color: #94a3b8; /* Slate 400 */
	padding: 0 1.25rem;
	flex-shrink: 0;
	user-select: none;
	overflow: hidden;
}

/* Gradient Fades for horizontal scrolling indicator */
.fade-overlay {
	position: absolute;
	top: 0;
	bottom: 0;
	width: 2.5rem;
	pointer-events: none;
	z-index: 10;
}
.fade-left {
	left: 0;
	background: linear-gradient(to right, #0f172a 10%, rgba(15, 23, 42, 0));
}
.fade-right {
	right: 0;
	background: linear-gradient(to left, #0f172a 10%, rgba(15, 23, 42, 0));
}

.shortcuts-wrapper {
	display: flex;
	align-items: center;
	gap: 0.5rem;
	overflow-x: auto;
	user-select: none;
	white-space: nowrap;
}

.shortcuts-title {
	display: flex;
	align-items: center;
	gap: 0.375rem;
	font-weight: 900;
	text-transform: uppercase;
	letter-spacing: 0.05em;
	color: #38bdf8; /* Sky 400 accent */
	margin-right: 1.25rem;
	font-size: 10px;
}
@media (min-width: 640px) {
	.shortcuts-title {
		font-size: 11px;
	}
}

.shortcuts-list {
	display: flex;
	align-items: center;
	gap: 1.5rem;
	padding: 0.5rem 0;
}

.shortcut-item {
	display: flex;
	align-items: center;
	gap: 0.5rem;
}

/* Premium 3D keyboard keys */
.shortcut-key {
	font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
	font-size: 10px;
	font-weight: 800;
	padding: 0.2rem 0.45rem;
	border-radius: 4px;
	background: linear-gradient(to bottom, #1e293b, #0f172a);
	color: #f8fafc; /* Slate 50 */
	border: 1px solid #334155; /* Slate 700 */
	border-bottom: 3px solid #020617; /* Darker bottom border for 3D depth */
	box-shadow: 
		inset 0 1px 0 rgba(255, 255, 255, 0.15),
		0 2px 4px rgba(0, 0, 0, 0.4);
	text-shadow: 0 -1px 0 rgba(0, 0, 0, 0.5);
	line-height: 1;
	display: inline-block;
}
@media (min-width: 640px) {
	.shortcut-key {
		font-size: 11px;
	}
}

/* Joiner character like plus (+) or slash (/) */
.shortcut-join {
	color: #64748b; /* Slate 500 */
	font-weight: 700;
	font-family: monospace;
	font-size: 11px;
}

/* Action Label description */
.shortcut-label {
	color: #e2e8f0; /* Slate 200 */
	font-weight: 500;
	letter-spacing: 0.025em;
	font-size: 10px;
	margin-left: 0.25rem;
}
@media (min-width: 640px) {
	.shortcut-label {
		font-size: 11px;
	}
}
</style>
