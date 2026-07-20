import { describe, expect, it } from 'vitest'
import {
	type CreateReviewNoteRequest,
	type ReviewApiErrorEnvelope,
	type ReviewVersion,
	type UploadReviewAttachmentRequest,
} from './contracts'

describe('review API contracts', () => {
	it('represents frame-aware image and note data', () => {
		const version = {
			id: 101,
			projectId: 7,
			playlistId: 20,
			name: 'Lighting review v012',
			description: null,
			statusCode: 'rev',
			createdAt: '2026-07-20T08:00:00.000Z',
			createdBy: null,
			entity: { id: 501, name: 'shot_010', type: 'Shot' },
			submittedBy: null,
			task: { id: 601, name: 'Lighting' },
			media: {
				kind: 'image',
				url: 'https://media.example.test/version-101.png',
				thumbnailUrl: null,
				contentType: 'image/png',
				width: 1920,
				height: 1080,
			},
		} satisfies ReviewVersion
		const note = {
			projectId: 7,
			versionId: version.id,
			subject: 'Adjust the rim light',
			content: 'Reduce the intensity on frame 1042.',
			frame: 1042,
		} satisfies CreateReviewNoteRequest

		expect({ version, note }).toMatchObject({
			version: { id: 101, media: { kind: 'image' } },
			note: { versionId: 101, frame: 1042 },
		})
	})

	it('keeps attachment bytes in the server request contract', () => {
		const attachment = {
			noteId: 501,
			fileName: 'annotation.png',
			contentType: 'image/png',
			contentBase64: 'c2FmZS10ZXN0LWJ5dGVz',
		} satisfies UploadReviewAttachmentRequest

		expect(attachment).toEqual({
			noteId: 501,
			fileName: 'annotation.png',
			contentType: 'image/png',
			contentBase64: 'c2FmZS10ZXN0LWJ5dGVz',
		})
	})

	it('uses a stable client error envelope', () => {
		const response = {
			error: {
				code: 'SHOTGRID_TIMEOUT',
				message: 'ShotGrid did not respond in time.',
				retryable: true,
				requestId: 'request-123',
			},
		} satisfies ReviewApiErrorEnvelope

		expect(response.error.code).toBe('SHOTGRID_TIMEOUT')
	})
})
