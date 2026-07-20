import { describe, expect, it } from 'vitest'
import { assertNoPublicShotGridEnvironment, validateViteEnvironment } from './publicEnvPolicy'

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
