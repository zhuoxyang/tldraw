import type { ReviewImageMedia } from '@tldraw/shotgrid-review-contracts'
import { describe, expect, it, vi } from 'vitest'
import {
	fetchReviewImage,
	decodeReviewImageDimensions,
	digestReviewImage,
	resolveReviewImageDimensions,
	ReviewImageError,
} from './reviewImage'

const media: ReviewImageMedia = {
	contentType: 'image/png',
	height: 1080,
	kind: 'image',
	thumbnailUrl: null,
	url: 'https://media.example.test/review.png',
	width: 1920,
}

describe('fetchReviewImage', () => {
	it('downloads an image with same-origin auth but without redirects or referrer data', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => imageResponse(pngBytes()))

		await expect(fetchReviewImage(media, undefined, fetch)).resolves.toMatchObject({
			size: pngBytes().byteLength,
			type: 'image/png',
		})
		expect(fetch).toHaveBeenCalledWith(
			media.url,
			expect.objectContaining({
				credentials: 'same-origin',
				method: 'GET',
				mode: 'cors',
				redirect: 'error',
				referrerPolicy: 'no-referrer',
			})
		)
	})

	it('accepts a validated proxy format when stale ShotGrid metadata said JPEG', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () => new Response(webpBytes(), { headers: { 'Content-Type': 'image/webp' } })
		)

		await expect(
			fetchReviewImage({ ...media, contentType: 'image/jpeg' }, undefined, fetch)
		).resolves.toMatchObject({ type: 'image/webp' })
	})

	it('checks animation chunk structure rather than rejecting matching pixel bytes', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			imageResponse(pngBytes(new TextEncoder().encode('pixel payload includes acTL text')))
		)

		await expect(fetchReviewImage(media, undefined, fetch)).resolves.toMatchObject({
			type: 'image/png',
		})
	})

	it('rejects a matching image header with spoofed bytes', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			imageResponse(new TextEncoder().encode('not really png'))
		)

		await expect(fetchReviewImage(media, undefined, fetch)).rejects.toMatchObject({
			code: 'IMAGE_INVALID',
		})
	})

	it('rejects and cancels a response whose type differs from ShotGrid metadata', async () => {
		const cancel = vi.fn()
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						cancel,
						start(controller) {
							controller.enqueue(new TextEncoder().encode('<html>not an image</html>'))
						},
					}),
					{ headers: { 'Content-Type': 'text/html' } }
				)
		)

		await expect(fetchReviewImage(media, undefined, fetch)).rejects.toMatchObject({
			code: 'IMAGE_UNSUPPORTED',
		})
		expect(cancel).toHaveBeenCalledOnce()
	})

	it('rejects a declared body over 32 MiB before reading it', async () => {
		const cancel = vi.fn()
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						cancel,
						start(controller) {
							controller.enqueue(new Uint8Array([1]))
						},
					}),
					{
						headers: {
							'Content-Length': String(32 * 1024 * 1024 + 1),
							'Content-Type': 'image/png',
						},
					}
				)
		)

		await expect(fetchReviewImage(media, undefined, fetch)).rejects.toMatchObject({
			code: 'IMAGE_TOO_LARGE',
		})
		expect(cancel).toHaveBeenCalledOnce()
	})
})

describe('digestReviewImage', () => {
	it('creates a stable SHA-256 source identity', async () => {
		await expect(digestReviewImage(new Blob(['review']))).resolves.toBe(
			'c97ace4c8fef2cee8fa0f3c9f52aab18dbd4f42438afe362ffb8f75ce4c04b84'
		)
	})
})

describe('decodeReviewImageDimensions', () => {
	it('reads encoded pixel dimensions and closes the decoder resource', async () => {
		const close = vi.fn()
		const createImageBitmap = vi.fn(async () => ({ close, height: 1080, width: 1920 }))

		await expect(
			decodeReviewImageDimensions(
				new Blob([pngBytes()], { type: 'image/png' }),
				undefined,
				createImageBitmap as unknown as typeof globalThis.createImageBitmap
			)
		).resolves.toEqual({ height: 1080, width: 1920 })
		expect(close).toHaveBeenCalledOnce()
	})

	it('fails closed when the bytes cannot be decoded', async () => {
		const createImageBitmap = vi.fn(async () => {
			throw new Error('decode failed')
		})

		await expect(
			decodeReviewImageDimensions(
				new Blob(['invalid']),
				undefined,
				createImageBitmap as unknown as typeof globalThis.createImageBitmap
			)
		).rejects.toMatchObject({ code: 'IMAGE_INVALID' })
	})
})

describe('resolveReviewImageDimensions', () => {
	it('uses decoded source pixels as the annotation coordinate system', () => {
		expect(resolveReviewImageDimensions(media, 1920, 1080)).toEqual({
			height: 1080,
			width: 1920,
		})
	})

	it.each([
		[1919, 1080],
		[1920, 1079],
		[0, 1080],
		[20_000, 20_000],
	])('rejects unsafe or inconsistent decoded dimensions %s×%s', (width, height) => {
		expect(() => resolveReviewImageDimensions(media, width, height)).toThrow(ReviewImageError)
	})

	it('accepts decoded dimensions when ShotGrid did not provide them', () => {
		expect(
			resolveReviewImageDimensions({ ...media, height: null, width: null }, 2048, 858)
		).toEqual({ height: 858, width: 2048 })
	})
})

function imageResponse(bytes: Uint8Array) {
	return new Response(Uint8Array.from(bytes).buffer, {
		headers: { 'Content-Type': 'image/png' },
	})
}

function pngBytes(imageData = new Uint8Array()) {
	const header = new Uint8Array(13)
	header[3] = 1
	header[7] = 1
	header[8] = 8
	header[9] = 6
	return concatenate([
		new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
		chunk('IHDR', header, false),
		chunk('IDAT', imageData, false),
		chunk('IEND', new Uint8Array(), false),
	])
}

function webpBytes() {
	const extendedHeader = chunk('VP8X', new Uint8Array(10), true)
	const imageData = chunk('VP8 ', new Uint8Array([0]), true)
	const payload = concatenate([new TextEncoder().encode('WEBP'), extendedHeader, imageData])
	const header = new Uint8Array(8)
	header.set(new TextEncoder().encode('RIFF'))
	new DataView(header.buffer).setUint32(4, payload.byteLength, true)
	return concatenate([header, payload])
}

function chunk(type: string, data: Uint8Array, littleEndian: boolean) {
	const padding = littleEndian && data.byteLength % 2 ? 1 : 0
	const result = new Uint8Array((littleEndian ? 8 : 12) + data.byteLength + padding)
	const typeOffset = littleEndian ? 0 : 4
	const lengthOffset = littleEndian ? 4 : 0
	new DataView(result.buffer).setUint32(lengthOffset, data.byteLength, littleEndian)
	result.set(new TextEncoder().encode(type), typeOffset)
	result.set(data, 8)
	return result
}

function concatenate(parts: Uint8Array[]) {
	const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
	let offset = 0
	for (const part of parts) {
		result.set(part, offset)
		offset += part.byteLength
	}
	return result
}
