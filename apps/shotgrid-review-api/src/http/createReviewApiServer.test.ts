import { createHash } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { deflateSync } from 'node:zlib'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { InMemoryReviewAuditStore } from '../audit/ReviewAuditStore'
import type { ReviewVersion } from '../contracts'
import { ReviewGatewayError } from '../errors'
import type { ReviewGateway } from '../gateway/ReviewGateway'
import { createReviewApiServer, type ReviewApiServerOptions } from './createReviewApiServer'
import {
	InMemoryReviewPublicationStore,
	type ReviewPublicationStore,
} from './ReviewPublicationStore'

const servers: ReturnType<typeof createReviewApiServer>[] = []
const PNG_BYTES = makeTestPng()
const PNG_SHA256 = createHash('sha256').update(PNG_BYTES).digest('hex')
const PUBLICATION_ID = '018f3f72-1d6b-4c51-8f4b-a12c9d2e3478'
const TRUSTED_PROXY_TOKEN = 'test-trusted-proxy-token-with-32-characters'
const METRICS_TOKEN = 'test-metrics-token-with-at-least-32-characters'
const FIXED_ACTOR_SUBJECT = 'oidc:test:reviewer-123'
const PUBLICATION_LINKS = {
	entity: { id: 501, name: 'shot_010', type: 'Shot' },
	project: { id: 101, name: 'Project', type: 'Project' },
	task: { id: 601, name: 'Lighting' },
	version: { id: 301, name: 'shot_v001', type: 'Version' },
}
const VERSION_FIXTURE: ReviewVersion = {
	createdAt: '2026-07-20T00:00:00Z',
	createdBy: null,
	description: null,
	entity: { id: 501, name: 'shot_010', type: 'Shot' },
	id: 301,
	media: {
		contentType: 'image/svg+xml',
		height: 1080,
		kind: 'image',
		thumbnailUrl: '/mock-media/northstar-lighting.svg',
		url: '/mock-media/northstar-lighting.svg',
		width: 1920,
	},
	name: 'shot_v001',
	playlistId: 201,
	projectId: 101,
	statusCode: 'rev',
	submittedBy: null,
	task: { id: 601, name: 'Lighting' },
}

afterEach(async () => {
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve, reject) => {
					server.close((error) => (error ? reject(error) : resolve()))
				})
		)
	)
})

describe('createReviewApiServer', () => {
	test('requires an explicit durable publication store in live mode', () => {
		expect(() =>
			createReviewApiServer({
				allowedOrigin: 'http://127.0.0.1:5430',
				gateway: makeGateway(),
				mode: 'shotgrid',
				trustedProxyToken: TRUSTED_PROXY_TOKEN,
			})
		).toThrow(expect.objectContaining({ code: 'CONFIGURATION_ERROR', status: 500 }))
	})

	test('requires a stable service actor identity when live mode does not impersonate a user', () => {
		expect(() =>
			createReviewApiServer({
				allowedOrigin: 'http://127.0.0.1:5430',
				gateway: makeGateway(),
				mode: 'shotgrid',
				publicationDeploymentScope: 'https://studio.example.test',
				publicationStore: new InMemoryReviewPublicationStore(),
				trustedProxyToken: TRUSTED_PROXY_TOKEN,
			})
		).toThrow(expect.objectContaining({ code: 'CONFIGURATION_ERROR', status: 500 }))
	})

	test.each([undefined, 'short', `${'m'.repeat(32)} `])(
		'requires a canonical operational metrics token in live mode: %s',
		(metricsToken) => {
			expect(() =>
				createReviewApiServer({
					allowedOrigin: 'http://127.0.0.1:5430',
					auditStore: new InMemoryReviewAuditStore(),
					fixedActorSubject: FIXED_ACTOR_SUBJECT,
					gateway: makeGateway(),
					mode: 'shotgrid',
					publicationDeploymentScope: 'https://studio.example.test',
					publicationStore: new InMemoryReviewPublicationStore(),
					serviceActorName: 'review-gateway',
					trustedProxyToken: TRUSTED_PROXY_TOKEN,
					...(metricsToken === undefined ? undefined : { metricsToken }),
				})
			).toThrow(expect.objectContaining({ code: 'CONFIGURATION_ERROR', status: 500 }))
		}
	)

	test('requires a canonical deployment scope for live publication keys', () => {
		expect(() =>
			createReviewApiServer({
				allowedOrigin: 'http://127.0.0.1:5430',
				gateway: makeGateway(),
				mode: 'shotgrid',
				publicationStore: new InMemoryReviewPublicationStore(),
				serviceActorName: 'review-gateway',
				trustedProxyToken: TRUSTED_PROXY_TOKEN,
			})
		).toThrow(expect.objectContaining({ code: 'CONFIGURATION_ERROR', status: 500 }))
	})

	test('exposes non-sensitive health and read contracts', async () => {
		const gateway = makeGateway()
		const baseUrl = await start(gateway)

		await expectJson(`${baseUrl}/api/health`, 200, { mode: 'mock', status: 'ok' })
		await expectJson(`${baseUrl}/api/review/me`, 200, {
			data: { avatarUrl: null, id: 7, kind: 'human', login: 'reviewer', name: 'Reviewer' },
		})
		await expectJson(`${baseUrl}/api/review/projects`, 200, {
			data: [{ id: 101, name: 'Project', statusCode: 'act', thumbnailUrl: null }],
		})
		await expectJson(`${baseUrl}/api/review/projects/101/playlists`, 200, {
			data: [
				{
					description: null,
					id: 201,
					name: 'Dailies',
					projectId: 101,
					updatedAt: '2026-07-20T00:00:00Z',
					versionCount: 1,
				},
			],
		})
		await expectJson(`${baseUrl}/api/review/playlists/201/versions`, 200, {
			data: [VERSION_FIXTURE],
		})
		await expectJson(`${baseUrl}/api/review/playlists/201/versions/301`, 200, {
			data: VERSION_FIXTURE,
		})

		expect(gateway.getVersion).toHaveBeenCalledWith(201, 301)
		expect(gateway.listPlaylists).toHaveBeenCalledWith(101)
		expect(gateway.listVersions).toHaveBeenCalledWith(201)
	})

	test('protects bounded Prometheus metrics with a separate operational token', async () => {
		const logger = { error: vi.fn(), info: vi.fn() }
		const baseUrl = await start(makeGateway(), logger)

		const unauthenticated = await fetch(`${baseUrl}/internal/metrics`)
		expect(unauthenticated.status).toBe(401)
		expect(await unauthenticated.text()).not.toContain(METRICS_TOKEN)

		await expectJson(`${baseUrl}/api/review/playlists/201/versions/301`, 200, {
			data: VERSION_FIXTURE,
		})
		const metrics = await fetch(`${baseUrl}/internal/metrics`, {
			headers: { 'X-Review-Metrics-Token': METRICS_TOKEN },
		})
		expect(metrics.status).toBe(200)
		expect(metrics.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8')
		const body = await metrics.text()
		expect(body).toContain(
			'shotgrid_review_api_http_requests_total{method="GET",route="version",status="200"} 1'
		)
		expect(body).toContain(
			'shotgrid_review_api_http_requests_total{method="GET",route="metrics",status="401"} 1'
		)
		expect(body).not.toContain('/api/review/playlists/201/versions/301')
		expect(body).not.toContain(METRICS_TOKEN)
		expect(JSON.stringify(logger.info.mock.calls)).not.toContain('/api/review/playlists/201')
		expect(logger.info).toHaveBeenCalledWith(
			'request_completed',
			expect.objectContaining({ method: 'GET', route: 'version', status: 200 })
		)
	})

	test('serves a bounded image payload with non-cacheable, non-sniffable headers', async () => {
		const imageBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
		const getVersionImage = vi.fn<ReviewGateway['getVersionImage']>(async () => ({
			body: imageBytes,
			contentType: 'image/jpeg',
		}))
		const gateway = makeGateway({ getVersionImage })
		const baseUrl = await start(gateway)

		const response = await fetch(`${baseUrl}/api/review/playlists/201/versions/301/media/image`)

		expect(response.status).toBe(200)
		expect(response.headers.get('cache-control')).toBe('no-store')
		expect(response.headers.get('content-length')).toBe(String(imageBytes.byteLength))
		expect(response.headers.get('content-type')).toBe('image/jpeg')
		expect(response.headers.get('x-content-type-options')).toBe('nosniff')
		expect(response.headers.get('x-request-id')).toBe('test-request-id')
		expect(Buffer.from(await response.arrayBuffer())).toEqual(imageBytes)
		expect(getVersionImage).toHaveBeenCalledOnce()
		const [playlistId, versionId, signal] = getVersionImage.mock.calls[0]
		expect([playlistId, versionId]).toEqual([201, 301])
		expect(signal).toBeInstanceOf(AbortSignal)
	})

	test('streams a full video payload and disposes its upstream resource', async () => {
		const bytes = Buffer.from('browser-playable-mp4')
		const dispose = vi.fn(async () => {})
		const getVersionVideo = vi.fn<ReviewGateway['getVersionVideo']>(async () => ({
			body: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(bytes.subarray(0, 5))
					controller.enqueue(bytes.subarray(5))
					controller.close()
				},
			}),
			contentLength: bytes.byteLength,
			contentRange: null,
			contentType: 'video/mp4',
			dispose,
			status: 200,
		}))
		const baseUrl = await start(makeGateway({ getVersionVideo }))

		const response = await fetch(`${baseUrl}/api/review/playlists/201/versions/301/media/video/901`)

		expect(response.status).toBe(200)
		expect(response.headers.get('accept-ranges')).toBe('bytes')
		expect(response.headers.get('cache-control')).toBe('no-store')
		expect(response.headers.get('content-length')).toBe(String(bytes.byteLength))
		expect(response.headers.get('content-range')).toBeNull()
		expect(response.headers.get('content-type')).toBe('video/mp4')
		expect(response.headers.get('x-content-type-options')).toBe('nosniff')
		expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
		expect(dispose).toHaveBeenCalledOnce()
		expect(getVersionVideo).toHaveBeenCalledOnce()
		const [playlistId, versionId, attachmentId, range, signal] = getVersionVideo.mock.calls[0]
		expect({ attachmentId, playlistId, range, versionId }).toEqual({
			attachmentId: 901,
			playlistId: 201,
			range: null,
			versionId: 301,
		})
		expect(signal).toBeInstanceOf(AbortSignal)
	})

	test.each([
		['bytes=2-5', { end: 5, kind: 'closed', start: 2 }],
		['bytes=6-', { kind: 'open', start: 6 }],
		['bytes=-3', { kind: 'suffix', length: 3 }],
	] as const)('accepts one canonical %s range', async (header, expectedRange) => {
		const getVersionVideo = vi.fn<ReviewGateway['getVersionVideo']>(
			async (_playlistId, _versionId, _attachmentId, range) => {
				expect(range).toEqual(expectedRange)
				const contentRange =
					range?.kind === 'closed'
						? 'bytes 2-5/10'
						: range?.kind === 'open'
							? 'bytes 6-9/10'
							: 'bytes 7-9/10'
				const bytes = Buffer.alloc(range?.kind === 'suffix' ? 3 : 4, 7)
				return {
					body: new ReadableStream({
						start(controller) {
							controller.enqueue(bytes)
							controller.close()
						},
					}),
					contentLength: bytes.byteLength,
					contentRange,
					contentType: 'video/mp4',
					dispose: async () => {},
					status: 206,
				}
			}
		)
		const baseUrl = await start(makeGateway({ getVersionVideo }))

		const response = await fetch(
			`${baseUrl}/api/review/playlists/201/versions/301/media/video/901`,
			{ headers: { Range: header } }
		)

		expect(response.status).toBe(206)
		expect(response.headers.get('content-range')).toMatch(/^bytes /)
		await response.arrayBuffer()
		expect(getVersionVideo).toHaveBeenCalledOnce()
	})

	test.each([
		'items=0-1',
		'bytes=',
		'bytes=0-1,2-3',
		'bytes=5-4',
		'bytes=-0',
		'bytes=01-2',
		'bytes=9007199254740992-',
		'bytes =0-1',
	])('rejects malformed or multiple video range %s before gateway work', async (range) => {
		const getVersionVideo = vi.fn<ReviewGateway['getVersionVideo']>()
		const baseUrl = await start(makeGateway({ getVersionVideo }))

		const response = await fetch(
			`${baseUrl}/api/review/playlists/201/versions/301/media/video/901`,
			{ headers: { Range: range } }
		)

		expect(response.status).toBe(416)
		expect(await response.json()).toMatchObject({
			error: { code: 'INVALID_REQUEST', retryable: false },
		})
		expect(getVersionVideo).not.toHaveBeenCalled()
	})

	test('returns the validated resource length for an unsatisfied upstream range', async () => {
		const getVersionVideo = vi.fn<ReviewGateway['getVersionVideo']>(async () => {
			throw new ReviewGatewayError({
				code: 'INVALID_REQUEST',
				rangeResourceLength: 10,
				retryable: false,
				status: 416,
				upstreamStatus: 416,
			})
		})
		const baseUrl = await start(makeGateway({ getVersionVideo }))

		const response = await fetch(
			`${baseUrl}/api/review/playlists/201/versions/301/media/video/901`,
			{ headers: { Range: 'bytes=10-' } }
		)

		expect(response.status).toBe(416)
		expect(response.headers.get('content-range')).toBe('bytes */10')
		expect(await response.json()).toMatchObject({
			error: { code: 'INVALID_REQUEST', upstreamStatus: 416 },
		})
	})

	test('disposes a video stream when its declared length does not match', async () => {
		const dispose = vi.fn(async () => {})
		const getVersionVideo = vi.fn<ReviewGateway['getVersionVideo']>(async () => ({
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(Uint8Array.from([1]))
					controller.close()
				},
			}),
			contentLength: 2,
			contentRange: null,
			contentType: 'video/mp4',
			dispose,
			status: 200,
		}))
		const baseUrl = await start(makeGateway({ getVersionVideo }))

		await expect(
			fetch(`${baseUrl}/api/review/playlists/201/versions/301/media/video/901`).then((response) =>
				response.arrayBuffer()
			)
		).rejects.toThrow()
		expect(dispose).toHaveBeenCalledOnce()
	})

	test('propagates a disconnected video client to the gateway abort signal', async () => {
		let gatewaySignal: AbortSignal | undefined
		const getVersionVideo = vi.fn<ReviewGateway['getVersionVideo']>(
			async (_playlistId, _versionId, _attachmentId, _range, signal) => {
				gatewaySignal = signal
				return await new Promise((_resolve, reject) => {
					signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
				})
			}
		)
		const baseUrl = await start(makeGateway({ getVersionVideo }))
		const clientController = new AbortController()
		const pending = fetch(`${baseUrl}/api/review/playlists/201/versions/301/media/video/901`, {
			signal: clientController.signal,
		})
		await vi.waitFor(() => expect(getVersionVideo).toHaveBeenCalledOnce())

		clientController.abort()
		await expect(pending).rejects.toThrow()
		await vi.waitFor(() => expect(gatewaySignal?.aborted).toBe(true))
	})

	test('releases a late video chunk after the client disconnects during an upstream read', async () => {
		let releaseChunk!: () => void
		let markPullStarted!: () => void
		const pullStarted = new Promise<void>((resolve) => {
			markPullStarted = resolve
		})
		const chunkGate = new Promise<void>((resolve) => {
			releaseChunk = resolve
		})
		const dispose = vi.fn(async () => {})
		const getVersionVideo = vi.fn<ReviewGateway['getVersionVideo']>(async () => ({
			body: new ReadableStream({
				async pull(controller) {
					markPullStarted()
					await chunkGate
					controller.enqueue(Uint8Array.from([1]))
					controller.close()
				},
			}),
			contentLength: 1,
			contentRange: null,
			contentType: 'video/mp4',
			dispose,
			status: 200,
		}))
		const baseUrl = await start(makeGateway({ getVersionVideo }))
		const clientController = new AbortController()
		const response = await fetch(
			`${baseUrl}/api/review/playlists/201/versions/301/media/video/901`,
			{ signal: clientController.signal }
		)
		const body = response.arrayBuffer()
		await pullStarted

		clientController.abort()
		releaseChunk()
		await expect(body).rejects.toThrow()
		await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce())
	})

	test('times out a stalled downstream video client and disposes upstream capacity', async () => {
		const bytes = Buffer.alloc(64 * 1024, 7)
		const dispose = vi.fn(async () => {})
		const getVersionVideo = vi.fn<ReviewGateway['getVersionVideo']>(async () => ({
			body: new ReadableStream({
				start(controller) {
					controller.enqueue(bytes)
					controller.close()
				},
			}),
			contentLength: bytes.byteLength,
			contentRange: null,
			contentType: 'video/mp4',
			dispose,
			status: 200,
		}))
		const baseUrl = await start(makeGateway({ getVersionVideo }), undefined, {
			mode: 'mock',
			videoDownstreamIdleTimeoutMs: 10,
		})
		const server = servers.at(-1)
		if (!server) throw new Error('Expected a test server')
		server.prependListener('request', (_request, response) => {
			response.write = vi.fn(() => false) as typeof response.write
		})

		const response = await fetch(`${baseUrl}/api/review/playlists/201/versions/301/media/video/901`)
		await expect(response.arrayBuffer()).rejects.toThrow()
		await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce())
	})

	test('keeps health public but requires the trusted proxy for live review routes', async () => {
		const gateway = makeGateway()
		const logger = { error: vi.fn() }
		const baseUrl = await start(gateway, logger, {
			mode: 'shotgrid',
			trustedProxyToken: TRUSTED_PROXY_TOKEN,
		})

		await expectJson(`${baseUrl}/api/health`, 200, { mode: 'shotgrid', status: 'ok' })

		const unauthenticatedRequests: RequestInit[] = [
			{},
			{ headers: { 'X-Review-Proxy-Token': 'incorrect-token' } },
		]
		for (const request of unauthenticatedRequests) {
			const response = await fetch(`${baseUrl}/api/review/projects`, request)
			expect(response.status).toBe(401)
			expect(await response.json()).toEqual({
				error: {
					code: 'AUTHENTICATION_REQUIRED',
					message: 'Authentication is required.',
					requestId: 'test-request-id',
					retryable: false,
				},
			})
		}

		expect(gateway.listProjects).not.toHaveBeenCalled()
		await expectJson(
			`${baseUrl}/api/review/projects`,
			200,
			{ data: [{ id: 101, name: 'Project', statusCode: 'act', thumbnailUrl: null }] },
			{ headers: trustedProxyHeaders() }
		)
		expect(logger.error).not.toHaveBeenCalled()
	})

	test('binds a trusted proxy request to the configured fixed subject', async () => {
		const gateway = makeGateway()
		const baseUrl = await start(gateway, undefined, {
			mode: 'shotgrid',
			sudoAsLogin: 'reviewer@example.test',
			trustedProxyToken: TRUSTED_PROXY_TOKEN,
		})

		const invalidIdentityHeaders: HeadersInit[] = [
			{ 'X-Review-Proxy-Token': TRUSTED_PROXY_TOKEN },
			{
				'X-Review-Authenticated-Subject': 'oidc:test:another-reviewer',
				'X-Review-Proxy-Token': TRUSTED_PROXY_TOKEN,
			},
		]
		for (const headers of invalidIdentityHeaders) {
			const response = await fetch(`${baseUrl}/api/review/projects`, { headers })
			expect(response.status).toBe(401)
			expect(await response.json()).toMatchObject({
				error: { code: 'AUTHENTICATION_REQUIRED', retryable: false },
			})
		}

		await expectJson(
			`${baseUrl}/api/review/projects`,
			200,
			{ data: [{ id: 101, name: 'Project', statusCode: 'act', thumbnailUrl: null }] },
			{ headers: trustedProxyHeaders() }
		)
		const noteOptions = await fetch(
			`${baseUrl}/api/review/playlists/201/versions/301/note-options`,
			{ headers: trustedProxyHeaders() }
		)
		expect(noteOptions.status).toBe(200)
		await noteOptions.json()
		expect(gateway.getNoteOptions).toHaveBeenCalledWith(201, 301)
	})

	test('denies service identities access to human review publication routes', async () => {
		const gateway = makeGateway()
		const publicationStore: ReviewPublicationStore = {
			initialize: vi.fn(),
			runExclusive: vi.fn(),
		}
		const baseUrl = await start(gateway, undefined, {
			mode: 'shotgrid',
			publicationStore,
			trustedProxyToken: TRUSTED_PROXY_TOKEN,
		})
		const headers = trustedProxyHeaders()

		const noteOptions = await fetch(
			`${baseUrl}/api/review/playlists/201/versions/301/note-options`,
			{ headers }
		)
		expect(noteOptions.status).toBe(403)
		expect(await noteOptions.json()).toMatchObject({
			error: { code: 'PERMISSION_DENIED', retryable: false },
		})

		const decisionContext = await fetch(
			`${baseUrl}/api/review/playlists/201/versions/301/decision-context`,
			{ headers }
		)
		expect(decisionContext.status).toBe(403)

		const decision = await fetch(`${baseUrl}/api/review/playlists/201/versions/301/decision`, {
			body: 'not-json-and-must-not-be-parsed',
			headers: { ...headers, 'Content-Type': 'application/json' },
			method: 'PUT',
		})
		expect(decision.status).toBe(403)

		const publication = await fetch(
			`${baseUrl}/api/review/playlists/201/versions/301/publications/${PUBLICATION_ID}`,
			{
				body: 'not-json-and-must-not-be-parsed',
				headers: { ...headers, 'Content-Type': 'application/json' },
				method: 'PUT',
			}
		)
		expect(publication.status).toBe(403)
		expect(await publication.json()).toMatchObject({
			error: { code: 'PERMISSION_DENIED', retryable: false },
		})

		expect(gateway.getNoteOptions).not.toHaveBeenCalled()
		expect(gateway.getDecisionContext).not.toHaveBeenCalled()
		expect(gateway.updateVersionDecision).not.toHaveBeenCalled()
		expect(gateway.createPublicationNote).not.toHaveBeenCalled()
		expect(gateway.uploadAttachment).not.toHaveBeenCalled()
		expect(publicationStore.initialize).not.toHaveBeenCalled()
		expect(publicationStore.runExclusive).not.toHaveBeenCalled()
	})

	test('keeps browse-only live deployments running but fails decision routes without mappings', async () => {
		const gateway = makeGateway()
		const logger = { error: vi.fn() }
		const baseUrl = await start(gateway, logger, {
			mode: 'shotgrid',
			sudoAsLogin: 'reviewer@example.test',
			trustedProxyToken: TRUSTED_PROXY_TOKEN,
		})
		const headers = trustedProxyHeaders()

		const context = await fetch(
			`${baseUrl}/api/review/playlists/201/versions/301/decision-context`,
			{ headers }
		)
		expect(context.status).toBe(500)
		expect(await context.json()).toMatchObject({
			error: { code: 'CONFIGURATION_ERROR', retryable: false },
		})
		const decision = await fetch(`${baseUrl}/api/review/playlists/201/versions/301/decision`, {
			body: JSON.stringify({ decisionKey: 'approve', expectedStatusCode: 'rev' }),
			headers: { ...headers, 'Content-Type': 'application/json' },
			method: 'PUT',
		})
		expect(decision.status).toBe(500)
		expect(gateway.getDecisionContext).not.toHaveBeenCalled()
		expect(gateway.updateVersionDecision).not.toHaveBeenCalled()
	})

	test('rejects non-exact decision bodies before the gateway', async () => {
		const gateway = makeGateway()
		const baseUrl = await start(gateway)
		for (const body of [
			{ decisionKey: 'approve' },
			{ decisionKey: 'Approve', expectedStatusCode: 'rev' },
			{ decisionKey: 'approve', expectedStatusCode: 'status code' },
			{ decisionKey: 'approve', expectedStatusCode: 'rev', statusCode: 'apr' },
		]) {
			const response = await fetch(`${baseUrl}/api/review/playlists/201/versions/301/decision`, {
				body: JSON.stringify(body),
				headers: { 'Content-Type': 'application/json' },
				method: 'PUT',
			})
			expect(response.status).toBe(400)
			expect(await response.json()).toMatchObject({
				error: { code: 'INVALID_REQUEST', retryable: false },
			})
		}
		expect(gateway.updateVersionDecision).not.toHaveBeenCalled()
	})

	test('returns a stable decision conflict without presenting success', async () => {
		const gateway = makeGateway({
			updateVersionDecision: vi.fn(async () => {
				throw new ReviewGatewayError({
					code: 'DECISION_CONFLICT',
					retryable: false,
					status: 409,
				})
			}),
		})
		const baseUrl = await start(gateway)
		const response = await fetch(`${baseUrl}/api/review/playlists/201/versions/301/decision`, {
			body: JSON.stringify({ decisionKey: 'approve', expectedStatusCode: 'rev' }),
			headers: { 'Content-Type': 'application/json' },
			method: 'PUT',
		})

		expect(response.status).toBe(409)
		expect(await response.json()).toMatchObject({
			error: { code: 'DECISION_CONFLICT', retryable: false },
		})
	})

	test('fails closed before review mutations when the audit intent cannot be persisted', async () => {
		const auditStore = {
			begin: vi.fn(async () => {
				throw new Error('audit store unavailable')
			}),
			finish: vi.fn(async () => {}),
		}
		const gateway = makeGateway()
		const logger = { error: vi.fn() }
		const baseUrl = await start(gateway, logger, {
			auditStore,
			mode: 'shotgrid',
			sudoAsLogin: 'reviewer@example.test',
			trustedProxyToken: TRUSTED_PROXY_TOKEN,
		})
		const headers = { ...trustedProxyHeaders(), 'Content-Type': 'application/json' }

		const decision = await fetch(`${baseUrl}/api/review/playlists/201/versions/301/decision`, {
			body: JSON.stringify({ decisionKey: 'approve', expectedStatusCode: 'rev' }),
			headers,
			method: 'PUT',
		})
		const publication = await fetch(
			`${baseUrl}/api/review/playlists/201/versions/301/publications/${PUBLICATION_ID}`,
			{
				body: JSON.stringify(publicationRequest()),
				headers,
				method: 'PUT',
			}
		)

		expect(decision.status).toBe(500)
		expect(await decision.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } })
		expect(publication.status).toBe(500)
		expect(await publication.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } })
		expect(auditStore.begin).toHaveBeenCalledTimes(2)
		expect(auditStore.finish).not.toHaveBeenCalled()
		expect(gateway.updateVersionDecision).not.toHaveBeenCalled()
		expect(gateway.createPublicationNote).not.toHaveBeenCalled()
		expect(gateway.uploadAttachment).not.toHaveBeenCalled()
	})

	test('audits a successful decision with opaque bounded metadata only', async () => {
		const auditStore = new InMemoryReviewAuditStore()
		const gateway = makeGateway()
		const baseUrl = await start(gateway, undefined, {
			auditStore,
			decisions: [{ key: 'approve', label: 'Approve', statusCode: 'apr' }],
			mode: 'shotgrid',
			sudoAsLogin: 'reviewer@example.test',
			trustedProxyToken: TRUSTED_PROXY_TOKEN,
		})
		const response = await fetch(`${baseUrl}/api/review/playlists/201/versions/301/decision`, {
			body: JSON.stringify({ decisionKey: 'approve', expectedStatusCode: 'rev' }),
			headers: { ...trustedProxyHeaders(), 'Content-Type': 'application/json' },
			method: 'PUT',
		})

		expect(response.status).toBe(200)
		await response.json()
		const entries = auditStore.getEntries()
		expect(entries).toHaveLength(2)
		expect(entries[0]).toMatchObject({
			action: 'decision',
			decisionStatus: null,
			effectiveActor: { id: 7, kind: 'human' },
			entryKind: 'attempt',
			outcome: null,
			playlistId: 201,
			principalId: expectedPrincipalId(),
			projectId: 101,
			requestId: 'test-request-id',
			versionId: 301,
		})
		expect(entries[1]).toMatchObject({
			action: 'decision',
			decisionStatus: 'apr',
			effectiveActor: { id: 7, kind: 'human' },
			entryKind: 'outcome',
			errorCode: null,
			outcome: 'succeeded',
			playlistId: 201,
			principalId: expectedPrincipalId(),
			projectId: 101,
			requestId: 'test-request-id',
			resultAttachmentId: null,
			resultNoteId: null,
			versionId: 301,
		})
		expect(entries[1].attemptId).toBe(entries[0].attemptId)

		const serialized = JSON.stringify(entries)
		expect(serialized).not.toContain(FIXED_ACTOR_SUBJECT)
		expect(serialized).not.toContain(TRUSTED_PROXY_TOKEN)
		expect(serialized).not.toContain('decisionKey')
		expect(serialized).not.toContain('expectedStatusCode')
		expect(serialized).not.toContain('approve')
	})

	test('audits an indeterminate decision outcome and its stable error code', async () => {
		const auditStore = new InMemoryReviewAuditStore()
		const gateway = makeGateway({
			updateVersionDecision: vi.fn<ReviewGateway['updateVersionDecision']>(async (request) => ({
				changed: true,
				decisionKey: request.decision.key,
				playlistId: request.playlistId,
				previousStatusCode: request.expectedStatusCode,
				reviewer: await makeGateway().getCurrentReviewer(),
				statusCode: 'unexpected',
				updatedAt: '2026-07-20T00:00:00Z',
				versionId: request.versionId,
			})),
		})
		const baseUrl = await start(gateway, undefined, {
			auditStore,
			decisions: [{ key: 'approve', label: 'Approve', statusCode: 'apr' }],
			mode: 'shotgrid',
			sudoAsLogin: 'reviewer@example.test',
			trustedProxyToken: TRUSTED_PROXY_TOKEN,
		})
		const response = await fetch(`${baseUrl}/api/review/playlists/201/versions/301/decision`, {
			body: JSON.stringify({ decisionKey: 'approve', expectedStatusCode: 'rev' }),
			headers: { ...trustedProxyHeaders(), 'Content-Type': 'application/json' },
			method: 'PUT',
		})

		expect(response.status).toBe(502)
		expect(await response.json()).toMatchObject({
			error: { code: 'DECISION_INDETERMINATE', retryable: false },
		})
		expect(auditStore.getEntries()).toHaveLength(2)
		expect(auditStore.getEntries()[1]).toMatchObject({
			action: 'decision',
			decisionStatus: null,
			entryKind: 'outcome',
			errorCode: 'DECISION_INDETERMINATE',
			outcome: 'indeterminate',
			resultAttachmentId: null,
			resultNoteId: null,
		})
	})

	test('audits successful publication identifiers without review content or credentials', async () => {
		const auditStore = new InMemoryReviewAuditStore()
		const gateway = makeGateway()
		const baseUrl = await start(gateway, undefined, {
			auditStore,
			mode: 'shotgrid',
			sudoAsLogin: 'reviewer@example.test',
			trustedProxyToken: TRUSTED_PROXY_TOKEN,
		})
		const ticket = 'super-secret-socket-ticket'
		const response = await fetch(
			`${baseUrl}/api/review/playlists/201/versions/301/publications/${PUBLICATION_ID}`,
			{
				body: JSON.stringify(publicationRequest()),
				headers: {
					...trustedProxyHeaders(),
					'Content-Type': 'application/json',
					'X-Review-Socket-Ticket': ticket,
				},
				method: 'PUT',
			}
		)

		expect(response.status).toBe(200)
		await response.json()
		const entries = auditStore.getEntries()
		expect(entries).toHaveLength(2)
		expect(entries[0]).toMatchObject({
			action: 'publication',
			effectiveActor: { id: 7, kind: 'human' },
			entryKind: 'attempt',
			playlistId: 201,
			principalId: expectedPrincipalId(),
			projectId: 101,
			requestId: 'test-request-id',
			versionId: 301,
		})
		expect(entries[1]).toMatchObject({
			action: 'publication',
			decisionStatus: null,
			entryKind: 'outcome',
			errorCode: null,
			outcome: 'succeeded',
			resultAttachmentId: 501,
			resultNoteId: 401,
		})
		expect(entries[1].attemptId).toBe(entries[0].attemptId)

		const serialized = JSON.stringify(entries)
		expect(serialized).not.toContain('Move the highlight left')
		expect(serialized).not.toContain('Lighting note')
		expect(serialized).not.toContain(PNG_BYTES.toString('base64'))
		expect(serialized).not.toContain(PNG_SHA256)
		expect(serialized).not.toContain(TRUSTED_PROXY_TOKEN)
		expect(serialized).not.toContain(ticket)
		expect(serialized).not.toContain('contentBase64')
	})

	test('does not require proxy headers in local mock mode', async () => {
		const gateway = makeGateway()
		const baseUrl = await start(gateway)

		const response = await fetch(`${baseUrl}/api/review/projects`)
		expect(response.status).toBe(200)
		expect(gateway.listProjects).toHaveBeenCalledOnce()
	})

	test('derives note options and publishes a note with its PNG attachment', async () => {
		const gateway = makeGateway()
		const baseUrl = await start(gateway)

		await expectJson(`${baseUrl}/api/review/playlists/201/versions/301/note-options`, 200, {
			data: {
				links: PUBLICATION_LINKS,
				recipients: [
					{
						avatarUrl: null,
						id: 7,
						kind: 'human',
						login: 'reviewer',
						name: 'Reviewer',
					},
				],
			},
		})

		await expectJson(
			`${baseUrl}/api/review/playlists/201/versions/301/publications/${PUBLICATION_ID}`,
			200,
			{
				data: {
					attachment: {
						contentType: 'image/png',
						fileName: 'annotation.png',
						id: 501,
						noteId: 401,
						sizeBytes: PNG_BYTES.byteLength,
					},
					links: PUBLICATION_LINKS,
					note: {
						content: 'Move the highlight left',
						createdAt: '2026-07-20T00:00:00Z',
						createdBy: {
							avatarUrl: null,
							id: 7,
							kind: 'human',
							login: 'reviewer',
							name: 'Reviewer',
						},
						frame: null,
						id: 401,
						projectId: 101,
						subject: 'Lighting note',
						versionId: 301,
					},
					publicationId: PUBLICATION_ID,
					status: 'complete',
				},
			},
			{
				body: JSON.stringify(publicationRequest()),
				headers: { 'Content-Type': 'application/json' },
				method: 'PUT',
			}
		)

		await expectJson(`${baseUrl}/api/review/playlists/201/versions/301/decision-context`, 200, {
			data: {
				currentStatusCode: 'rev',
				decisions: [
					{ key: 'approve', label: 'Approve', statusCode: 'apr' },
					{ key: 'needs-changes', label: 'Needs changes', statusCode: 'chg' },
					{
						key: 'pending-clarification',
						label: 'Pending clarification',
						statusCode: 'rev',
					},
				],
				history: [],
				historyTruncated: false,
				playlistId: 201,
				versionId: 301,
			},
		})

		await expectJson(
			`${baseUrl}/api/review/playlists/201/versions/301/decision`,
			200,
			{
				data: {
					changed: true,
					decisionKey: 'approve',
					playlistId: 201,
					previousStatusCode: 'rev',
					reviewer: {
						avatarUrl: null,
						id: 7,
						kind: 'human',
						login: 'reviewer',
						name: 'Reviewer',
					},
					statusCode: 'apr',
					updatedAt: '2026-07-20T00:00:00Z',
					versionId: 301,
				},
			},
			{
				body: JSON.stringify({ decisionKey: 'approve', expectedStatusCode: 'rev' }),
				headers: { 'Content-Type': 'application/json' },
				method: 'PUT',
			}
		)
		const legacyStatus = await fetch(`${baseUrl}/api/review/versions/301/status`, {
			body: JSON.stringify({ statusCode: 'apr' }),
			headers: { 'Content-Type': 'application/json' },
			method: 'PATCH',
		})
		expect(legacyStatus.status).toBe(404)

		expect(gateway.createPublicationNote).toHaveBeenCalledWith(201, 301, {
			content: 'Move the highlight left',
			recipientIds: [7],
			subject: 'Lighting note',
		})
		expect(gateway.uploadAttachment).toHaveBeenCalledWith({
			contentBase64: PNG_BYTES.toString('base64'),
			contentType: 'image/png',
			fileName: 'annotation.png',
			noteId: 401,
		})
	})

	test('reuses an idempotent publication and returns 409 for changed content', async () => {
		const gateway = makeGateway()
		const baseUrl = await start(gateway)
		const url = `${baseUrl}/api/review/playlists/201/versions/301/publications/${PUBLICATION_ID}`
		const first = await fetch(url, {
			body: JSON.stringify(publicationRequest()),
			headers: { 'Content-Type': 'application/json' },
			method: 'PUT',
		})
		const repeated = await fetch(url, {
			body: JSON.stringify(publicationRequest()),
			headers: { 'Content-Type': 'application/json' },
			method: 'PUT',
		})
		const changed = await fetch(url, {
			body: JSON.stringify({ ...publicationRequest(), content: 'Changed content' }),
			headers: { 'Content-Type': 'application/json' },
			method: 'PUT',
		})

		expect(first.status).toBe(200)
		expect(await repeated.json()).toEqual(await first.json())
		expect(changed.status).toBe(409)
		expect(await changed.json()).toMatchObject({
			error: { code: 'PUBLICATION_CONFLICT', retryable: false },
		})
		expect(gateway.createPublicationNote).toHaveBeenCalledOnce()
		expect(gateway.uploadAttachment).toHaveBeenCalledOnce()
	})

	test('does not reuse a publication id across ShotGrid site scopes', async () => {
		const publicationStore = new InMemoryReviewPublicationStore()
		const firstGateway = makeGateway()
		const secondGateway = makeGateway()
		const firstBaseUrl = await start(firstGateway, undefined, {
			mode: 'shotgrid',
			publicationDeploymentScope: 'https://sandbox.example.test',
			publicationStore,
			sudoAsLogin: 'reviewer@example.test',
			trustedProxyToken: TRUSTED_PROXY_TOKEN,
		})
		const secondBaseUrl = await start(secondGateway, undefined, {
			mode: 'shotgrid',
			publicationDeploymentScope: 'https://production.example.test',
			publicationStore,
			sudoAsLogin: 'reviewer@example.test',
			trustedProxyToken: TRUSTED_PROXY_TOKEN,
		})
		const path = `/api/review/playlists/201/versions/301/publications/${PUBLICATION_ID}`
		for (const baseUrl of [firstBaseUrl, secondBaseUrl]) {
			const response = await fetch(`${baseUrl}${path}`, {
				body: JSON.stringify(publicationRequest()),
				headers: { ...trustedProxyHeaders(), 'Content-Type': 'application/json' },
				method: 'PUT',
			})
			expect(response.status).toBe(200)
		}
		expect(firstGateway.createPublicationNote).toHaveBeenCalledOnce()
		expect(secondGateway.createPublicationNote).toHaveBeenCalledOnce()
	})

	test('rejects excess publication concurrency before reading the body or calling the gateway', async () => {
		let releaseFirst!: () => void
		let firstEntered!: () => void
		const firstStarted = new Promise<void>((resolve) => (firstEntered = resolve))
		const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve))
		const defaultGateway = makeGateway()
		const createPublicationNote = vi.fn<ReviewGateway['createPublicationNote']>(async (...args) => {
			firstEntered()
			await firstGate
			return await defaultGateway.createPublicationNote(...args)
		})
		const gateway = makeGateway({ createPublicationNote })
		const baseUrl = await start(gateway)
		const firstUrl = `${baseUrl}/api/review/playlists/201/versions/301/publications/${PUBLICATION_ID}`
		const secondUrl = `${baseUrl}/api/review/playlists/201/versions/301/publications/018f3f72-1d6b-4c51-8f4b-a12c9d2e3479`
		const first = fetch(firstUrl, {
			body: JSON.stringify(publicationRequest()),
			headers: { 'Content-Type': 'application/json' },
			method: 'PUT',
		})
		await firstStarted

		const excess = await fetch(secondUrl, {
			body: 'not-json-and-must-not-be-parsed',
			headers: { 'Content-Type': 'application/json' },
			method: 'PUT',
		})
		expect(excess.status).toBe(429)
		expect(await excess.json()).toMatchObject({
			error: { code: 'SHOTGRID_RATE_LIMITED', retryable: true },
		})
		expect(createPublicationNote).toHaveBeenCalledOnce()

		releaseFirst()
		expect((await first).status).toBe(200)
		expect(gateway.uploadAttachment).toHaveBeenCalledOnce()
	})

	test('returns stable validation, route, method, and media type errors', async () => {
		const baseUrl = await start(makeGateway())

		const invalidId = await fetch(`${baseUrl}/api/review/projects/0/playlists`)
		expect(invalidId.status).toBe(400)
		expect(await invalidId.json()).toMatchObject({
			error: { code: 'INVALID_REQUEST', retryable: false },
		})

		const invalidNestedId = await fetch(`${baseUrl}/api/review/playlists/201/versions/0`)
		expect(invalidNestedId.status).toBe(400)
		expect(await invalidNestedId.json()).toMatchObject({
			error: { code: 'INVALID_REQUEST', retryable: false },
		})

		const invalidMediaId = await fetch(`${baseUrl}/api/review/playlists/201/versions/0/media/image`)
		expect(invalidMediaId.status).toBe(400)
		expect(await invalidMediaId.json()).toMatchObject({
			error: { code: 'INVALID_REQUEST', retryable: false },
		})

		const invalidPublicationId = await fetch(
			`${baseUrl}/api/review/playlists/201/versions/301/publications/018f3f72-1d6b-7c51-8f4b-a12c9d2e3478`,
			{
				body: JSON.stringify(publicationRequest()),
				headers: { 'Content-Type': 'application/json' },
				method: 'PUT',
			}
		)
		expect(invalidPublicationId.status).toBe(400)

		const missing = await fetch(`${baseUrl}/api/unknown`)
		expect(missing.status).toBe(404)
		expect(await missing.json()).toMatchObject({ error: { code: 'NOT_FOUND' } })

		const method = await fetch(`${baseUrl}/api/review/projects`, { method: 'POST' })
		expect(method.status).toBe(405)
		expect(method.headers.get('allow')).toBe('GET')

		const mediaType = await fetch(
			`${baseUrl}/api/review/playlists/201/versions/301/publications/${PUBLICATION_ID}`,
			{
				body: '{}',
				method: 'PUT',
			}
		)
		expect(mediaType.status).toBe(415)
		expect(await mediaType.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } })

		for (const removedRoute of ['/api/review/notes', '/api/review/attachments']) {
			const removed = await fetch(`${baseUrl}${removedRoute}`, {
				headers: { 'Content-Type': 'application/json' },
				method: 'POST',
				body: '{}',
			})
			expect(removed.status).toBe(404)
		}
	})

	test('rejects unsafe publication input before it reaches the gateway', async () => {
		const gateway = makeGateway()
		const baseUrl = await start(gateway)
		const response = await fetch(
			`${baseUrl}/api/review/playlists/201/versions/301/publications/${PUBLICATION_ID}`,
			{
				body: JSON.stringify({
					...publicationRequest(),
					attachment: {
						...publicationRequest().attachment,
						contentBase64: 'not base64',
						contentType: 'image/svg+xml',
						fileName: '../annotation.svg',
					},
					noteId: 401,
				}),
				headers: { 'Content-Type': 'application/json' },
				method: 'PUT',
			}
		)

		expect(response.status).toBe(400)
		expect(gateway.createPublicationNote).not.toHaveBeenCalled()
		expect(gateway.uploadAttachment).not.toHaveBeenCalled()
	})

	test.each([
		['duplicate recipients', { ...publicationRequest(), recipientIds: [7, 7] }],
		[
			'too many recipients',
			{
				...publicationRequest(),
				recipientIds: Array.from({ length: 51 }, (_, index) => index + 1),
			},
		],
		['client-supplied links', { ...publicationRequest(), projectId: 101 }],
	] as const)('rejects %s before any publication mutation', async (_name, requestBody) => {
		const gateway = makeGateway()
		const baseUrl = await start(gateway)
		const response = await fetch(
			`${baseUrl}/api/review/playlists/201/versions/301/publications/${PUBLICATION_ID}`,
			{
				body: JSON.stringify(requestBody),
				headers: { 'Content-Type': 'application/json' },
				method: 'PUT',
			}
		)

		expect(response.status).toBe(400)
		expect(gateway.createPublicationNote).not.toHaveBeenCalled()
	})

	test.each([
		['mismatched extension', 'review.html', 'image/png', PNG_BYTES, PNG_SHA256],
		[
			'forged PNG bytes',
			'annotation.png',
			'image/png',
			Buffer.from('<html>unsafe</html>'),
			createHash('sha256').update('<html>unsafe</html>').digest('hex'),
		],
		['wrong content type', 'annotation.png', 'image/jpeg', PNG_BYTES, PNG_SHA256],
		['bidirectional file name', 'annotation\u202egnp.exe.png', 'image/png', PNG_BYTES, PNG_SHA256],
		['wrong digest', 'annotation.png', 'image/png', PNG_BYTES, '0'.repeat(64)],
	] as const)(
		'rejects attachment content with %s',
		async (_name, fileName, contentType, content, sha256) => {
			const gateway = makeGateway()
			const baseUrl = await start(gateway)
			const response = await fetch(
				`${baseUrl}/api/review/playlists/201/versions/301/publications/${PUBLICATION_ID}`,
				{
					body: JSON.stringify({
						...publicationRequest(),
						attachment: {
							contentBase64: content.toString('base64'),
							contentType,
							fileName,
							sha256,
						},
					}),
					headers: { 'Content-Type': 'application/json' },
					method: 'PUT',
				}
			)

			expect(response.status).toBe(400)
			expect(gateway.createPublicationNote).not.toHaveBeenCalled()
			expect(gateway.uploadAttachment).not.toHaveBeenCalled()
		}
	)

	test.each([
		['IHDR is not first', makeTestPng({ beforeHeader: ['tEXt'] })],
		['duplicate IHDR', makeTestPng({ afterHeader: ['IHDR'] })],
		['empty IDAT', makeTestPng({ imageData: Buffer.alloc(0) })],
		['animated control chunk', makeTestPng({ afterHeader: ['acTL'] })],
		['unknown critical chunk', makeTestPng({ afterHeader: ['ABCD'] })],
		['reserved chunk bit is set', makeTestPng({ afterHeader: ['tExt'] })],
		['indexed color omits PLTE', makeTestPng({ bitDepth: 8, colorType: 3 })],
		['PLTE follows IDAT', makeTestPng({ afterImageData: ['PLTE'] })],
		['IDAT chunks are not consecutive', makeTestPng({ afterImageData: ['tEXt', 'IDAT'] })],
		['invalid bit-depth/color pair', makeTestPng({ bitDepth: 1, colorType: 6 })],
		['invalid compression method', makeTestPng({ compression: 1 })],
		['interlacing is enabled', makeTestPng({ interlace: 1 })],
		['grayscale color is used', makeTestPng({ colorType: 0 })],
		['a dimension exceeds 8192', makeTestPng({ width: 8193 })],
		['the pixel count exceeds the source limit', makeTestPng({ height: 4097, width: 4096 })],
		['trailing data', Buffer.concat([makeTestPng(), Buffer.from([0])])],
		['truncated chunk', makeTestPng().subarray(0, -1)],
		['bad chunk CRC', corruptPngCrc(makeTestPng())],
		[
			'high-bit IHDR bytes alias an ASCII chunk name',
			makeTestPng({ headerChunkType: Buffer.from([0xc9, 0x48, 0x44, 0x52]) }),
		],
		[
			'high-bit IDAT bytes alias an ASCII chunk name',
			makeTestPng({ imageChunkType: Buffer.from([0xc9, 0x44, 0x41, 0x54]) }),
		],
		['IDAT is not a valid zlib stream', makeTestPng({ imageData: Buffer.from([1]) })],
		[
			'the decompressed scanline length is wrong',
			makeTestPng({ imageData: deflateSync(Buffer.from([0])) }),
		],
		[
			'a scanline uses an invalid filter',
			makeTestPng({ imageData: deflateSync(Buffer.from([5, 0, 0, 0, 0])) }),
		],
		[
			'compressed image data contains trailing bytes',
			makeTestPng({
				imageData: Buffer.concat([deflateSync(Buffer.from([0, 0, 0, 0, 0])), Buffer.from([1])]),
			}),
		],
	] as const)('rejects a PNG when %s', async (_name, content) => {
		const gateway = makeGateway()
		const baseUrl = await start(gateway)
		const response = await fetch(
			`${baseUrl}/api/review/playlists/201/versions/301/publications/${PUBLICATION_ID}`,
			{
				body: JSON.stringify({
					...publicationRequest(),
					attachment: {
						...publicationRequest().attachment,
						contentBase64: content.toString('base64'),
						sha256: createHash('sha256').update(content).digest('hex'),
					},
				}),
				headers: { 'Content-Type': 'application/json' },
				method: 'PUT',
			}
		)

		expect(response.status).toBe(400)
		expect(gateway.createPublicationNote).not.toHaveBeenCalled()
	})

	test('rejects a decoded PNG larger than 10 MiB', async () => {
		const gateway = makeGateway()
		const baseUrl = await start(gateway)
		const content = Buffer.alloc(10 * 1024 * 1024 + 1)
		const response = await fetch(
			`${baseUrl}/api/review/playlists/201/versions/301/publications/${PUBLICATION_ID}`,
			{
				body: JSON.stringify({
					...publicationRequest(),
					attachment: {
						...publicationRequest().attachment,
						contentBase64: content.toString('base64'),
						sha256: createHash('sha256').update(content).digest('hex'),
					},
				}),
				headers: { 'Content-Type': 'application/json' },
				method: 'PUT',
			}
		)

		expect(response.status).toBe(413)
		expect(gateway.createPublicationNote).not.toHaveBeenCalled()
	})

	test('normalizes gateway and unknown errors without leaking raw details', async () => {
		const secret = 'SCRIPT-KEY-DO-NOT-LEAK'
		const logger = { error: vi.fn() }
		const forbiddenGateway = makeGateway({
			listProjects: vi.fn(async () => {
				throw new ReviewGatewayError({
					code: 'SHOTGRID_PERMISSION_DENIED',
					message: 'ShotGrid denied access',
					retryable: false,
					status: 403,
					upstreamStatus: 403,
				})
			}),
		})
		const forbiddenBaseUrl = await start(forbiddenGateway, logger)
		const forbidden = await fetch(`${forbiddenBaseUrl}/api/review/projects`)
		expect(forbidden.status).toBe(403)
		expect(await forbidden.json()).toMatchObject({
			error: {
				code: 'SHOTGRID_PERMISSION_DENIED',
				message: 'ShotGrid did not allow this review action.',
				retryable: false,
			},
		})

		const unknownGateway = makeGateway({
			listProjects: vi.fn(async () => {
				throw new Error(`upstream html ${secret}`)
			}),
		})
		const unknownBaseUrl = await start(unknownGateway, logger)
		const unknown = await fetch(`${unknownBaseUrl}/api/review/projects`)
		const unknownText = await unknown.text()
		expect(unknown.status).toBe(500)
		expect(unknownText).not.toContain(secret)
		expect(unknownText).not.toContain('upstream html')
		expect(JSON.stringify(logger.error.mock.calls)).not.toContain(secret)
	})

	test('returns typed identifiers for an indeterminate attachment without review content', async () => {
		const gateway = makeGateway({
			uploadAttachment: vi.fn(async () => {
				throw new ReviewGatewayError({
					cause: new Error('signed_url=https://private.example content=secret'),
					code: 'PUBLICATION_INDETERMINATE',
					retryable: false,
					status: 502,
				})
			}),
		})
		const baseUrl = await start(gateway)
		const response = await fetch(
			`${baseUrl}/api/review/playlists/201/versions/301/publications/${PUBLICATION_ID}`,
			{
				body: JSON.stringify(publicationRequest()),
				headers: { 'Content-Type': 'application/json' },
				method: 'PUT',
			}
		)
		const text = await response.text()

		expect(response.status).toBe(502)
		expect(JSON.parse(text)).toMatchObject({
			error: {
				code: 'PUBLICATION_INDETERMINATE',
				publication: {
					noteId: 401,
					publicationId: PUBLICATION_ID,
					stage: 'attachment-completion',
				},
				requestId: 'test-request-id',
			},
		})
		expect(text).not.toContain('signed_url')
		expect(text).not.toContain('Move the highlight left')
	})

	test('allows only the configured browser origin and a restricted preflight', async () => {
		const baseUrl = await start(makeGateway())
		const allowedOrigin = 'http://127.0.0.1:5430'

		const allowed = await fetch(`${baseUrl}/api/review/projects`, {
			headers: { Origin: allowedOrigin },
		})
		expect(allowed.status).toBe(200)
		expect(allowed.headers.get('access-control-allow-origin')).toBe(allowedOrigin)
		expect(allowed.headers.get('vary')).toBe('Origin')

		for (const origin of ['https://evil.example', 'null']) {
			const denied = await fetch(`${baseUrl}/api/review/projects`, { headers: { Origin: origin } })
			expect(denied.status).toBe(403)
			expect(denied.headers.get('access-control-allow-origin')).toBeNull()
		}

		const publicationUrl = `${baseUrl}/api/review/playlists/201/versions/301/publications/${PUBLICATION_ID}`
		const preflight = await fetch(publicationUrl, {
			headers: {
				'Access-Control-Request-Headers': 'content-type',
				'Access-Control-Request-Method': 'PUT',
				Origin: allowedOrigin,
			},
			method: 'OPTIONS',
		})
		expect(preflight.status).toBe(204)
		expect(preflight.headers.get('access-control-allow-headers')).toBe('Content-Type')
		expect(preflight.headers.get('access-control-allow-methods')).toBe('PUT')

		for (const requestedHeader of [
			'authorization',
			'x-review-proxy-token',
			'x-review-authenticated-login',
		]) {
			const unsafePreflight = await fetch(publicationUrl, {
				headers: {
					'Access-Control-Request-Headers': requestedHeader,
					'Access-Control-Request-Method': 'PUT',
					Origin: allowedOrigin,
				},
				method: 'OPTIONS',
			})
			expect(unsafePreflight.status).toBe(403)
			expect(unsafePreflight.headers.get('access-control-allow-headers')).toBeNull()
		}
	})

	test('sets no-store and request correlation headers on every JSON response', async () => {
		const baseUrl = await start(makeGateway())
		const response = await fetch(`${baseUrl}/api/unknown`)

		expect(response.headers.get('cache-control')).toBe('no-store')
		expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8')
		expect(response.headers.get('x-content-type-options')).toBe('nosniff')
		expect(response.headers.get('x-request-id')).toBe('test-request-id')
	})
})

function makeGateway(overrides: Partial<ReviewGateway> = {}): ReviewGateway {
	const reviewer = {
		avatarUrl: null,
		id: 7,
		kind: 'human' as const,
		login: 'reviewer',
		name: 'Reviewer',
	}
	return {
		createNote: vi.fn(async (request) => ({
			...request,
			createdAt: '2026-07-20T00:00:00Z',
			createdBy: reviewer,
			id: 401,
		})),
		createPublicationNote: vi.fn(async (_playlistId, versionId, request) => ({
			links: PUBLICATION_LINKS,
			note: {
				content: request.content,
				createdAt: '2026-07-20T00:00:00Z',
				createdBy: reviewer,
				frame: null,
				id: 401,
				projectId: 101,
				subject: request.subject,
				versionId,
			},
		})),
		getCurrentReviewer: vi.fn(async () => reviewer),
		getDecisionContext: vi.fn<ReviewGateway['getDecisionContext']>(
			async (playlistId, versionId, decisions) => ({
				currentStatusCode: 'rev',
				decisions: decisions.map((decision) => ({ ...decision })),
				history: [],
				historyTruncated: false,
				playlistId,
				versionId,
			})
		),
		getNoteOptions: vi.fn(async () => ({
			links: PUBLICATION_LINKS,
			recipients: [reviewer],
		})),
		getVersion: vi.fn(async (playlistId, versionId) => ({
			...VERSION_FIXTURE,
			id: versionId,
			playlistId,
		})),
		getVersionImage: vi.fn(async () => ({
			body: PNG_BYTES,
			contentType: 'image/png' as const,
		})),
		getVersionVideo: vi.fn(async () => {
			throw new ReviewGatewayError({ code: 'NOT_FOUND', retryable: false, status: 404 })
		}),
		listPlaylists: vi.fn(async (projectId) => [
			{
				description: null,
				id: 201,
				name: 'Dailies',
				projectId,
				updatedAt: '2026-07-20T00:00:00Z',
				versionCount: 1,
			},
		]),
		listProjects: vi.fn(async () => [
			{ id: 101, name: 'Project', statusCode: 'act', thumbnailUrl: null },
		]),
		listVersions: vi.fn(async (playlistId) => [{ ...VERSION_FIXTURE, playlistId }]),
		updateVersionDecision: vi.fn(async (request) => ({
			changed: request.expectedStatusCode !== request.decision.statusCode,
			decisionKey: request.decision.key,
			playlistId: request.playlistId,
			previousStatusCode: request.expectedStatusCode,
			reviewer,
			statusCode: request.decision.statusCode,
			updatedAt: '2026-07-20T00:00:00Z',
			versionId: request.versionId,
		})),
		uploadAttachment: vi.fn(async (request) => ({
			fileName: request.fileName,
			id: 501,
			noteId: request.noteId,
			contentType: request.contentType,
			sizeBytes: Buffer.byteLength(request.contentBase64, 'base64'),
		})),
		...overrides,
	}
}

function publicationRequest() {
	return {
		attachment: {
			contentBase64: PNG_BYTES.toString('base64'),
			contentType: 'image/png' as const,
			fileName: 'annotation.png',
			sha256: PNG_SHA256,
		},
		content: ' Move the highlight left ',
		recipientIds: [7],
		subject: ' Lighting note ',
	}
}

function makeTestPng(
	options: {
		afterImageData?: readonly string[]
		afterHeader?: readonly string[]
		beforeHeader?: readonly string[]
		bitDepth?: number
		colorType?: number
		compression?: number
		height?: number
		headerChunkType?: Buffer
		imageData?: Buffer
		imageChunkType?: Buffer
		interlace?: number
		width?: number
	} = {}
) {
	const header = Buffer.alloc(13)
	header.writeUInt32BE(options.width ?? 1, 0)
	header.writeUInt32BE(options.height ?? 1, 4)
	header[8] = options.bitDepth ?? 8
	header[9] = options.colorType ?? 6
	header[10] = options.compression ?? 0
	header[12] = options.interlace ?? 0
	return Buffer.concat([
		Buffer.from('89504e470d0a1a0a', 'hex'),
		...(options.beforeHeader ?? []).map((type) => makeTestPngChunk(type, Buffer.alloc(0))),
		makeTestPngChunk(options.headerChunkType ?? 'IHDR', header),
		...(options.afterHeader ?? []).map((type) =>
			makeTestPngChunk(type, type === 'IHDR' ? header : Buffer.alloc(type === 'acTL' ? 8 : 0))
		),
		makeTestPngChunk(
			options.imageChunkType ?? 'IDAT',
			options.imageData ?? deflateSync(Buffer.from([0, 0, 0, 0, 0]))
		),
		...(options.afterImageData ?? []).map((type) =>
			makeTestPngChunk(type, type === 'PLTE' ? Buffer.from([0, 0, 0]) : Buffer.from([1]))
		),
		makeTestPngChunk('IEND', Buffer.alloc(0)),
	])
}

function makeTestPngChunk(type: string | Buffer, data: Buffer) {
	const typeBytes = typeof type === 'string' ? Buffer.from(type, 'ascii') : type
	if (typeBytes.byteLength !== 4) throw new Error('PNG test chunk names must contain four bytes')
	const chunk = Buffer.alloc(12 + data.byteLength)
	chunk.writeUInt32BE(data.byteLength, 0)
	typeBytes.copy(chunk, 4)
	data.copy(chunk, 8)
	chunk.writeUInt32BE(testCrc32(Buffer.concat([typeBytes, data])), 8 + data.byteLength)
	return chunk
}

function corruptPngCrc(content: Buffer) {
	const corrupted = Buffer.from(content)
	corrupted[29] ^= 1
	return corrupted
}

function testCrc32(content: Buffer) {
	let crc = 0xffffffff
	for (const byte of content) {
		crc ^= byte
		for (let bit = 0; bit < 8; bit++) {
			crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1
		}
	}
	return (crc ^ 0xffffffff) >>> 0
}

async function start(
	gateway: ReviewGateway,
	logger?: ReviewApiServerOptions['logger'],
	options: Pick<
		ReviewApiServerOptions,
		| 'auditStore'
		| 'decisions'
		| 'fixedActorSubject'
		| 'metricsToken'
		| 'mode'
		| 'publicationDeploymentScope'
		| 'publicationStore'
		| 'sudoAsLogin'
		| 'trustedProxyToken'
		| 'videoDownstreamIdleTimeoutMs'
	> = {
		mode: 'mock',
	}
) {
	const server = createReviewApiServer({
		allowedOrigin: 'http://127.0.0.1:5430',
		auditStore: options.auditStore ?? new InMemoryReviewAuditStore(),
		...(options.decisions === undefined ? undefined : { decisions: options.decisions }),
		gateway,
		logger,
		metricsToken: options.metricsToken ?? METRICS_TOKEN,
		mode: options.mode,
		publicationStore: options.publicationStore ?? new InMemoryReviewPublicationStore(),
		requestId: () => 'test-request-id',
		...(options.mode === 'shotgrid'
			? {
					fixedActorSubject: options.fixedActorSubject ?? FIXED_ACTOR_SUBJECT,
					publicationDeploymentScope:
						options.publicationDeploymentScope ?? 'https://studio.example.test',
					serviceActorName: 'review-gateway',
				}
			: undefined),
		...(options.sudoAsLogin === undefined ? undefined : { sudoAsLogin: options.sudoAsLogin }),
		...(options.trustedProxyToken === undefined
			? undefined
			: { trustedProxyToken: options.trustedProxyToken }),
		...(options.videoDownstreamIdleTimeoutMs === undefined
			? undefined
			: { videoDownstreamIdleTimeoutMs: options.videoDownstreamIdleTimeoutMs }),
	})
	servers.push(server)
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const { port } = server.address() as AddressInfo
	return `http://127.0.0.1:${port}`
}

function trustedProxyHeaders() {
	return {
		'X-Review-Authenticated-Subject': FIXED_ACTOR_SUBJECT,
		'X-Review-Proxy-Token': TRUSTED_PROXY_TOKEN,
	}
}

function expectedPrincipalId() {
	return `p1_${createHash('sha256')
		.update('shotgrid-review-principal-v1\0', 'utf8')
		.update(FIXED_ACTOR_SUBJECT, 'utf8')
		.digest('base64url')}`
}

async function expectJson(url: string, status: number, expected: unknown, init?: RequestInit) {
	const response = await fetch(url, init)
	expect(response.status).toBe(status)
	expect(await response.json()).toEqual(expected)
}
