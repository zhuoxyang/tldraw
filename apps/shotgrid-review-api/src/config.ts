import { ReviewGatewayError } from './errors'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 5431
const DEFAULT_ALLOWED_ORIGIN = 'http://127.0.0.1:5430'
const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_RETRIES = 2

export interface ShotGridConnectionConfig {
	siteUrl: string
	scriptName: string
	scriptKey: string
	sudoAsLogin?: string
	timeoutMs: number
	maxRetries: number
}

export interface GatewayConfig {
	mode: 'mock' | 'shotgrid'
	host: string
	port: number
	allowedOrigin: string
	shotgrid?: ShotGridConnectionConfig
}

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
		return { mode: rawMode, host, port, allowedOrigin }
	}

	const scriptName = readRequired(environment, 'SHOTGRID_SCRIPT_NAME').trim()
	const scriptKey = readRequired(environment, 'SHOTGRID_SCRIPT_KEY')
	const sudoAsLogin = environment.SHOTGRID_SUDO_AS_LOGIN?.trim() || undefined

	return {
		mode: rawMode,
		host,
		port,
		allowedOrigin,
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
