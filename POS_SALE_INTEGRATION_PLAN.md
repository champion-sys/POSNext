> **Outdated.** This describes an early state of the project. For the current assessment and plan, see [docs/offline-multiplatform](docs/offline-multiplatform/README.md).

# POS Sale Integration Plan - POS Next

## Overview
This document outlines the strategy for integrating the POS sale functionality into POS Next, following Frappe UI design patterns and maintaining consistency with the existing login/shift management implementation.

## Current State Analysis

### Reference POS Architecture
**Components Structure:**
- `Pos.vue` - Main POS container with dialogs
- `ItemsSelector.vue` - Item selection grid/list (175KB - complex)
- `Invoice.vue` - Shopping cart and invoice display (50KB)
- `ItemsTable.vue` - Cart items table (87KB - complex)
- `Payments.vue` - Payment processing (71KB)
- `Customer.vue` - Customer selection
- Additional: Drafts, Returns, SalesOrders, Offers, Coupons

**Key Features:**
1. Two-column layout: Items selector (left) | Invoice cart (right)
2. Offline-first architecture with IndexedDB
3. Real-time calculations with offers/discounts
4. Barcode scanning support
5. Multiple payment methods
6. Draft invoice management
7. Customer selection and management

### POS Next Current State
**Existing:**
- ✅ Login page with Frappe UI components
- ✅ Shift management (opening/closing)
- ✅ Backend API for shifts (`pos_next/api/shifts.py`)
- ✅ Composables pattern (`useShift.js`)
- ✅ Frappe UI theme integration

**Missing:**
- ❌ POS sale page
- ❌ Invoice management backend
- ❌ Item selection backend
- ❌ Payment processing backend
- ❌ Invoice composables
- ❌ Sale UI components
- ❌ Add print functionality for invoices
- ❌ Implement draft invoice management
- ❌ Add returns/refunds support
- ❌ Implement offline support with IndexedDB
- ❌ Add offers/coupons integration
- ❌ Implement batch/serial number selection
- ❌ Add invoice history and reprinting

## Integration Strategy

### Phase 1: Backend API Setup (Day 1)

#### 1.1 Create Invoice API Module
**File:** `pos_next/api/invoices.py`

```python
# API Endpoints needed:
@frappe.whitelist()
def get_items(pos_profile, search_term=None, item_group=None, start=0, limit=20):
    """Get items for POS with stock, price, and tax details"""
    # Return: items with barcode, price, stock, image, tax template
    pass

@frappe.whitelist()
def get_item_details(item_code, pos_profile, customer=None, qty=1):
    """Get detailed item info including price, tax, stock"""
    # Implement item details logic
    pass

@frappe.whitelist()
def create_draft_invoice(invoice_data):
    """Save invoice draft to IndexedDB queue"""
    # Return: draft_id
    pass

@frappe.whitelist()
def submit_invoice(invoice_data):
    """Create and submit POS Invoice or Sales Invoice"""
    # Implement invoice submission logic
    pass

@frappe.whitelist()
def get_customers(pos_profile, search_term=None, start=0, limit=20):
    """Get customers for autocomplete"""
    pass

@frappe.whitelist()
def get_payment_methods(pos_profile):
    """Get available payment methods from POS Profile"""
    pass

@frappe.whitelist()
def apply_offers(invoice_data):
    """Calculate and apply promotional offers"""
    # Implement promotional offer logic
    pass
```

#### 1.2 Create Items API Module
**File:** `pos_next/api/items.py`

```python
@frappe.whitelist()
def search_by_barcode(barcode, pos_profile):
    """Search item by barcode"""
    pass

@frappe.whitelist()
def get_item_stock(item_code, warehouse):
    """Get real-time stock for item"""
    pass

@frappe.whitelist()
def get_batch_serial_details(item_code, warehouse):
    """Get batch/serial number details"""
    pass
```

### Phase 2: Frontend Composables (Day 2)

#### 2.1 Create Invoice Composable
**File:** `POS/src/composables/useInvoice.js`

```javascript
import { ref, computed } from 'vue'
import { createResource } from 'frappe-ui'

export function useInvoice() {
  // State
  const invoiceItems = ref([])
  const customer = ref(null)
  const payments = ref([])
  const posProfile = ref(null)

  // Resources
  const submitInvoiceResource = createResource({
    url: 'pos_next.api.invoices.submit_invoice',
    auto: false,
  })

  const applyOffersResource = createResource({
    url: 'pos_next.api.invoices.apply_offers',
    auto: false,
  })

  // Computed
  const subtotal = computed(() => {
    return invoiceItems.value.reduce((sum, item) => {
      return sum + (item.quantity * item.rate)
    }, 0)
  })

  const totalTax = computed(() => {
    return invoiceItems.value.reduce((sum, item) => {
      return sum + (item.tax_amount || 0)
    }, 0)
  })

  const totalDiscount = computed(() => {
    return invoiceItems.value.reduce((sum, item) => {
      return sum + (item.discount_amount || 0)
    }, 0)
  })

  const grandTotal = computed(() => {
    return subtotal.value + totalTax.value - totalDiscount.value
  })

  const totalPaid = computed(() => {
    return payments.value.reduce((sum, p) => sum + p.amount, 0)
  })

  const remainingAmount = computed(() => {
    return grandTotal.value - totalPaid.value
  })

  const canSubmit = computed(() => {
    return invoiceItems.value.length > 0 && remainingAmount.value <= 0
  })

  // Actions
  function addItem(item, quantity = 1) {
    const existingItem = invoiceItems.value.find(i => i.item_code === item.item_code)

    if (existingItem) {
      existingItem.quantity += quantity
      recalculateItem(existingItem)
    } else {
      invoiceItems.value.push({
        ...item,
        quantity,
        discount_amount: 0,
      })
    }
  }

  function removeItem(itemCode) {
    invoiceItems.value = invoiceItems.value.filter(i => i.item_code !== itemCode)
  }

  function updateItemQuantity(itemCode, quantity) {
    const item = invoiceItems.value.find(i => i.item_code === itemCode)
    if (item) {
      item.quantity = quantity
      recalculateItem(item)
    }
  }

  function recalculateItem(item) {
    // Recalculate tax and amounts based on quantity
    item.amount = item.quantity * item.rate
    item.tax_amount = calculateTax(item)
  }

  function addPayment(payment) {
    payments.value.push(payment)
  }

  function removePayment(index) {
    payments.value.splice(index, 1)
  }

  async function submitInvoice() {
    const invoiceData = {
      items: invoiceItems.value,
      customer: customer.value,
      payments: payments.value,
      pos_profile: posProfile.value,
    }

    const result = await submitInvoiceResource.submit({ invoice_data: invoiceData })
    resetInvoice()
    return result
  }

  function resetInvoice() {
    invoiceItems.value = []
    customer.value = null
    payments.value = []
  }

  return {
    // State
    invoiceItems,
    customer,
    payments,
    posProfile,

    // Computed
    subtotal,
    totalTax,
    totalDiscount,
    grandTotal,
    totalPaid,
    remainingAmount,
    canSubmit,

    // Actions
    addItem,
    removeItem,
    updateItemQuantity,
    addPayment,
    removePayment,
    submitInvoice,
    resetInvoice,

    // Resources
    submitInvoiceResource,
    applyOffersResource,
  }
}
```

#### 2.2 Create Items Composable
**File:** `POS/src/composables/useItems.js`

```javascript
import { ref, computed } from 'vue'
import { createResource } from 'frappe-ui'

export function useItems(posProfile) {
  const items = ref([])
  const searchTerm = ref('')
  const selectedItemGroup = ref(null)

  const itemsResource = createResource({
    url: 'pos_next.api.invoices.get_items',
    params: {
      pos_profile: posProfile,
      search_term: searchTerm.value,
      item_group: selectedItemGroup.value,
    },
    auto: true,
    onSuccess(data) {
      items.value = data
    }
  })

  const searchByBarcodeResource = createResource({
    url: 'pos_next.api.items.search_by_barcode',
    auto: false,
  })

  const filteredItems = computed(() => {
    if (!searchTerm.value) return items.value

    const term = searchTerm.value.toLowerCase()
    return items.value.filter(item =>
      item.item_name.toLowerCase().includes(term) ||
      item.item_code.toLowerCase().includes(term)
    )
  })

  async function searchByBarcode(barcode) {
    const result = await searchByBarcodeResource.submit({
      barcode,
      pos_profile: posProfile
    })
    return result
  }

  function refreshItems() {
    itemsResource.reload()
  }

  return {
    items,
    filteredItems,
    searchTerm,
    selectedItemGroup,
    searchByBarcode,
    refreshItems,
    itemsResource,
  }
}
```

### Phase 3: UI Components (Day 3-4)

#### 3.1 Create POS Sale Page
**File:** `POS/src/pages/POSSale.vue`

```vue
<template>
  <div class="h-screen flex flex-col bg-gray-50">
    <!-- Header -->
    <div class="bg-white border-b border-gray-200 px-4 py-3">
      <div class="flex justify-between items-center">
        <div class="flex items-center space-x-4">
          <h1 class="text-xl font-semibold text-gray-900">POS Sale</h1>
          <div class="text-sm text-gray-600">
            {{ currentProfile?.name }}
          </div>
        </div>

        <div class="flex items-center space-x-3">
          <Button variant="subtle" @click="showDrafts = true">
            Drafts
          </Button>
          <Button variant="subtle" theme="red" @click="confirmCloseShift">
            Close Shift
          </Button>
        </div>
      </div>
    </div>

    <!-- Main Content: Two Column Layout -->
    <div class="flex-1 flex overflow-hidden">
      <!-- Left: Items Selector -->
      <div class="w-1/2 border-r border-gray-200 flex flex-col bg-white">
        <ItemsSelector
          :pos-profile="currentProfile?.name"
          @item-selected="handleItemSelected"
        />
      </div>

      <!-- Right: Invoice Cart -->
      <div class="w-1/2 flex flex-col bg-gray-50">
        <InvoiceCart
          :items="invoiceItems"
          :customer="customer"
          :subtotal="subtotal"
          :tax-amount="totalTax"
          :discount-amount="totalDiscount"
          :grand-total="grandTotal"
          @update-quantity="updateItemQuantity"
          @remove-item="removeItem"
          @select-customer="showCustomerDialog = true"
          @proceed-to-payment="showPaymentDialog = true"
        />
      </div>
    </div>

    <!-- Payment Dialog -->
    <PaymentDialog
      v-model="showPaymentDialog"
      :grand-total="grandTotal"
      :payment-methods="paymentMethods"
      @payment-completed="handlePaymentCompleted"
    />

    <!-- Customer Selection Dialog -->
    <CustomerDialog
      v-model="showCustomerDialog"
      @customer-selected="handleCustomerSelected"
    />
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import { useInvoice } from '../composables/useInvoice'
import { useShift } from '../composables/useShift'
import { Button } from 'frappe-ui'
import ItemsSelector from '../components/sale/ItemsSelector.vue'
import InvoiceCart from '../components/sale/InvoiceCart.vue'
import PaymentDialog from '../components/sale/PaymentDialog.vue'
import CustomerDialog from '../components/sale/CustomerDialog.vue'

const { currentProfile, currentShift, hasOpenShift } = useShift()
const {
  invoiceItems,
  customer,
  subtotal,
  totalTax,
  totalDiscount,
  grandTotal,
  addItem,
  removeItem,
  updateItemQuantity,
  submitInvoice,
} = useInvoice()

const showPaymentDialog = ref(false)
const showCustomerDialog = ref(false)
const showDrafts = ref(false)
const paymentMethods = ref([])

onMounted(() => {
  if (!hasOpenShift.value) {
    // Redirect to home or show open shift dialog
    router.push('/')
  }
})

function handleItemSelected(item) {
  addItem(item)
}

function handleCustomerSelected(selectedCustomer) {
  customer.value = selectedCustomer
  showCustomerDialog.value = false
}

async function handlePaymentCompleted(payments) {
  // Add payments and submit invoice
  await submitInvoice()
  showPaymentDialog.value = false
  // Show success message and print option
}

function confirmCloseShift() {
  // Show close shift dialog
}
</script>
```

#### 3.2 Create Items Selector Component
**File:** `POS/src/components/sale/ItemsSelector.vue`

```vue
<template>
  <div class="flex flex-col h-full">
    <!-- Search Bar -->
    <div class="p-4 border-b border-gray-200">
      <Input
        v-model="searchTerm"
        type="text"
        placeholder="Search items or scan barcode..."
        class="w-full"
      >
        <template #prefix>
          <svg class="h-5 w-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
        </template>
      </Input>
    </div>

    <!-- Item Groups Filter -->
    <div class="px-4 py-2 border-b border-gray-200 flex space-x-2 overflow-x-auto">
      <button
        v-for="group in itemGroups"
        :key="group.name"
        @click="selectedGroup = group.name"
        :class="[
          'px-3 py-1 rounded-lg text-sm font-medium whitespace-nowrap',
          selectedGroup === group.name
            ? 'bg-blue-100 text-blue-700'
            : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
        ]"
      >
        {{ group.name }}
      </button>
    </div>

    <!-- Items Grid -->
    <div class="flex-1 overflow-y-auto p-4">
      <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
        <div
          v-for="item in filteredItems"
          :key="item.item_code"
          @click="$emit('item-selected', item)"
          class="bg-white border border-gray-200 rounded-lg p-3 cursor-pointer hover:border-blue-500 hover:shadow-md transition-all"
        >
          <div class="aspect-square bg-gray-100 rounded-md mb-2 flex items-center justify-center">
            <img
              v-if="item.image"
              :src="item.image"
              :alt="item.item_name"
              class="w-full h-full object-cover rounded-md"
            />
            <svg v-else class="h-12 w-12 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
            </svg>
          </div>
          <h3 class="text-sm font-medium text-gray-900 truncate">{{ item.item_name }}</h3>
          <p class="text-xs text-gray-500 truncate">{{ item.item_code }}</p>
          <div class="flex justify-between items-center mt-2">
            <span class="text-base font-semibold text-gray-900">{{ formatCurrency(item.rate) }}</span>
            <span v-if="item.stock_qty > 0" class="text-xs text-green-600">
              Stock: {{ item.stock_qty }}
            </span>
            <span v-else class="text-xs text-red-600">Out of stock</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue'
import { Input } from 'frappe-ui'
import { useItems } from '../../composables/useItems'

const props = defineProps({
  posProfile: String
})

const emit = defineEmits(['item-selected'])

const { filteredItems, searchTerm, selectedGroup, itemGroups } = useItems(props.posProfile)

function formatCurrency(amount) {
  return parseFloat(amount || 0).toFixed(2)
}
</script>
```

#### 3.3 Create Invoice Cart Component
**File:** `POS/src/components/sale/InvoiceCart.vue`

```vue
<template>
  <div class="flex flex-col h-full">
    <!-- Customer Selection -->
    <div class="p-4 bg-white border-b border-gray-200">
      <div v-if="customer" class="flex items-center justify-between">
        <div>
          <p class="text-sm font-medium text-gray-900">{{ customer.customer_name }}</p>
          <p class="text-xs text-gray-500">{{ customer.mobile_no }}</p>
        </div>
        <Button variant="subtle" size="sm" @click="$emit('select-customer')">
          Change
        </Button>
      </div>
      <Button v-else variant="subtle" @click="$emit('select-customer')" class="w-full">
        + Select Customer
      </Button>
    </div>

    <!-- Cart Items -->
    <div class="flex-1 overflow-y-auto p-4 bg-gray-50">
      <div v-if="items.length === 0" class="text-center py-12">
        <svg class="mx-auto h-12 w-12 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z" />
        </svg>
        <p class="mt-2 text-sm text-gray-500">No items in cart</p>
      </div>

      <div v-else class="space-y-2">
        <div
          v-for="(item, index) in items"
          :key="index"
          class="bg-white border border-gray-200 rounded-lg p-3"
        >
          <div class="flex justify-between items-start mb-2">
            <div class="flex-1">
              <h4 class="text-sm font-medium text-gray-900">{{ item.item_name }}</h4>
              <p class="text-xs text-gray-500">{{ item.item_code }}</p>
            </div>
            <button
              @click="$emit('remove-item', item.item_code)"
              class="text-red-500 hover:text-red-700"
            >
              <svg class="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div class="flex items-center justify-between">
            <div class="flex items-center space-x-2">
              <button
                @click="decrementQuantity(item)"
                class="w-7 h-7 rounded border border-gray-300 hover:bg-gray-100"
              >
                -
              </button>
              <input
                :value="item.quantity"
                @input="updateQuantity(item, $event.target.value)"
                type="number"
                min="1"
                class="w-16 text-center border border-gray-300 rounded px-2 py-1"
              />
              <button
                @click="incrementQuantity(item)"
                class="w-7 h-7 rounded border border-gray-300 hover:bg-gray-100"
              >
                +
              </button>
            </div>
            <div class="text-right">
              <p class="text-xs text-gray-500">{{ formatCurrency(item.rate) }} × {{ item.quantity }}</p>
              <p class="text-sm font-semibold text-gray-900">{{ formatCurrency(item.amount) }}</p>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Totals Summary -->
    <div class="p-4 bg-white border-t border-gray-200">
      <div class="space-y-2 text-sm">
        <div class="flex justify-between">
          <span class="text-gray-600">Subtotal</span>
          <span class="font-medium text-gray-900">{{ formatCurrency(subtotal) }}</span>
        </div>
        <div v-if="discountAmount > 0" class="flex justify-between text-green-600">
          <span>Discount</span>
          <span>-{{ formatCurrency(discountAmount) }}</span>
        </div>
        <div class="flex justify-between">
          <span class="text-gray-600">Tax</span>
          <span class="font-medium text-gray-900">{{ formatCurrency(taxAmount) }}</span>
        </div>
        <div class="border-t border-gray-200 pt-2 flex justify-between text-lg">
          <span class="font-semibold text-gray-900">Total</span>
          <span class="font-bold text-blue-600">{{ formatCurrency(grandTotal) }}</span>
        </div>
      </div>

      <Button
        variant="solid"
        theme="blue"
        @click="$emit('proceed-to-payment')"
        :disabled="items.length === 0"
        class="w-full mt-4"
      >
        Proceed to Payment ({{ formatCurrency(grandTotal) }})
      </Button>
    </div>
  </div>
</template>

<script setup>
import { Button } from 'frappe-ui'

const props = defineProps({
  items: Array,
  customer: Object,
  subtotal: Number,
  taxAmount: Number,
  discountAmount: Number,
  grandTotal: Number
})

const emit = defineEmits(['update-quantity', 'remove-item', 'select-customer', 'proceed-to-payment'])

function formatCurrency(amount) {
  return parseFloat(amount || 0).toFixed(2)
}

function incrementQuantity(item) {
  emit('update-quantity', item.item_code, item.quantity + 1)
}

function decrementQuantity(item) {
  if (item.quantity > 1) {
    emit('update-quantity', item.item_code, item.quantity - 1)
  }
}

function updateQuantity(item, value) {
  const qty = parseInt(value) || 1
  if (qty > 0) {
    emit('update-quantity', item.item_code, qty)
  }
}
</script>
```

### Phase 4: Router Integration (Day 4)

#### Update Router
**File:** `POS/src/router/index.js`

```javascript
import { createRouter, createWebHistory } from 'vue-router'
import Login from '../pages/Login.vue'
import Home from '../pages/Home.vue'
import POSSale from '../pages/POSSale.vue'
import { useShift } from '../composables/useShift'

const routes = [
  {
    path: '/',
    redirect: '/login'
  },
  {
    path: '/login',
    name: 'Login',
    component: Login,
    meta: { requiresGuest: true }
  },
  {
    path: '/home',
    name: 'Home',
    component: Home,
    meta: { requiresAuth: true }
  },
  {
    path: '/pos',
    name: 'POSSale',
    component: POSSale,
    meta: { requiresAuth: true, requiresShift: true }
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

router.beforeEach((to, from, next) => {
  const { hasOpenShift } = useShift()

  if (to.meta.requiresShift && !hasOpenShift.value) {
    next('/home')
  } else {
    next()
  }
})

export default router
```

## Implementation Timeline

### Day 1: Backend Foundation
- ✅ Create `pos_next/api/invoices.py`
- ✅ Create `pos_next/api/items.py`
- ✅ Test API endpoints with Postman/API client

### Day 2: Composables & State Management
- ✅ Create `useInvoice.js`
- ✅ Create `useItems.js`
- ✅ Create `useCustomers.js`
- ✅ Test composables in isolation

### Day 3: Core UI Components
- ✅ Create `POSSale.vue` page
- ✅ Create `ItemsSelector.vue`
- ✅ Create `InvoiceCart.vue`
- ✅ Test basic item selection and cart flow

### Day 4: Payment & Finalization
- ✅ Create `PaymentDialog.vue`
- ✅ Create `CustomerDialog.vue`
- ✅ Integrate with router
- ✅ End-to-end testing
- ✅ Update Home.vue to navigate to POS

## Key Design Decisions

### 1. **Follow Frappe UI Patterns**
- Use Frappe UI components (Button, Input, Dialog)
- Consistent with Login and Shift dialogs
- No custom Vuetify components

### 2. **Build on Existing Backend**
- Implement robust API methods for POS operations
- Create efficient item/price logic
- Wrapper API in `pos_next` for clean separation

### 3. **Simple First, Enhance Later**
- Start with basic item selection + cart + payment
- No offers/coupons initially
- No drafts/returns initially
- Focus on core sale flow

### 4. **Offline Support (Future)**
- Phase 2 enhancement
- Use IndexedDB for offline storage
- Sync queue for offline invoices

### 5. **Responsive Design**
- Desktop-first (POS terminals are typically desktop)
- Tablet support for split view
- Mobile fallback with single column

## Success Criteria

✅ User can:
1. Select items from grid/list
2. Add items to cart
3. Adjust quantities
4. Select customer (optional)
5. Process payment (multiple methods)
6. Submit invoice
7. Print invoice (optional)

✅ System:
1. Calculates tax correctly
2. Applies pricing rules
3. Validates stock
4. Integrates with shift management
5. Follows Frappe UI theme
6. Maintains consistency with existing code

## Next Steps

After reviewing this plan:
1. Confirm approach aligns with requirements
2. Decide on timeline (4 days vs adjust)
3. Start with Phase 1: Backend API setup
4. Iterate based on feedback

This integration will transform POS Next from shift management to a full-featured POS system while maintaining code quality and design consistency.
