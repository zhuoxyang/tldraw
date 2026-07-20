import type {
	ReviewDecisionContext,
	ReviewDecisionRequest,
	ReviewDecisionResult,
	ReviewHealth,
	ReviewNoteOptions,
	ReviewPlaylist,
	ReviewProject,
	ReviewPublicationRequest,
	ReviewPublicationResult,
	ReviewUser,
	ReviewVersion,
} from '@tldraw/shotgrid-review-contracts'
import { describe, expect, it, vi } from 'vitest'
import { parseReviewApiDevTarget } from '../vite.config'
import {
	createReviewApiClient,
	decodedCanonicalBase64Length,
	ReviewApiClientError,
} from './reviewApiClient'

const health: ReviewHealth = { mode: 'shotgrid', status: 'ok' }
const reviewer: ReviewUser = {
	avatarUrl: null,
	id: 7,
	kind: 'human',
	login: 'reviewer',
	name: 'Reviewer',
}
const project: ReviewProject = {
	id: 101,
	name: 'Northstar',
	statusCode: 'act',
	thumbnailUrl: null,
}
const playlist: ReviewPlaylist = {
	description: null,
	id: 201,
	name: 'Dailies',
	projectId: 101,
	updatedAt: '2026-07-20T00:00:00Z',
	versionCount: 1,
}
const version: ReviewVersion = {
	createdAt: '2026-07-20T00:00:00Z',
	createdBy: null,
	description: null,
	entity: { id: 401, name: 'shot_010', type: 'Shot' },
	id: 301,
	media: null,
	name: 'shot_010_comp_v001',
	playlistId: 201,
	projectId: 101,
	statusCode: 'rev',
	submittedBy: null,
	task: { id: 501, name: 'Compositing' },
}
const publicationId = '11111111-1111-4111-8111-111111111111'
const noteOptions: ReviewNoteOptions = {
	links: {
		entity: version.entity,
		project: { id: 101, name: 'Northstar', type: 'Project' },
		task: version.task,
		version: { id: 301, name: version.name, type: 'Version' },
	},
	recipients: [reviewer],
}
const publicationRequest: ReviewPublicationRequest = {
	attachment: {
		contentBase64: 'aGVsbG8=',
		contentType: 'image/png',
		fileName: 'shot_010.annotated.png',
		sha256: 'a'.repeat(64),
	},
	content: 'Please address marker 1.',
	recipientIds: [7],
	subject: 'Review: shot_010_comp_v001',
}
const publicationResult: ReviewPublicationResult = {
	attachment: {
		contentType: 'image/png',
		fileName: publicationRequest.attachment.fileName,
		id: 901,
		noteId: 801,
		sizeBytes: 5,
	},
	links: noteOptions.links,
	note: {
		content: publicationRequest.content,
		createdAt: '2026-07-21T00:00:00Z',
		createdBy: reviewer,
		frame: null,
		id: 801,
		projectId: 101,
		subject: publicationRequest.subject,
		versionId: 301,
	},
	publicationId,
	status: 'complete',
}
const decisionContext: ReviewDecisionContext = {
	currentStatusCode: 'rev',
	decisions: [
		{ key: 'approve', label: 'Approved for final', statusCode: 'apr' },
		{ key: 'changes', label: 'Needs changes', statusCode: 'chg' },
	],
	history: [
		{
			decidedAt: '2026-07-20T23:00:00Z',
			decisionKey: null,
			id: 601,
			previousStatusCode: null,
			resultingStatusCode: 'rev',
			reviewer: null,
		},
	],
	historyTruncated: false,
	playlistId: 201,
	versionId: 301,
}
const decisionRequest: ReviewDecisionRequest = {
	decisionKey: 'approve',
	expectedStatusCode: 'rev',
}
const decisionResult: ReviewDecisionResult = {
	changed: true,
	decisionKey: 'approve',
	playlistId: 201,
	previousStatusCode: 'rev',
	reviewer,
	statusCode: 'apr',
	updatedAt: '2026-07-21T00:00:00Z',
	versionId: 301,
}

describe('createReviewApiClient', () => {
	it('calls every endpoint through a relative base URL and forwards AbortSignal', async () => {
		const responses = [
			jsonResponse(health),
			jsonResponse({ data: reviewer }),
			jsonResponse({ data: [project] }),
			jsonResponse({ data: [playlist] }),
			jsonResponse({ data: [version] }),
			jsonResponse({ data: version }),
		]
		const fetch = vi.fn<typeof globalThis.fetch>(async () => responses.shift()!)
		const client = createReviewApiClient({ baseUrl: '/api/', fetch })
		const signal = new AbortController().signal

		await expect(client.getHealth(signal)).resolves.toEqual(health)
		await expect(client.getCurrentReviewer(signal)).resolves.toEqual(reviewer)
		await expect(client.listProjects(signal)).resolves.toEqual([project])
		await expect(client.listPlaylists(101, signal)).resolves.toEqual([playlist])
		await expect(client.listVersions(201, signal)).resolves.toEqual([version])
		await expect(client.getVersion(201, 301, signal)).resolves.toEqual(version)

		expect(fetch.mock.calls.map(([input]) => String(input))).toEqual([
			'/api/health',
			'/api/review/me',
			'/api/review/projects',
			'/api/review/projects/101/playlists',
			'/api/review/playlists/201/versions',
			'/api/review/playlists/201/versions/301',
		])
		for (const [, init] of fetch.mock.calls) {
			expect(init).toMatchObject({ cache: 'no-store', method: 'GET', redirect: 'error', signal })
			expect(new Headers(init?.headers)).toEqual(new Headers({ Accept: 'application/json' }))
			expect(new Headers(init?.headers).has('X-Review-Proxy-Token')).toBe(false)
		}
	})

	it('normalizes an absolute API base URL', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => jsonResponse(health))
		const client = createReviewApiClient({
			baseUrl: 'https://review.example.test/gateway/api/',
			fetch,
		})

		await client.getHealth()
		expect(String(fetch.mock.calls[0][0])).toBe('https://review.example.test/gateway/api/health')
	})

	it('loads Note options and publishes an idempotent JSON request', async () => {
		const responses = [
			jsonResponse({ data: noteOptions }),
			jsonResponse({ data: publicationResult }),
		]
		const fetch = vi.fn<typeof globalThis.fetch>(async () => responses.shift()!)
		const client = createReviewApiClient({ baseUrl: '/api', fetch })
		const signal = new AbortController().signal

		await expect(client.getNoteOptions(201, 301, signal)).resolves.toEqual(noteOptions)
		await expect(
			client.publishReview(201, 301, publicationId, publicationRequest, signal)
		).resolves.toEqual(publicationResult)

		expect(fetch).toHaveBeenNthCalledWith(
			1,
			'/api/review/playlists/201/versions/301/note-options',
			expect.objectContaining({ method: 'GET', signal })
		)
		expect(fetch).toHaveBeenNthCalledWith(
			2,
			`/api/review/playlists/201/versions/301/publications/${publicationId}`,
			expect.objectContaining({
				body: JSON.stringify(publicationRequest),
				method: 'PUT',
				signal,
			})
		)
		expect(new Headers(fetch.mock.calls[1][1]?.headers)).toEqual(
			new Headers({ Accept: 'application/json', 'Content-Type': 'application/json' })
		)
	})

	it('loads decision context and sends an expected-status decision request', async () => {
		const responses = [
			jsonResponse({ data: decisionContext }),
			jsonResponse({ data: decisionResult }),
		]
		const fetch = vi.fn<typeof globalThis.fetch>(async () => responses.shift()!)
		const client = createReviewApiClient({ baseUrl: '/api', fetch })
		const signal = new AbortController().signal

		await expect(client.getDecisionContext(201, 301, signal)).resolves.toEqual(decisionContext)
		await expect(client.updateDecision(201, 301, decisionRequest, signal)).resolves.toEqual(
			decisionResult
		)

		expect(fetch).toHaveBeenNthCalledWith(
			1,
			'/api/review/playlists/201/versions/301/decision-context',
			expect.objectContaining({ method: 'GET', signal })
		)
		expect(fetch).toHaveBeenNthCalledWith(
			2,
			'/api/review/playlists/201/versions/301/decision',
			expect.objectContaining({
				body: JSON.stringify(decisionRequest),
				method: 'PUT',
				signal,
			})
		)
	})

	it('rejects decision responses not bound to the request path and expected status', async () => {
		const client = createReviewApiClient({
			baseUrl: '/api',
			fetch: vi.fn(async () =>
				jsonResponse({ data: { ...decisionResult, previousStatusCode: 'ip' } })
			),
		})

		await expect(client.updateDecision(201, 301, decisionRequest)).rejects.toMatchObject({
			code: 'INVALID_RESPONSE',
			status: 200,
		})

		const fetch = vi.fn<typeof globalThis.fetch>()
		const invalidClient = createReviewApiClient({ baseUrl: '/api', fetch })
		await expect(
			invalidClient.updateDecision(201, 301, { ...decisionRequest, decisionKey: 'invalid key' })
		).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 0 })
		expect(fetch).not.toHaveBeenCalled()
	})

	it('rejects decision context not bound to the requested Playlist and Version', async () => {
		const client = createReviewApiClient({
			baseUrl: '/api',
			fetch: vi.fn(async () =>
				jsonResponse({ data: { ...decisionContext, versionId: 302 } }, 200, {
					'X-Request-Id': 'wrong-decision-context',
				})
			),
		})

		await expect(client.getDecisionContext(201, 301)).rejects.toMatchObject({
			code: 'INVALID_RESPONSE',
			requestId: 'wrong-decision-context',
			status: 200,
		})
	})

	it('rejects an invalid publication id and a mismatched publication result', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			jsonResponse({ data: { ...publicationResult, publicationId: crypto.randomUUID() } })
		)
		const client = createReviewApiClient({ baseUrl: '/api', fetch })

		await expect(
			client.publishReview(201, 301, 'not-a-publication-id', publicationRequest)
		).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 0 })
		expect(fetch).not.toHaveBeenCalled()

		await expect(
			client.publishReview(201, 301, publicationId, publicationRequest)
		).rejects.toMatchObject({ code: 'INVALID_RESPONSE', status: 200 })
	})

	it.each([
		[
			'Note subject',
			(result: ReviewPublicationResult): void => void (result.note.subject = 'Other subject'),
		],
		[
			'Note content',
			(result: ReviewPublicationResult): void => void (result.note.content = 'Other content'),
		],
		[
			'attachment filename',
			(result: ReviewPublicationResult): void =>
				void (result.attachment.fileName = 'other.annotated.png'),
		],
		[
			'attachment content type',
			(result: ReviewPublicationResult): void =>
				void (result.attachment.contentType = 'image/jpeg'),
		],
		[
			'attachment size',
			(result: ReviewPublicationResult): void => void (result.attachment.sizeBytes = 6),
		],
	] as const)(
		'rejects a success whose %s is not bound to the frozen request',
		async (_label, mutate) => {
			const mismatched = structuredClone(publicationResult)
			mutate(mismatched)
			const client = createReviewApiClient({
				baseUrl: '/api',
				fetch: vi.fn(async () => jsonResponse({ data: mismatched })),
			})

			await expect(
				client.publishReview(201, 301, publicationId, publicationRequest)
			).rejects.toMatchObject({ code: 'INVALID_RESPONSE', status: 200 })
		}
	)

	it('computes only canonical base64 decoded lengths', () => {
		expect(decodedCanonicalBase64Length('aGVsbG8=')).toBe(5)
		expect(decodedCanonicalBase64Length('cG5n')).toBe(3)
		expect(decodedCanonicalBase64Length('aGVsbG9=')).toBeNull()
		expect(decodedCanonicalBase64Length('AA=A')).toBeNull()
		expect(decodedCanonicalBase64Length('')).toBeNull()
	})

	it('rejects duplicate Note recipients from the gateway', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			jsonResponse({ data: { ...noteOptions, recipients: [reviewer, reviewer] } }, 200, {
				'X-Request-Id': 'duplicate-recipients',
			})
		)
		const client = createReviewApiClient({ baseUrl: '/api', fetch })

		await expect(client.getNoteOptions(201, 301)).rejects.toMatchObject({
			code: 'INVALID_RESPONSE',
			requestId: 'duplicate-recipients',
			status: 200,
		})
	})

	it('resolves protected media routes through the configured API base URL', async () => {
		const proxyPath = '/review/playlists/201/versions/301/media/image'
		const imageVersion: ReviewVersion = {
			...version,
			media: {
				contentType: 'image/jpeg',
				height: null,
				kind: 'image',
				thumbnailUrl: proxyPath,
				url: proxyPath,
				width: null,
			},
		}
		const responses = [jsonResponse({ data: [imageVersion] }), jsonResponse({ data: imageVersion })]
		const fetch = vi.fn<typeof globalThis.fetch>(async () => responses.shift()!)
		const client = createReviewApiClient({
			baseUrl: 'https://review.example.test/gateway/api',
			fetch,
		})
		const expectedUrl =
			'https://review.example.test/gateway/api/review/playlists/201/versions/301/media/image'

		await expect(client.listVersions(201)).resolves.toMatchObject([
			{ media: { thumbnailUrl: expectedUrl, url: expectedUrl } },
		])
		await expect(client.getVersion(201, 301)).resolves.toMatchObject({
			media: { thumbnailUrl: expectedUrl, url: expectedUrl },
		})
	})

	it.each([
		'',
		'api',
		'//evil.example/api',
		'ftp://review.example.test/api',
		'http://review.example.test/api',
		'https://user:password@review.example.test/api',
		'https://review.example.test/api?token=value',
		'https://review.example.test/api#fragment',
	])('rejects an unsafe API base URL: %s', (baseUrl) => {
		let error: unknown
		try {
			createReviewApiClient({ baseUrl })
		} catch (caughtError) {
			error = caughtError
		}
		expect(error).toMatchObject({ code: 'INVALID_REQUEST', status: 0 })
	})

	it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
		'rejects an invalid ShotGrid id before fetching: %s',
		async (id) => {
			const fetch = vi.fn<typeof globalThis.fetch>()
			const client = createReviewApiClient({ baseUrl: '/api', fetch })

			await expect(client.listPlaylists(id)).rejects.toMatchObject({
				code: 'INVALID_REQUEST',
				retryable: false,
				status: 0,
			})
			await expect(client.getVersion(201, id)).rejects.toBeInstanceOf(ReviewApiClientError)
			expect(fetch).not.toHaveBeenCalled()
		}
	)

	it('preserves a valid API error envelope and request id', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			jsonResponse(
				{
					error: {
						code: 'SHOTGRID_RATE_LIMITED',
						message: 'ShotGrid is receiving too many requests.',
						requestId: 'body-request-id',
						retryable: true,
					},
				},
				503,
				{ 'X-Request-Id': 'header-request-id' }
			)
		)
		const client = createReviewApiClient({ baseUrl: '/api', fetch })

		await expect(client.listProjects()).rejects.toMatchObject({
			code: 'SHOTGRID_RATE_LIMITED',
			message: 'ShotGrid is receiving too many requests.',
			requestId: 'body-request-id',
			retryable: true,
			status: 503,
		})
	})

	it('preserves a publication uncertainty context from an indeterminate PUT', async () => {
		const publication = {
			attachmentId: 901,
			links: noteOptions.links,
			noteId: 801,
			publicationId,
			stage: 'attachment-completion' as const,
		}
		const client = createReviewApiClient({
			baseUrl: '/api',
			fetch: vi.fn(async () =>
				jsonResponse(
					{
						error: {
							code: 'PUBLICATION_INDETERMINATE',
							message: 'Attachment completion is uncertain.',
							publication,
							requestId: 'request-uncertain',
							retryable: false,
						},
					},
					502
				)
			),
		})

		await expect(
			client.publishReview(201, 301, publicationId, publicationRequest)
		).rejects.toMatchObject({
			code: 'PUBLICATION_INDETERMINATE',
			publication,
			requestId: 'request-uncertain',
		})
	})

	it.each([
		{
			links: noteOptions.links,
			noteId: 801,
			publicationId: '22222222-2222-4222-8222-222222222222',
			stage: 'note-created' as const,
		},
		{
			links: {
				...noteOptions.links,
				version: { ...noteOptions.links.version, id: 302 },
			},
			noteId: 801,
			publicationId,
			stage: 'attachment-completion' as const,
		},
	])('rejects uncertainty context not bound to the PUT path', async (publication) => {
		const client = createReviewApiClient({
			baseUrl: '/api',
			fetch: vi.fn(async () =>
				jsonResponse(
					{
						error: {
							code: 'PUBLICATION_INDETERMINATE',
							message: 'Publication outcome is uncertain.',
							publication,
							retryable: false,
						},
					},
					502
				)
			),
		})

		await expect(
			client.publishReview(201, 301, publicationId, publicationRequest)
		).rejects.toMatchObject({ code: 'INVALID_RESPONSE', status: 502 })
	})

	it('rejects a non-error payload on a failed HTTP status', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			jsonResponse({ data: [project] }, 502, { 'X-Request-Id': 'request-502' })
		)
		const client = createReviewApiClient({ baseUrl: '/api', fetch })

		await expect(client.listProjects()).rejects.toMatchObject({
			code: 'HTTP_ERROR',
			requestId: 'request-502',
			retryable: true,
			status: 502,
		})
	})

	it.each([
		['invalid JSON', new Response('{broken', { headers: { 'X-Request-Id': 'invalid-json' } })],
		['missing data envelope', jsonResponse([project], 200, { 'X-Request-Id': 'missing-data' })],
		[
			'extra envelope fields',
			jsonResponse({ data: [project], metadata: {} }, 200, { 'X-Request-Id': 'extra-field' }),
		],
		[
			'invalid project contract',
			jsonResponse({ data: [{ ...project, id: 0 }] }, 200, { 'X-Request-Id': 'invalid-item' }),
		],
	] as const)('rejects a response with %s', async (_name, response) => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () => response)
		const client = createReviewApiClient({ baseUrl: '/api', fetch })

		await expect(client.listProjects()).rejects.toMatchObject({
			code: 'INVALID_RESPONSE',
			requestId: expect.any(String),
			retryable: false,
			status: 200,
		})
	})

	it('rejects a declared response body larger than 16 MiB before reading it', async () => {
		const cancel = vi.fn()
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						cancel,
						start(controller) {
							controller.enqueue(new TextEncoder().encode('{}'))
						},
					}),
					{
						headers: {
							'Content-Length': String(16 * 1024 * 1024 + 1),
							'X-Request-Id': 'declared-too-large',
						},
					}
				)
		)
		const client = createReviewApiClient({ baseUrl: '/api', fetch })

		await expect(client.getHealth()).rejects.toMatchObject({
			code: 'INVALID_RESPONSE',
			requestId: 'declared-too-large',
			status: 200,
		})
		expect(cancel).toHaveBeenCalledOnce()
	})

	it('cancels a streamed response body after it crosses 16 MiB', async () => {
		const cancel = vi.fn()
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						cancel,
						start(controller) {
							controller.enqueue(new Uint8Array(16 * 1024 * 1024))
							controller.enqueue(new Uint8Array(1))
						},
					}),
					{ headers: { 'X-Request-Id': 'stream-too-large' } }
				)
		)
		const client = createReviewApiClient({ baseUrl: '/api', fetch })

		await expect(client.getHealth()).rejects.toMatchObject({
			code: 'INVALID_RESPONSE',
			requestId: 'stream-too-large',
			status: 200,
		})
		expect(cancel).toHaveBeenCalledOnce()
	})

	it('rejects an API collection larger than the gateway entity limit', async () => {
		const fetch = vi.fn<typeof globalThis.fetch>(async () =>
			jsonResponse({ data: Array.from({ length: 10_001 }, () => project) })
		)
		const client = createReviewApiClient({ baseUrl: '/api', fetch })

		await expect(client.listProjects()).rejects.toMatchObject({
			code: 'INVALID_RESPONSE',
			retryable: false,
			status: 200,
		})
	})

	it('cancels an unconsumed response body after invalid UTF-8', async () => {
		const cancel = vi.fn()
		const fetch = vi.fn<typeof globalThis.fetch>(
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						cancel,
						start(controller) {
							controller.enqueue(new Uint8Array([0xff]))
						},
					}),
					{ headers: { 'X-Request-Id': 'invalid-utf8' } }
				)
		)
		const client = createReviewApiClient({ baseUrl: '/api', fetch })

		await expect(client.getHealth()).rejects.toMatchObject({
			code: 'INVALID_RESPONSE',
			requestId: 'invalid-utf8',
			status: 200,
		})
		expect(cancel).toHaveBeenCalledOnce()
	})

	it('normalizes aborted and network requests without exposing raw failures', async () => {
		const controller = new AbortController()
		controller.abort()
		const abortedFetch = vi.fn<typeof globalThis.fetch>(async () => {
			throw Object.assign(new Error('private cross-realm abort detail'), { name: 'AbortError' })
		})
		const abortedClient = createReviewApiClient({ baseUrl: '/api', fetch: abortedFetch })

		await expect(abortedClient.getHealth(controller.signal)).rejects.toMatchObject({
			code: 'REQUEST_ABORTED',
			message: 'The review API request was aborted.',
			retryable: false,
			status: 0,
		})

		const networkFetch = vi.fn<typeof globalThis.fetch>(async () => {
			throw new Error('private DNS detail')
		})
		const networkClient = createReviewApiClient({ baseUrl: '/api', fetch: networkFetch })
		await expect(networkClient.getHealth()).rejects.toMatchObject({
			code: 'NETWORK_ERROR',
			message: 'The review API could not be reached.',
			retryable: true,
			status: 0,
		})
	})
})

describe('parseReviewApiDevTarget', () => {
	it('uses the local API origin by default and accepts an HTTPS origin', () => {
		expect(parseReviewApiDevTarget(undefined)).toBe('http://127.0.0.1:5431')
		expect(parseReviewApiDevTarget(' https://gateway.example.test:8443/ ')).toBe(
			'https://gateway.example.test:8443'
		)
	})

	it('accepts an HTTP development proxy only on loopback', () => {
		expect(parseReviewApiDevTarget('http://localhost:5431')).toBe('http://localhost:5431')
		expect(() => parseReviewApiDevTarget('http://gateway.example.test:5431')).toThrow(
			/REVIEW_API_DEV_TARGET/
		)
	})

	it.each([
		'not a URL',
		'ftp://gateway.example.test',
		'https://user:password@gateway.example.test',
		'https://gateway.example.test/api',
		'https://gateway.example.test?token=value',
		'https://gateway.example.test#fragment',
	])('rejects an unsafe development proxy target: %s', (target) => {
		expect(() => parseReviewApiDevTarget(target)).toThrow(/REVIEW_API_DEV_TARGET/)
	})
})

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
	return new Response(JSON.stringify(body), {
		headers: { 'Content-Type': 'application/json', ...headers },
		status,
	})
}
