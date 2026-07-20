import { describe, expect, it } from 'vitest'
import { ReviewApiClientError } from './reviewApiClient'
import { ReviewBrowserInvalidResponseError, ReviewBrowserNotFoundError } from './reviewBrowser'
import { resolveReviewPath, toReviewBrowserDisplayError } from './useReviewBrowser'

describe('resolveReviewPath', () => {
	it('loads root and legacy paths with canonical replacement', () => {
		expect(resolveReviewPath('/')).toEqual({
			historyMode: 'replace',
			request: { playlistId: null, projectId: null, versionId: null },
		})
		expect(resolveReviewPath('/review/201/301')).toEqual({
			historyMode: 'replace',
			request: { playlistId: 201, projectId: null, versionId: 301 },
		})
	})

	it('keeps canonical history entries and rejects malformed paths', () => {
		expect(resolveReviewPath('/review/101/201/301')).toEqual({
			historyMode: 'none',
			request: { playlistId: 201, projectId: 101, versionId: 301 },
		})
		expect(resolveReviewPath('/review/not-an-id/201/301')).toBeNull()
	})

	it('canonicalizes explicit partial selections after loading them', () => {
		expect(resolveReviewPath('/review/projects/101')).toEqual({
			historyMode: 'replace',
			request: { playlistId: null, projectId: 101, versionId: null },
		})
		expect(resolveReviewPath('/review/projects/101/playlists/201')).toEqual({
			historyMode: 'replace',
			request: { playlistId: 201, projectId: 101, versionId: null },
		})
	})
})

describe('toReviewBrowserDisplayError', () => {
	it('distinguishes not-found, permission, and retryable upstream failures', () => {
		expect(toReviewBrowserDisplayError(new ReviewBrowserNotFoundError())).toMatchObject({
			kind: 'not-found',
			retryable: false,
		})
		expect(
			toReviewBrowserDisplayError(
				new ReviewApiClientError({
					code: 'SHOTGRID_PERMISSION_DENIED',
					message: 'safe error',
					requestId: 'request-permission',
					retryable: false,
					status: 403,
				})
			)
		).toMatchObject({ kind: 'permission', requestId: 'request-permission', retryable: false })
		expect(
			toReviewBrowserDisplayError(
				new ReviewApiClientError({
					code: 'SHOTGRID_TIMEOUT',
					message: 'safe error',
					retryable: true,
					status: 504,
				})
			)
		).toMatchObject({ kind: 'upstream', retryable: true })
	})

	it('does not offer retry for a non-retryable gateway contract error', () => {
		const result = toReviewBrowserDisplayError(
			new ReviewApiClientError({
				code: 'INVALID_RESPONSE',
				message: 'safe error',
				retryable: false,
				status: 200,
			})
		)
		expect(result).toMatchObject({ kind: 'general', retryable: false })
	})

	it('does not offer retry for an inconsistent browser relationship', () => {
		expect(toReviewBrowserDisplayError(new ReviewBrowserInvalidResponseError())).toMatchObject({
			kind: 'general',
			retryable: false,
		})
	})
})
