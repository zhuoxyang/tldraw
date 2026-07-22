import { describe, expect, it } from 'vitest'
import {
	assertAllowedPublicEnvironment,
	assertNoPublicShotGridEnvironment,
	assertShotGridApiBaseUrl,
	validateViteEnvironment,
} from './publicEnvPolicy'

describe('public environment policy', () => {
	it('rejects every ShotGrid value using the Vite public prefix', () => {
		expect(() =>
			assertNoPublicShotGridEnvironment({ VITE_SHOTGRID_ACCESS_TOKEN: 'secret' })
		).toThrow("uses Vite's public environment prefix")
	})

	it('rejects a trusted proxy token using the Vite public prefix', () => {
		expect(() =>
			assertNoPublicShotGridEnvironment({
				VITE_REVIEW_API_TRUSTED_PROXY_TOKEN: 'server-only-token',
			})
		).toThrow("uses Vite's public environment prefix")
	})

	it('allows only the four documented public environment variables', () => {
		expect(() =>
			assertAllowedPublicEnvironment({
				VITE_REVIEW_API_BASE_URL: '/api',
				VITE_REVIEW_DATA_MODE: 'shotgrid',
				VITE_REVIEW_STORAGE_NAMESPACE: 'studio-sandbox',
				VITE_TLDRAW_LICENSE_KEY: 'public-license-key',
			})
		).not.toThrow()
	})

	it.each([
		'VITE_ANALYTICS_KEY',
		'VITE_REVIEW_API_TRUSTED_PROXY_TOKEN',
		'VITE_REVIEW_EXTRA',
		'VITE_SHOTGRID_SCRIPT_KEY',
	])('rejects non-allowlisted public variable %s', (name) => {
		expect(() => assertAllowedPublicEnvironment({ [name]: '' })).toThrow(
			"uses Vite's public environment prefix"
		)
	})

	it('does not reject private server environment variables', () => {
		expect(() =>
			assertAllowedPublicEnvironment({
				REVIEW_API_DEV_TARGET: 'http://127.0.0.1:5431',
				SHOTGRID_SCRIPT_KEY: 'server-only-secret',
			})
		).not.toThrow()
	})

	it('allows an explicitly public tldraw license key', () => {
		expect(() =>
			validateViteEnvironment(
				{
					VITE_REVIEW_DATA_MODE: 'shotgrid',
					VITE_REVIEW_STORAGE_NAMESPACE: 'studio-sandbox',
					VITE_TLDRAW_LICENSE_KEY: 'public-license-key',
				},
				'build'
			)
		).not.toThrow()
	})

	it.each(['/api', '/review/api', '/review-api/v1/'])(
		'allows same-origin root-relative ShotGrid API path %s',
		(apiBaseUrl) => {
			expect(() => assertShotGridApiBaseUrl(apiBaseUrl)).not.toThrow()
		}
	)

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
		expect(() => assertShotGridApiBaseUrl(apiBaseUrl)).toThrow(
			'ShotGrid mode requires VITE_REVIEW_API_BASE_URL to be a same-origin root-relative path'
		)
	})

	it('enforces the ShotGrid API boundary during Vite validation', () => {
		expect(() =>
			validateViteEnvironment(
				{
					VITE_REVIEW_API_BASE_URL: 'https://review-api.example.test',
					VITE_REVIEW_DATA_MODE: 'shotgrid',
				},
				'serve'
			)
		).toThrow('same-origin root-relative path')
	})

	it('keeps absolute mock API base URLs available', () => {
		expect(() =>
			validateViteEnvironment(
				{
					VITE_REVIEW_API_BASE_URL: 'https://review-api.example.test',
					VITE_REVIEW_DATA_MODE: 'mock',
				},
				'serve'
			)
		).not.toThrow()
	})

	it('blocks ShotGrid production builds without a storage namespace', () => {
		expect(() =>
			validateViteEnvironment(
				{
					VITE_REVIEW_DATA_MODE: 'shotgrid',
					VITE_TLDRAW_LICENSE_KEY: 'public-license-key',
				},
				'build'
			)
		).toThrow('ShotGrid production builds require VITE_REVIEW_STORAGE_NAMESPACE')
	})

	it('blocks ShotGrid production builds without a tldraw license key', () => {
		expect(() => validateViteEnvironment({ VITE_REVIEW_DATA_MODE: 'shotgrid' }, 'build')).toThrow(
			'ShotGrid production builds require VITE_TLDRAW_LICENSE_KEY'
		)
	})

	it('allows mock builds without a tldraw license key', () => {
		expect(() => validateViteEnvironment({}, 'build')).not.toThrow()
	})
})
