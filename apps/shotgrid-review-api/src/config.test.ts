import { describe, expect, it } from 'vitest'
import { parseGatewayConfig } from './config'
import { ReviewGatewayError } from './errors'

const LIVE_ENVIRONMENT = {
	SHOTGRID_GATEWAY_MODE: 'shotgrid',
	SHOTGRID_SITE_URL: 'https://studio.shotgrid.autodesk.com',
	SHOTGRID_SCRIPT_NAME: 'review-gateway',
	SHOTGRID_SCRIPT_KEY: 'private-test-key',
} as const

function expectConfigurationError(environment: Record<string, string | undefined>) {
	try {
		parseGatewayConfig(environment)
	} catch (error) {
		expect(error).toBeInstanceOf(ReviewGatewayError)
		expect(error).toMatchObject({
			code: 'CONFIGURATION_ERROR',
			status: 500,
			retryable: false,
		})
		return error as ReviewGatewayError
	}
	throw new Error('Expected configuration parsing to fail')
}

describe('parseGatewayConfig', () => {
	it('uses safe local mock defaults', () => {
		expect(parseGatewayConfig({})).toEqual({
			mode: 'mock',
			host: '127.0.0.1',
			port: 5431,
			allowedOrigin: 'http://127.0.0.1:5430',
		})
	})

	it('parses live ShotGrid credentials and request policy', () => {
		expect(
			parseGatewayConfig({
				...LIVE_ENVIRONMENT,
				REVIEW_API_HOST: '0.0.0.0',
				REVIEW_API_PORT: '6543',
				REVIEW_APP_ORIGIN: 'https://review.example.test/',
				SHOTGRID_SUDO_AS_LOGIN: 'reviewer@example.test',
				SHOTGRID_TIMEOUT_MS: '25000',
				SHOTGRID_MAX_RETRIES: '4',
			})
		).toEqual({
			mode: 'shotgrid',
			host: '0.0.0.0',
			port: 6543,
			allowedOrigin: 'https://review.example.test',
			shotgrid: {
				siteUrl: 'https://studio.shotgrid.autodesk.com',
				scriptName: 'review-gateway',
				scriptKey: 'private-test-key',
				sudoAsLogin: 'reviewer@example.test',
				timeoutMs: 25_000,
				maxRetries: 4,
			},
		})
	})

	it.each([
		['REVIEW_API_PORT', '0'],
		['REVIEW_API_PORT', '65536'],
		['REVIEW_API_PORT', '5431.5'],
		['SHOTGRID_TIMEOUT_MS', '0'],
		['SHOTGRID_TIMEOUT_MS', '120001'],
		['SHOTGRID_MAX_RETRIES', '-1'],
		['SHOTGRID_MAX_RETRIES', '11'],
		['SHOTGRID_MAX_RETRIES', '1.5'],
	])('rejects an invalid %s value', (name, value) => {
		expectConfigurationError({ [name]: value })
	})

	it.each(['SHOTGRID_SITE_URL', 'SHOTGRID_SCRIPT_NAME', 'SHOTGRID_SCRIPT_KEY'])(
		'requires %s in ShotGrid mode',
		(name) => {
			expectConfigurationError({ ...LIVE_ENVIRONMENT, [name]: undefined })
		}
	)

	it.each([
		'http://studio.shotgrid.autodesk.com',
		'https://user:password@studio.shotgrid.autodesk.com',
		'https://studio.shotgrid.autodesk.com/api/v1.1',
		'https://studio.shotgrid.autodesk.com?token=value',
		'https://studio.shotgrid.autodesk.com#fragment',
	])('rejects an unsafe ShotGrid site URL: %s', (siteUrl) => {
		const error = expectConfigurationError({ ...LIVE_ENVIRONMENT, SHOTGRID_SITE_URL: siteUrl })

		expect(error.message).not.toContain(siteUrl)
	})

	it('never includes the script key in a configuration error', () => {
		const secret = 'a-secret-that-must-not-be-logged'
		const error = expectConfigurationError({
			...LIVE_ENVIRONMENT,
			SHOTGRID_SITE_URL: 'not a URL',
			SHOTGRID_SCRIPT_KEY: secret,
		})

		expect(error.message).not.toContain(secret)
		expect(String(error.cause)).not.toContain(secret)
		expect(JSON.stringify(error.toApiErrorEnvelope())).not.toContain(secret)
	})

	it.each([
		'ftp://review.example.test',
		'https://user:password@review.example.test',
		'https://review.example.test/reviews',
		'https://review.example.test?debug=true',
	])('rejects an invalid browser origin: %s', (allowedOrigin) => {
		expectConfigurationError({ REVIEW_APP_ORIGIN: allowedOrigin })
	})
})
