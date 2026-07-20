import type { ReviewApiErrorCode, ReviewApiErrorEnvelope } from './contracts'

const CLIENT_MESSAGES: Record<ReviewApiErrorCode, string> = {
	INVALID_REQUEST: 'The review request is invalid.',
	AUTHENTICATION_REQUIRED: 'Authentication is required.',
	PERMISSION_DENIED: 'You do not have permission to perform this review action.',
	NOT_FOUND: 'The requested review item was not found.',
	INVALID_SHOTGRID_PATH: 'The requested ShotGrid operation is invalid.',
	SHOTGRID_AUTH_FAILED: 'The review service could not authenticate with ShotGrid.',
	SHOTGRID_PERMISSION_DENIED: 'ShotGrid did not allow this review action.',
	SHOTGRID_RATE_LIMITED: 'ShotGrid is receiving too many requests.',
	SHOTGRID_TIMEOUT: 'ShotGrid did not respond in time.',
	SHOTGRID_UNAVAILABLE: 'ShotGrid is temporarily unavailable.',
	SHOTGRID_INVALID_RESPONSE: 'ShotGrid returned an invalid response.',
	SHOTGRID_REQUEST_FAILED: 'ShotGrid could not complete the review action.',
	CONFIGURATION_ERROR: 'The review service is not configured correctly.',
	INTERNAL_ERROR: 'The review request could not be completed.',
}

export interface ReviewGatewayErrorOptions {
	code: ReviewApiErrorCode
	/** Accepted for call-site compatibility; client output always uses the fixed message for `code`. */
	message?: string
	status: number
	retryable: boolean
	upstreamStatus?: number
	cause?: unknown
}

export class ReviewGatewayError extends Error {
	readonly code: ReviewApiErrorCode
	readonly status: number
	readonly retryable: boolean
	readonly upstreamStatus?: number

	constructor(options: ReviewGatewayErrorOptions) {
		super(CLIENT_MESSAGES[options.code], { cause: options.cause })
		this.name = 'ReviewGatewayError'
		this.code = options.code
		this.status = options.status
		this.retryable = options.retryable
		this.upstreamStatus = options.upstreamStatus
	}

	toApiErrorEnvelope(requestId?: string): ReviewApiErrorEnvelope {
		return {
			error: {
				code: this.code,
				message: this.message,
				retryable: this.retryable,
				...(this.upstreamStatus === undefined
					? undefined
					: { upstreamStatus: this.upstreamStatus }),
				...(requestId === undefined ? undefined : { requestId }),
			},
		}
	}
}

export function isReviewGatewayError(error: unknown): error is ReviewGatewayError {
	return error instanceof ReviewGatewayError
}

export function toReviewApiErrorEnvelope(
	error: unknown,
	requestId?: string
): ReviewApiErrorEnvelope {
	if (isReviewGatewayError(error)) {
		return error.toApiErrorEnvelope(requestId)
	}

	return new ReviewGatewayError({
		code: 'INTERNAL_ERROR',
		status: 500,
		retryable: false,
		cause: error,
	}).toApiErrorEnvelope(requestId)
}
