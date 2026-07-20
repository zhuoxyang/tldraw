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
})
