import { describe, expect, it } from 'vitest'
import { parseReviewConfig } from './config'

describe('parseReviewConfig', () => {
	it('uses safe mock defaults', () => {
		expect(parseReviewConfig({})).toEqual({
			apiBaseUrl: '/api',
			dataMode: 'mock',
			tldrawLicenseKey: undefined,
		})
	})

	it('accepts ShotGrid mode through a server API boundary', () => {
		expect(
			parseReviewConfig({
				VITE_REVIEW_API_BASE_URL: 'https://review-api.example.test',
				VITE_REVIEW_DATA_MODE: 'shotgrid',
			})
		).toMatchObject({
			apiBaseUrl: 'https://review-api.example.test',
			dataMode: 'shotgrid',
		})
	})

	it('rejects ShotGrid secrets in browser configuration', () => {
		expect(() => parseReviewConfig({ VITE_SHOTGRID_SCRIPT_KEY: 'secret' })).toThrow(
			'must never be exposed through browser configuration'
		)
	})

	it('rejects unsupported data modes', () => {
		expect(() => parseReviewConfig({ VITE_REVIEW_DATA_MODE: 'live' })).toThrow(
			'Unsupported VITE_REVIEW_DATA_MODE'
		)
	})
})
