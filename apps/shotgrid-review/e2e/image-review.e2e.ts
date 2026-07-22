import { readFile } from 'node:fs/promises'
import { deflateSync } from 'node:zlib'
import { expect, test, type Browser, type Page } from '@playwright/test'
import type { Editor, TLShapeId } from 'tldraw'

// Keep this outside Vitest's *.test / *.spec discovery; Playwright owns this browser gate.

declare global {
	interface Window {
		reviewEditor?: Editor
	}
}

const SOURCE_WIDTH = 1920
const SOURCE_HEIGHT = 1080
const SOURCE_SHAPE_ID = 'shape:shotgrid-review-source-301'
const E2E_URL = 'http://127.0.0.1:5460/e2e/image-review.html'
const WHITE_SOURCE_PNG = makeSolidPng(SOURCE_WIDTH, SOURCE_HEIGHT)

test('preserves editable image annotations and exports the source resolution', async ({
	browser,
}) => {
	const firstPage = await newReviewPage(browser)

	await firstPage.getByTestId('tools.rectangle').click()
	const sourceCenter = await sourceScreenPoint(firstPage)
	await firstPage.mouse.move(sourceCenter.x - 80, sourceCenter.y - 55)
	await firstPage.mouse.down()
	await firstPage.mouse.move(sourceCenter.x + 80, sourceCenter.y + 55, { steps: 5 })
	await firstPage.mouse.up()

	await expect.poll(() => getOnlyAnnotation(firstPage)).not.toBeNull()
	const createdAnnotation = await getOnlyAnnotation(firstPage)
	if (!createdAnnotation) throw new Error('The real editor did not create an annotation shape.')
	await expect(firstPage.getByTestId('tools.select')).toHaveAttribute('aria-pressed', 'true')

	const snapshotDownloadPromise = firstPage.waitForEvent('download')
	await firstPage.getByRole('button', { name: 'Save editable' }).click()
	const snapshotDownload = await snapshotDownloadPromise
	expect(snapshotDownload.suggestedFilename()).toBe('shot_020_comp_v008.review.json')
	const snapshotPath = await snapshotDownload.path()
	if (!snapshotPath) throw new Error('Playwright did not retain the editable snapshot download.')
	const snapshot = await readFile(snapshotPath)
	const snapshotFileName = snapshotDownload.suggestedFilename()
	await firstPage.context().close()

	const secondPage = await newReviewPage(browser)
	await secondPage.getByLabel('Open editable review snapshot').setInputFiles({
		buffer: snapshot,
		mimeType: 'application/json',
		name: snapshotFileName,
	})
	await expect(secondPage.getByText('Editable snapshot opened.')).toBeVisible()

	const reopenedAnnotation = await getOnlyAnnotation(secondPage)
	expect(reopenedAnnotation).toEqual(createdAnnotation)

	const annotationCenter = await annotationScreenPoint(secondPage, createdAnnotation.id)
	await secondPage.mouse.move(annotationCenter.x, annotationCenter.y)
	await secondPage.mouse.down()
	await secondPage.mouse.move(annotationCenter.x + 48, annotationCenter.y + 24, { steps: 5 })
	await secondPage.mouse.up()

	await expect
		.poll(async () => (await getOnlyAnnotation(secondPage))?.x)
		.toBeGreaterThan(createdAnnotation.x + 20)
	const editedAnnotation = await getOnlyAnnotation(secondPage)
	expect(editedAnnotation?.isLocked).toBe(false)

	const pngDownloadPromise = secondPage.waitForEvent('download')
	await secondPage.getByRole('button', { name: 'Export PNG' }).click()
	const pngDownload = await pngDownloadPromise
	expect(pngDownload.suggestedFilename()).toBe('shot_020_comp_v008.annotated.png')
	const pngPath = await pngDownload.path()
	if (!pngPath) throw new Error('Playwright did not retain the PNG download.')
	const dimensions = readPngDimensions(await readFile(pngPath))
	expect(dimensions).toEqual({ height: SOURCE_HEIGHT, width: SOURCE_WIDTH })
	if (!editedAnnotation || editedAnnotation.w === null || editedAnnotation.h === null) {
		throw new Error('The reopened rectangle does not expose raster-testable bounds.')
	}
	const changedPixels = await countNonWhitePixels(secondPage, await readFile(pngPath), {
		h: editedAnnotation.h,
		w: editedAnnotation.w,
		x: editedAnnotation.x,
		y: editedAnnotation.y,
	})
	expect(changedPixels).toBeGreaterThan(40)
	await expect(secondPage.getByText('Flattened PNG exported.')).toBeVisible()

	await secondPage.context().close()
})

async function newReviewPage(browser: Browser) {
	const context = await browser.newContext({
		acceptDownloads: true,
		viewport: { height: 800, width: 1280 },
	})
	await context.route('**/mock-media/shot-comp.png', (route) =>
		route.fulfill({ body: WHITE_SOURCE_PNG, contentType: 'image/png', status: 200 })
	)
	const page = await context.newPage()
	await page.goto(E2E_URL)
	await expect(page.locator('.tl-canvas')).toBeVisible()
	await expect(page.getByRole('button', { name: 'Save editable' })).toBeEnabled()
	await expect.poll(() => page.evaluate(() => Boolean(window.reviewEditor))).toBe(true)
	return page
}

async function sourceScreenPoint(page: Page) {
	return page.evaluate((sourceShapeId) => {
		const editor = window.reviewEditor
		if (!editor) throw new Error('The review editor has not mounted.')
		const bounds = editor.getShapePageBounds(sourceShapeId as TLShapeId)
		if (!bounds) throw new Error('The protected source image is missing.')
		return editor.pageToScreen(bounds.center)
	}, SOURCE_SHAPE_ID)
}

async function annotationScreenPoint(page: Page, shapeId: string) {
	return page.evaluate((id) => {
		const editor = window.reviewEditor
		if (!editor) throw new Error('The review editor has not mounted.')
		const bounds = editor.getShapePageBounds(id as TLShapeId)
		if (!bounds) throw new Error('The annotation shape is missing.')
		return editor.pageToScreen(bounds.center)
	}, shapeId)
}

async function getOnlyAnnotation(page: Page) {
	return page.evaluate((sourceShapeId) => {
		const editor = window.reviewEditor
		if (!editor) throw new Error('The review editor has not mounted.')
		const annotations = editor.getCurrentPageShapes().filter((shape) => shape.id !== sourceShapeId)
		if (annotations.length !== 1) return null
		const [shape] = annotations
		return {
			h: 'h' in shape.props ? Number(shape.props.h) : null,
			id: shape.id,
			isLocked: shape.isLocked,
			type: shape.type,
			w: 'w' in shape.props ? Number(shape.props.w) : null,
			x: shape.x,
			y: shape.y,
		}
	}, SOURCE_SHAPE_ID)
}

function readPngDimensions(bytes: Buffer) {
	const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
	if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature)) {
		throw new Error('The exported download is not a PNG image.')
	}
	return { height: bytes.readUInt32BE(20), width: bytes.readUInt32BE(16) }
}

async function countNonWhitePixels(
	page: Page,
	png: Buffer,
	bounds: { h: number; w: number; x: number; y: number }
) {
	return page.evaluate(
		async ({ base64, bounds }) => {
			const bytes = Uint8Array.from(atob(base64), (character) => character.charCodeAt(0))
			const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }))
			try {
				const canvas = document.createElement('canvas')
				canvas.width = bitmap.width
				canvas.height = bitmap.height
				const context = canvas.getContext('2d', { willReadFrequently: true })
				if (!context) throw new Error('The browser did not provide a 2D export verifier.')
				context.drawImage(bitmap, 0, 0)
				const padding = 8
				const left = Math.max(0, Math.floor(bounds.x - padding))
				const top = Math.max(0, Math.floor(bounds.y - padding))
				const right = Math.min(bitmap.width, Math.ceil(bounds.x + bounds.w + padding))
				const bottom = Math.min(bitmap.height, Math.ceil(bounds.y + bounds.h + padding))
				const pixels = context.getImageData(left, top, right - left, bottom - top).data
				let changed = 0
				for (let index = 0; index < pixels.length; index += 4) {
					if (
						pixels[index] < 250 ||
						pixels[index + 1] < 250 ||
						pixels[index + 2] < 250 ||
						pixels[index + 3] < 250
					) {
						changed += 1
					}
				}
				return changed
			} finally {
				bitmap.close()
			}
		},
		{ base64: png.toString('base64'), bounds }
	)
}

function makeSolidPng(width: number, height: number) {
	const stride = width * 4 + 1
	const scanlines = Buffer.alloc(stride * height)
	for (let row = 0; row < height; row += 1) {
		scanlines.fill(0xff, row * stride + 1, (row + 1) * stride)
	}
	const header = Buffer.alloc(13)
	header.writeUInt32BE(width, 0)
	header.writeUInt32BE(height, 4)
	header.set([8, 6, 0, 0, 0], 8)
	return Buffer.concat([
		Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		pngChunk('IHDR', header),
		pngChunk('IDAT', deflateSync(scanlines)),
		pngChunk('IEND', Buffer.alloc(0)),
	])
}

function pngChunk(type: string, data: Buffer) {
	const typeBytes = Buffer.from(type, 'ascii')
	const length = Buffer.alloc(4)
	length.writeUInt32BE(data.length)
	const checksum = Buffer.alloc(4)
	checksum.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])))
	return Buffer.concat([length, typeBytes, data, checksum])
}

function crc32(bytes: Buffer) {
	let crc = 0xffffffff
	for (const byte of bytes) {
		crc ^= byte
		for (let bit = 0; bit < 8; bit += 1) {
			crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
		}
	}
	return (crc ^ 0xffffffff) >>> 0
}
