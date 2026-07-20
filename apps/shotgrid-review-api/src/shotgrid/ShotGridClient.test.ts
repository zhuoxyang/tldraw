import { afterEach, describe, expect, test, vi } from 'vitest'
import type { ShotGridConnectionConfig } from '../config'
import { ReviewGatewayError } from '../errors'
import { ShotGridClient } from './ShotGridClient'

const AUTH_URL = 'https://studio.example.com/api/v1.1/auth/access_token'

function connectionConfig(
	overrides: Partial<ShotGridConnectionConfig> = {}
): ShotGridConnectionConfig {
	return {
		frameRateMode: 'unknown',
		siteUrl: 'https://studio.example.com',
		scriptName: 'review-script',
		scriptKey: 'script-secret',
		timeoutMs: 1_000,
		maxRetries: 0,
		...overrides,
	}
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json', ...headers },
	})
}

function tokenResponse(accessToken: string, expiresIn = 3_600): Response {
	return jsonResponse({
		access_token: accessToken,
		expires_in: expiresIn,
		token_type: 'Bearer',
	})
}

function requestUrl(input: string | URL | Request): string {
	return input instanceof Request ? input.url : String(input)
}

function asFetch(
	handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
): typeof fetch {
	return vi.fn(handler) as unknown as typeof fetch
}

function authorization(init: RequestInit | undefined): string | null {
	return new Headers(init?.headers).get('Authorization')
}

afterEach(() => {
	vi.useRealTimers()
	vi.restoreAllMocks()
})

describe('ShotGridClient', () => {
	test('uses client credentials, caches the token, and blocks automatic redirects', async () => {
		let authenticationCalls = 0
		const resourceTokens: Array<string | null> = []
		const redirects: Array<RequestRedirect | undefined> = []
		const fetch = asFetch(async (input, init) => {
			redirects.push(init?.redirect)
			if (requestUrl(input) === AUTH_URL) {
				authenticationCalls += 1
				const body = new URLSearchParams(String(init?.body))
				expect(body.get('grant_type')).toBe('client_credentials')
				expect(body.get('client_id')).toBe('review-script')
				expect(body.get('client_secret')).toBe('script-secret')
				return tokenResponse('cached-token')
			}

			resourceTokens.push(authorization(init))
			return jsonResponse({ ok: true })
		})
		const client = new ShotGridClient(connectionConfig(), { fetch })

		expect(await client.request('/entity/Project')).toEqual({ ok: true })
		expect(await client.request('/entity/Project/1')).toEqual({ ok: true })

		expect(authenticationCalls).toBe(1)
		expect(resourceTokens).toEqual(['Bearer cached-token', 'Bearer cached-token'])
		expect(redirects).toEqual(['manual', 'manual', 'manual'])
	})

	test('adds the optional ShotGrid sudo scope without exposing it in the resource URL', async () => {
		const fetch = asFetch(async (input, init) => {
			if (requestUrl(input) === AUTH_URL) {
				const body = new URLSearchParams(String(init?.body))
				expect(body.get('scope')).toBe('sudo_as_login:reviewer@example.com')
				return tokenResponse('scoped-token')
			}

			expect(requestUrl(input)).toBe('https://studio.example.com/api/v1.1/entity/HumanUser/1')
			return jsonResponse({ id: 1 })
		})
		const client = new ShotGridClient(connectionConfig({ sudoAsLogin: 'reviewer@example.com' }), {
			fetch,
		})

		await client.request('/entity/HumanUser/1')
	})

	test('refreshes a short-lived token at its conservative expiry boundary', async () => {
		let now = 0
		let authenticationCalls = 0
		const resourceTokens: Array<string | null> = []
		const fetch = asFetch(async (input, init) => {
			if (requestUrl(input) === AUTH_URL) {
				authenticationCalls += 1
				return tokenResponse(`token-${authenticationCalls}`, 0.2)
			}

			resourceTokens.push(authorization(init))
			return jsonResponse({ ok: true })
		})
		const client = new ShotGridClient(connectionConfig(), { fetch, now: () => now })

		await client.request('/entity/Project')
		now = 99
		await client.request('/entity/Project')
		now = 100
		await client.request('/entity/Project')

		expect(authenticationCalls).toBe(2)
		expect(resourceTokens).toEqual(['Bearer token-1', 'Bearer token-1', 'Bearer token-2'])
	})

	test.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
		'rejects invalid token expiry %s',
		async (expiresIn) => {
			const fetch = asFetch(async () => tokenResponse('bad-token', expiresIn))
			const client = new ShotGridClient(connectionConfig(), { fetch })

			await expect(client.request('/entity/Project')).rejects.toMatchObject({
				code: 'SHOTGRID_INVALID_RESPONSE',
				status: 502,
			})
			expect(fetch).toHaveBeenCalledTimes(1)
		}
	)

	test('shares one authentication request across concurrent callers', async () => {
		let resolveAuthentication!: (response: Response) => void
		const authentication = new Promise<Response>((resolve) => {
			resolveAuthentication = resolve
		})
		let authenticationCalls = 0
		const fetch = asFetch(async (input) => {
			if (requestUrl(input) === AUTH_URL) {
				authenticationCalls += 1
				return await authentication
			}
			return jsonResponse({ ok: true })
		})
		const client = new ShotGridClient(connectionConfig(), { fetch })

		const requests = [
			client.request('/entity/Project/1'),
			client.request('/entity/Project/2'),
			client.request('/entity/Project/3'),
		]
		await Promise.resolve()
		expect(authenticationCalls).toBe(1)

		resolveAuthentication(tokenResponse('shared-token'))
		await expect(Promise.all(requests)).resolves.toEqual([{ ok: true }, { ok: true }, { ok: true }])
		expect(authenticationCalls).toBe(1)
	})

	test('evicts a rejected token and replays a 401 response once', async () => {
		let authenticationCalls = 0
		const resourceTokens: Array<string | null> = []
		const fetch = asFetch(async (input, init) => {
			if (requestUrl(input) === AUTH_URL) {
				authenticationCalls += 1
				return tokenResponse(authenticationCalls === 1 ? 'old-token' : 'new-token')
			}

			const token = authorization(init)
			resourceTokens.push(token)
			return token === 'Bearer old-token'
				? jsonResponse({ error: 'expired' }, 401)
				: jsonResponse({ ok: true })
		})
		const client = new ShotGridClient(connectionConfig(), { fetch })

		await expect(client.request('/entity/Project')).resolves.toEqual({ ok: true })
		expect(authenticationCalls).toBe(2)
		expect(resourceTokens).toEqual(['Bearer old-token', 'Bearer new-token'])
	})

	test('does not replay a non-idempotent POST after a 401 response', async () => {
		let authenticationCalls = 0
		let resourceCalls = 0
		const fetch = asFetch(async (input) => {
			if (requestUrl(input) === AUTH_URL) {
				authenticationCalls += 1
				return tokenResponse('mutation-token')
			}

			resourceCalls += 1
			return jsonResponse({ error: 'expired' }, 401)
		})
		const client = new ShotGridClient(connectionConfig({ maxRetries: 3 }), { fetch })

		await expect(
			client.request('/entity/notes', {
				body: { subject: 'Review note' },
				method: 'POST',
			})
		).rejects.toMatchObject({
			code: 'SHOTGRID_AUTH_FAILED',
			retryable: false,
			status: 502,
			upstreamStatus: 401,
		})
		expect(authenticationCalls).toBe(1)
		expect(resourceCalls).toBe(1)
	})

	test('does not evict a newer token when a late 401 rejects an older token', async () => {
		let authenticationCalls = 0
		let oldTokenCalls = 0
		let resolveFirst401!: (response: Response) => void
		let resolveLate401!: (response: Response) => void
		const first401 = new Promise<Response>((resolve) => {
			resolveFirst401 = resolve
		})
		const late401 = new Promise<Response>((resolve) => {
			resolveLate401 = resolve
		})
		const fetch = asFetch(async (input, init) => {
			if (requestUrl(input) === AUTH_URL) {
				authenticationCalls += 1
				return tokenResponse(authenticationCalls === 1 ? 'old-token' : 'new-token')
			}

			if (authorization(init) === 'Bearer old-token') {
				oldTokenCalls += 1
				return await (oldTokenCalls === 1 ? first401 : late401)
			}

			return jsonResponse({ ok: true })
		})
		const client = new ShotGridClient(connectionConfig(), { fetch })

		const firstRequest = client.request('/entity/Project/1')
		const lateRequest = client.request('/entity/Project/2')
		await vi.waitFor(() => expect(oldTokenCalls).toBe(2))

		resolveFirst401(jsonResponse({ error: 'expired' }, 401))
		await expect(firstRequest).resolves.toEqual({ ok: true })
		expect(authenticationCalls).toBe(2)

		resolveLate401(jsonResponse({ error: 'expired' }, 401))
		await expect(lateRequest).resolves.toEqual({ ok: true })
		expect(authenticationCalls).toBe(2)
	})

	test('normalizes a permission failure without retrying it', async () => {
		const sleep = vi.fn(async () => undefined)
		const fetch = asFetch(async (input) =>
			requestUrl(input) === AUTH_URL
				? tokenResponse('permission-token')
				: jsonResponse({ detailedError: 'private upstream detail' }, 403)
		)
		const client = new ShotGridClient(connectionConfig({ maxRetries: 3 }), { fetch, sleep })

		await expect(client.request('/entity/Project')).rejects.toMatchObject({
			code: 'SHOTGRID_PERMISSION_DENIED',
			status: 403,
			retryable: false,
			upstreamStatus: 403,
		})
		expect(fetch).toHaveBeenCalledTimes(2)
		expect(sleep).not.toHaveBeenCalled()
	})

	test('retries a transient GET and caps the upstream Retry-After delay', async () => {
		let resourceCalls = 0
		const sleep = vi.fn(async () => undefined)
		const fetch = asFetch(async (input) => {
			if (requestUrl(input) === AUTH_URL) return tokenResponse('retry-token')
			resourceCalls += 1
			return resourceCalls === 1
				? jsonResponse({ error: 'busy' }, 503, { 'Retry-After': '9999' })
				: jsonResponse({ ok: true })
		})
		const client = new ShotGridClient(connectionConfig({ maxRetries: 1 }), { fetch, sleep })

		await expect(client.request('/entity/Project')).resolves.toEqual({ ok: true })
		expect(resourceCalls).toBe(2)
		expect(sleep).toHaveBeenCalledOnce()
		expect(sleep).toHaveBeenCalledWith(30_000)
	})

	test('retries a network failure for an idempotent request and clears every attempt timer', async () => {
		let resourceCalls = 0
		const sleep = vi.fn(async () => undefined)
		const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
		const fetch = asFetch(async (input) => {
			if (requestUrl(input) === AUTH_URL) return tokenResponse('network-retry-token')
			resourceCalls += 1
			if (resourceCalls === 1) throw new Error('socket closed with private details')
			return jsonResponse({ ok: true })
		})
		const client = new ShotGridClient(connectionConfig({ maxRetries: 1 }), { fetch, sleep })

		await expect(client.request('/entity/Project')).resolves.toEqual({ ok: true })
		expect(resourceCalls).toBe(2)
		expect(sleep).toHaveBeenCalledWith(250)
		// Authentication, the failed resource attempt, and the replay all release their timers.
		expect(clearTimeoutSpy).toHaveBeenCalledTimes(3)
	})

	test('does not retry a POST mutation or advertise a 503 as safely retryable', async () => {
		let resourceCalls = 0
		const sleep = vi.fn(async () => undefined)
		const fetch = asFetch(async (input) => {
			if (requestUrl(input) === AUTH_URL) return tokenResponse('mutation-token')
			resourceCalls += 1
			return jsonResponse({ error: 'busy' }, 503)
		})
		const client = new ShotGridClient(connectionConfig({ maxRetries: 3 }), { fetch, sleep })

		await expect(
			client.request('/entity/Note', { method: 'POST', body: { subject: 'Review note' } })
		).rejects.toMatchObject({
			code: 'SHOTGRID_UNAVAILABLE',
			retryable: false,
			upstreamStatus: 503,
		})
		expect(resourceCalls).toBe(1)
		expect(sleep).not.toHaveBeenCalled()
	})

	test('retries an upstream 500 for an idempotent request', async () => {
		let resourceCalls = 0
		const sleep = vi.fn(async () => undefined)
		const fetch = asFetch(async (input) => {
			if (requestUrl(input) === AUTH_URL) return tokenResponse('server-error-token')
			resourceCalls += 1
			return resourceCalls === 1
				? jsonResponse({ error: 'internal upstream detail' }, 500)
				: jsonResponse({ ok: true })
		})
		const client = new ShotGridClient(connectionConfig({ maxRetries: 1 }), { fetch, sleep })

		await expect(client.request('/entity/Project')).resolves.toEqual({ ok: true })
		expect(resourceCalls).toBe(2)
		expect(sleep).toHaveBeenCalledWith(250)
	})

	test('maps an upstream 404 to the public not-found error', async () => {
		const fetch = asFetch(async (input) =>
			requestUrl(input) === AUTH_URL
				? tokenResponse('not-found-token')
				: jsonResponse({ detail: 'private upstream detail' }, 404)
		)
		const client = new ShotGridClient(connectionConfig(), { fetch })

		await expect(client.request('/entity/Version/404')).rejects.toMatchObject({
			code: 'NOT_FOUND',
			status: 404,
			retryable: false,
			upstreamStatus: 404,
		})
	})

	test('allows a semantically idempotent search POST to opt into retry', async () => {
		let resourceCalls = 0
		const sleep = vi.fn(async () => undefined)
		const fetch = asFetch(async (input, init) => {
			if (requestUrl(input) === AUTH_URL) return tokenResponse('search-token')
			resourceCalls += 1
			expect(requestUrl(input)).toBe(
				'https://studio.example.com/api/v1.1/entity/Version/_search?page=2&fields=id&fields=code'
			)
			expect(init?.body).toBe(JSON.stringify({ filters: [['project', 'is', 42]] }))
			return resourceCalls === 1
				? jsonResponse({ error: 'busy' }, 503)
				: jsonResponse({ data: [{ id: 7 }] })
		})
		const client = new ShotGridClient(connectionConfig({ maxRetries: 1 }), { fetch, sleep })

		await expect(
			client.request('/entity/Version/_search', {
				method: 'POST',
				idempotent: true,
				query: { page: 2, fields: ['id', 'code'] },
				body: { filters: [['project', 'is', 42]] },
			})
		).resolves.toEqual({ data: [{ id: 7 }] })
		expect(resourceCalls).toBe(2)
		expect(sleep).toHaveBeenCalledWith(250)
	})

	test('aborts a timed-out attempt and reports only a normalized error', async () => {
		vi.useFakeTimers()
		let resourceStarted = false
		const fetch = asFetch(async (input, init) => {
			if (requestUrl(input) === AUTH_URL) return tokenResponse('timeout-token')
			resourceStarted = true
			return await new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener('abort', () => reject(new Error('raw timeout detail')), {
					once: true,
				})
			})
		})
		const client = new ShotGridClient(connectionConfig({ timeoutMs: 50 }), { fetch })

		const request = client.request('/entity/Project')
		const rejection = expect(request).rejects.toMatchObject({
			code: 'SHOTGRID_TIMEOUT',
			status: 504,
			retryable: true,
		})
		await vi.runAllTimersAsync()

		expect(resourceStarted).toBe(true)
		await rejection
	})

	test('times out while a successful response body is still streaming', async () => {
		vi.useFakeTimers()
		let bodyStarted = false
		const fetch = asFetch(async (input, init) => {
			if (requestUrl(input) === AUTH_URL) return tokenResponse('slow-body-token')

			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						bodyStarted = true
						init?.signal?.addEventListener(
							'abort',
							() => controller.error(new Error('private slow body detail')),
							{ once: true }
						)
					},
				})
			)
		})
		const client = new ShotGridClient(connectionConfig({ timeoutMs: 50 }), { fetch })

		const request = client.request('/entity/Project')
		const rejection = expect(request).rejects.toMatchObject({
			code: 'SHOTGRID_TIMEOUT',
			status: 504,
			retryable: true,
		})
		await vi.runAllTimersAsync()

		expect(bodyStarted).toBe(true)
		await rejection
	})

	test('marks a non-idempotent body timeout as unsafe to retry', async () => {
		vi.useFakeTimers()
		let resourceStarted = false
		const fetch = asFetch(async (input) => {
			if (requestUrl(input) === AUTH_URL) return tokenResponse('mutation-timeout-token')
			resourceStarted = true
			return new Response(new ReadableStream<Uint8Array>())
		})
		const client = new ShotGridClient(connectionConfig({ timeoutMs: 50, maxRetries: 3 }), {
			fetch,
		})

		const request = client.request('/entity/Note', {
			method: 'POST',
			body: { subject: 'Review note' },
		})
		const rejection = expect(request).rejects.toMatchObject({
			code: 'SHOTGRID_TIMEOUT',
			status: 504,
			retryable: false,
		})
		await vi.runAllTimersAsync()

		expect(resourceStarted).toBe(true)
		await rejection
		expect(fetch).toHaveBeenCalledTimes(2)
	})

	test('rejects and cancels a successful response body larger than 16 MiB', async () => {
		const cancel = vi.fn()
		let resourceCalls = 0
		const sleep = vi.fn(async () => undefined)
		const fetch = asFetch(async (input) => {
			if (requestUrl(input) === AUTH_URL) return tokenResponse('oversized-body-token')
			resourceCalls += 1
			return new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(new Uint8Array(16 * 1024 * 1024 + 1))
					},
					cancel,
				}),
				{ headers: { 'Content-Type': 'application/json' } }
			)
		})
		const client = new ShotGridClient(connectionConfig({ maxRetries: 2 }), { fetch, sleep })

		await expect(client.request('/entity/Project')).rejects.toMatchObject({
			code: 'SHOTGRID_INVALID_RESPONSE',
			status: 502,
			retryable: false,
		})
		expect(resourceCalls).toBe(1)
		expect(cancel).toHaveBeenCalledOnce()
		expect(sleep).not.toHaveBeenCalled()
	})

	test('normalizes malformed successful response bytes without leaking the body', async () => {
		const fetch = asFetch(async (input) =>
			requestUrl(input) === AUTH_URL
				? tokenResponse('malformed-body-token')
				: new Response(Uint8Array.from([0xff, 0x70, 0x72, 0x69, 0x76, 0x61, 0x74, 0x65]))
		)
		const client = new ShotGridClient(connectionConfig(), { fetch })

		let caught: unknown
		try {
			await client.request('/entity/Project')
		} catch (error) {
			caught = error
		}

		expect(caught).toMatchObject({
			code: 'SHOTGRID_INVALID_RESPONSE',
			status: 502,
			retryable: false,
		})
		expect(JSON.stringify(caught)).not.toContain('private')
	})

	test('never includes server credentials, tokens, or upstream text in an error', async () => {
		const accessToken = 'access-token-secret'
		const scriptKey = 'script-key-secret'
		const fetch = asFetch(async (input) => {
			if (requestUrl(input) === AUTH_URL) return tokenResponse(accessToken)
			throw new Error(`upstream failure ${accessToken} ${scriptKey}`)
		})
		const client = new ShotGridClient(connectionConfig({ scriptKey }), { fetch })

		let caught: unknown
		try {
			await client.request('/entity/Project')
		} catch (error) {
			caught = error
		}

		expect(caught).toBeInstanceOf(ReviewGatewayError)
		const serialized = JSON.stringify(
			(caught as ReviewGatewayError).toApiErrorEnvelope('request-id')
		)
		expect(serialized).not.toContain(accessToken)
		expect(serialized).not.toContain(scriptKey)
		expect(serialized).not.toContain('upstream failure')
	})

	test('rejects absolute and escaping paths before authenticating', async () => {
		const fetch = asFetch(async () => tokenResponse('unused-token'))
		const client = new ShotGridClient(connectionConfig(), { fetch })

		await expect(client.request('https://attacker.example/steal')).rejects.toMatchObject({
			code: 'INVALID_SHOTGRID_PATH',
			status: 400,
		})
		await expect(client.request('/../auth/access_token')).rejects.toMatchObject({
			code: 'INVALID_SHOTGRID_PATH',
			status: 400,
		})
		expect(fetch).not.toHaveBeenCalled()
	})

	test('returns undefined for a successful no-content response', async () => {
		const fetch = asFetch(async (input) =>
			requestUrl(input) === AUTH_URL
				? tokenResponse('no-content-token')
				: new Response(null, { status: 204 })
		)
		const client = new ShotGridClient(connectionConfig(), { fetch })

		await expect(client.request<void>('/entity/Note/1', { method: 'DELETE' })).resolves.toBe(
			undefined
		)
	})
})
