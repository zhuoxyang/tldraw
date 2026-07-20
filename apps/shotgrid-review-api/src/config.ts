import { isAbsolute, resolve } from 'node:path'
import { isReviewDecisionOption, type ReviewDecisionOption } from './contracts'
import { ReviewGatewayError } from './errors'
import {
	DEFAULT_REVIEW_PUBLICATION_MAX_RECORD_BYTES,
	minimumReviewPublicationJournalBytes,
} from './http/ReviewPublicationStore'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 5431
const DEFAULT_ALLOWED_ORIGIN = 'http://127.0.0.1:5430'
const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_RETRIES = 2
const MAX_DECISION_CONFIG_BYTES = 16 * 1024
const MAX_DECISION_OPTIONS = 32
const DEFAULT_MOCK_DECISIONS: ReviewDecisionOption[] = [
	{ key: 'approve', label: 'Approve', statusCode: 'apr' },
	{ key: 'needs-changes', label: 'Needs changes', statusCode: 'chg' },
	{ key: 'pending-clarification', label: 'Pending clarification', statusCode: 'rev' },
]
const DEFAULT_PUBLICATION_MAX_JOURNAL_BYTES = 4 * 1024 * 1024
const DEFAULT_PUBLICATION_MAX_JOURNAL_COUNT = 10_000
const MINIMUM_PUBLICATION_MAX_JOURNAL_BYTES = Math.max(
	1024 * 1024,
	minimumReviewPublicationJournalBytes(DEFAULT_REVIEW_PUBLICATION_MAX_RECORD_BYTES)
)

export interface ShotGridConnectionConfig {
	siteUrl: string
	scriptName: string
	scriptKey: string
	sudoAsLogin?: string
	timeoutMs: number
	maxRetries: number
}

interface GatewayConfigBase {
	host: string
	port: number
	allowedOrigin: string
	decisions: ReviewDecisionOption[]
}

export type GatewayConfig = GatewayConfigBase &
	(
		| {
				mode: 'mock'
				shotgrid?: never
				trustedProxyToken?: never
		  }
		| {
				mode: 'shotgrid'
				publicationMaxJournalBytes: number
				publicationMaxJournalCount: number
				publicationStoreDir: string
				shotgrid: ShotGridConnectionConfig
				trustedProxyToken: string
		  }
	)

type GatewayEnvironment = Readonly<Record<string, string | undefined>>

function configurationError(variableName: string, reason: string): ReviewGatewayError {
	return new ReviewGatewayError({
		code: 'CONFIGURATION_ERROR',
		status: 500,
		retryable: false,
		cause: new Error(`${variableName} ${reason}`),
	})
}

function readRequired(environment: GatewayEnvironment, variableName: string): string {
	const value = environment[variableName]
	if (value === undefined || value.trim() === '') {
		throw configurationError(variableName, 'is required in ShotGrid mode')
	}
	return value
}

function parseInteger(
	environment: GatewayEnvironment,
	variableName: string,
	defaultValue: number,
	minimum: number,
	maximum: number
): number {
	const rawValue = environment[variableName]
	if (rawValue === undefined || rawValue.trim() === '') return defaultValue

	const value = Number(rawValue)
	if (!Number.isInteger(value) || value < minimum || value > maximum) {
		throw configurationError(variableName, `must be an integer from ${minimum} to ${maximum}`)
	}
	return value
}

function parseOrigin(environment: GatewayEnvironment): string {
	const rawValue = environment.REVIEW_APP_ORIGIN?.trim() || DEFAULT_ALLOWED_ORIGIN
	let url: URL
	try {
		url = new URL(rawValue)
	} catch {
		throw configurationError('REVIEW_APP_ORIGIN', 'must be an absolute HTTP or HTTPS origin')
	}

	if (
		(url.protocol !== 'http:' && url.protocol !== 'https:') ||
		url.username !== '' ||
		url.password !== '' ||
		(url.pathname !== '' && url.pathname !== '/') ||
		url.search !== '' ||
		url.hash !== ''
	) {
		throw configurationError('REVIEW_APP_ORIGIN', 'must contain only an HTTP or HTTPS origin')
	}

	return url.origin
}

function parseSiteUrl(rawValue: string): string {
	let url: URL
	try {
		url = new URL(rawValue.trim())
	} catch {
		throw configurationError('SHOTGRID_SITE_URL', 'must be an absolute HTTPS origin')
	}

	if (
		url.protocol !== 'https:' ||
		url.username !== '' ||
		url.password !== '' ||
		(url.pathname !== '' && url.pathname !== '/') ||
		url.search !== '' ||
		url.hash !== ''
	) {
		throw configurationError('SHOTGRID_SITE_URL', 'must contain only an HTTPS origin')
	}

	return url.origin
}

function parsePublicationStoreDirectory(rawValue: string) {
	const value = rawValue.trim()
	if (!isAbsolute(value) || /\p{Cc}/u.test(value)) {
		throw configurationError(
			'SHOTGRID_REVIEW_PUBLICATION_STORE_DIR',
			'must be an absolute filesystem path'
		)
	}
	return resolve(value)
}

function parseDecisionOptions(
	environment: GatewayEnvironment,
	options: { defaultDecisions: readonly ReviewDecisionOption[] }
): ReviewDecisionOption[] {
	const rawValue = environment.SHOTGRID_REVIEW_DECISIONS_JSON
	if (rawValue === undefined || rawValue.trim() === '') {
		return options.defaultDecisions.map((decision) => ({ ...decision }))
	}
	if (Buffer.byteLength(rawValue, 'utf8') > MAX_DECISION_CONFIG_BYTES) {
		throw configurationError('SHOTGRID_REVIEW_DECISIONS_JSON', 'is too large')
	}

	let parsed: unknown
	try {
		parsed = JSON.parse(rawValue)
	} catch {
		throw configurationError('SHOTGRID_REVIEW_DECISIONS_JSON', 'must be valid JSON')
	}
	if (
		!Array.isArray(parsed) ||
		parsed.length > MAX_DECISION_OPTIONS ||
		!parsed.every(isReviewDecisionOption)
	) {
		throw configurationError(
			'SHOTGRID_REVIEW_DECISIONS_JSON',
			'must be an array of up to 32 valid decision mappings'
		)
	}

	const decisions = parsed.map((decision) => ({ ...decision }))
	if (
		new Set(decisions.map(({ key }) => key)).size !== decisions.length ||
		new Set(decisions.map(({ statusCode }) => statusCode)).size !== decisions.length
	) {
		throw configurationError(
			'SHOTGRID_REVIEW_DECISIONS_JSON',
			'must use unique decision keys and status codes'
		)
	}
	return decisions
}

export function parseGatewayConfig(environment: GatewayEnvironment = process.env): GatewayConfig {
	const rawMode = environment.SHOTGRID_GATEWAY_MODE?.trim() || 'mock'
	if (rawMode !== 'mock' && rawMode !== 'shotgrid') {
		throw configurationError('SHOTGRID_GATEWAY_MODE', 'must be either mock or shotgrid')
	}

	const host = environment.REVIEW_API_HOST?.trim() || DEFAULT_HOST
	const port = parseInteger(environment, 'REVIEW_API_PORT', DEFAULT_PORT, 1, 65_535)
	const allowedOrigin = parseOrigin(environment)
	const timeoutMs = parseInteger(environment, 'SHOTGRID_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 1, 120_000)
	const maxRetries = parseInteger(environment, 'SHOTGRID_MAX_RETRIES', DEFAULT_MAX_RETRIES, 0, 10)

	if (rawMode === 'mock') {
		return {
			mode: rawMode,
			host,
			port,
			allowedOrigin,
			decisions: parseDecisionOptions(environment, {
				defaultDecisions: DEFAULT_MOCK_DECISIONS,
			}),
		}
	}

	const scriptName = readRequired(environment, 'SHOTGRID_SCRIPT_NAME').trim()
	const scriptKey = readRequired(environment, 'SHOTGRID_SCRIPT_KEY')
	const trustedProxyToken = readRequired(environment, 'REVIEW_API_TRUSTED_PROXY_TOKEN').trim()
	const publicationStoreDir = parsePublicationStoreDirectory(
		readRequired(environment, 'SHOTGRID_REVIEW_PUBLICATION_STORE_DIR')
	)
	const publicationMaxJournalBytes = parseInteger(
		environment,
		'SHOTGRID_REVIEW_PUBLICATION_MAX_JOURNAL_BYTES',
		DEFAULT_PUBLICATION_MAX_JOURNAL_BYTES,
		MINIMUM_PUBLICATION_MAX_JOURNAL_BYTES,
		16 * 1024 * 1024
	)
	const publicationMaxJournalCount = parseInteger(
		environment,
		'SHOTGRID_REVIEW_PUBLICATION_MAX_JOURNALS',
		DEFAULT_PUBLICATION_MAX_JOURNAL_COUNT,
		1,
		1_000_000
	)
	if (trustedProxyToken.length < 32 || /\p{Cc}/u.test(trustedProxyToken)) {
		throw configurationError(
			'REVIEW_API_TRUSTED_PROXY_TOKEN',
			'must contain at least 32 characters'
		)
	}
	const sudoAsLogin = environment.SHOTGRID_SUDO_AS_LOGIN?.trim() || undefined
	const decisions = parseDecisionOptions(environment, { defaultDecisions: [] })

	return {
		mode: rawMode,
		host,
		port,
		allowedOrigin,
		decisions,
		publicationMaxJournalBytes,
		publicationMaxJournalCount,
		publicationStoreDir,
		trustedProxyToken,
		shotgrid: {
			siteUrl: parseSiteUrl(readRequired(environment, 'SHOTGRID_SITE_URL')),
			scriptName,
			scriptKey,
			...(sudoAsLogin === undefined ? undefined : { sudoAsLogin }),
			timeoutMs,
			maxRetries,
		},
	}
}
