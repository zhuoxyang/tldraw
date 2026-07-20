import type { ReviewPublicationRequest } from '@tldraw/shotgrid-review-contracts'
import { Box, getSnapshot, type Editor } from 'tldraw'
import {
	getReviewExportOptions,
	getReviewImageIds,
	type LoadedReviewImage,
} from './reviewAnnotationEditor'
import { assertReviewAnnotationRecords } from './reviewAnnotationSnapshot'
import { decodeReviewImageDimensions, digestReviewImage } from './reviewImage'

export const MAX_REVIEW_PUBLICATION_PNG_BYTES = 10 * 1024 * 1024
export const MAX_REVIEW_PUBLICATION_RECIPIENTS = 50
export const MAX_REVIEW_PUBLICATION_SUBJECT_LENGTH = 255
export const MAX_REVIEW_PUBLICATION_CONTENT_LENGTH = 10_000

export function sanitizeReviewFileNameBase(value: string) {
	const normalized = value
		.normalize('NFKC')
		.replace(/[<>:"/\\|?*]/g, '-')
		.replace(/[\p{Cc}\p{Bidi_Control}]/gu, '-')
		.replace(/[. ]+$/g, '')
		.slice(0, 96)
	return normalized || 'shotgrid-review'
}

export interface ReviewPublicationDraftInput {
	content: string
	fileName: string
	generation: number
	png: Blob
	recipientIds: number[]
	subject: string
}

export interface PreparedReviewPublication {
	fingerprint: string
	generation: number
	publicationId: string
	request: ReviewPublicationRequest
}

interface ReviewCrypto {
	getRandomValues<T extends ArrayBufferView>(array: T): T
	randomUUID?(): string
}

export async function renderReviewPng(editor: Editor, image: LoadedReviewImage) {
	const { assetId, shapeId } = getReviewImageIds(image.versionId)
	assertReviewAnnotationRecords(getSnapshot(editor.store), {
		sourceAssetId: assetId,
		sourceShapeId: shapeId,
	})
	const asset = editor.getAsset(assetId)
	const shape = editor.getShape(shapeId)
	if (asset?.type !== 'image' || shape?.type !== 'image' || !shape.isLocked) {
		throw new Error('The protected source image is missing from this review.')
	}
	if (!asset.props.src || !/^(asset:|data:image\/)/.test(asset.props.src)) {
		throw new Error('The source image is not stored locally and cannot be exported safely.')
	}
	const resolvedSource = await editor.resolveAssetUrl(assetId, {
		shouldResolveToOriginal: true,
	})
	if (!resolvedSource || !/^(blob:|data:image\/)/.test(resolvedSource)) {
		throw new Error('The local source image could not be resolved for export.')
	}

	const bounds = new Box(0, 0, image.width, image.height)
	const { blob } = await editor.toImage(
		[...editor.getCurrentPageShapeIds()],
		getReviewExportOptions(bounds)
	)
	if (blob.type !== 'image/png') throw new Error('The editor did not produce a PNG image.')
	if (blob.size === 0) throw new Error('The editor produced an empty PNG image.')
	const exported = await decodeReviewImageDimensions(blob)
	if (exported.width !== image.width || exported.height !== image.height) {
		throw new Error('The exported PNG does not match the source image resolution.')
	}
	return blob
}

export async function prepareReviewPublication(
	input: ReviewPublicationDraftInput,
	cryptoImplementation: ReviewCrypto = globalThis.crypto
): Promise<PreparedReviewPublication> {
	const subject = input.subject.trim()
	const content = input.content.trim()
	if (!Number.isSafeInteger(input.generation) || input.generation < 0) {
		throw new Error('The publication generation is invalid.')
	}
	if (subject.length === 0 || subject.length > MAX_REVIEW_PUBLICATION_SUBJECT_LENGTH) {
		throw new Error('The note subject must be between 1 and 255 characters.')
	}
	if (content.length === 0 || content.length > MAX_REVIEW_PUBLICATION_CONTENT_LENGTH) {
		throw new Error('The note content must be between 1 and 10,000 characters.')
	}
	if (
		input.recipientIds.length > MAX_REVIEW_PUBLICATION_RECIPIENTS ||
		new Set(input.recipientIds).size !== input.recipientIds.length ||
		input.recipientIds.some((id) => !Number.isSafeInteger(id) || id <= 0)
	) {
		throw new Error('The selected recipients are invalid.')
	}
	if (
		input.fileName.trim() !== input.fileName ||
		input.fileName.length === 0 ||
		input.fileName.length > 255 ||
		/[\p{Cc}\p{Bidi_Control}]/u.test(input.fileName) ||
		input.fileName !== input.fileName.split(/[\\/]/).at(-1) ||
		!input.fileName.toLowerCase().endsWith('.png')
	) {
		throw new Error('The annotation file name is invalid.')
	}
	if (
		input.png.type !== 'image/png' ||
		input.png.size === 0 ||
		input.png.size > MAX_REVIEW_PUBLICATION_PNG_BYTES
	) {
		throw new Error('The flattened PNG must be between 1 byte and 10 MiB.')
	}

	const [contentBase64, sha256] = await Promise.all([
		blobToBase64(input.png),
		digestReviewImage(input.png),
	])
	const request: ReviewPublicationRequest = {
		attachment: {
			contentBase64,
			contentType: 'image/png',
			fileName: input.fileName,
			sha256,
		},
		content,
		recipientIds: input.recipientIds.slice(),
		subject,
	}
	const fingerprint = await digestReviewImage(
		new Blob([publicationFingerprintSource(request)], { type: 'application/json' })
	)
	return {
		fingerprint,
		generation: input.generation,
		publicationId: createReviewPublicationId(cryptoImplementation),
		request,
	}
}

export function createReviewPublicationId(
	cryptoImplementation: ReviewCrypto = globalThis.crypto
): string {
	if (cryptoImplementation.randomUUID) return cryptoImplementation.randomUUID().toLowerCase()
	const bytes = cryptoImplementation.getRandomValues(new Uint8Array(16))
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

async function blobToBase64(blob: Blob) {
	const bytes = new Uint8Array(await blob.arrayBuffer())
	let binary = ''
	for (let offset = 0; offset < bytes.length; offset += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
	}
	return btoa(binary)
}

function publicationFingerprintSource(request: ReviewPublicationRequest) {
	return JSON.stringify({
		attachment: {
			contentType: request.attachment.contentType,
			fileName: request.attachment.fileName,
			sha256: request.attachment.sha256,
		},
		content: request.content,
		recipientIds: request.recipientIds,
		subject: request.subject,
	})
}
