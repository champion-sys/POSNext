import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
	platform: { current: "web" },
	Filesystem: { rmdir: vi.fn(), writeFile: vi.fn() },
	Share: { share: vi.fn() },
}))

vi.mock("@/platform/capacitor", () => ({ Filesystem: mocks.Filesystem, Share: mocks.Share }))
vi.mock("../runtime", () => ({
	ANDROID: "android",
	get PLATFORM() {
		return mocks.platform.current
	},
}))

const { saveQueueFile } = await import("../queueFile")

const NAME = "pos-queue-0294017d-20261107-090503.json"

describe("on the web and the desktop", () => {
	let clicked

	beforeEach(() => {
		mocks.platform.current = "web"
		clicked = null
		URL.createObjectURL = vi.fn(() => "blob:queue")
		URL.revokeObjectURL = vi.fn()
		vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function () {
			clicked = { href: this.href, download: this.download, attached: this.isConnected }
		})
	})

	afterEach(() => {
		vi.restoreAllMocks()
		vi.useRealTimers()
	})

	it("downloads the text under the file's name", async () => {
		expect(await saveQueueFile(NAME, '{"text":"عميل"}')).toBe(true)

		expect(clicked).toEqual({ href: "blob:queue", download: NAME, attached: true })
		const [blob] = URL.createObjectURL.mock.calls[0]
		expect(blob.type).toBe("application/json")
		expect(blob.size).toBe(new TextEncoder().encode('{"text":"عميل"}').length)
	})

	it("leaves no link behind", async () => {
		await saveQueueFile(NAME, "{}")
		expect(document.querySelector("a[download]")).toBeNull()
	})

	it("keeps the address alive until the browser has read it", async () => {
		vi.useFakeTimers()

		await saveQueueFile(NAME, "{}")
		expect(URL.revokeObjectURL).not.toHaveBeenCalled()

		vi.runAllTimers()
		expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:queue")
	})

	it("needs no native plugin", async () => {
		await saveQueueFile(NAME, "{}")
		expect(mocks.Filesystem.writeFile).not.toHaveBeenCalled()
	})
})

describe("on Android", () => {
	const URI = "file:///data/cache/queue-export/file.json"

	beforeEach(() => {
		mocks.platform.current = "android"
		mocks.Filesystem.rmdir.mockReset().mockResolvedValue()
		mocks.Filesystem.writeFile.mockReset().mockResolvedValue({ uri: URI })
		mocks.Share.share.mockReset().mockResolvedValue({ activityType: "drive" })
	})

	it("hands the written file to the share sheet", async () => {
		expect(await saveQueueFile(NAME, '{"text":"عميل"}')).toBe(true)

		expect(mocks.Filesystem.writeFile).toHaveBeenCalledWith({
			path: `queue-export/${NAME}`,
			directory: "CACHE",
			data: '{"text":"عميل"}',
			encoding: "utf8",
			recursive: true,
		})
		expect(mocks.Share.share).toHaveBeenCalledWith(expect.objectContaining({ files: [URI] }))
	})

	it("clears the last export's copy first", async () => {
		await saveQueueFile(NAME, "{}")

		expect(mocks.Filesystem.rmdir).toHaveBeenCalledWith({
			path: "queue-export",
			directory: "CACHE",
			recursive: true,
		})
		expect(mocks.Filesystem.rmdir.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.Filesystem.writeFile.mock.invocationCallOrder[0],
		)
	})

	it("does not mind having no earlier copy", async () => {
		mocks.Filesystem.rmdir.mockRejectedValue(new Error("Folder does not exist."))
		expect(await saveQueueFile(NAME, "{}")).toBe(true)
	})

	it("does not delete the file while another app may be reading it", async () => {
		await saveQueueFile(NAME, "{}")
		expect(mocks.Filesystem.rmdir).toHaveBeenCalledTimes(1)
	})

	it("treats closing the share sheet as backing out", async () => {
		mocks.Share.share.mockRejectedValue(new Error("Share canceled"))
		expect(await saveQueueFile(NAME, "{}")).toBe(false)
	})

	it("reports a share that really failed", async () => {
		mocks.Share.share.mockRejectedValue(new Error("Can't share while sharing is in progress"))
		await expect(saveQueueFile(NAME, "{}")).rejects.toThrow("in progress")
	})

	it("reports a file that could not be written", async () => {
		mocks.Filesystem.writeFile.mockRejectedValue(new Error("No space left on device"))

		await expect(saveQueueFile(NAME, "{}")).rejects.toThrow("No space")
		expect(mocks.Share.share).not.toHaveBeenCalled()
	})
})
