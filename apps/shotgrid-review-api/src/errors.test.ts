import { describe, expect, it } from 'vitest'
import { ReviewGatewayError, toReviewApiErrorEnvelope } from './errors'

describe('ReviewGatewayError', () => {
	it('exposes only the generic message in the API envelope', () => {
		const secret = 'super-secret-script-key'
		const error = new ReviewGatewayError({
			code: 'SHOTGRID_PERMISSION_DENIED',
			status: 502,
			retryable: false,
			upstreamStatus: 403,
			cause: new Error(`ShotGrid rejected ${secret}`),
		})

		expect(error.toApiErrorEnvelope('request-7')).toEqual({
			error: {
				code: 'SHOTGRID_PERMISSION_DENIED',
				message: 'ShotGrid did not allow this review action.',
				retryable: false,
				upstreamStatus: 403,
				requestId: 'request-7',
			},
		})
		expect(JSON.stringify(error.toApiErrorEnvelope())).not.toContain(secret)
	})

	it('normalizes unexpected errors without leaking their messages', () => {
		const response = toReviewApiErrorEnvelope(new Error('token=do-not-expose'))

		expect(response).toEqual({
			error: {
				code: 'INTERNAL_ERROR',
				message: 'The review request could not be completed.',
				retryable: false,
			},
		})
		expect(JSON.stringify(response)).not.toContain('do-not-expose')
	})

	it('exposes only typed publication identifiers for an indeterminate attachment', () => {
		const error = new ReviewGatewayError({
			cause: new Error('signed_url=https://storage.example/private content=secret'),
			code: 'PUBLICATION_INDETERMINATE',
			publication: {
				links: {
					entity: { id: 501, name: 'shot_010', type: 'Shot' },
					project: { id: 101, name: 'Project', type: 'Project' },
					task: { id: 601, name: 'Lighting' },
					version: { id: 301, name: 'shot_v001', type: 'Version' },
				},
				noteId: 401,
				publicationId: '018f3f72-1d6b-4c51-8f4b-a12c9d2e3478',
				stage: 'attachment-completion',
			},
			retryable: false,
			status: 502,
		})

		expect(error.toApiErrorEnvelope('request-8')).toMatchObject({
			error: {
				publication: {
					noteId: 401,
					publicationId: '018f3f72-1d6b-4c51-8f4b-a12c9d2e3478',
					stage: 'attachment-completion',
				},
				requestId: 'request-8',
			},
		})
		expect(JSON.stringify(error.toApiErrorEnvelope())).not.toContain('signed_url')
		expect(JSON.stringify(error.toApiErrorEnvelope())).not.toContain('content')
	})
})
