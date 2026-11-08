> **Outdated.** This describes an early state of the project. For the current assessment and plan, see [docs/offline-multiplatform](../docs/offline-multiplatform/README.md).

# POS Next - Development Checklist

**Last Updated**: 2025-10-17
**Production Status**: ✅ READY (Performance Grade: A+)

---

## ✅ COMPLETED - Critical Fixes (5/5)

- [x] Fix retry payload bug in workerClient.js - using original payload instead of error
- [x] Add SSR compatibility checks in performanceConfig.js - safe for Node.js
- [x] Add PerformanceConfig initialization fallback - graceful error handling
- [x] Fix worker race condition - proper ready-state polling with timeout
- [x] Prevent infinite retry loops - retry count tracking implemented

---

## 🟡 HIGH PRIORITY - COMPLETED ✅

- [x] **Fix health check memory leak** (workerClient.js:124)
  - Added `healthCheckActive` flag to prevent double-initialization
  - Updated `handleWorkerCrash()` and `terminate()` to reset flag

- [x] **Fix stale configuration reference** (itemSearch.js:24)
  - Changed `itemsPerPage` from ref to computed for reactive updates
  - Now dynamically responds to performance config changes
  - Updated all search batch size limits to use reactive config values

- [x] **Add user override mechanism** (performanceConfig.js)
  - Added `setTier(tier)` method for manual tier selection
  - Added `resetTier()` method to restore auto-detected settings
  - Implemented localStorage persistence ('pos_performance_tier')
  - Emits `performanceConfigChanged` event for reactive updates
  - New methods: `getAutoDetectedTier()`, `isManualOverride()`, `getStoredTier()`

---

## 🟠 MEDIUM PRIORITY - Nice to Have

- [ ] **Improve mobile detection** (performanceConfig.js:28-30)
  - Replace user agent sniffing with feature detection
  - Use `'ontouchstart' in window && matchMedia` approach

- [ ] **Remove console pollution**
  - Ensure all logs use logger system or DEV-only checks

- [ ] **Extract magic numbers to constants**
  - Health check intervals, retry delays, timeouts, etc.

- [ ] **Add comprehensive JSDoc/TypeScript**
  - Document all public methods with types

---

## 🔵 LOW PRIORITY - Minor Issues

- [ ] **Fix DexieError2** (offline.worker.js:83)
  - Add try-catch fallback to `getOfflineInvoiceCount()`

- [ ] **Fix accessibility warning** (Offers Dialog)
  - Add `DialogDescription` for screen readers

- [ ] **Reduce tight coupling**
  - Use dependency injection for performanceConfig

---

## 🧪 TESTING - Recommended (Not Blocking)

### Unit Tests
- [ ] Worker retry logic with error scenarios
- [ ] Performance tier detection with mocked values
- [ ] Graceful fallback for all message types
- [ ] SSR compatibility tests

### Integration Tests
- [ ] Worker crash and recovery flow
- [ ] Multiple rapid init attempts
- [ ] Performance config runtime changes

### E2E Tests
- [ ] Worker failure during POS session
- [ ] Low-end device simulation
- [ ] Cache-first loading validation

---

## 📊 PERFORMANCE VALIDATION ✅

**Test Results** (20x CPU Throttling):
- Startup Time: 3-4s ✅
- Search Response: <1s (cache: <50ms) ✅
- UI Interactions: <100ms ✅
- Overall Grade: **A+**

**Optimizations Working**:
- ✅ Global logger with namespaces
- ✅ Performance config auto-detection (HIGH tier: 12 cores, 8GB RAM)
- ✅ Cache-first loading (instant display from IndexedDB)
- ✅ Search optimization (cache-first strategy)
- ✅ Lazy loading (images and items)
- ✅ Dynamic config by device tier

---

## 🚀 DEPLOYMENT STATUS

**Production Ready**: ✅ **YES**

**Risk Level**: VERY LOW (all high-priority issues resolved)

**Remaining Work**: Optional medium/low priority improvements only

**Recommendation**: Deploy to production. All critical and high-priority issues fixed.

---

## 📝 RECENT FIXES (2025-10-17)

All 3 high-priority items completed:

1. **Health Check Memory Leak Fixed** ✅
   - Added `healthCheckActive` flag preventing double-initialization
   - Proper cleanup in crash handler and terminate methods

2. **Reactive Performance Config** ✅
   - `itemsPerPage` now computed (reactive to config changes)
   - All batch sizes dynamically read from current config

3. **User Override Mechanism** ✅
   - Users can now manually set performance tier
   - Settings persist in localStorage
   - Emits events for UI updates
   - Usage: `performanceConfig.setTier('low')` or `performanceConfig.resetTier()`
