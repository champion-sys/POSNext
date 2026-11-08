/**
 * A rendered template drawn as a bitmap for ESC/POS printers, which take no HTML.
 *
 * The page is laid out at the paper's width in CSS pixels inside a sandboxed frame,
 * then drawn through an SVG foreignObject onto a canvas as wide as the printer's dots.
 * The SVG is loaded as an image, which may not fetch anything: every image in a
 * template is a data URI, so nothing is missing and the canvas is never tainted.
 *
 * @module platform/printing/rasterize
 */

import { normalizePaper, PAPERS } from "./template"

/** Dots across the print head: 58mm rolls print 384, 80mm rolls 576 */
export const RASTER_WIDTHS = { 58: 384, 80: 576 }

const CSS_PX_PER_MM = 96 / 25.4

/**
 * How wide to lay the page out and how wide to draw it.
 * @param {string} templatePaper - The template's paper
 * @param {string|number} printerPaper - The printer's roll, "58" or "80"
 * @returns {{cssWidth: number, rasterWidth: number}}
 */
export function rasterGeometry(templatePaper, printerPaper) {
	const roll = String(printerPaper) === "58" ? 58 : 80
	const paper = PAPERS[normalizePaper(templatePaper)]
	// A page template on a roll is laid out at the roll's width rather than shrunk to it
	const layoutMm = paper.roll ? paper.widthMm : roll
	return { cssWidth: Math.round(layoutMm * CSS_PX_PER_MM), rasterWidth: RASTER_WIDTHS[roll] }
}

function waitForFrame(frame) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("The receipt took too long to lay out")), 10000)
		frame.onload = () => {
			clearTimeout(timer)
			resolve()
		}
	})
}

async function waitForImages(doc) {
	await Promise.all(
		Array.from(doc.images).map((image) =>
			image.complete ? null : new Promise((resolve) => {
				image.onload = resolve
				image.onerror = resolve
			}),
		),
	)
	await doc.fonts?.ready
}

/**
 * Lay the document out and measure its height in CSS pixels.
 * @param {string} html
 * @param {number} cssWidth
 * @returns {Promise<{height: number, doc: Document}>}
 */
async function layOut(html, cssWidth) {
	const frame = document.createElement("iframe")
	// No scripts run; same origin only so the frame's layout can be read
	frame.setAttribute("sandbox", "allow-same-origin")
	frame.setAttribute("aria-hidden", "true")
	frame.style.cssText = `position:fixed;left:-10000px;top:0;width:${cssWidth}px;height:10px;border:0;visibility:hidden`
	const loaded = waitForFrame(frame)
	frame.srcdoc = html
	document.body.appendChild(frame)
	try {
		await loaded
		const doc = frame.contentDocument
		await waitForImages(doc)
		const height = Math.ceil(
			Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight || 0, doc.documentElement.getBoundingClientRect().height),
		)
		return { height, doc }
	} finally {
		frame.remove()
	}
}

/**
 * The document as XHTML, which an SVG foreignObject needs.
 * @param {string} html
 * @param {number} cssWidth
 * @returns {string}
 */
export function toForeignObjectMarkup(html, cssWidth) {
	const doc = new DOMParser().parseFromString(html, "text/html")
	for (const node of doc.querySelectorAll("script, link, iframe, object, embed")) node.remove()
	// The roll is as wide as the frame; a fixed body width in mm would round differently
	const fit = doc.createElement("style")
	fit.textContent = `html,body{width:${cssWidth}px !important;min-width:0 !important;background:#fff}`
	doc.head.appendChild(fit)
	return new XMLSerializer().serializeToString(doc.documentElement)
}

/**
 * Draw a rendered template onto a canvas as wide as the print head.
 * @param {string} html - A whole document from renderTemplate
 * @param {{cssWidth: number, rasterWidth: number}} geometry
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function htmlToRasterCanvas(html, { cssWidth, rasterWidth }) {
	const { height } = await layOut(html, cssWidth)
	const cssHeight = Math.max(height, 1)
	const markup = toForeignObjectMarkup(html, cssWidth)
	const svg =
		`<svg xmlns="http://www.w3.org/2000/svg" width="${cssWidth}" height="${cssHeight}">` +
		`<foreignObject x="0" y="0" width="${cssWidth}" height="${cssHeight}">${markup}</foreignObject></svg>`

	const scale = rasterWidth / cssWidth
	const canvas = document.createElement("canvas")
	canvas.width = rasterWidth
	canvas.height = Math.ceil(cssHeight * scale)
	const ctx = canvas.getContext("2d")
	if (!ctx) throw new Error("Could not create 2D canvas context")
	ctx.fillStyle = "#ffffff"
	ctx.fillRect(0, 0, canvas.width, canvas.height)

	const image = new Image()
	await new Promise((resolve, reject) => {
		image.onload = resolve
		image.onerror = () => reject(new Error("The receipt could not be drawn"))
		// A data URI, not a blob URL: Chromium taints a canvas drawn from a blob SVG with foreignObject
		image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`
	})
	// Drawn at the printer's size, so text is rasterized sharp rather than scaled up
	ctx.drawImage(image, 0, 0, canvas.width, canvas.height)
	return canvas
}

/**
 * A canvas as one ESC/POS raster image (GS v 0), followed by feeds and a cut.
 * @param {{width: number, height: number, getContext: Function}} canvas - width a multiple of 8
 * @param {{feeds?: number}} [options]
 * @returns {Uint8Array}
 */
export function canvasToEscPos(canvas, { feeds = 3 } = {}) {
	const { width, height } = canvas
	const ctx = canvas.getContext("2d")
	if (!ctx) throw new Error("Could not create 2D canvas context")
	const data = ctx.getImageData(0, 0, width, height).data
	const widthBytes = Math.ceil(width / 8)
	const feedCount = Math.max(0, Number(feeds) || 0)
	const bytes = new Uint8Array(2 + 8 + widthBytes * height + feedCount + 4 + 2)

	let at = 0
	bytes[at++] = 0x1b
	bytes[at++] = 0x40 // ESC @
	bytes.set([0x1d, 0x76, 0x30, 0, widthBytes % 256, Math.floor(widthBytes / 256), height % 256, Math.floor(height / 256)], at)
	at += 8

	for (let y = 0; y < height; y++) {
		for (let xByte = 0; xByte < widthBytes; xByte++) {
			let byte = 0
			for (let bit = 0; bit < 8; bit++) {
				const x = xByte * 8 + bit
				if (x >= width) continue
				const i = (y * width + x) * 4
				if (data[i + 3] > 50 && (data[i] * 77 + data[i + 1] * 150 + data[i + 2] * 29) >> 8 < 200) {
					byte |= 1 << (7 - bit)
				}
			}
			bytes[at++] = byte
		}
	}

	for (let i = 0; i < feedCount; i++) bytes[at++] = 0x0a
	bytes.set([0x1d, 0x56, 66, 0], at) // GS V: feed and cut
	at += 4
	bytes[at++] = 0x1b
	bytes[at++] = 0x40
	return bytes
}
