import { beforeEach, describe, expect, it, vi } from 'vitest'

const publicationMocks = vi.hoisted(() => ({
	assertRecords: vi.fn(),
	decode: vi.fn(async () => ({ height: 1080, width: 1920 })),
	digest: vi.fn(async () => 'b'.repeat(64)),
	getSnapshot: vi.fn(() => ({ document: {}, session: {} })),
}))

vi.mock('tldraw', async (importOriginal) => ({
	...(await importOriginal<typeof import('tldraw')>()),
	getSnapshot: publicationMocks.getSnapshot,
}))

vi.mock('./reviewAnnotationSnapshot', async (importOriginal) => ({
	...(await importOriginal<typeof import('./reviewAnnotationSnapshot')>()),
	assertReviewAnnotationRecords: publicationMocks.assertRecords,
}))

vi.mock('./reviewImage', async (importOriginal) => ({
	...(await importOriginal<typeof import('./reviewImage')>()),
	decodeReviewImageDimensions: publicationMocks.decode,
	digestReviewImage: publicationMocks.digest,
}))

import type { Editor } from 'tldraw'
import type { LoadedReviewImage } from './reviewAnnotationEditor'
import {
	createReviewPublicationId,
	prepareReviewPublication,
	renderReviewPng,
	sanitizeReviewFileNameBase,
} from './reviewPublication'

const publicationId = '11111111-1111-4111-8111-111111111111'
const publicationCrypto = {
	getRandomValues<T extends ArrayBufferView>(array: T) {
		return array
	},
	randomUUID: () => publicationId,
}

beforeEach(() => {
	vi.clearAllMocks()
	publicationMocks.decode.mockResolvedValue({ height: 1080, width: 1920 })
	publicationMocks.digest.mockResolvedValue('b'.repeat(64))
})

describe('prepareReviewPublication', () => {
	it('creates a canonical immutable retry payload from one PNG', async () => {
		const prepared = await prepareReviewPublication(
			{
				content: '  Please address marker 1.  ',
				fileName: 'shot_010.annotated.png',
				generation: 0,
				png: new Blob(['hello'], { type: 'image/png' }),
				recipientIds: [7, 8],
				subject: '  Review: shot_010  ',
			},
			publicationCrypto
		)

		expect(prepared).toEqual({
			fingerprint: 'b'.repeat(64),
			generation: 0,
			publicationId,
			request: {
				attachment: {
					contentBase64: 'aGVsbG8=',
					contentType: 'image/png',
					fileName: 'shot_010.annotated.png',
					sha256: 'b'.repeat(64),
				},
				content: 'Please address marker 1.',
				recipientIds: [7, 8],
				subject: 'Review: shot_010',
			},
		})
		expect(publicationMocks.digest).toHaveBeenCalledTimes(2)
	})

	it('rejects invalid form values before encoding the PNG', async () => {
		await expect(
			prepareReviewPublication(
				{
					content: '   ',
					fileName: 'shot.png',
					generation: 0,
					png: new Blob(['hello'], { type: 'image/png' }),
					recipientIds: [7, 7],
					subject: 'Review',
				},
				publicationCrypto
			)
		).rejects.toThrow(/note content/i)
		expect(publicationMocks.digest).not.toHaveBeenCalled()
	})

	it('removes bidirectional controls from generated file names', () => {
		const fileName = `${sanitizeReviewFileNameBase('shot_010\u202Egnp.exe')}.annotated.png`
		expect(fileName).toBe('shot_010-gnp.exe.annotated.png')
		expect(fileName).not.toMatch(/\p{Bidi_Control}/u)
	})

	it('generates UUID v4 variant bits when randomUUID is unavailable', () => {
		const fallbackCrypto = {
			getRandomValues<T extends ArrayBufferView>(array: T) {
				new Uint8Array(array.buffer, array.byteOffset, array.byteLength).fill(0)
				return array
			},
		}
		expect(createReviewPublicationId(fallbackCrypto)).toBe('00000000-0000-4000-8000-000000000000')
	})
})

describe('renderReviewPng', () => {
	it('renders and validates a PNG without downloading it', async () => {
		const png = new Blob(['png'], { type: 'image/png' })
		const editor = {
			getAsset: vi.fn(() => ({ props: { src: 'asset:source' }, type: 'image' })),
			getCurrentPageShapeIds: vi.fn(() => new Set(['shape:source'])),
			getShape: vi.fn(() => ({ isLocked: true, type: 'image' })),
			resolveAssetUrl: vi.fn(async () => 'blob:local-source'),
			store: {},
			toImage: vi.fn(async () => ({ blob: png })),
		} as unknown as Editor
		const image: LoadedReviewImage = {
			blob: new Blob(['source'], { type: 'image/png' }),
			contentType: 'image/png',
			height: 1080,
			name: 'shot_010',
			sha256: 'a'.repeat(64),
			versionId: 301,
			width: 1920,
		}

		await expect(renderReviewPng(editor, image)).resolves.toBe(png)
		expect(editor.toImage).toHaveBeenCalledOnce()
		expect(publicationMocks.assertRecords).toHaveBeenCalledOnce()
		expect(publicationMocks.decode).toHaveBeenCalledWith(png)
	})
})
