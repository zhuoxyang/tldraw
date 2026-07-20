import { createHash } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { deflateSync } from 'node:zlib'
import { afterEach, describe, expect, test, vi } from 'vitest'
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
		const noteOptions = await fetch(
			`${baseUrl}/api/review/playlists/201/versions/301/note-options`,
			{
				headers: {
					'X-Review-Authenticated-Login': 'reviewer@example.test',
					'X-Review-Proxy-Token': TRUSTED_PROXY_TOKEN,
				},
			}
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
		const headers = { 'X-Review-Proxy-Token': TRUSTED_PROXY_TOKEN }

		const noteOptions = await fetch(
			`${baseUrl}/api/review/playlists/201/versions/301/note-options`,
			{ headers }
		)
		expect(noteOptions.status).toBe(403)
		expect(await noteOptions.json()).toMatchObject({
			error: { code: 'PERMISSION_DENIED', retryable: false },
		})

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
		expect(gateway.createPublicationNote).not.toHaveBeenCalled()
		expect(gateway.uploadAttachment).not.toHaveBeenCalled()
		expect(publicationStore.initialize).not.toHaveBeenCalled()
		expect(publicationStore.runExclusive).not.toHaveBeenCalled()
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
				headers: {
					'Content-Type': 'application/json',
					'X-Review-Authenticated-Login': 'reviewer@example.test',
					'X-Review-Proxy-Token': TRUSTED_PROXY_TOKEN,
				},
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
		'mode' | 'publicationDeploymentScope' | 'publicationStore' | 'sudoAsLogin' | 'trustedProxyToken'
	> = {
		mode: 'mock',
	}
) {
	const server = createReviewApiServer({
		allowedOrigin: 'http://127.0.0.1:5430',
		gateway,
		logger,
		mode: options.mode,
		publicationStore: options.publicationStore ?? new InMemoryReviewPublicationStore(),
		requestId: () => 'test-request-id',
		...(options.mode === 'shotgrid'
			? {
					publicationDeploymentScope:
						options.publicationDeploymentScope ?? 'https://studio.example.test',
					serviceActorName: 'review-gateway',
				}
			: undefined),
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
