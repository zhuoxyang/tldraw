import type { ShotGridConnectionConfig } from '../config'
import { ReviewGatewayError } from '../errors'

export type ShotGridHttpMethod = 'DELETE' | 'GET' | 'HEAD' | 'OPTIONS' | 'PATCH' | 'POST' | 'PUT'

type QueryPrimitive = boolean | number | string

export type ShotGridQuery = Readonly<
	Record<string, QueryPrimitive | readonly QueryPrimitive[] | null | undefined>
>

export interface ShotGridRequestOptions {
	/**
	 * Marks a request as safe to replay after a transient failure. GET and HEAD requests are
	 * idempotent by default; other methods must opt in explicitly.
	 */
	idempotent?: boolean
	method?: ShotGridHttpMethod
	query?: ShotGridQuery
	body?: unknown
	headers?: Readonly<Record<string, string>>
}

export interface ShotGridClientDependencies {
	fetch?: typeof globalThis.fetch
	now?(): number
	sleep?(milliseconds: number): Promise<void>
}

interface CachedAccessToken {
	accessToken: string
	refreshAt: number
}

interface AccessTokenResponse {
	access_token?: unknown
	expires_in?: unknown
	token_type?: unknown
}

type FetchFailureKind = 'network' | 'timeout'

class FetchAttemptFailure extends Error {
	constructor(readonly kind: FetchFailureKind) {
		super(kind)
	}
}

const API_PATH = '/api/v1.1/'
const AUTH_PATH = '/api/v1.1/auth/access_token'
const MAX_RETRY_DELAY_MS = 30_000
const MAX_BACKOFF_DELAY_MS = 5_000
const INITIAL_BACKOFF_DELAY_MS = 250
const MAX_TOKEN_EXPIRY_SKEW_MS = 30_000
const MIN_TOKEN_EXPIRY_SKEW_MS = 1_000
const TRANSIENT_STATUSES = new Set([429, 502, 503, 504])
const DEFAULT_IDEMPOTENT_METHODS = new Set<ShotGridHttpMethod>(['GET', 'HEAD'])
const FORBIDDEN_HEADER_NAMES = new Set([
	'authorization',
	'connection',
	'content-length',
	'cookie',
	'host',
	'proxy-authorization',
	'set-cookie',
])

const defaultSleep = (milliseconds: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, milliseconds))

/**
 * A small server-only ShotGrid REST client. It owns OAuth credentials, token refresh, retry
 * policy, and error normalization so callers never need to handle raw upstream responses.
 */
export class ShotGridClient {
	private readonly apiBaseUrl: URL
	private readonly authUrl: URL
	private readonly fetch: typeof globalThis.fetch
	private readonly now: () => number
	private readonly sleep: (milliseconds: number) => Promise<void>
	private readonly maxRetries: number
	private readonly timeoutMs: number

	private cachedToken: CachedAccessToken | undefined
	private authenticationInFlight: Promise<CachedAccessToken> | undefined

	constructor(
		private readonly config: ShotGridConnectionConfig,
		dependencies: ShotGridClientDependencies = {}
	) {
		this.fetch = dependencies.fetch ?? globalThis.fetch
		this.now = dependencies.now ?? Date.now
		this.sleep = dependencies.sleep ?? defaultSleep
		this.maxRetries = Math.max(0, Math.floor(config.maxRetries))
		this.timeoutMs = Math.max(1, Math.floor(config.timeoutMs))

		try {
			this.apiBaseUrl = new URL(API_PATH, config.siteUrl)
			this.authUrl = new URL(AUTH_PATH, config.siteUrl)
		} catch {
			throw this.createError({
				code: 'CONFIGURATION_ERROR',
				status: 500,
				message: 'The ShotGrid connection is not configured correctly.',
				retryable: false,
			})
		}
	}

	async request<T>(path: string, options: ShotGridRequestOptions = {}): Promise<T> {
		const method = options.method ?? 'GET'
		const idempotent = options.idempotent ?? DEFAULT_IDEMPOTENT_METHODS.has(method)
		const url = this.createResourceUrl(path, options.query)
		const body = this.serializeBody(method, options.body)
		const headers = this.createResourceHeaders(options.headers, body !== undefined)

		let authenticationReplayed = false
		let transientRetries = 0

		for (;;) {
			const token = await this.getAccessToken()
			headers.set('Authorization', `Bearer ${token.accessToken}`)

			let response: Response
			try {
				response = await this.fetchAttempt(url, {
					body,
					headers,
					method,
					redirect: 'manual',
				})
			} catch (error) {
				if (!(error instanceof FetchAttemptFailure)) throw error

				if (idempotent && transientRetries < this.maxRetries) {
					await this.sleep(this.getBackoffDelay(transientRetries))
					transientRetries += 1
					continue
				}

				throw this.normalizeFetchFailure(error.kind)
			}

			if (response.status === 401 && !authenticationReplayed) {
				await this.discardResponseBody(response)
				this.invalidateTokenIfUsed(token.accessToken)
				authenticationReplayed = true
				continue
			}

			if (
				idempotent &&
				TRANSIENT_STATUSES.has(response.status) &&
				transientRetries < this.maxRetries
			) {
				const retryDelay = this.getRetryDelay(response, transientRetries)
				await this.discardResponseBody(response)
				await this.sleep(retryDelay)
				transientRetries += 1
				continue
			}

			if (!response.ok) {
				await this.discardResponseBody(response)
				throw this.normalizeUpstreamResponse(response.status)
			}

			return await this.parseSuccessfulResponse<T>(response, method)
		}
	}

	private async getAccessToken(): Promise<CachedAccessToken> {
		if (this.cachedToken && this.now() < this.cachedToken.refreshAt) {
			return this.cachedToken
		}

		if (this.authenticationInFlight) return await this.authenticationInFlight

		const authentication = this.authenticate()
		this.authenticationInFlight = authentication

		try {
			return await authentication
		} finally {
			if (this.authenticationInFlight === authentication) {
				this.authenticationInFlight = undefined
			}
		}
	}

	private async authenticate(): Promise<CachedAccessToken> {
		let transientRetries = 0

		for (;;) {
			const requestedAt = this.now()
			let response: Response

			try {
				response = await this.fetchAttempt(this.authUrl, {
					body: this.createAuthenticationBody(),
					headers: {
						Accept: 'application/json',
						'Content-Type': 'application/x-www-form-urlencoded',
					},
					method: 'POST',
					redirect: 'manual',
				})
			} catch (error) {
				if (!(error instanceof FetchAttemptFailure)) throw error

				if (transientRetries < this.maxRetries) {
					await this.sleep(this.getBackoffDelay(transientRetries))
					transientRetries += 1
					continue
				}

				throw this.normalizeFetchFailure(error.kind)
			}

			if (TRANSIENT_STATUSES.has(response.status) && transientRetries < this.maxRetries) {
				const retryDelay = this.getRetryDelay(response, transientRetries)
				await this.discardResponseBody(response)
				await this.sleep(retryDelay)
				transientRetries += 1
				continue
			}

			if (!response.ok) {
				await this.discardResponseBody(response)
				throw this.normalizeAuthenticationResponse(response.status)
			}

			const payload = await this.parseJsonObject<AccessTokenResponse>(response)
			const token = this.validateAccessToken(payload, requestedAt)
			this.cachedToken = token
			return token
		}
	}

	private createAuthenticationBody(): string {
		const body = new URLSearchParams({
			client_id: this.config.scriptName,
			client_secret: this.config.scriptKey,
			grant_type: 'client_credentials',
		})

		if (this.config.sudoAsLogin) {
			body.set('scope', `sudo_as_login:${this.config.sudoAsLogin}`)
		}

		return body.toString()
	}

	private validateAccessToken(
		payload: AccessTokenResponse,
		requestedAt: number
	): CachedAccessToken {
		const accessToken = payload.access_token
		const tokenType = payload.token_type
		const expiresInSeconds =
			typeof payload.expires_in === 'string' && payload.expires_in.trim() !== ''
				? Number(payload.expires_in)
				: payload.expires_in

		if (
			typeof accessToken !== 'string' ||
			accessToken.trim() === '' ||
			(tokenType !== undefined &&
				(typeof tokenType !== 'string' || tokenType.toLowerCase() !== 'bearer')) ||
			typeof expiresInSeconds !== 'number' ||
			!Number.isFinite(expiresInSeconds) ||
			expiresInSeconds <= 0
		) {
			throw this.invalidUpstreamResponse()
		}

		const lifetimeMs = expiresInSeconds * 1_000
		if (!Number.isFinite(lifetimeMs)) throw this.invalidUpstreamResponse()

		const expirySkewMs = Math.min(
			MAX_TOKEN_EXPIRY_SKEW_MS,
			Math.max(MIN_TOKEN_EXPIRY_SKEW_MS, lifetimeMs * 0.1),
			lifetimeMs / 2
		)
		const refreshAt = requestedAt + lifetimeMs - expirySkewMs

		if (!Number.isFinite(refreshAt) || this.now() >= refreshAt) {
			throw this.invalidUpstreamResponse()
		}

		return { accessToken, refreshAt }
	}

	private invalidateTokenIfUsed(accessToken: string): void {
		if (this.cachedToken?.accessToken === accessToken) this.cachedToken = undefined
	}

	private createResourceUrl(path: string, query: ShotGridQuery | undefined): URL {
		if (
			!path.startsWith('/') ||
			path.startsWith('//') ||
			path.includes('\\') ||
			path.includes('?') ||
			path.includes('#')
		) {
			throw this.invalidPathError()
		}

		let url: URL
		try {
			url = new URL(path.slice(1), this.apiBaseUrl)
		} catch {
			throw this.invalidPathError()
		}

		if (
			url.origin !== this.apiBaseUrl.origin ||
			!url.pathname.startsWith(this.apiBaseUrl.pathname)
		) {
			throw this.invalidPathError()
		}

		for (const [key, value] of Object.entries(query ?? {})) {
			if (value === null || value === undefined) continue

			if (Array.isArray(value)) {
				for (const item of value) url.searchParams.append(key, String(item))
			} else {
				url.searchParams.append(key, String(value))
			}
		}

		return url
	}

	private createResourceHeaders(
		headersInput: Readonly<Record<string, string>> | undefined,
		hasBody: boolean
	): Headers {
		for (const name of Object.keys(headersInput ?? {})) {
			if (FORBIDDEN_HEADER_NAMES.has(name.toLowerCase())) {
				throw this.createError({
					code: 'INVALID_SHOTGRID_PATH',
					status: 400,
					message: 'The ShotGrid request is invalid.',
					retryable: false,
				})
			}
		}

		let headers: Headers
		try {
			headers = new Headers(headersInput)
		} catch {
			throw this.createError({
				code: 'INVALID_SHOTGRID_PATH',
				status: 400,
				message: 'The ShotGrid request is invalid.',
				retryable: false,
			})
		}

		if (!headers.has('Accept')) headers.set('Accept', 'application/json')
		if (hasBody && !headers.has('Content-Type')) {
			headers.set('Content-Type', 'application/json')
		}

		return headers
	}

	private serializeBody(method: ShotGridHttpMethod, body: unknown): string | undefined {
		if (body === undefined) return undefined

		if (method === 'GET' || method === 'HEAD') {
			throw this.createError({
				code: 'INVALID_SHOTGRID_PATH',
				status: 400,
				message: 'The ShotGrid request is invalid.',
				retryable: false,
			})
		}

		try {
			const serialized = JSON.stringify(body)
			if (serialized === undefined) throw new Error('Not JSON serializable')
			return serialized
		} catch {
			throw this.createError({
				code: 'INVALID_SHOTGRID_PATH',
				status: 400,
				message: 'The ShotGrid request is invalid.',
				retryable: false,
			})
		}
	}

	private async fetchAttempt(url: URL, init: RequestInit): Promise<Response> {
		const controller = new AbortController()
		const timeout = setTimeout(() => controller.abort(), this.timeoutMs)

		try {
			return await this.fetch(url, { ...init, signal: controller.signal })
		} catch {
			throw new FetchAttemptFailure(controller.signal.aborted ? 'timeout' : 'network')
		} finally {
			clearTimeout(timeout)
		}
	}

	private async parseSuccessfulResponse<T>(
		response: Response,
		method: ShotGridHttpMethod
	): Promise<T> {
		if (method === 'HEAD' || response.status === 204 || response.status === 205) {
			await this.discardResponseBody(response)
			return undefined as T
		}

		let text: string
		try {
			text = await response.text()
		} catch {
			throw this.invalidUpstreamResponse()
		}

		if (text.trim() === '') return undefined as T

		try {
			return JSON.parse(text) as T
		} catch {
			throw this.invalidUpstreamResponse()
		}
	}

	private async parseJsonObject<T extends object>(response: Response): Promise<T> {
		let text: string
		try {
			text = await response.text()
		} catch {
			throw this.invalidUpstreamResponse()
		}

		if (text.trim() === '') throw this.invalidUpstreamResponse()

		try {
			const parsed: unknown = JSON.parse(text)
			if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
				throw this.invalidUpstreamResponse()
			}
			return parsed as T
		} catch (error) {
			if (error instanceof ReviewGatewayError) throw error
			throw this.invalidUpstreamResponse()
		}
	}

	private async discardResponseBody(response: Response): Promise<void> {
		try {
			await response.body?.cancel()
		} catch {
			// Discard failures are intentionally ignored; the original status determines the outcome.
		}
	}

	private getRetryDelay(response: Response, retryIndex: number): number {
		const retryAfter = response.headers.get('Retry-After')?.trim()
		if (!retryAfter) return this.getBackoffDelay(retryIndex)

		if (/^\d+(?:\.\d+)?$/.test(retryAfter)) {
			return Math.min(MAX_RETRY_DELAY_MS, Number(retryAfter) * 1_000)
		}

		const retryAt = Date.parse(retryAfter)
		if (!Number.isFinite(retryAt)) return this.getBackoffDelay(retryIndex)

		return Math.min(MAX_RETRY_DELAY_MS, Math.max(0, retryAt - this.now()))
	}

	private getBackoffDelay(retryIndex: number): number {
		return Math.min(MAX_BACKOFF_DELAY_MS, INITIAL_BACKOFF_DELAY_MS * 2 ** retryIndex)
	}

	private normalizeFetchFailure(kind: FetchFailureKind): ReviewGatewayError {
		if (kind === 'timeout') {
			return this.createError({
				code: 'SHOTGRID_TIMEOUT',
				status: 504,
				message: 'ShotGrid did not respond in time.',
				retryable: true,
			})
		}

		return this.createError({
			code: 'SHOTGRID_UNAVAILABLE',
			status: 503,
			message: 'ShotGrid is temporarily unavailable.',
			retryable: true,
		})
	}

	private normalizeAuthenticationResponse(upstreamStatus: number): ReviewGatewayError {
		if (upstreamStatus === 429) {
			return this.createError({
				code: 'SHOTGRID_RATE_LIMITED',
				status: 503,
				message: 'ShotGrid is temporarily rate limited.',
				retryable: true,
				upstreamStatus,
			})
		}

		if (upstreamStatus >= 500) {
			return this.createError({
				code: 'SHOTGRID_UNAVAILABLE',
				status: 503,
				message: 'ShotGrid is temporarily unavailable.',
				retryable: true,
				upstreamStatus,
			})
		}

		return this.createError({
			code: 'SHOTGRID_AUTH_FAILED',
			status: 502,
			message: 'ShotGrid authentication failed.',
			retryable: false,
			upstreamStatus,
		})
	}

	private normalizeUpstreamResponse(upstreamStatus: number): ReviewGatewayError {
		if (upstreamStatus === 401) {
			return this.createError({
				code: 'SHOTGRID_AUTH_FAILED',
				status: 502,
				message: 'ShotGrid authentication failed.',
				retryable: false,
				upstreamStatus,
			})
		}

		if (upstreamStatus === 403) {
			return this.createError({
				code: 'SHOTGRID_PERMISSION_DENIED',
				status: 403,
				message: 'ShotGrid denied this request.',
				retryable: false,
				upstreamStatus,
			})
		}

		if (upstreamStatus === 429) {
			return this.createError({
				code: 'SHOTGRID_RATE_LIMITED',
				status: 503,
				message: 'ShotGrid is temporarily rate limited.',
				retryable: true,
				upstreamStatus,
			})
		}

		if (upstreamStatus === 502 || upstreamStatus === 503 || upstreamStatus === 504) {
			return this.createError({
				code: 'SHOTGRID_UNAVAILABLE',
				status: 503,
				message: 'ShotGrid is temporarily unavailable.',
				retryable: true,
				upstreamStatus,
			})
		}

		const clientStatus = [400, 404, 409, 422].includes(upstreamStatus) ? upstreamStatus : 502
		return this.createError({
			code: 'SHOTGRID_REQUEST_FAILED',
			status: clientStatus,
			message: 'ShotGrid could not complete the request.',
			retryable: false,
			upstreamStatus,
		})
	}

	private invalidPathError(): ReviewGatewayError {
		return this.createError({
			code: 'INVALID_SHOTGRID_PATH',
			status: 400,
			message: 'The ShotGrid request path is invalid.',
			retryable: false,
		})
	}

	private invalidUpstreamResponse(): ReviewGatewayError {
		return this.createError({
			code: 'SHOTGRID_INVALID_RESPONSE',
			status: 502,
			message: 'ShotGrid returned an invalid response.',
			retryable: false,
		})
	}

	private createError(options: {
		code:
			| 'CONFIGURATION_ERROR'
			| 'INVALID_SHOTGRID_PATH'
			| 'SHOTGRID_AUTH_FAILED'
			| 'SHOTGRID_INVALID_RESPONSE'
			| 'SHOTGRID_PERMISSION_DENIED'
			| 'SHOTGRID_RATE_LIMITED'
			| 'SHOTGRID_REQUEST_FAILED'
			| 'SHOTGRID_TIMEOUT'
			| 'SHOTGRID_UNAVAILABLE'
		message: string
		retryable: boolean
		status: number
		upstreamStatus?: number
	}): ReviewGatewayError {
		return new ReviewGatewayError(options)
	}
}
