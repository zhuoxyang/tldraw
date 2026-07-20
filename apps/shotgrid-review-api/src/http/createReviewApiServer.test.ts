import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { ReviewVersion } from '../contracts'
import { ReviewGatewayError } from '../errors'
import type { ReviewGateway } from '../gateway/ReviewGateway'
import { createReviewApiServer, type ReviewApiServerOptions } from './createReviewApiServer'

const servers: ReturnType<typeof createReviewApiServer>[] = []
const PNG_BYTES = Buffer.from('89504e470d0a1a0a', 'hex')
const TRUSTED_PROXY_TOKEN = 'test-trusted-proxy-token-with-32-characters'
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
			{ headers: { 'X-Review-Proxy-Token': TRUSTED_PROXY_TOKEN } }
		)
		expect(logger.error).not.toHaveBeenCalled()
	})

	test('binds a trusted proxy request to the configured sudo login', async () => {
		const gateway = makeGateway()
		const baseUrl = await start(gateway, undefined, {
			mode: 'shotgrid',
			sudoAsLogin: 'reviewer@example.test',
			trustedProxyToken: TRUSTED_PROXY_TOKEN,
		})

		const invalidIdentityHeaders: HeadersInit[] = [
			{ 'X-Review-Proxy-Token': TRUSTED_PROXY_TOKEN },
			{
				'X-Review-Authenticated-Login': 'another-reviewer@example.test',
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
			{
				headers: {
					'X-Review-Authenticated-Login': 'reviewer@example.test',
					'X-Review-Proxy-Token': TRUSTED_PROXY_TOKEN,
				},
			}
		)
	})

	test('does not require proxy headers in local mock mode', async () => {
		const gateway = makeGateway()
		const baseUrl = await start(gateway)

		const response = await fetch(`${baseUrl}/api/review/projects`)
		expect(response.status).toBe(200)
		expect(gateway.listProjects).toHaveBeenCalledOnce()
	})

	test('validates and forwards review mutations', async () => {
		const gateway = makeGateway()
		const baseUrl = await start(gateway)

		await expectJson(
			`${baseUrl}/api/review/notes`,
			201,
			{
				data: {
					content: 'Move the highlight left',
					createdAt: '2026-07-20T00:00:00Z',
					createdBy: {
						avatarUrl: null,
						id: 7,
						kind: 'human',
						login: 'reviewer',
						name: 'Reviewer',
					},
					frame: 18,
					id: 401,
					projectId: 101,
					subject: 'Lighting note',
					versionId: 301,
				},
			},
			{
				body: JSON.stringify({
					content: ' Move the highlight left ',
					frame: 18,
					projectId: 101,
					subject: ' Lighting note ',
					versionId: 301,
				}),
				headers: { 'Content-Type': 'application/json' },
				method: 'POST',
			}
		)

		await expectJson(
			`${baseUrl}/api/review/attachments`,
			201,
			{
				data: {
					contentType: 'image/png',
					fileName: 'annotation.png',
					id: 501,
					noteId: 401,
					sizeBytes: PNG_BYTES.byteLength,
				},
			},
			{
				body: JSON.stringify({
					contentBase64: PNG_BYTES.toString('base64'),
					contentType: 'image/png',
					fileName: 'annotation.png',
					noteId: 401,
				}),
				headers: { 'Content-Type': 'application/json' },
				method: 'POST',
			}
		)

		await expectJson(
			`${baseUrl}/api/review/versions/301/status`,
			200,
			{
				data: {
					statusCode: 'apr',
					updatedAt: '2026-07-20T00:00:00Z',
					versionId: 301,
				},
			},
			{
				body: JSON.stringify({ statusCode: 'apr' }),
				headers: { 'Content-Type': 'application/json' },
				method: 'PATCH',
			}
		)

		expect(gateway.createNote).toHaveBeenCalledWith({
			content: 'Move the highlight left',
			frame: 18,
			projectId: 101,
			subject: 'Lighting note',
			versionId: 301,
		})
	})

	test('accepts an explicit null frame for an unframed note', async () => {
		const gateway = makeGateway()
		const baseUrl = await start(gateway)
		const response = await fetch(`${baseUrl}/api/review/notes`, {
			body: JSON.stringify({
				content: 'General review note',
				frame: null,
				projectId: 101,
				subject: 'Overall feedback',
				versionId: 301,
			}),
			headers: { 'Content-Type': 'application/json' },
			method: 'POST',
		})

		expect(response.status).toBe(201)
		expect(gateway.createNote).toHaveBeenCalledWith({
			content: 'General review note',
			frame: null,
			projectId: 101,
			subject: 'Overall feedback',
			versionId: 301,
		})
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

		const missing = await fetch(`${baseUrl}/api/unknown`)
		expect(missing.status).toBe(404)
		expect(await missing.json()).toMatchObject({ error: { code: 'NOT_FOUND' } })

		const method = await fetch(`${baseUrl}/api/review/projects`, { method: 'POST' })
		expect(method.status).toBe(405)
		expect(method.headers.get('allow')).toBe('GET')

		const mediaType = await fetch(`${baseUrl}/api/review/notes`, {
			body: '{}',
			method: 'POST',
		})
		expect(mediaType.status).toBe(415)
		expect(await mediaType.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } })
	})

	test('rejects unsafe attachment input before it reaches the gateway', async () => {
		const gateway = makeGateway()
		const baseUrl = await start(gateway)
		const response = await fetch(`${baseUrl}/api/review/attachments`, {
			body: JSON.stringify({
				contentBase64: 'not base64',
				contentType: 'image/svg+xml',
				fileName: '../annotation.svg',
				noteId: 401,
			}),
			headers: { 'Content-Type': 'application/json' },
			method: 'POST',
		})

		expect(response.status).toBe(400)
		expect(gateway.uploadAttachment).not.toHaveBeenCalled()
	})

	test.each([
		['mismatched extension', 'review.html', 'image/png', PNG_BYTES],
		['forged PNG bytes', 'annotation.png', 'image/png', Buffer.from('<html>unsafe</html>')],
		['invalid JSON', 'snapshot.tldr', 'application/vnd.tldraw+json', Buffer.from('{broken')],
		['bidirectional file name', 'annotation\u202egnp.exe.png', 'image/png', PNG_BYTES],
	] as const)(
		'rejects attachment content with %s',
		async (_name, fileName, contentType, content) => {
			const gateway = makeGateway()
			const baseUrl = await start(gateway)
			const response = await fetch(`${baseUrl}/api/review/attachments`, {
				body: JSON.stringify({
					contentBase64: content.toString('base64'),
					contentType,
					fileName,
					noteId: 401,
				}),
				headers: { 'Content-Type': 'application/json' },
				method: 'POST',
			})

			expect(response.status).toBe(400)
			expect(gateway.uploadAttachment).not.toHaveBeenCalled()
		}
	)

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

		const preflight = await fetch(`${baseUrl}/api/review/notes`, {
			headers: {
				'Access-Control-Request-Headers': 'content-type',
				'Access-Control-Request-Method': 'POST',
				Origin: allowedOrigin,
			},
			method: 'OPTIONS',
		})
		expect(preflight.status).toBe(204)
		expect(preflight.headers.get('access-control-allow-headers')).toBe('Content-Type')
		expect(preflight.headers.get('access-control-allow-methods')).toBe('POST')

		for (const requestedHeader of [
			'authorization',
			'x-review-proxy-token',
			'x-review-authenticated-login',
		]) {
			const unsafePreflight = await fetch(`${baseUrl}/api/review/notes`, {
				headers: {
					'Access-Control-Request-Headers': requestedHeader,
					'Access-Control-Request-Method': 'POST',
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
		getCurrentReviewer: vi.fn(async () => reviewer),
		getVersion: vi.fn(async (playlistId, versionId) => ({
			...VERSION_FIXTURE,
			id: versionId,
			playlistId,
		})),
		getVersionImage: vi.fn(async () => ({
			body: PNG_BYTES,
			contentType: 'image/png' as const,
		})),
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
		updateVersionStatus: vi.fn(async (request) => ({
			statusCode: request.statusCode,
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

async function start(
	gateway: ReviewGateway,
	logger?: ReviewApiServerOptions['logger'],
	options: Pick<ReviewApiServerOptions, 'mode' | 'sudoAsLogin' | 'trustedProxyToken'> = {
		mode: 'mock',
	}
) {
	const server = createReviewApiServer({
		allowedOrigin: 'http://127.0.0.1:5430',
		gateway,
		logger,
		mode: options.mode,
		requestId: () => 'test-request-id',
		...(options.sudoAsLogin === undefined ? undefined : { sudoAsLogin: options.sudoAsLogin }),
		...(options.trustedProxyToken === undefined
			? undefined
			: { trustedProxyToken: options.trustedProxyToken }),
	})
	servers.push(server)
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const { port } = server.address() as AddressInfo
	return `http://127.0.0.1:${port}`
}

async function expectJson(url: string, status: number, expected: unknown, init?: RequestInit) {
	const response = await fetch(url, init)
	expect(response.status).toBe(status)
	expect(await response.json()).toEqual(expected)
}
