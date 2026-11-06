> **Outdated.** This describes an early state of the project. For the current assessment and plan, see [docs/offline-multiplatform](../docs/offline-multiplatform/README.md).

# Offline Implementation Status - POS Next

## Current Status: ⚠️ INCOMPLETE - POS Cannot Work Without Backend

### Problem Summary
The POS application currently **does not work when the backend is offline** because:
1. No data is pre-loaded when online
2. Components try to fetch data on-demand using `createResource`
3. When backend is down, `createResource` fails and returns no data
4. Users cannot browse items, select customers, or create invoices

---

## Offline Implementation Comparison

### ✅ Full Offline Capability Reference

**How Offline POS Systems Work:**
1. **Pre-Loading Phase (While Online):**
   - Loads ALL items into IndexedDB
   - Loads ALL customers into IndexedDB
   - Caches price lists, stock levels, tax templates
   - Sets `cache_ready` flag when complete

2. **Offline Operation:**
   - Reads from IndexedDB/memory cache
   - Never tries to contact server
   - Queues invoices in IndexedDB
   - Can create invoices, search items, select customers

3. **Sync Phase (When Back Online):**
   - Sends queued invoices to server
   - Updates local cache with fresh data
   - Clears synced items from queue

### ❌ POS Next - Currently NOT Offline Capable

**Current Implementation:**
1. **No Pre-Loading:**
   - Items are fetched on-demand via `createResource`
   - Customers are fetched on-demand via `createResource`
   - No data cached before going offline

2. **Fails When Offline:**
   - `createResource` returns empty data
   - Item search shows no results
   - Customer selection shows no results
   - Cannot create invoices

3. **Has Offline Infrastructure:**
   - IndexedDB schema exists
   - Queue system exists
   - Sync mechanism exists
   - **BUT**: No data to work with!

---

## Missing Features

### 1. Data Pre-Loading System ⚠️ CRITICAL

**Status:** ❌ Not Implemented

**What's Needed:**
```javascript
// When POS opens (while online):
await cacheItemsFromServer(posProfile)    // Load all items
await cacheCustomersFromServer(posProfile) // Load all customers
await setSetting('cache_ready', true)      // Mark as ready
```

**Files Affected:**
- `/src/pages/POSSale.vue` - Need to trigger pre-loading on mount
- `/src/pages/Home.vue` - Could pre-load when selecting POS Profile
- `/src/utils/offline/cache.js` - ✅ Created with pre-loading functions

### 2. Cache-First Data Loading ⚠️ CRITICAL

**Status:** ❌ Not Implemented

**Current Code (BROKEN):**
```javascript
// In POSSale.vue - tries to fetch from server every time
const itemsResource = createResource({
	url: 'pos_next.api.invoices.get_items',
	// This FAILS when offline!
})
```

**What's Needed:**
```javascript
// Should check cache first, server second
async function loadItems() {
	// If offline or cache exists, use cache
	if (isOffline() || isCacheReady()) {
		return await searchCachedItems()
	}

	// If online and cache stale, fetch from server
	if (needsCacheRefresh()) {
		await cacheItemsFromServer(posProfile)
	}

	return await searchCachedItems()
}
```

**Files Affected:**
- `/src/composables/useItems.js` - ❌ Doesn't exist, needs to be created
- `/src/components/sale/ItemGrid.vue` - If exists, needs updating
- Any component that loads items

### 3. Offline-Aware Components ⚠️ CRITICAL

**Status:** ❌ Not Implemented

**Current Components:**
- `InvoiceHistoryDialog.vue` - Uses `createResource` (fails offline)
- `CustomerDialog.vue` - Uses `createResource` (fails offline)
- `BatchSerialDialog.vue` - Uses `createResource` (fails offline)

**What's Needed:**
Each component should:
1. Check if offline: `isOffline()`
2. Check if cache ready: `isCacheReady()`
3. Load from cache when offline
4. Show warning if cache not ready

### 4. Cache Initialization on Startup ⚠️ CRITICAL

**Status:** ❌ Not Implemented

**What's Needed:**
```javascript
// In App.vue or main.js
import { initMemoryCache, isCacheReady } from '@/utils/offline'

onMounted(async () => {
	await initMemoryCache()

	if (!isCacheReady()) {
		// Show warning: "POS needs to sync data for offline use"
		// Trigger sync if online
	}
})
```

### 5. Manual Offline Mode Toggle

**Status:** ⚠️ Partially Implemented

**What Exists:**
- `isManualOffline()` function exists in cache.js
- `setManualOffline()` function exists
- `toggleManualOffline()` function exists

**What's Missing:**
- UI toggle button in navbar
- Visual indicator when in manual offline mode
- Documentation on how to use it

### 6. Cache Refresh Strategy

**Status:** ⚠️ Partially Implemented

**What Exists:**
- `needsCacheRefresh()` checks if cache is >24 hours old
- `cacheItemsFromServer()` can refresh items
- `cacheCustomersFromServer()` can refresh customers

**What's Missing:**
- Automatic background refresh when online
- User-triggered "Sync Now" button
- Progress indicator during sync
- Notification when sync completes

---

## Implementation Plan

### Phase 1: Make POS Work Offline (URGENT)

**Priority:** 🔴 CRITICAL - Must be done ASAP

**Tasks:**
1. ✅ Create `/src/utils/offline/cache.js` with pre-loading functions
2. ⚠️ Update `POSSale.vue` to pre-load data on mount (if online)
3. ⚠️ Create `useItems` composable that loads from cache
4. ⚠️ Update item selection to use cached items
5. ⚠️ Update customer selection to use cached customers
6. ⚠️ Add cache readiness check and warning

**Expected Result:**
- POS can work when backend is offline
- Users can browse cached items
- Users can select cached customers
- Users can create invoices (queued for sync)

### Phase 2: Improve User Experience

**Priority:** 🟡 MEDIUM

**Tasks:**
1. Add "Sync Now" button
2. Show sync progress
3. Add manual offline toggle
4. Show cache statistics
5. Add cache clear option

### Phase 3: Advanced Features

**Priority:** 🟢 LOW

**Tasks:**
1. Implement incremental sync
2. Add conflict resolution
3. Implement partial sync
4. Add data compression

---

## Quick Fix Instructions

### For Developer: Make POS Work Offline NOW

**Step 1: Pre-load data when POS opens**

Edit `/src/pages/POSSale.vue`:
```javascript
import {
	cacheItemsFromServer,
	cacheCustomersFromServer,
	isCacheReady
} from '@/utils/offline'

onMounted(async () => {
	// ... existing code ...

	// Pre-load data if online and cache not ready
	if (!isOffline.value && !isCacheReady()) {
		console.log('Pre-loading data for offline use...')
		await cacheItemsFromServer(posProfile.value)
		await cacheCustomersFromServer(posProfile.value)
		console.log('Data pre-loaded successfully')
	}
})
```

**Step 2: Use cached items instead of API**

Create `/src/composables/useItems.js`:
```javascript
import { ref, computed } from 'vue'
import {
	searchCachedItems,
	isOffline,
	isCacheReady
} from '@/utils/offline'

export function useItems(posProfile) {
	const items = ref([])
	const loading = ref(false)
	const searchTerm = ref('')

	async function loadItems() {
		loading.value = true
		try {
			// Always try cache first
			items.value = await searchCachedItems(searchTerm.value)
		} catch (error) {
			console.error('Error loading items:', error)
			items.value = []
		} finally {
			loading.value = false
		}
	}

	return {
		items,
		loading,
		searchTerm,
		loadItems
	}
}
```

**Step 3: Update components to use cached data**

Wherever you see:
```javascript
const itemsResource = createResource({
	url: 'pos_next.api.invoices.get_items',
	// ...
})
```

Replace with:
```javascript
const { items, loading, loadItems } = useItems(posProfile)
```

---

## Testing Offline Mode

### Method 1: Stop Backend
```bash
cd /home/ubuntu/frappe-bench
bench stop
```

### Method 2: Use Manual Offline Toggle
```javascript
import { setManualOffline } from '@/utils/offline'
setManualOffline(true) // Force offline mode
```

### Method 3: Browser DevTools
1. Open Chrome DevTools
2. Go to Network tab
3. Select "Offline" from throttling dropdown

---

## Files Reference

### New Files Created
- ✅ `/src/utils/offline/cache.js` - Cache management system

### Files That Need Updates
- ⚠️ `/src/pages/POSSale.vue` - Add data pre-loading
- ⚠️ `/src/composables/useItems.js` - CREATE THIS - Item cache composable
- ⚠️ `/src/composables/useCustomers.js` - CREATE THIS - Customer cache composable
- ⚠️ All components using `createResource` for items/customers

### Files Already OK
- ✅ `/src/utils/offline/db.js` - IndexedDB schema
- ✅ `/src/utils/offline/sync.js` - Sync mechanism
- ✅ `/src/utils/offline/index.js` - Exports

---

## Success Criteria

### ✅ POS is Fully Offline When:
1. User can open POS without internet
2. User can browse items from cache
3. User can search items by name/code
4. User can select customers from cache
5. User can create invoices
6. Invoices are queued locally
7. Invoices sync when back online
8. User sees clear indication of offline mode

### ❌ Current State:
- [ ] Can open POS without internet → NO (blank page)
- [ ] Can browse items → NO (empty list)
- [ ] Can search items → NO (no results)
- [ ] Can select customers → NO (empty list)
- [ ] Can create invoices → NO (cannot proceed)
- [x] Invoices queued → YES (if you could create them)
- [x] Invoices sync → YES (mechanism works)
- [ ] Offline indicator → PARTIAL (exists but not useful without data)

---

**Last Updated:** 2025-10-01
**Status:** 🔴 NEEDS IMMEDIATE ATTENTION
