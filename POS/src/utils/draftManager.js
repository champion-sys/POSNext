// Draft Invoice Management
import { localStore } from "@/platform/store"

function sanitizeDraftData(data) {
	if (data === null || data === undefined) {
		return data
	}

	try {
		// Vue reactive refs/proxies can't be stored directly.
		// Serializing through JSON removes reactivity while keeping data shallow.
		return JSON.parse(JSON.stringify(data))
	} catch (error) {
		console.warn("Failed to sanitize draft data for storage", error)
		throw error
	}
}

// Save draft invoice
export async function saveDraft(invoiceData) {
	const sanitizedInvoiceData = sanitizeDraftData(invoiceData) || {}

	const draft = {
		draft_id: `DRAFT-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
		...sanitizedInvoiceData,
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
	}

	await localStore.addDraft(draft)
	return draft
}

// Update existing draft
export async function updateDraft(draftId, invoiceData) {
	const existingDraft = await getDraftById(draftId)
	if (!existingDraft) {
		throw new Error("Draft not found")
	}

	const sanitizedInvoiceData = sanitizeDraftData(invoiceData) || {}
	const updatedDraft = {
		...existingDraft,
		...sanitizedInvoiceData,
		updated_at: new Date().toISOString(),
	}

	await localStore.putDraft(updatedDraft)
	return updatedDraft
}

// Get all draft invoices
export async function getAllDrafts() {
	const drafts = await localStore.listDrafts()
	// Sort by created_at descending
	return drafts.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
}

// Get draft by ID
export function getDraftById(draftId) {
	return localStore.getDraft(draftId)
}

// Delete draft
export async function deleteDraft(draftId) {
	const draft = await getDraftById(draftId)
	if (!draft) {
		throw new Error("Draft not found")
	}

	await localStore.deleteDraft(draftId)
	return true
}

// Clear all drafts
export async function clearAllDrafts() {
	await localStore.clearDrafts()
	return true
}

// Get drafts count
export function getDraftsCount() {
	return localStore.countDrafts()
}
