import { parse, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseGatewayConfig } from './config'
import { ReviewGatewayError } from './errors'

const PUBLICATION_STORE_DIR = resolve('/var/lib/shotgrid-review-publications')
const SYNC_STORE_DIR = resolve('/var/lib/shotgrid-review-sync')
const EVENT_STORE_DIR = resolve('/var/lib/shotgrid-review-events')
const AUDIT_STORE_DIR = resolve('/var/lib/shotgrid-review-audit')

const LIVE_ENVIRONMENT = {
	SHOTGRID_GATEWAY_MODE: 'shotgrid',
	SHOTGRID_SITE_URL: 'https://studio.shotgrid.autodesk.com',
	SHOTGRID_SCRIPT_NAME: 'review-gateway',
	SHOTGRID_SCRIPT_KEY: 'private-test-key',
	SHOTGRID_REVIEW_PUBLICATION_STORE_DIR: PUBLICATION_STORE_DIR,
	SHOTGRID_REVIEW_SYNC_STORE_DIR: SYNC_STORE_DIR,
	SHOTGRID_REVIEW_EVENT_STORE_DIR: EVENT_STORE_DIR,
	SHOTGRID_REVIEW_AUDIT_STORE_DIR: AUDIT_STORE_DIR,
	SHOTGRID_REVIEW_PROJECT_IDS: '101,202,303',
	SHOTGRID_WEBHOOK_IDS: 'd0af3184-4d29-4f2d-80f0-c5d2f4198f74,01c215c7-ca11-4aa6-9247-96ef778c0a31',
	SHOTGRID_WEBHOOK_PROJECT_IDS: '101,202',
	SHOTGRID_WEBHOOK_SECRET: 'shotgrid-webhook-secret-with-32-characters',
	REVIEW_API_TRUSTED_PROXY_TOKEN: 'trusted-proxy-token-with-32-characters',
	REVIEW_FIXED_ACTOR_SUBJECT: 'oidc:studio:reviewer-123',
	REVIEW_METRICS_TOKEN: 'metrics-token-with-at-least-32-characters',
	REVIEW_SYNC_SECRET: 'review-sync-secret-with-at-least-32-characters',
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
			allowedProjectIds: [101, 102],
			host: '127.0.0.1',
			port: 5431,
			allowedOrigin: 'http://127.0.0.1:5430',
			collaborationMaxRooms: 100,
			collaborationMaxSessionsPerRoom: 16,
			collaborationSecret: 'local-development-only-review-sync-secret',
			collaborationStoreDir: resolve('.shotgrid-review-sync'),
			decisions: [
				{ key: 'approve', label: 'Approve', statusCode: 'apr' },
				{ key: 'needs-changes', label: 'Needs changes', statusCode: 'chg' },
				{
					key: 'pending-clarification',
					label: 'Pending clarification',
					statusCode: 'rev',
				},
			],
			metricsToken: 'local-development-only-review-metrics-token',
			eventSync: {
				allowedProjectIds: [101, 102],
				secret: 'local-development-only-shotgrid-webhook-secret',
				siteUrl: 'https://mock.shotgrid.invalid',
				storeDir: resolve('.shotgrid-review-events'),
				webhookIds: ['00000000-0000-4000-8000-000000000011'],
			},
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
			auditMaxEntries: 100_000,
			auditStoreDir: AUDIT_STORE_DIR,
			mode: 'shotgrid',
			allowedProjectIds: [101, 202, 303],
			fixedActorSubject: 'oidc:studio:reviewer-123',
			host: '0.0.0.0',
			port: 6543,
			allowedOrigin: 'https://review.example.test',
			collaborationMaxRooms: 100,
			collaborationMaxSessionsPerRoom: 16,
			collaborationSecret: 'review-sync-secret-with-at-least-32-characters',
			collaborationStoreDir: SYNC_STORE_DIR,
			decisions: [],
			metricsToken: 'metrics-token-with-at-least-32-characters',
			eventSync: {
				allowedProjectIds: [101, 202],
				secret: 'shotgrid-webhook-secret-with-32-characters',
				siteUrl: 'https://studio.shotgrid.autodesk.com',
				storeDir: EVENT_STORE_DIR,
				webhookIds: [
					'01c215c7-ca11-4aa6-9247-96ef778c0a31',
					'd0af3184-4d29-4f2d-80f0-c5d2f4198f74',
				],
			},
			publicationMaxJournalBytes: 4_194_304,
			publicationMaxJournalCount: 10_000,
			publicationStoreDir: PUBLICATION_STORE_DIR,
			trustedProxyToken: 'trusted-proxy-token-with-32-characters',
			shotgrid: {
				frameRateMode: 'unknown',
				siteUrl: 'https://studio.shotgrid.autodesk.com',
				scriptName: 'review-gateway',
				scriptKey: 'private-test-key',
				sudoAsLogin: 'reviewer@example.test',
				timeoutMs: 25_000,
				maxRetries: 4,
			},
		})
	})

	it.each(['constant', 'unknown', 'variable'] as const)(
		'accepts the %s review-video frame-rate policy',
		(frameRateMode) => {
			const parsed = parseGatewayConfig({
				...LIVE_ENVIRONMENT,
				SHOTGRID_REVIEW_VIDEO_FRAME_RATE_MODE: frameRateMode,
			})
			if (parsed.mode !== 'shotgrid') throw new Error('Expected live ShotGrid configuration')
			expect(parsed.shotgrid.frameRateMode).toBe(frameRateMode)
		}
	)

	it('rejects an invalid review-video frame-rate policy', () => {
		expectConfigurationError({
			...LIVE_ENVIRONMENT,
			SHOTGRID_REVIEW_VIDEO_FRAME_RATE_MODE: 'auto',
		})
	})

	it('parses an explicit bounded decision mapping', () => {
		const decisions = [
			{ key: 'approve', label: 'Approve', statusCode: 'apr' },
			{ key: 'needs-changes', label: 'Needs changes', statusCode: 'chg' },
		]
		const parsed = parseGatewayConfig({
			...LIVE_ENVIRONMENT,
			SHOTGRID_REVIEW_DECISIONS_JSON: JSON.stringify(decisions),
		})
		expect(parsed.decisions).toEqual(decisions)
	})

	it.each([
		['not-json'],
		[[{}]],
		[[{ key: 'Approve', label: 'Approve', statusCode: 'apr' }]],
		[[{ key: 'approve', label: 'Approve\nnow', statusCode: 'apr' }]],
		[[{ key: 'approve', label: 'Approve', statusCode: 'status code' }]],
		[
			[
				{ key: 'approve', label: 'Approve', statusCode: 'apr' },
				{ key: 'approve', label: 'Again', statusCode: 'chg' },
			],
		],
		[
			[
				{ key: 'approve', label: 'Approve', statusCode: 'apr' },
				{ key: 'approve-again', label: 'Again', statusCode: 'apr' },
			],
		],
		[[{ key: 'approve', label: 'Approve', statusCode: 'apr', secret: true }]],
	])('rejects an invalid decision mapping: %j', (decisions) => {
		expectConfigurationError({
			...LIVE_ENVIRONMENT,
			SHOTGRID_REVIEW_DECISIONS_JSON:
				typeof decisions === 'string' ? decisions : JSON.stringify(decisions),
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
		['SHOTGRID_REVIEW_SYNC_MAX_ROOMS', '0'],
		['SHOTGRID_REVIEW_SYNC_MAX_ROOMS', '1001'],
		['SHOTGRID_REVIEW_SYNC_MAX_SESSIONS_PER_ROOM', '0'],
		['SHOTGRID_REVIEW_SYNC_MAX_SESSIONS_PER_ROOM', '101'],
		['REVIEW_METRICS_TOKEN', 'short'],
		['SHOTGRID_WEBHOOK_PROJECT_IDS', '0'],
		['SHOTGRID_WEBHOOK_PROJECT_IDS', '1,1'],
		['SHOTGRID_REVIEW_PROJECT_IDS', '1,1'],
		['SHOTGRID_WEBHOOK_IDS', 'not-a-uuid'],
		[
			'SHOTGRID_WEBHOOK_IDS',
			'd0af3184-4d29-4f2d-80f0-c5d2f4198f74,d0af3184-4d29-4f2d-80f0-c5d2f4198f74',
		],
	])('rejects an invalid %s value', (name, value) => {
		expectConfigurationError({ [name]: value })
	})

	it.each([
		['SHOTGRID_REVIEW_PUBLICATION_MAX_JOURNAL_BYTES', '1024'],
		['SHOTGRID_REVIEW_PUBLICATION_MAX_JOURNALS', '0'],
		['SHOTGRID_REVIEW_AUDIT_MAX_ENTRIES', '1'],
	])('rejects an invalid live %s value', (name, value) => {
		expectConfigurationError({ ...LIVE_ENVIRONMENT, [name]: value })
	})

	it('accepts the one-mebibyte minimum publication journal capacity', () => {
		const parsed = parseGatewayConfig({
			...LIVE_ENVIRONMENT,
			SHOTGRID_REVIEW_PUBLICATION_MAX_JOURNAL_BYTES: String(1024 * 1024),
		})
		if (parsed.mode !== 'shotgrid') throw new Error('Expected live ShotGrid configuration')
		expect(parsed.publicationMaxJournalBytes).toBe(1024 * 1024)
	})

	it.each([
		'SHOTGRID_SITE_URL',
		'SHOTGRID_SCRIPT_NAME',
		'SHOTGRID_SCRIPT_KEY',
		'SHOTGRID_REVIEW_PUBLICATION_STORE_DIR',
		'SHOTGRID_REVIEW_SYNC_STORE_DIR',
		'SHOTGRID_REVIEW_EVENT_STORE_DIR',
		'SHOTGRID_REVIEW_AUDIT_STORE_DIR',
		'SHOTGRID_REVIEW_PROJECT_IDS',
		'SHOTGRID_WEBHOOK_IDS',
		'SHOTGRID_WEBHOOK_PROJECT_IDS',
		'SHOTGRID_WEBHOOK_SECRET',
		'REVIEW_API_TRUSTED_PROXY_TOKEN',
		'REVIEW_FIXED_ACTOR_SUBJECT',
		'REVIEW_METRICS_TOKEN',
		'REVIEW_SYNC_SECRET',
	])('requires %s in ShotGrid mode', (name) => {
		expectConfigurationError({ ...LIVE_ENVIRONMENT, [name]: undefined })
	})

	it('requires every webhook project to be within the review allowlist', () => {
		expectConfigurationError({
			...LIVE_ENVIRONMENT,
			SHOTGRID_REVIEW_PROJECT_IDS: '101',
		})
	})

	it.each([
		['REVIEW_FIXED_ACTOR_SUBJECT', ' reviewer-123'],
		['REVIEW_API_TRUSTED_PROXY_TOKEN', `${'x'.repeat(32)} `],
		['REVIEW_METRICS_TOKEN', `${'x'.repeat(32)} `],
		['REVIEW_SYNC_SECRET', `${'x'.repeat(32)}\n`],
		['SHOTGRID_SCRIPT_KEY', ' private-key'],
	])('rejects unsafe whitespace in %s', (name, value) => {
		expectConfigurationError({ ...LIVE_ENVIRONMENT, [name]: value })
	})

	it('requires a strong trusted proxy token without leaking it', () => {
		const secret = 'short-proxy-secret'
		const error = expectConfigurationError({
			...LIVE_ENVIRONMENT,
			REVIEW_API_TRUSTED_PROXY_TOKEN: secret,
		})

		expect(error.message).not.toContain(secret)
		expect(String(error.cause)).not.toContain(secret)
		expect(JSON.stringify(error.toApiErrorEnvelope())).not.toContain(secret)
	})

	it('requires a strong collaboration secret without leaking it', () => {
		const secret = 'short-sync-secret'
		const error = expectConfigurationError({
			...LIVE_ENVIRONMENT,
			REVIEW_SYNC_SECRET: secret,
		})

		expect(error.message).not.toContain(secret)
		expect(String(error.cause)).not.toContain(secret)
		expect(JSON.stringify(error.toApiErrorEnvelope())).not.toContain(secret)
	})

	it('requires a strong webhook secret without leaking it', () => {
		const secret = 'short-webhook-secret'
		const error = expectConfigurationError({
			...LIVE_ENVIRONMENT,
			SHOTGRID_WEBHOOK_SECRET: secret,
		})

		expect(error.message).not.toContain(secret)
		expect(String(error.cause)).not.toContain(secret)
		expect(JSON.stringify(error.toApiErrorEnvelope())).not.toContain(secret)
	})

	it('requires an absolute durable publication store in live mode', () => {
		expectConfigurationError({
			...LIVE_ENVIRONMENT,
			SHOTGRID_REVIEW_PUBLICATION_STORE_DIR: './review-publications',
		})
	})

	it('requires an absolute durable collaboration store in live mode', () => {
		expectConfigurationError({
			...LIVE_ENVIRONMENT,
			SHOTGRID_REVIEW_SYNC_STORE_DIR: './review-sync',
		})
	})

	it('requires an absolute durable event store in live mode', () => {
		expectConfigurationError({
			...LIVE_ENVIRONMENT,
			SHOTGRID_REVIEW_EVENT_STORE_DIR: './review-events',
		})
	})

	it.each([
		'SHOTGRID_REVIEW_PUBLICATION_STORE_DIR',
		'SHOTGRID_REVIEW_SYNC_STORE_DIR',
		'SHOTGRID_REVIEW_EVENT_STORE_DIR',
		'SHOTGRID_REVIEW_AUDIT_STORE_DIR',
	])('rejects a filesystem root for %s', (name) => {
		expectConfigurationError({
			...LIVE_ENVIRONMENT,
			[name]: parse(resolve('.')).root,
		})
	})

	it.each([
		['SHOTGRID_REVIEW_AUDIT_STORE_DIR', ` ${AUDIT_STORE_DIR}`],
		['SHOTGRID_REVIEW_SYNC_STORE_DIR', '\\\\server\\share\\review-sync'],
	])('rejects a non-local or whitespace-padded %s', (name, value) => {
		expectConfigurationError({ ...LIVE_ENVIRONMENT, [name]: value })
	})

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
