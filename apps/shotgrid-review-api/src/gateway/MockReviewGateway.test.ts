import { describe, expect, test } from 'vitest'
import { MockReviewGateway } from './MockReviewGateway'

describe('MockReviewGateway', () => {
	test('preserves project and version integrity for review notes', async () => {
		const gateway = new MockReviewGateway()

		await expect(
			gateway.createNote({
				content: 'Valid note',
				frame: null,
				projectId: 101,
				subject: 'Review',
				versionId: 301,
			})
		).resolves.toMatchObject({ projectId: 101, versionId: 301 })

		await expect(
			gateway.createNote({
				content: 'Cross-project note',
				frame: null,
				projectId: 102,
				subject: 'Invalid review',
				versionId: 301,
			})
		).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 })
	})

	test('returns only truthful status update fields', async () => {
		const gateway = new MockReviewGateway()

		await expect(
			gateway.updateVersionStatus({ statusCode: 'apr', versionId: 301 })
		).resolves.toEqual({
			statusCode: 'apr',
			updatedAt: '1970-01-01T00:00:00.000Z',
			versionId: 301,
		})
	})

	test('gets a contextual version only from its owning playlist', async () => {
		const gateway = new MockReviewGateway()

		await expect(gateway.getVersion(201, 301)).resolves.toMatchObject({
			entity: { id: 501, name: 'shot_010', type: 'Shot' },
			id: 301,
			media: {
				contentType: 'image/png',
				thumbnailUrl: '/mock-media/northstar-lighting.png',
				url: '/mock-media/northstar-lighting.png',
			},
			playlistId: 201,
			task: { id: 601, name: 'Lighting' },
		})
		await expect(gateway.getVersion(202, 301)).rejects.toMatchObject({
			code: 'NOT_FOUND',
			status: 404,
		})
	})

	test('does not proxy mock media that is already served by the review app', async () => {
		const gateway = new MockReviewGateway()

		await expect(gateway.getVersionImage(201, 301)).rejects.toMatchObject({
			code: 'NOT_FOUND',
			status: 404,
		})
	})

	test('only accepts attachments for notes created by this gateway', async () => {
		const gateway = new MockReviewGateway()
		const attachment = {
			contentBase64: Buffer.from('annotation').toString('base64'),
			contentType: 'image/png',
			fileName: 'annotation.png',
			noteId: 401,
		}

		await expect(gateway.uploadAttachment(attachment)).rejects.toMatchObject({
			code: 'NOT_FOUND',
			status: 404,
		})

		const note = await gateway.createNote({
			content: 'Valid note',
			frame: null,
			projectId: 101,
			subject: 'Review',
			versionId: 301,
		})
		await expect(
			gateway.uploadAttachment({ ...attachment, noteId: note.id })
		).resolves.toMatchObject({
			fileName: 'annotation.png',
			noteId: note.id,
		})
	})

	test('evicts the oldest retained note id after reaching capacity', async () => {
		const gateway = new MockReviewGateway(2)
		const noteRequest = {
			content: 'Valid note',
			frame: null,
			projectId: 101,
			subject: 'Review',
			versionId: 301,
		}
		const attachmentFor = (noteId: number) => ({
			contentBase64: Buffer.from('annotation').toString('base64'),
			contentType: 'image/png',
			fileName: 'annotation.png',
			noteId,
		})

		const first = await gateway.createNote(noteRequest)
		const second = await gateway.createNote(noteRequest)
		await expect(gateway.uploadAttachment(attachmentFor(first.id))).resolves.toMatchObject({
			noteId: first.id,
		})

		const third = await gateway.createNote(noteRequest)
		await expect(gateway.uploadAttachment(attachmentFor(first.id))).rejects.toMatchObject({
			code: 'NOT_FOUND',
			status: 404,
		})
		await expect(gateway.uploadAttachment(attachmentFor(second.id))).resolves.toMatchObject({
			noteId: second.id,
		})
		await expect(gateway.uploadAttachment(attachmentFor(third.id))).resolves.toMatchObject({
			noteId: third.id,
		})
	})
})
