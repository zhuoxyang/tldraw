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
})
