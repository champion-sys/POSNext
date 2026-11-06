import { describe, expect, it, vi } from "vitest"

vi.mock("@/utils/apiWrapper", () => ({ call: vi.fn() }))
vi.mock("@/utils/offline/offlineReceiptCache", () => ({}))
vi.mock("@/utils/offline/sync", () => ({}))
vi.mock("@/utils/offline/workerClient", () => ({ offlineWorker: {} }))
vi.mock("@/utils/qzTray", () => ({ printHTML: vi.fn() }))
vi.mock("@/stores/posSettings", () => ({ usePOSSettingsStore: () => ({}) }))

import { esc } from "@/utils/printInvoice"

describe("esc", () => {
	it("makes markup in a customer name plain text", () => {
		expect(esc('<img src=x onerror="alert(1)">')).toBe("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;")
	})

	it("leaves Arabic text alone", () => {
		expect(esc("عميل عابر")).toBe("عميل عابر")
	})

	it("gives nothing for a missing value, so a fallback can apply", () => {
		expect(esc(undefined)).toBe("")
		expect(esc(null) || "default").toBe("default")
	})
})
