import { localStore } from "@/platform/store";
import { ENTITY_INVOICE, getEntity } from "./entities";
import { getSetting } from "./settings";
import { logger } from "@/utils/logger";

const log = logger.create("OfflineItems");

// Cache items on the device
export const cacheItems = async (items, priceList = null) => {
	try {
		if (!items || items.length === 0) return;

		await localStore.mergeCachedItems(items, priceList);

		log.debug(`Cached ${items.length} items`);
		return true;
	} catch (error) {
		console.error("Error caching items:", error);
		return false;
	}
};

// Get cached items
export const getCachedItems = async (limit = 100) => {
	try {
		return await localStore.searchCachedItems("", limit);
	} catch (error) {
		console.error("Error getting cached items:", error);
		return [];
	}
};

// Fuzzy search: matches if any search word is contained in item text
export const searchCachedItems = async (searchTerm, limit = 50) => {
	try {
		return await localStore.searchCachedItems(searchTerm, limit);
	} catch (error) {
		console.error("Error searching cached items:", error);
		return [];
	}
};

// Get item by barcode
export const getItemByBarcode = async (barcode) => {
	try {
		return await localStore.getCachedItemByBarcode(barcode);
	} catch (error) {
		console.error("Error getting item by barcode:", error);
		return null;
	}
};

// Get cached variants for a template item
export const getCachedVariants = async (templateItemCode) => {
	try {
		if (!templateItemCode) return [];

		return await localStore.getCachedVariants(templateItemCode);
	} catch (error) {
		console.error("Error getting cached variants:", error);
		return [];
	}
};

// Get cached batch data for an item
export const getCachedBatchData = async (itemCode) => {
	try {
		if (!itemCode) return [];

		const item = await localStore.getCachedItem(itemCode);
		return item?.batch_no_data || [];
	} catch (error) {
		console.error("Error getting cached batch data:", error);
		return [];
	}
};

// Get cached serial number data for an item
export const getCachedSerialData = async (itemCode) => {
	try {
		if (!itemCode) return [];

		const item = await localStore.getCachedItem(itemCode);
		return await withoutQueuedSerials(itemCode, item?.serial_no_data || []);
	} catch (error) {
		console.error("Error getting cached serial data:", error);
		return [];
	}
};

export function parseSerialNumbers(serialNumbers) {
	if (!serialNumbers) return [];
	return Array.isArray(serialNumbers)
		? serialNumbers
		: String(serialNumbers)
				.split("\n")
				.map((s) => s.trim())
				.filter(Boolean);
}

/** Holds the same sales as sumQueuedStock. A return gives its serial back. */
function getQueuedSerials(rows, itemCode) {
	const held = new Set();
	for (const { data, void_reason } of rows) {
		if (data?.doctype === "Sales Order" || data?.is_return || void_reason) continue;
		for (const item of data?.items || []) {
			if (item.item_code !== itemCode) continue;
			for (const serial of parseSerialNumbers(item.serial_no)) held.add(serial);
		}
	}
	return held;
}

/**
 * Take off serials a queued sale has sold. The server lists them as available until that
 * sale reaches it. A queue that cannot be read must not stop the sale in front of the
 * cashier, and the server still refuses a serial sold twice.
 * @param {string} itemCode
 * @param {Array<{serial_no: string}>} serials
 * @returns {Promise<Array<{serial_no: string}>>}
 */
export const withoutQueuedSerials = async (itemCode, serials) => {
	if (serials.length === 0) return serials;

	try {
		const held = getQueuedSerials(await localStore.getOfflineInvoices(), itemCode);
		return serials.filter((serial) => !held.has(serial.serial_no));
	} catch (error) {
		console.error("Error reading serials held by the queue:", error);
		return serials;
	}
};

// Persist batch/serial data for a single cached item (partial updates supported)
export const persistItemBatchSerialData = async (itemCode, data) => {
	try {
		if (!itemCode || !data) return false;

		const update = {};
		if (data.batch_no_data !== undefined) update.batch_no_data = data.batch_no_data;
		if (data.serial_no_data !== undefined) update.serial_no_data = data.serial_no_data;

		if (Object.keys(update).length === 0) return false;

		return (await localStore.updateItemBatchSerial([itemCode], () => update)) > 0;
	} catch (error) {
		console.error("Error persisting item batch/serial data:", error);
		return false;
	}
};

// Update batch/serial data for items in cache
export const updateItemBatchSerialData = async (batchSerialDataMap) => {
	try {
		if (!batchSerialDataMap || Object.keys(batchSerialDataMap).length === 0) return;

		await localStore.updateItemBatchSerial(Object.keys(batchSerialDataMap), (item) => ({
			batch_no_data: batchSerialDataMap[item.item_code].batch_no_data || [],
			serial_no_data: batchSerialDataMap[item.item_code].serial_no_data || [],
		}));

		log.debug(`Updated batch/serial data for ${Object.keys(batchSerialDataMap).length} items`);
		return true;
	} catch (error) {
		console.error("Error updating batch/serial data:", error);
		return false;
	}
};

// Remove consumed serial numbers from offline cache
export const consumeCachedSerials = async (itemCode, serialNumbers) => {
	try {
		if (!itemCode) return;

		await localStore.updateItemBatchSerial([itemCode], (item) => {
			const serials = item.serial_no_data || [];
			if (!serials.length) return null;

			const toRemove = new Set(parseSerialNumbers(serialNumbers));
			return { serial_no_data: serials.filter((s) => !toRemove.has(s.serial_no)) };
		});
	} catch (error) {
		console.error("Error consuming cached serials:", error);
	}
};

// Return serial numbers to offline cache (e.g. item removed from cart)
export const returnCachedSerials = async (itemCode, serialNumbers, warehouse = null) => {
	try {
		if (!itemCode) return;

		await localStore.updateItemBatchSerial([itemCode], (item) => {
			const serials = item.serial_no_data || [];
			const toReturn = parseSerialNumbers(serialNumbers);
			if (!toReturn.length) return null;

			const scopedWarehouse = warehouse || serials[0]?.warehouse;
			if (!scopedWarehouse) return null;

			const existing = new Set(serials.map((s) => s.serial_no));
			const added = toReturn
				.filter((serialNo) => !existing.has(serialNo))
				.map((serial_no) => ({ serial_no, warehouse: scopedWarehouse }));

			if (!added.length) return null;

			const merged = [...serials, ...added].sort((a, b) =>
				a.serial_no.localeCompare(b.serial_no, undefined, { numeric: true }),
			);

			return { serial_no_data: merged };
		});
	} catch (error) {
		console.error("Error returning cached serials:", error);
	}
};

// Deduct a sold batch quantity from offline cache
export const deductCachedBatchQty = async (itemCode, batchNo, qty) => {
	try {
		if (!itemCode || !batchNo || !qty) return;

		await localStore.updateItemBatchSerial([itemCode], (item) => {
			if (!item.batch_no_data?.length) return null;

			const batch_no_data = item.batch_no_data.map((b) =>
				b.batch_no === batchNo ? { ...b, batch_qty: Math.max(0, (b.batch_qty || 0) - qty) } : b,
			);
			return { batch_no_data };
		});
	} catch (error) {
		console.error("Error deducting cached batch qty:", error);
	}
};

// Give a batch quantity back to the offline cache (e.g. its sale was voided)
export const returnCachedBatchQty = async (itemCode, batchNo, qty) => {
	await deductCachedBatchQty(itemCode, batchNo, -qty);
};

const getSoldQty = (item) => (item.qty || item.quantity || 0) * (item.conversion_factor || 1);

/** What checkout took off the cache for a sale. A return took nothing. */
const getSoldBatchItems = (row) =>
	getEntity(row) === ENTITY_INVOICE && !row.data?.is_return ? row.data?.items || [] : [];

/**
 * A sale with a void waiting holds nothing, so its batches and serials can be sold again.
 * @param {Object} row - Queue row
 * @returns {Promise<string[]>} The items that had serials
 */
export const releaseSoldBatchesAndSerials = async (row) => {
	const serialItems = [];
	for (const item of getSoldBatchItems(row)) {
		if (item.batch_no) await returnCachedBatchQty(item.item_code, item.batch_no, getSoldQty(item));
		if (item.serial_no) {
			await returnCachedSerials(item.item_code, item.serial_no, item.warehouse);
			serialItems.push(item.item_code);
		}
	}
	return serialItems;
};

/**
 * The void did not happen, so the sale takes its batches and serials again.
 * @param {Object} row - Queue row
 */
export const retakeSoldBatchesAndSerials = async (row) => {
	for (const item of getSoldBatchItems(row)) {
		if (item.batch_no) await deductCachedBatchQty(item.item_code, item.batch_no, getSoldQty(item));
		if (item.serial_no) await consumeCachedSerials(item.item_code, item.serial_no);
	}
};

// Get item with price
export const getItemWithPrice = async (itemCode, priceList) => {
	try {
		const item = await localStore.getCachedItem(itemCode);
		if (!item) return null;

		if (priceList) {
			const rate = await localStore.getCachedItemPrice(priceList, itemCode);
			if (rate !== undefined) {
				item.rate = rate;
				item.price_list_rate = rate;
			}
		}

		return item;
	} catch (error) {
		console.error("Error getting item with price:", error);
		return null;
	}
};

// Cache customers
export const cacheCustomers = async (customers) => {
	try {
		if (!customers || customers.length === 0) return;

		await localStore.cacheCustomers(customers);

		log.debug(`Cached ${customers.length} customers`);
		return true;
	} catch (error) {
		console.error("Error caching customers:", error);
		return false;
	}
};

// Search cached customers
export const searchCachedCustomers = async (searchTerm, limit = 20) => {
	try {
		return await localStore.searchCachedCustomers(searchTerm, limit);
	} catch (error) {
		console.error("Error searching cached customers:", error);
		return [];
	}
};

// Get items last sync time
export const getItemsLastSync = async () => {
	return await getSetting("items_last_sync", null);
};

// Get customers last sync time
export const getCustomersLastSync = async () => {
	return await getSetting("customers_last_sync", null);
};

// Check if cache is fresh (less than 24 hours old)
export const isCacheFresh = async (type = "items") => {
	const lastSync = type === "items" ? await getItemsLastSync() : await getCustomersLastSync();

	if (!lastSync) return false;

	const hoursSinceSync = (Date.now() - lastSync) / (1000 * 60 * 60);
	return hoursSinceSync < 24;
};

// Clear cache
export const clearItemsCache = async () => {
	try {
		await localStore.clearItemsCache();
		log.debug("Items cache cleared");
		return true;
	} catch (error) {
		console.error("Error clearing items cache:", error);
		return false;
	}
};

export const clearCustomersCache = async () => {
	try {
		await localStore.clearCustomersCache();
		log.debug("Customers cache cleared");
		return true;
	} catch (error) {
		console.error("Error clearing customers cache:", error);
		return false;
	}
};
