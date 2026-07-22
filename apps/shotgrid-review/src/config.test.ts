import { describe, expect, it } from 'vitest'
import { parseReviewConfig } from './config'

describe('parseReviewConfig', () => {
	it('uses safe mock defaults', () => {
		expect(parseReviewConfig({})).toEqual({
			apiBaseUrl: '/api',
			dataMode: 'mock',
			storageNamespace: 'local-dev',
			tldrawLicenseKey: undefined,
		})
	})

	it('accepts ShotGrid mode through a server API boundary', () => {
		expect(
			parseReviewConfig({
				VITE_REVIEW_API_BASE_URL: '/api',
				VITE_REVIEW_DATA_MODE: 'shotgrid',
				VITE_REVIEW_STORAGE_NAMESPACE: 'studio-sandbox',
			})
		).toMatchObject({
			apiBaseUrl: '/api',
			dataMode: 'shotgrid',
		})
	})

	it('accepts a nested same-origin API root in ShotGrid mode', () => {
		expect(
			parseReviewConfig({
				VITE_REVIEW_API_BASE_URL: '/review/api/',
				VITE_REVIEW_DATA_MODE: 'shotgrid',
				VITE_REVIEW_STORAGE_NAMESPACE: 'studio-sandbox',
			})
		).toMatchObject({ apiBaseUrl: '/review/api/' })
	})

	it.each([
		'api',
		'https://review-api.example.test/api',
		'https://user:password@review-api.example.test/api',
		'//review-api.example.test/api',
		'//user@review-api.example.test/api',
		'/api?tenant=studio',
		'/api#review',
		'\\api',
		'/api\\admin',
		'/api//admin',
		'/api/../admin',
	])('rejects unsafe ShotGrid API base URL %s', (apiBaseUrl) => {
		expect(() =>
			parseReviewConfig({
				VITE_REVIEW_API_BASE_URL: apiBaseUrl,
				VITE_REVIEW_DATA_MODE: 'shotgrid',
				VITE_REVIEW_STORAGE_NAMESPACE: 'studio-sandbox',
			})
		).toThrow('same-origin root-relative path')
	})

	it('keeps absolute API base URLs available in mock mode', () => {
		expect(
			parseReviewConfig({
				VITE_REVIEW_API_BASE_URL: 'https://review-api.example.test',
				VITE_REVIEW_DATA_MODE: 'mock',
			})
		).toMatchObject({ apiBaseUrl: 'https://review-api.example.test', dataMode: 'mock' })
	})

	it('requires an explicit persistence namespace in ShotGrid mode', () => {
		expect(() => parseReviewConfig({ VITE_REVIEW_DATA_MODE: 'shotgrid' })).toThrow(
			'ShotGrid mode requires VITE_REVIEW_STORAGE_NAMESPACE'
		)
	})

	it('rejects ShotGrid values in browser configuration', () => {
		expect(() => parseReviewConfig({ VITE_SHOTGRID_SESSION_TOKEN: 'secret' })).toThrow(
			"uses Vite's public environment prefix"
		)
	})

	it('rejects every non-allowlisted VITE variable', () => {
		expect(() => parseReviewConfig({ VITE_PUBLIC_ANALYTICS_ID: 'tracking-id' })).toThrow(
			"uses Vite's public environment prefix"
		)
	})

	it('rejects unsupported data modes', () => {
		expect(() => parseReviewConfig({ VITE_REVIEW_DATA_MODE: 'live' })).toThrow(
			'Unsupported VITE_REVIEW_DATA_MODE'
		)
	})

	it('validates the persistence namespace', () => {
		expect(() => parseReviewConfig({ VITE_REVIEW_STORAGE_NAMESPACE: 'unsafe namespace' })).toThrow(
			'VITE_REVIEW_STORAGE_NAMESPACE contains unsupported characters'
		)
	})
})
