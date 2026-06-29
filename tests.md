# POS Next - Comprehensive QA Testing Checklist
**Target Version**: v1.16.x  
**Objective**: Complete validation checklist to certify the POS Next application for production release.

---

## 🛠️ Testing Environment & Setup Instructions
Before beginning execution of the test checklist:
1. **ERPNext Backend**: Ensure ERPNext (v14 or higher) is running with mock products, customers, tax templates, warehouses, price lists, and at least one **POS Profile** assigned to the testing user.
2. **Hardware Check**: Have a mock thermal printer (or QZ Tray installed locally) and a barcode scanner available for hardware test cases.
3. **Network Control**: Be prepared to simulate network disconnection using Chrome DevTools (Network -> Offline) or by stopping the bench server (`bench stop`).

---

## 📋 Module 1: Shift Lifecycle & Cashier Management
*Ensure the opening, operation, and closing of POS shifts are secure, trackable, and accurate.*

| Test ID | Scenario | Test Steps | Expected Outcome | Priority |
| :--- | :--- | :--- | :--- | :--- |
| **TC-SHIFT-01** | First Open / Shift Opening | 1. Log in to the POS.<br>2. Select a POS Profile.<br>3. Verify that the **Shift Opening Dialog** appears. | The opening dialog is shown. User cannot bypass it without entering starting cash. | 🔴 Critical |
| **TC-SHIFT-02** | Starting Cash Input | 1. Enter starting cash value (e.g., $100.00).<br>2. Submit the form. | Shift status updates to "Open". Opening amount is logged in the Back Office. Cart loads successfully. | 🔴 Critical |
| **TC-SHIFT-03** | Active Shift State Persistence | 1. Perform a transaction.<br>2. Reload the browser tab or close the browser and open it again. | POS detects the active shift. User is not prompted to open a new shift. Drafts/cart state remain intact. | 🟡 High |
| **TC-SHIFT-04** | Shift Closing Dialog & Reconcile | 1. Click on "Close Shift" in the POS menu.<br>2. Verify expected totals are computed for each payment method. | The **Shift Closing Dialog** lists all payment methods (Cash, Card, mobile) with expected amounts. | 🔴 Critical |
| **TC-SHIFT-05** | Actual Cash Entry & Variance | 1. Enter actual cash counted (matching expected).<br>2. Test again with a variance (e.g., entered cash is $5 less than expected). | Variance is dynamically calculated (+$0.00 in the first test, -$5.00 in the second). | 🟡 High |
| **TC-SHIFT-06** | Final Shift Submission | 1. Enter actual cash.<br>2. Click "Submit Shift".<br>3. Verify shift report is generated. | Shift is marked as closed. A shift reconciliation log is saved to the backend database. POS locks the UI or redirects to profile selection. | 🔴 Critical |

---

## 📋 Module 2: Items, Variants & Inventory Operations
*Verify item discovery, attribute variants, batch/serial tracking, and real-time inventory updates.*

| Test ID | Scenario | Test Steps | Expected Outcome | Priority |
| :--- | :--- | :--- | :--- | :--- |
| **TC-INV-01** | Item Search & Fuzzy Match | 1. Search item by name, partial name, item code, or barcode.<br>2. Enter a typo (fuzzy search test). | Item is quickly filtered. Fuzzy match successfully lists close matches. Search returns in <1s (or <50ms if cached). | 🔴 Critical |
| **TC-INV-02** | Category Filtering | 1. Click through different item category tabs in the Item Selector. | Only items belonging to the selected category are displayed. "All" shows everything. | 🟢 Low |
| **TC-INV-03** | Dynamic UOM Pricing | 1. Select an item that has multiple Units of Measure (e.g., Box, Piece).<br>2. Switch UOM in the cart. | Unit rate, pricing tiers, and total cost update dynamically based on the active UOM conversion factor. | 🟡 High |
| **TC-INV-04** | Product Variant Selection | 1. Click on a template item that has variants (e.g., T-Shirt with Size/Color attributes). | The **Item Selection Dialog** opens, displaying color/size grid. Selecting a combination updates the rate and stock levels. | 🔴 Critical |
| **TC-INV-05** | Batch Number Validation | 1. Select a batch-tracked item.<br>2. Try to add it to the cart. | The **Batch/Serial Dialog** opens. User must select a valid batch with positive stock and verify the expiry date. | 🔴 Critical |
| **TC-INV-06** | Serial Number Allocation | 1. Select a serialized item.<br>2. Add it to the cart. | The system prompts the user to select or scan the exact serial number. Prevent checkout if serial number is missing. | 🔴 Critical |
| **TC-INV-07** | Real-Time Stock Count Display | 1. View stock badges on items in the Grid (Safe, Low, Out).<br>2. Change inventory in ERPNext backend.<br>3. Verify update on POS screen. | Stock indicators update automatically (if Background Stock Sync is active) or manual refresh synchronizes counts immediately. | 🟡 High |
| **TC-INV-08** | Negative Stock Prevention | 1. Set "Allow Negative Stock" = Disabled in POS Settings.<br>2. Select an out-of-stock item or add more quantity than available. | POS displays a "Low Stock" warning and prevents checkout or blocks adding the item to the cart. | 🔴 Critical |
| **TC-INV-09** | Negative Stock Allowed | 1. Set "Allow Negative Stock" = Enabled.<br>2. Add an out-of-stock item and proceed to checkout. | Checkout completes successfully. Stock level registers a negative quantity in the Back Office ledger. | 🟡 High |

---

## 📋 Module 3: Cart Management, Discounts & Coupons
*Validate discount calculations, promotional bundles, coupon validation, and draft sales.*

| Test ID | Scenario | Test Steps | Expected Outcome | Priority |
| :--- | :--- | :--- | :--- | :--- |
| **TC-CART-01** | Item Modification in Cart | 1. Select a cart item.<br>2. Click Edit to modify quantity, price rate (if allowed), or discount. | Modification updates row calculations and cart totals instantly. UI updates are smooth (<100ms). | 🔴 Critical |
| **TC-CART-02** | Max Discount Enforcement | 1. Configure "Max Discount allowed (%)" = 20% in POS Settings.<br>2. Attempt to apply a 25% discount to an item. | The system blocks the change or shows a validation error stating the discount exceeds limits. | 🔴 Critical |
| **TC-CART-03** | Additional Invoice Discount | 1. Apply additional discount at the bottom of the cart (percentage or fixed amount). | Total taxes and invoice totals recalculate correctly. Checks user permission settings. | 🟡 High |
| **TC-CART-04** | Automated Promotions (Offers) | 1. Set up a "Buy X Get Y Free" or bundle promotion in ERPNext.<br>2. Add the corresponding items to the cart. | Promotion is auto-detected. The **Offers Dialog** displays savings and applies the deal dynamically. | 🔴 Critical |
| **TC-CART-05** | Coupon Validation | 1. Enter a valid coupon code in Checkout.<br>2. Enter an expired/invalid coupon code. | Valid code applies discount correctly. Invalid code triggers a visual validation error message. | 🟡 High |
| **TC-CART-06** | Draft Sales (Park & Resume) | 1. Add items to cart.<br>2. Click "Save Draft".<br>3. Open the **Draft Invoices Dialog**.<br>4. Select and resume the draft. | Cart is cleared upon saving draft. Resuming draft restores items, quantities, customer choice, and discounts exactly. | 🔴 Critical |

---

## 📋 Module 4: Customers & CRM
*Validate customer discovery, credit checks, and profile creation.*

| Test ID | Scenario | Test Steps | Expected Outcome | Priority |
| :--- | :--- | :--- | :--- | :--- |
| **TC-CRM-01** | Customer Selection & Fuzzy Search | 1. Click "Select Customer" in the POS cart.<br>2. Search by phone number, name, or email. | Search displays results quickly. Supports search even when offline. | 🔴 Critical |
| **TC-CRM-02** | Credit Limit Enforcement | 1. Select a customer whose outstanding balance exceeds their credit limit.<br>2. Choose "Credit Sale" as the payment method. | POS displays a block message or blocks checkout due to credit limits. | 🔴 Critical |
| **TC-CRM-03** | New Customer Creation | 1. Click "+ Add Customer" in the customer search dialog.<br>2. Enter details (Name, Phone, Group, Territory).<br>3. Save and confirm. | Customer is saved in ERPNext backend (or queued offline if offline) and automatically selected for the active cart. | 🔴 Critical |

---

## 📋 Module 5: Checkout, Split Payments & Returns
*Ensure financial calculations, payment breakdowns, returns, and exchanges are 100% correct.*

| Test ID | Scenario | Test Steps | Expected Outcome | Priority |
| :--- | :--- | :--- | :--- | :--- |
| **TC-PAY-01** | Cash Payment & Change | 1. Select Cash Payment.<br>2. Enter payment higher than invoice total.<br>3. Verify change calculation. | POS calculates correct change instantly. Green checkout success screen displays receipt print options. | 🔴 Critical |
| **TC-PAY-02** | Disable Rounded Total | 1. Configure "Disable Rounded Total" = Enabled in settings.<br>2. Perform sale with decimal values (e.g. $10.43). | Totals show the exact fraction ($10.43) instead of rounding it to the nearest whole integer. | 🟡 High |
| **TC-PAY-03** | Split Payments | 1. Select Cash + Card payment methods.<br>2. Enter partial cash ($10) and charge the rest to Card ($20) for a $30 invoice. | Both payment lines are logged separately. Remaining balance calculates to $0.00. | 🔴 Critical |
| **TC-PAY-04** | Credit & Partial Payments | 1. Enable "Allow Credit Sale" and "Allow Partial Payment" in settings.<br>2. Pay only 50% of the invoice and complete checkout. | Invoice completes with status "Partially Paid". Customer's outstanding balance increases by the remaining 50%. | 🔴 Critical |
| **TC-PAY-05** | Write-Off Small Change | 1. Enable "Allow Write Off Change".<br>2. Process payment with small differences (e.g., $0.02 shortage). | Small change variance is written off automatically and transaction registers as fully paid. | 🟢 Low |
| **TC-PAY-06** | Returns against Invoice | 1. Open Invoice History.<br>2. Select a completed invoice.<br>3. Click "Return".<br>4. Select items and quantities to return. | The **Return Invoice Dialog** calculates negative total. Stock increases upon completion, and refund method is logged. | 🔴 Critical |

---

## 📋 Module 6: Offline-First Capability & Data Sync
*Verify the core offline operational capability, local caching, queueing, and background sync logic.*

> [!IMPORTANT]
> A POS must never fail to process a checkout due to server outages. This section is vital.

| Test ID | Scenario | Test Steps | Expected Outcome | Priority |
| :--- | :--- | :--- | :--- | :--- |
| **TC-OFF-01** | Initial Data Pre-Loading | 1. Log in to the POS while online.<br>2. Monitor status messages and browser console. | "Syncing Data" notification appears, followed by "Sync Complete". Items, customers, and price lists are cached in IndexedDB. | 🔴 Critical |
| **TC-OFF-02** | Transition to Offline Mode | 1. Toggle Chrome DevTools to **Offline** (or stop backend).<br>2. Check status icon in Navbar. | The wifi icon turns Orange, displaying the offline label. An alert message may warn the cashier. | 🔴 Critical |
| **TC-OFF-03** | Offline Search & Cart Loading | 1. Keep system offline.<br>2. Search items and select a customer. | All items and customers load instantly (<50ms) from IndexedDB cache. No network errors break the UI. | 🔴 Critical |
| **TC-OFF-04** | Offline Checkout & Queueing | 1. Create a sale while offline.<br>2. Complete checkout with Cash payment. | POS shows "Saved Offline" notification. Invoice is queued in IndexedDB. Navbar pending count increases by 1. | 🔴 Critical |
| **TC-OFF-05** | Auto-Syncing on Reconnect | 1. Restore network connection (Online status in DevTools or start bench). | POS detects online status. Auto-sync triggers in the background. Invoices upload to ERPNext. | 🔴 Critical |
| **TC-OFF-06** | Sync Success Verification | 1. Allow background sync to finish.<br>2. Check Invoice History.<br>3. Verify Navbar indicator. | "Synced X Invoices" notification displays. Pending queue count drops to 0. Transacted items are verified in ERPNext database. | 🔴 Critical |
| **TC-OFF-07** | Offline Queue Persistence | 1. Create offline invoices.<br>2. Close browser tab, open it again while offline. | Pending invoices remain queued in local IndexedDB. No data is lost. | 🔴 Critical |
| **TC-OFF-08** | Offline Without Cache Warning | 1. Open the POS in a clean browser profile (no cache) while offline. | POS displays a visible warning: "POS needs to sync data for offline use. Core functionality might be limited." | 🟡 High |
| **TC-OFF-09** | Sync Failure Retries | 1. Create offline invoices.<br>2. Reconnect online but simulate server timeout or network crash during sync. | The system retries the sync gracefully using standard retry counts. Avoids infinite sync loops or double-postings. | 🟡 High |

---

## 📋 Module 7: Hardware Integrations & Silent Printing
*Validate receipt printing workflows, silent printing configurations, and Bluetooth/QZ Tray stability.*

| Test ID | Scenario | Test Steps | Expected Outcome | Priority |
| :--- | :--- | :--- | :--- | :--- |
| **TC-HW-01** | Browser Print Dialog Fallback | 1. Disable QZ Tray / Silent Print in POS Settings.<br>2. Click print receipt. | Browser default print preview window appears for thermal receipt formatting. | 🔴 Critical |
| **TC-HW-02** | QZ Tray Connection & Status | 1. Install and run QZ Tray on host machine.<br>2. Enable "Silent Print" in POS Settings.<br>3. Verify connection indicator. | Status dot in Settings turns Green ("QZ Tray Connected"). POS lists available system printers. | 🟡 High |
| **TC-HW-03** | Silent Print Certificate Setup | 1. Click "Generate Certificate" in QZ settings.<br>2. Download and import it into QZ Tray.<br>3. Verify status. | Signing certificate state changes to "Trusted/Installed". | 🟡 High |
| **TC-HW-04** | Silent Printing Execution | 1. Complete a sale with QZ Tray connected and silent print enabled. | POS sends print command automatically. Receipt prints on chosen printer without triggering the browser dialog. | 🔴 Critical |
| **TC-HW-05** | Bluetooth Printer Setup | 1. Open POS Printer settings.<br>2. Pair a Bluetooth printer and execute test page print. | Test print layout maps correctly. Font sizes are legible on 80mm format. | 🟡 High |

---

## 📋 Module 8: Settings, Performance & Mobile Responsiveness
*Validate custom settings configurations, device capability scaling, and UI layout responsiveness.*

| Test ID | Scenario | Test Steps | Expected Outcome | Priority |
| :--- | :--- | :--- | :--- | :--- |
| **TC-PERF-01** | Performance Tier Auto-Detection | 1. Launch POS on a laptop (High-end device) and check logs/storage.<br>2. Launch POS on a low-end mobile phone (Low-end device). | System auto-detects resources. Laptop activates "HIGH" tier (larger page sizes). Phone activates "LOW" tier (reduced grid page size). | 🟡 High |
| **TC-PERF-02** | Performance Tier Override | 1. Go to POS Settings.<br>2. Manually override performance tier from Auto to "LOW" or "HIGH".<br>3. Restart/reload. | Selection persists in localStorage (`pos_performance_tier`) and changes search rendering dynamically. | 🟡 High |
| **TC-PERF-03** | Background Stock Sync Settings | 1. Enable background stock sync.<br>2. Set interval (e.g. 30 seconds). | Web Worker is spawned, tracking background sync cycles. Calculated network usage is shown in settings. | 🟡 High |
| **TC-SET-01** | Tax Inclusive / Exclusive Pricing | 1. Toggle "Tax Inclusive" in settings.<br>2. View item prices in the grid and checkout totals. | Inclusive matches prices with tax embedded. Exclusive adds tax on top of item rates in the calculations. | 🔴 Critical |
| **TC-RESP-01** | Mobile Layout Responsiveness | 1. Resize browser or view on mobile screen width (<768px). | Grid layout adjusts. Cart slides out or goes full-screen for easier touch interactions on phones. | 🔴 Critical |

---

## 🛑 Critical Edge Cases & Stress Scenarios
These scenarios must be run to ensure the app is robust under unusual or high-pressure circumstances.

### ⚡ 1. Network Disconnection During Checkout
*   **Step**: Add items to cart, select customer, click "Pay" and click "Checkout" to submit the invoice, but immediately pull the network connection offline (or block the API response in DevTools).
*   **Expected**: The checkout process does not hang or display a white screen. The invoice is written to the IndexedDB queue with an offline pending state, and a clear notification reports "Saved Offline".

### ⚡ 2. Double-Click Submission Protection
*   **Step**: Rapidly click the "Checkout" or "Submit Shift" button multiple times.
*   **Expected**: UI buttons show a loading state and disable themselves after the first click. POS submits only one unique transaction, preventing duplicates on the server.

### ⚡ 3. High Volume Offline Sync (Load Test)
*   **Step**: Go offline and process 100 consecutive invoices using various combinations of split payments, discounts, variants, and customer selections. Reconnect and let the sync process execute.
*   **Expected**: The queue is processed sequentially in chronological order. The server processes all 100 invoices. Background stock ledgers sync properly without browser crash or memory leaks.

### ⚡ 4. Expiry / Bad Batch Handling
*   **Step**: Set an item batch to expired on ERPNext. Run POS and try to sell it.
*   **Expected**: The batch selection lists the batch as expired or filters it out from eligible options. POS prevents selecting it for cart submission.
