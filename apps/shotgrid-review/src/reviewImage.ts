import type { ReviewImageMedia } from '@tldraw/shotgrid-review-contracts'

type FetchImplementation = typeof globalThis.fetch

const MAX_IMAGE_BYTES = 32 * 1024 * 1024
const MAX_IMAGE_DIMENSION = 8_192
const MAX_IMAGE_PIXELS = 16_777_216
const SUPPORTED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp'])

export type ReviewImageErrorCode =
	| 'IMAGE_INVALID'
	| 'IMAGE_TOO_LARGE'
	| 'IMAGE_UNAVAILABLE'
	| 'IMAGE_UNSUPPORTED'

export class ReviewImageError extends Error {
	readonly code: ReviewImageErrorCode

	constructor(code: ReviewImageErrorCode, message: string) {
		super(message)
		this.name = 'ReviewImageError'
		this.code = code
	}
}

export interface ReviewImageDimensions {
	height: number
	width: number
}

export async function fetchReviewImage(
	media: ReviewImageMedia,
	signal?: AbortSignal,
	fetchImplementation: FetchImplementation = globalThis.fetch
): Promise<Blob> {
	let response: Response
	try {
		response = await fetchImplementation(media.url, {
			cache: 'no-store',
			credentials: 'same-origin',
			headers: {
				Accept: 'image/webp,image/png,image/jpeg',
			},
			method: 'GET',
			mode: 'cors',
			redirect: 'error',
			referrerPolicy: 'no-referrer',
			signal,
		})
	} catch (error) {
		if (signal?.aborted || isAbortError(error)) throw error
		throw new ReviewImageError(
			'IMAGE_UNAVAILABLE',
			'The review image could not be downloaded safely.'
		)
	}

	if (!response.ok || response.redirected) {
		await cancelResponseBody(response)
		throw new ReviewImageError('IMAGE_UNAVAILABLE', 'The review image is unavailable.')
	}

	const contentType = normalizeContentType(response.headers.get('content-type'))
	const expectedContentType = normalizeContentType(media.contentType)
	if (
		!contentType ||
		!SUPPORTED_IMAGE_TYPES.has(contentType) ||
		!expectedContentType ||
		!SUPPORTED_IMAGE_TYPES.has(expectedContentType)
	) {
		await cancelResponseBody(response)
		throw new ReviewImageError('IMAGE_UNSUPPORTED', 'The review image format is unsupported.')
	}

	const declaredLength = response.headers.get('content-length')?.trim()
	if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > MAX_IMAGE_BYTES) {
		await cancelResponseBody(response)
		throw imageTooLargeError()
	}

	if (!response.body) {
		throw new ReviewImageError('IMAGE_INVALID', 'The review image response was empty.')
	}

	const reader = response.body.getReader()
	const chunks: Uint8Array[] = []
	let byteLength = 0
	let cancellationAttempted = false
	const cancelReader = async () => {
		if (cancellationAttempted) return
		cancellationAttempted = true
		try {
			await reader.cancel()
		} catch {
			// Preserve the safe image error that caused cancellation.
		}
	}

	try {
		for (;;) {
			const { done, value } = await reader.read()
			if (done) break
			byteLength += value.byteLength
			if (byteLength > MAX_IMAGE_BYTES) {
				await cancelReader()
				throw imageTooLargeError()
			}
			chunks.push(value)
		}
	} catch (error) {
		await cancelReader()
		if (error instanceof ReviewImageError || signal?.aborted || isAbortError(error)) throw error
		throw new ReviewImageError('IMAGE_INVALID', 'The review image response was interrupted.')
	} finally {
		reader.releaseLock()
	}

	if (byteLength === 0) {
		throw new ReviewImageError('IMAGE_INVALID', 'The review image response was empty.')
	}
	const bytes = concatenateChunks(chunks, byteLength)
	if (!isStaticRasterImage(bytes, contentType)) {
		throw new ReviewImageError(
			'IMAGE_INVALID',
			'The review image bytes do not match a supported static image.'
		)
	}
	return new Blob([bytes], { type: contentType })
}

export async function digestReviewImage(blob: Blob) {
	const digest = await globalThis.crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function decodeReviewImageDimensions(
	blob: Blob,
	signal?: AbortSignal,
	createImageBitmapImplementation: typeof globalThis.createImageBitmap = globalThis.createImageBitmap
): Promise<ReviewImageDimensions> {
	if (signal?.aborted) throw abortError()
	let bitmap: ImageBitmap
	try {
		bitmap = await createImageBitmapImplementation(blob)
	} catch (error) {
		if (signal?.aborted || isAbortError(error)) throw error
		throw new ReviewImageError('IMAGE_INVALID', 'The review image could not be decoded.')
	}
	try {
		if (signal?.aborted) throw abortError()
		return { height: bitmap.height, width: bitmap.width }
	} finally {
		bitmap.close()
	}
}

export function resolveReviewImageDimensions(
	media: ReviewImageMedia,
	naturalWidth: number,
	naturalHeight: number
): ReviewImageDimensions {
	if (
		!Number.isSafeInteger(naturalWidth) ||
		!Number.isSafeInteger(naturalHeight) ||
		naturalWidth <= 0 ||
		naturalHeight <= 0 ||
		naturalWidth > MAX_IMAGE_DIMENSION ||
		naturalHeight > MAX_IMAGE_DIMENSION ||
		naturalWidth * naturalHeight > MAX_IMAGE_PIXELS
	) {
		throw new ReviewImageError(
			'IMAGE_INVALID',
			'The review image dimensions are invalid or too large.'
		)
	}
	if (
		(media.width !== null && media.width !== naturalWidth) ||
		(media.height !== null && media.height !== naturalHeight)
	) {
		throw new ReviewImageError(
			'IMAGE_INVALID',
			'The downloaded image dimensions do not match the review metadata.'
		)
	}
	return { height: naturalHeight, width: naturalWidth }
}

function normalizeContentType(value: string | null) {
	if (!value) return null
	const normalized = value.split(';', 1)[0].trim().toLowerCase()
	return normalized === 'image/jpg' ? 'image/jpeg' : normalized
}

function concatenateChunks(chunks: Uint8Array[], byteLength: number) {
	const bytes = new Uint8Array(byteLength)
	let offset = 0
	for (const chunk of chunks) {
		bytes.set(chunk, offset)
		offset += chunk.byteLength
	}
	return bytes
}

function isStaticRasterImage(bytes: Uint8Array, contentType: string) {
	if (contentType === 'image/jpeg') {
		return (
			bytes.length >= 4 &&
			bytes[0] === 0xff &&
			bytes[1] === 0xd8 &&
			bytes[bytes.length - 2] === 0xff &&
			bytes[bytes.length - 1] === 0xd9
		)
	}
	if (contentType === 'image/png') {
		return isStaticPng(bytes)
	}
	return isStaticWebp(bytes)
}

function startsWith(bytes: Uint8Array, prefix: number[]) {
	return prefix.every((byte, index) => bytes[index] === byte)
}

function isStaticPng(bytes: Uint8Array) {
	if (!startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return false
	let offset = 8
	let sawHeader = false
	let sawImageData = false
	while (offset + 12 <= bytes.length) {
		const dataLength = readUInt32BE(bytes, offset)
		const chunkEnd = offset + 12 + dataLength
		if (chunkEnd > bytes.length) return false
		const typeOffset = offset + 4
		if (!sawHeader) {
			if (!containsAsciiAt(bytes, 'IHDR', typeOffset) || dataLength !== 13) return false
			sawHeader = true
		}
		if (
			containsAsciiAt(bytes, 'acTL', typeOffset) ||
			containsAsciiAt(bytes, 'fcTL', typeOffset) ||
			containsAsciiAt(bytes, 'fdAT', typeOffset)
		) {
			return false
		}
		if (containsAsciiAt(bytes, 'IDAT', typeOffset)) sawImageData = true
		if (containsAsciiAt(bytes, 'IEND', typeOffset)) {
			return dataLength === 0 && sawHeader && sawImageData && chunkEnd === bytes.length
		}
		offset = chunkEnd
	}
	return false
}

function isStaticWebp(bytes: Uint8Array) {
	if (
		bytes.length < 20 ||
		!containsAsciiAt(bytes, 'RIFF', 0) ||
		!containsAsciiAt(bytes, 'WEBP', 8) ||
		readUInt32LE(bytes, 4) + 8 !== bytes.length
	) {
		return false
	}
	let offset = 12
	let sawImageData = false
	while (offset + 8 <= bytes.length) {
		const dataLength = readUInt32LE(bytes, offset + 4)
		const dataStart = offset + 8
		const chunkEnd = dataStart + dataLength
		if (chunkEnd > bytes.length) return false
		if (containsAsciiAt(bytes, 'ANIM', offset) || containsAsciiAt(bytes, 'ANMF', offset)) {
			return false
		}
		if (containsAsciiAt(bytes, 'VP8X', offset)) {
			if (dataLength < 10 || (bytes[dataStart] & 0x02) !== 0) return false
		}
		if (containsAsciiAt(bytes, 'VP8 ', offset) || containsAsciiAt(bytes, 'VP8L', offset)) {
			sawImageData = true
		}
		offset = chunkEnd + (dataLength % 2)
	}
	return sawImageData && offset === bytes.length
}

function containsAsciiAt(bytes: Uint8Array, value: string, offset: number) {
	for (let index = 0; index < value.length; index++) {
		if (bytes[offset + index] !== value.charCodeAt(index)) return false
	}
	return true
}

function readUInt32BE(bytes: Uint8Array, offset: number) {
	return (
		bytes[offset] * 0x1000000 +
		(bytes[offset + 1] << 16) +
		(bytes[offset + 2] << 8) +
		bytes[offset + 3]
	)
}

function readUInt32LE(bytes: Uint8Array, offset: number) {
	return (
		bytes[offset] +
		(bytes[offset + 1] << 8) +
		(bytes[offset + 2] << 16) +
		bytes[offset + 3] * 0x1000000
	)
}

function imageTooLargeError() {
	return new ReviewImageError('IMAGE_TOO_LARGE', 'The review image exceeds the 32 MiB limit.')
}

async function cancelResponseBody(response: Response) {
	try {
		await response.body?.cancel()
	} catch {
		// Preserve the safe image error that caused cancellation.
	}
}

function isAbortError(error: unknown) {
	return error instanceof Error && error.name === 'AbortError'
}

function abortError() {
	return new DOMException('The image operation was aborted.', 'AbortError')
}
