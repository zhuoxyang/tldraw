import { isAbsolute, parse, resolve } from 'node:path'
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
const DEFAULT_AUDIT_MAX_ENTRIES = 100_000
const DEFAULT_COLLABORATION_MAX_ROOMS = 100
const DEFAULT_COLLABORATION_MAX_SESSIONS_PER_ROOM = 16
const DEFAULT_MOCK_COLLABORATION_SECRET = 'local-development-only-review-sync-secret'
const DEFAULT_MOCK_METRICS_TOKEN = 'local-development-only-review-metrics-token'
const DEFAULT_MOCK_WEBHOOK_SECRET = 'local-development-only-shotgrid-webhook-secret'
const DEFAULT_MOCK_WEBHOOK_ID = '00000000-0000-4000-8000-000000000011'
const DEFAULT_MOCK_WEBHOOK_SITE_URL = 'https://mock.shotgrid.invalid'
const WEBHOOK_UUID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MINIMUM_PUBLICATION_MAX_JOURNAL_BYTES = Math.max(
	1024 * 1024,
	minimumReviewPublicationJournalBytes(DEFAULT_REVIEW_PUBLICATION_MAX_RECORD_BYTES)
)

export interface ShotGridConnectionConfig {
	frameRateMode: 'constant' | 'unknown' | 'variable'
	siteUrl: string
	scriptName: string
	scriptKey: string
	sudoAsLogin?: string
	timeoutMs: number
	maxRetries: number
}

export interface ShotGridEventSyncConfig {
	allowedProjectIds: number[]
	secret: string
	siteUrl: string
	storeDir: string
	webhookIds: string[]
}

interface GatewayConfigBase {
	allowedProjectIds: number[]
	host: string
	port: number
	allowedOrigin: string
	collaborationMaxRooms: number
	collaborationMaxSessionsPerRoom: number
	collaborationSecret: string
	collaborationStoreDir: string
	decisions: ReviewDecisionOption[]
	eventSync: ShotGridEventSyncConfig
	metricsToken: string
}

export type GatewayConfig = GatewayConfigBase &
	(
		| {
				mode: 'mock'
				shotgrid?: never
				trustedProxyToken?: never
		  }
		| {
				auditMaxEntries: number
				auditStoreDir: string
				mode: 'shotgrid'
				fixedActorSubject: string
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

function parseVideoFrameRateMode(environment: GatewayEnvironment) {
	const value = environment.SHOTGRID_REVIEW_VIDEO_FRAME_RATE_MODE?.trim() || 'unknown'
	if (value !== 'constant' && value !== 'unknown' && value !== 'variable') {
		throw configurationError(
			'SHOTGRID_REVIEW_VIDEO_FRAME_RATE_MODE',
			'must be constant, variable, or unknown'
		)
	}
	return value
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

function parseAbsoluteStoreDirectory(rawValue: string, variableName: string) {
	const value = rawValue.trim()
	const resolved = resolve(value)
	if (
		value !== rawValue ||
		!isAbsolute(value) ||
		/^[\\/]{2}/.test(value) ||
		/\p{Cc}/u.test(value) ||
		resolved === parse(resolved).root
	) {
		throw configurationError(variableName, 'must be an absolute local non-root filesystem path')
	}
	return resolved
}

function parseWebhookSecret(rawValue: string, variableName: string) {
	if (
		rawValue.length < 32 ||
		rawValue.length > 1024 ||
		rawValue.trim() !== rawValue ||
		/\p{Cc}/u.test(rawValue)
	) {
		throw configurationError(variableName, 'must contain from 32 to 1024 plain characters')
	}
	return rawValue
}

function parseWebhookIds(rawValue: string) {
	const values = rawValue.split(',').map((value) => value.trim().toLowerCase())
	if (
		values.length === 0 ||
		values.length > 32 ||
		values.some((value) => !WEBHOOK_UUID_PATTERN.test(value)) ||
		new Set(values).size !== values.length
	) {
		throw configurationError(
			'SHOTGRID_WEBHOOK_IDS',
			'must contain from 1 to 32 unique comma-separated UUIDs'
		)
	}
	return values.sort()
}

function parseProjectIds(rawValue: string, variableName: string) {
	const parts = rawValue.split(',').map((part) => part.trim())
	if (
		parts.length === 0 ||
		parts.length > 1_000 ||
		parts.some((part) => !/^[1-9]\d*$/.test(part))
	) {
		throw configurationError(
			variableName,
			'must be a comma-separated list of positive ShotGrid project ids'
		)
	}
	const ids = parts.map(Number)
	if (ids.some((id) => !Number.isSafeInteger(id)) || new Set(ids).size !== ids.length) {
		throw configurationError(variableName, 'must contain unique positive safe integers')
	}
	return ids
}

function parseBoundedPlainValue(
	rawValue: string,
	variableName: string,
	options: { maximumLength: number; minimumLength?: number } = { maximumLength: 255 }
) {
	const minimumLength = options.minimumLength ?? 1
	if (
		rawValue.length < minimumLength ||
		rawValue.length > options.maximumLength ||
		rawValue.trim() !== rawValue ||
		/\p{Cc}/u.test(rawValue)
	) {
		throw configurationError(
			variableName,
			`must contain from ${minimumLength} to ${options.maximumLength} plain characters`
		)
	}
	return rawValue
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
	const collaborationMaxRooms = parseInteger(
		environment,
		'SHOTGRID_REVIEW_SYNC_MAX_ROOMS',
		DEFAULT_COLLABORATION_MAX_ROOMS,
		1,
		1_000
	)
	const collaborationMaxSessionsPerRoom = parseInteger(
		environment,
		'SHOTGRID_REVIEW_SYNC_MAX_SESSIONS_PER_ROOM',
		DEFAULT_COLLABORATION_MAX_SESSIONS_PER_ROOM,
		1,
		100
	)
	const timeoutMs = parseInteger(environment, 'SHOTGRID_TIMEOUT_MS', DEFAULT_TIMEOUT_MS, 1, 120_000)
	const maxRetries = parseInteger(environment, 'SHOTGRID_MAX_RETRIES', DEFAULT_MAX_RETRIES, 0, 10)

	if (rawMode === 'mock') {
		const allowedProjectIds = parseProjectIds(
			environment.SHOTGRID_REVIEW_PROJECT_IDS || '101,102',
			'SHOTGRID_REVIEW_PROJECT_IDS'
		)
		const eventAllowedProjectIds = parseProjectIds(
			environment.SHOTGRID_WEBHOOK_PROJECT_IDS || '101,102',
			'SHOTGRID_WEBHOOK_PROJECT_IDS'
		)
		if (eventAllowedProjectIds.some((projectId) => !allowedProjectIds.includes(projectId))) {
			throw configurationError(
				'SHOTGRID_WEBHOOK_PROJECT_IDS',
				'must be a subset of SHOTGRID_REVIEW_PROJECT_IDS'
			)
		}
		const collaborationSecret =
			environment.REVIEW_SYNC_SECRET?.trim() || DEFAULT_MOCK_COLLABORATION_SECRET
		if (collaborationSecret.length < 32 || /\p{Cc}/u.test(collaborationSecret)) {
			throw configurationError('REVIEW_SYNC_SECRET', 'must contain at least 32 characters')
		}
		return {
			mode: rawMode,
			allowedProjectIds,
			host,
			port,
			allowedOrigin,
			collaborationMaxRooms,
			collaborationMaxSessionsPerRoom,
			collaborationSecret,
			collaborationStoreDir: parseAbsoluteStoreDirectory(
				environment.SHOTGRID_REVIEW_SYNC_STORE_DIR ||
					resolve(process.cwd(), '.shotgrid-review-sync'),
				'SHOTGRID_REVIEW_SYNC_STORE_DIR'
			),
			decisions: parseDecisionOptions(environment, {
				defaultDecisions: DEFAULT_MOCK_DECISIONS,
			}),
			eventSync: {
				allowedProjectIds: eventAllowedProjectIds,
				secret: parseWebhookSecret(
					environment.SHOTGRID_WEBHOOK_SECRET || DEFAULT_MOCK_WEBHOOK_SECRET,
					'SHOTGRID_WEBHOOK_SECRET'
				),
				siteUrl: DEFAULT_MOCK_WEBHOOK_SITE_URL,
				storeDir: parseAbsoluteStoreDirectory(
					environment.SHOTGRID_REVIEW_EVENT_STORE_DIR ||
						resolve(process.cwd(), '.shotgrid-review-events'),
					'SHOTGRID_REVIEW_EVENT_STORE_DIR'
				),
				webhookIds: parseWebhookIds(environment.SHOTGRID_WEBHOOK_IDS || DEFAULT_MOCK_WEBHOOK_ID),
			},
			metricsToken: parseBoundedPlainValue(
				environment.REVIEW_METRICS_TOKEN || DEFAULT_MOCK_METRICS_TOKEN,
				'REVIEW_METRICS_TOKEN',
				{ maximumLength: 1024, minimumLength: 32 }
			),
		}
	}

	const scriptName = parseBoundedPlainValue(
		readRequired(environment, 'SHOTGRID_SCRIPT_NAME'),
		'SHOTGRID_SCRIPT_NAME'
	)
	const scriptKey = parseBoundedPlainValue(
		readRequired(environment, 'SHOTGRID_SCRIPT_KEY'),
		'SHOTGRID_SCRIPT_KEY',
		{ maximumLength: 1024 }
	)
	const trustedProxyToken = parseBoundedPlainValue(
		readRequired(environment, 'REVIEW_API_TRUSTED_PROXY_TOKEN'),
		'REVIEW_API_TRUSTED_PROXY_TOKEN',
		{ maximumLength: 1024, minimumLength: 32 }
	)
	const metricsToken = parseBoundedPlainValue(
		readRequired(environment, 'REVIEW_METRICS_TOKEN'),
		'REVIEW_METRICS_TOKEN',
		{ maximumLength: 1024, minimumLength: 32 }
	)
	const collaborationSecret = parseBoundedPlainValue(
		readRequired(environment, 'REVIEW_SYNC_SECRET'),
		'REVIEW_SYNC_SECRET',
		{ maximumLength: 1024, minimumLength: 32 }
	)
	const fixedActorSubject = parseBoundedPlainValue(
		readRequired(environment, 'REVIEW_FIXED_ACTOR_SUBJECT'),
		'REVIEW_FIXED_ACTOR_SUBJECT',
		{ maximumLength: 512 }
	)
	const collaborationStoreDir = parseAbsoluteStoreDirectory(
		readRequired(environment, 'SHOTGRID_REVIEW_SYNC_STORE_DIR'),
		'SHOTGRID_REVIEW_SYNC_STORE_DIR'
	)
	const publicationStoreDir = parseAbsoluteStoreDirectory(
		readRequired(environment, 'SHOTGRID_REVIEW_PUBLICATION_STORE_DIR'),
		'SHOTGRID_REVIEW_PUBLICATION_STORE_DIR'
	)
	const shotgridSiteUrl = parseSiteUrl(readRequired(environment, 'SHOTGRID_SITE_URL'))
	const allowedProjectIds = parseProjectIds(
		readRequired(environment, 'SHOTGRID_REVIEW_PROJECT_IDS'),
		'SHOTGRID_REVIEW_PROJECT_IDS'
	)
	const auditStoreDir = parseAbsoluteStoreDirectory(
		readRequired(environment, 'SHOTGRID_REVIEW_AUDIT_STORE_DIR'),
		'SHOTGRID_REVIEW_AUDIT_STORE_DIR'
	)
	const eventSync: ShotGridEventSyncConfig = {
		allowedProjectIds: parseProjectIds(
			readRequired(environment, 'SHOTGRID_WEBHOOK_PROJECT_IDS'),
			'SHOTGRID_WEBHOOK_PROJECT_IDS'
		),
		secret: parseWebhookSecret(
			readRequired(environment, 'SHOTGRID_WEBHOOK_SECRET'),
			'SHOTGRID_WEBHOOK_SECRET'
		),
		siteUrl: shotgridSiteUrl,
		storeDir: parseAbsoluteStoreDirectory(
			readRequired(environment, 'SHOTGRID_REVIEW_EVENT_STORE_DIR'),
			'SHOTGRID_REVIEW_EVENT_STORE_DIR'
		),
		webhookIds: parseWebhookIds(readRequired(environment, 'SHOTGRID_WEBHOOK_IDS')),
	}
	if (eventSync.allowedProjectIds.some((projectId) => !allowedProjectIds.includes(projectId))) {
		throw configurationError(
			'SHOTGRID_WEBHOOK_PROJECT_IDS',
			'must be a subset of SHOTGRID_REVIEW_PROJECT_IDS'
		)
	}
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
	const auditMaxEntries = parseInteger(
		environment,
		'SHOTGRID_REVIEW_AUDIT_MAX_ENTRIES',
		DEFAULT_AUDIT_MAX_ENTRIES,
		2,
		10_000_000
	)
	const rawSudoAsLogin = environment.SHOTGRID_SUDO_AS_LOGIN
	const sudoAsLogin = rawSudoAsLogin
		? parseBoundedPlainValue(rawSudoAsLogin, 'SHOTGRID_SUDO_AS_LOGIN', {
				maximumLength: 255,
			})
		: undefined
	const decisions = parseDecisionOptions(environment, { defaultDecisions: [] })

	return {
		auditMaxEntries,
		auditStoreDir,
		mode: rawMode,
		allowedProjectIds,
		fixedActorSubject,
		host,
		port,
		allowedOrigin,
		collaborationMaxRooms,
		collaborationMaxSessionsPerRoom,
		collaborationSecret,
		collaborationStoreDir,
		decisions,
		eventSync,
		metricsToken,
		publicationMaxJournalBytes,
		publicationMaxJournalCount,
		publicationStoreDir,
		trustedProxyToken,
		shotgrid: {
			frameRateMode: parseVideoFrameRateMode(environment),
			siteUrl: shotgridSiteUrl,
			scriptName,
			scriptKey,
			...(sudoAsLogin === undefined ? undefined : { sudoAsLogin }),
			timeoutMs,
			maxRetries,
		},
	}
}
