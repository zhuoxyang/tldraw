import { describe, expect, test, vi } from 'vitest'
import type { ShotGridConnectionConfig } from '../config'
import { ReviewGatewayError } from '../errors'
import type { ShotGridClient } from '../shotgrid/ShotGridClient'
import { ShotGridReviewGateway } from './ShotGridReviewGateway'

const config: ShotGridConnectionConfig = {
	frameRateMode: 'unknown',
	maxRetries: 2,
	scriptKey: 'server-only-key',
	scriptName: 'review-gateway',
	siteUrl: 'https://studio.example.com',
	timeoutMs: 1000,
}
const DECISIONS = [
	{ key: 'approve', label: 'Approve', statusCode: 'apr' },
	{ key: 'needs-changes', label: 'Needs changes', statusCode: 'chg' },
] as const

describe('ShotGridReviewGateway', () => {
	test('maps project, playlist, and version searches into review contracts', async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce({
				data: [
					{
						attributes: {
							image: 'https://media.example.com/project.jpg',
							name: 'Northstar',
							sg_status: 'act',
						},
						id: 101,
						type: 'Project',
					},
				],
			})
			.mockResolvedValueOnce({
				data: { id: 101, type: 'Project' },
			})
			.mockResolvedValueOnce({
				data: [
					{
						attributes: {
							code: 'Lighting dailies',
							description: 'Morning review',
							updated_at: '2026-07-20T00:00:00Z',
						},
						id: 201,
						relationships: {
							versions: [
								{ id: 301, type: 'Version' },
								{ id: 302, type: 'Version' },
							],
						},
						type: 'Playlist',
					},
				],
			})
			.mockResolvedValueOnce({
				data: { id: 201, type: 'Playlist' },
			})
			.mockResolvedValueOnce({
				data: [
					{
						attributes: {
							code: 'shot_010_lgt_v014',
							created_at: '2026-07-20T00:00:00Z',
							description: 'Lighting polish',
							frame_count: 120,
							frame_rate: 24,
							image: 'https://media.example.com/thumb.jpg',
							sg_status_list: 'rev',
							sg_uploaded_movie: {
								id: 901,
								name: 'shot_010_lgt_v014.mp4',
								content_type: 'video/mp4',
								type: 'Attachment',
								url: 'https://media.example.com/review.mp4',
							},
							sg_first_frame: 1001,
							sg_last_frame: 1120,
						},
						id: 301,
						relationships: {
							created_by: { data: { id: 10, name: 'Publish Bot', type: 'ApiUser' } },
							entity: { data: { id: 501, name: 'shot_010', type: 'Shot' } },
							project: { data: { id: 101, name: 'Northstar', type: 'Project' } },
							sg_task: { data: { id: 601, name: 'Lighting', type: 'Task' } },
							user: { data: { id: 11, name: 'Mei Chen', type: 'HumanUser' } },
						},
						type: 'Version',
					},
				],
			})
		const gateway = makeGateway(request)

		await expect(gateway.listProjects()).resolves.toEqual([
			{
				id: 101,
				name: 'Northstar',
				statusCode: 'act',
				thumbnailUrl: null,
			},
		])
		await expect(gateway.listPlaylists(101)).resolves.toEqual([
			{
				description: 'Morning review',
				id: 201,
				name: 'Lighting dailies',
				projectId: 101,
				updatedAt: '2026-07-20T00:00:00Z',
				versionCount: 2,
			},
		])
		await expect(gateway.listVersions(201)).resolves.toEqual([
			{
				createdAt: '2026-07-20T00:00:00Z',
				createdBy: {
					avatarUrl: null,
					id: 10,
					kind: 'service',
					login: null,
					name: 'Publish Bot',
				},
				description: 'Lighting polish',
				entity: { id: 501, name: 'shot_010', type: 'Shot' },
				id: 301,
				media: {
					attachmentId: 901,
					contentType: 'video/mp4',
					durationSeconds: null,
					fileName: 'shot_010_lgt_v014.mp4',
					firstFrame: 1001,
					frameCount: 120,
					frameRate: 24,
					frameRateMode: 'unknown',
					height: null,
					kind: 'video',
					lastFrame: 1120,
					thumbnailUrl: '/review/playlists/201/versions/301/media/image',
					url: '/review/playlists/201/versions/301/media/video/901',
					width: null,
				},
				name: 'shot_010_lgt_v014',
				playlistId: 201,
				projectId: 101,
				statusCode: 'rev',
				submittedBy: {
					avatarUrl: null,
					id: 11,
					kind: 'human',
					login: null,
					name: 'Mei Chen',
				},
				task: { id: 601, name: 'Lighting' },
			},
		])

		const searchCalls = request.mock.calls.filter((call) => call[1]?.method === 'POST')
		expect(searchCalls).toHaveLength(3)
		for (const call of searchCalls) {
			expect(call[0]).toMatch(/^\/entity\//)
			expect(call[0]).not.toContain('/api/v1.1')
			expect(call[1]).toMatchObject({
				headers: { 'Content-Type': 'application/vnd+shotgun.api3_array+json' },
				idempotent: true,
				method: 'POST',
			})
		}
		expect(request.mock.calls[1][0]).toBe('/entity/projects/101')
		expect(request.mock.calls[3][0]).toBe('/entity/playlists/201')
		expect(request.mock.calls[4][1]?.query?.fields).toContain('entity')
		expect(request.mock.calls[4][1]?.query?.fields).toContain('sg_task')
		expect(request.mock.calls[4][1]?.query?.fields).toContain('sg_first_frame')
		expect(request.mock.calls[4][1]?.query?.fields).toContain('sg_last_frame')
	})

	test('filters projects and rejects a disallowed project before an upstream lookup', async () => {
		const request = vi.fn().mockResolvedValueOnce({
			data: [
				{
					attributes: { image: 'https://signed.example/one', name: 'One' },
					id: 101,
					type: 'Project',
				},
				{
					attributes: { image: 'https://signed.example/two', name: 'Two' },
					id: 202,
					type: 'Project',
				},
			],
		})
		const gateway = makeGateway(request, config, undefined, { allowedProjectIds: [101] })

		await expect(gateway.listProjects()).resolves.toEqual([
			{ id: 101, name: 'One', statusCode: null, thumbnailUrl: null },
		])
		await expect(gateway.listPlaylists(202)).rejects.toMatchObject({
			code: 'NOT_FOUND',
			status: 404,
		})
		expect(request).toHaveBeenCalledOnce()
	})

	test('rejects a Playlist outside the project allowlist before reading its Version', async () => {
		const request = vi.fn().mockResolvedValueOnce({
			data: {
				id: 201,
				relationships: { project: { data: { id: 202, type: 'Project' } } },
				type: 'Playlist',
			},
		})
		const gateway = makeGateway(request, config, undefined, { allowedProjectIds: [101] })

		await expect(gateway.getVersion(201, 301)).rejects.toMatchObject({
			code: 'NOT_FOUND',
			status: 404,
		})
		expect(request).toHaveBeenCalledOnce()
	})

	test('rejects a Playlist search result whose Project differs from the authorized query', async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce({ data: { id: 101, type: 'Project' } })
			.mockResolvedValueOnce({
				data: [
					{
						attributes: { code: 'Wrong project' },
						id: 201,
						relationships: {
							project: { data: { id: 202, type: 'Project' } },
							versions: { data: [] },
						},
						type: 'Playlist',
					},
				],
			})
		const gateway = makeGateway(request, config, undefined, { allowedProjectIds: [101] })

		await expect(gateway.listPlaylists(101)).rejects.toMatchObject({
			code: 'SHOTGRID_INVALID_RESPONSE',
			status: 502,
		})
	})

	test('rejects a Version whose Project differs from its authorized Playlist', async () => {
		const version = makeVersionResponse('https://media.example/review.mp4')
		version.data.relationships.project.data.id = 202
		const request = vi
			.fn()
			.mockResolvedValueOnce({
				data: {
					id: 201,
					relationships: { project: { data: { id: 101, type: 'Project' } } },
					type: 'Playlist',
				},
			})
			.mockResolvedValueOnce(version)
		const gateway = makeGateway(request, config, undefined, { allowedProjectIds: [101] })

		await expect(gateway.getVersion(201, 301)).rejects.toMatchObject({
			code: 'NOT_FOUND',
			status: 404,
		})
	})

	test('re-reads a selected version to refresh Attachment identity and map standard context', async () => {
		const playlistResponse = { data: { id: 201, type: 'Playlist' } }
		const request = vi
			.fn()
			.mockResolvedValueOnce(playlistResponse)
			.mockResolvedValueOnce(
				makeVersionResponse('https://media.example.com/review-old.mp4', 201, 'Playlist', 301, 901)
			)
			.mockResolvedValueOnce(playlistResponse)
			.mockResolvedValueOnce(
				makeVersionResponse('https://media.example.com/review-fresh.mp4', 201, 'Playlist', 301, 902)
			)
		const gateway = makeGateway(request)

		await expect(gateway.getVersion(201, 301)).resolves.toMatchObject({
			entity: { id: 501, name: 'shot_010', type: 'Shot' },
			id: 301,
			media: {
				attachmentId: 901,
				url: '/review/playlists/201/versions/301/media/video/901',
			},
			playlistId: 201,
			task: { id: 601, name: 'Lighting' },
		})
		await expect(gateway.getVersion(201, 301)).resolves.toMatchObject({
			media: {
				attachmentId: 902,
				url: '/review/playlists/201/versions/301/media/video/902',
			},
		})

		expect(request.mock.calls.map((call) => call[0])).toEqual([
			'/entity/playlists/201',
			'/entity/versions/301',
			'/entity/playlists/201',
			'/entity/versions/301',
		])
		expect(request.mock.calls[1][1]?.query?.fields).toContain('entity')
		expect(request.mock.calls[1][1]?.query?.fields).toContain('sg_task')
		expect(request.mock.calls[1][1]?.query?.fields).toContain('sg_uploaded_movie')
	})

	test('fails closed on malformed movie identity and numeric metadata', async () => {
		const corruptions: Array<(attributes: Record<string, unknown>) => void> = [
			(attributes) => {
				delete (attributes.sg_uploaded_movie as Record<string, unknown>).id
			},
			(attributes) => {
				;(attributes.sg_uploaded_movie as Record<string, unknown>).name = '../review.mp4'
			},
			(attributes) => {
				;(attributes.sg_uploaded_movie as Record<string, unknown>).type = 'LocalStorage'
			},
			(attributes) => {
				attributes.frame_count = 0
			},
			(attributes) => {
				attributes.frame_rate = '24'
			},
			(attributes) => {
				attributes.sg_first_frame = 1001.5
			},
			(attributes) => {
				attributes.sg_last_frame = 1000
			},
		]

		for (const corrupt of corruptions) {
			const response = makeVersionResponse('https://studio.example.com/media/review.mp4')
			corrupt(response.data.attributes as Record<string, unknown>)
			const request = vi
				.fn()
				.mockResolvedValueOnce({ data: { id: 201, type: 'Playlist' } })
				.mockResolvedValueOnce(response)
			const gateway = makeGateway(request)
			await expect(gateway.getVersion(201, 301)).rejects.toMatchObject({
				code: 'SHOTGRID_INVALID_RESPONSE',
				status: 502,
			})
		}
	})

	test('preserves explicitly missing frame metadata for the time-only fallback', async () => {
		const response = makeVersionResponse('https://studio.example.com/media/review.mp4')
		delete (response.data.attributes as Record<string, unknown>).frame_count
		delete (response.data.attributes as Record<string, unknown>).frame_rate
		delete (response.data.attributes as Record<string, unknown>).sg_first_frame
		delete (response.data.attributes as Record<string, unknown>).sg_last_frame
		const request = vi
			.fn()
			.mockResolvedValueOnce({ data: { id: 201, type: 'Playlist' } })
			.mockResolvedValueOnce(response)
		const gateway = makeGateway(request)

		await expect(gateway.getVersion(201, 301)).resolves.toMatchObject({
			media: {
				firstFrame: null,
				frameCount: null,
				frameRate: null,
				lastFrame: null,
			},
		})
	})

	test.each(['unsupported MOV', 'transcode without URL'] as const)(
		'keeps browsing available for an %s movie attachment',
		async (scenario) => {
			const response = makeVersionResponse('https://studio.example.com/media/review.mp4')
			const movie = (response.data.attributes as Record<string, unknown>)
				.sg_uploaded_movie as Record<string, unknown>
			if (scenario === 'unsupported MOV') {
				movie.content_type = 'video/quicktime'
				movie.name = 'review.mov'
			} else {
				delete movie.url
			}
			const request = vi
				.fn()
				.mockResolvedValueOnce({ data: { id: 201, type: 'Playlist' } })
				.mockResolvedValueOnce(response)
			const gateway = makeGateway(request)

			await expect(gateway.getVersion(201, 301)).resolves.toMatchObject({
				media: {
					contentType: 'image/jpeg',
					kind: 'image',
					url: '/review/playlists/201/versions/301/media/image',
				},
			})
		}
	)

	test('replaces live still-image URLs with the same-origin proxy contract', async () => {
		const playlistResponse = { data: { id: 201, type: 'Playlist' } }
		const stillVersion = makeStillVersionResponse(
			'https://studio.example.com/media/image.jpg?signature=do-not-expose'
		)
		const request = vi
			.fn()
			.mockResolvedValueOnce(playlistResponse)
			.mockResolvedValueOnce({ data: [stillVersion.data] })
			.mockResolvedValueOnce(playlistResponse)
			.mockResolvedValueOnce(stillVersion)
		const gateway = makeGateway(request)
		const proxyUrl = '/review/playlists/201/versions/301/media/image'

		const listed = await gateway.listVersions(201)
		expect(listed).toMatchObject([
			{ media: { kind: 'image', thumbnailUrl: proxyUrl, url: proxyUrl } },
		])
		const selected = await gateway.getVersion(201, 301)
		expect(selected).toMatchObject({
			media: { kind: 'image', thumbnailUrl: proxyUrl, url: proxyUrl },
		})
		expect(JSON.stringify([listed, selected])).not.toContain('do-not-expose')
	})

	test('revalidates a still image and downloads it without forwarding credentials', async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce({ data: { id: 201, type: 'Playlist' } })
			.mockResolvedValueOnce(makeStillVersionResponse('https://studio.example.com/media/image.jpg'))
		const imageBytes = makeJpeg()
		const imageFetch = vi.fn<typeof fetch>(
			async () =>
				new Response(imageBytes, {
					headers: {
						'Content-Length': String(imageBytes.byteLength),
						'Content-Type': 'image/jpeg; charset=binary',
					},
				})
		)
		const gateway = makeGateway(request, config, imageFetch)

		const image = await gateway.getVersionImage(201, 301)

		expect(Buffer.from(image.body)).toEqual(imageBytes)
		expect(image.contentType).toBe('image/jpeg')
		expect(request.mock.calls.map((call) => call[0])).toEqual([
			'/entity/playlists/201',
			'/entity/versions/301',
		])
		expect(imageFetch).toHaveBeenCalledOnce()
		expect(imageFetch.mock.calls[0][0].toString()).toBe(
			'https://studio.example.com/media/image.jpg'
		)
		const fetchOptions = imageFetch.mock.calls[0][1]
		const headers = new Headers(fetchOptions?.headers)
		expect(fetchOptions).toMatchObject({
			cache: 'no-store',
			credentials: 'omit',
			method: 'GET',
			redirect: 'manual',
			referrerPolicy: 'no-referrer',
		})
		expect(headers.get('Accept')).toContain('image/jpeg')
		expect(headers.get('Accept-Encoding')).toBe('identity')
		expect(headers.has('Authorization')).toBe(false)
		expect(headers.has('Cookie')).toBe(false)
	})

	test('revalidates and streams an exact Version Attachment without forwarding credentials', async () => {
		const videoBytes = Buffer.from('browser-playable-mp4')
		const videoFetch = vi.fn<typeof fetch>(
			async () =>
				new Response(videoBytes, {
					headers: {
						'Accept-Ranges': 'bytes',
						'Content-Length': String(videoBytes.byteLength),
						'Content-Type': 'video/mp4',
					},
				})
		)
		const request = makeVideoRequest()
		const gateway = makeGateway(request, config, videoFetch)

		const video = await gateway.getVersionVideo(201, 301, 901, null)
		expect(video).toMatchObject({
			contentLength: videoBytes.byteLength,
			contentRange: null,
			contentType: 'video/mp4',
			status: 200,
		})
		await expect(readStream(video.body)).resolves.toEqual(videoBytes)
		await video.dispose()

		expect(request.mock.calls.map((call) => call[0])).toEqual([
			'/entity/playlists/201',
			'/entity/versions/301',
		])
		expect(videoFetch).toHaveBeenCalledOnce()
		expect(videoFetch.mock.calls[0][0].toString()).toBe(
			'https://studio.example.com/media/review.mp4'
		)
		const fetchOptions = videoFetch.mock.calls[0][1]
		const headers = new Headers(fetchOptions?.headers)
		expect(fetchOptions).toMatchObject({
			cache: 'no-store',
			credentials: 'omit',
			method: 'GET',
			redirect: 'manual',
			referrerPolicy: 'no-referrer',
		})
		expect(headers.get('Accept')).toBe('video/mp4')
		expect(headers.get('Accept-Encoding')).toBe('identity')
		expect(headers.has('Authorization')).toBe(false)
		expect(headers.has('Cookie')).toBe(false)
		expect(headers.has('Range')).toBe(false)
	})

	test('serves a video thumbnail through the existing same-origin image proxy', async () => {
		const imageBytes = makeJpeg()
		const imageFetch = vi.fn<typeof fetch>(
			async () =>
				new Response(imageBytes, {
					headers: {
						'Content-Length': String(imageBytes.byteLength),
						'Content-Type': 'image/jpeg',
					},
				})
		)
		const gateway = makeGateway(makeVideoRequest(), config, imageFetch)

		await expect(gateway.getVersionImage(201, 301)).resolves.toMatchObject({
			contentType: 'image/jpeg',
		})
		expect(imageFetch.mock.calls[0][0].toString()).toBe(
			'https://studio.example.com/media/thumb.jpg'
		)
	})

	test.each([
		[{ end: 5, kind: 'closed', start: 2 }, 'bytes=2-5', 'bytes 2-5/10', 4],
		[{ kind: 'open', start: 6 }, 'bytes=6-', 'bytes 6-9/10', 4],
		[{ kind: 'suffix', length: 3 }, 'bytes=-3', 'bytes 7-9/10', 3],
	] as const)(
		'forwards and validates one byte range %#',
		async (range, requestRange, responseRange, length) => {
			const videoFetch = vi.fn<typeof fetch>(
				async () =>
					new Response(Buffer.alloc(length, 7), {
						headers: {
							'Accept-Ranges': 'bytes',
							'Content-Length': String(length),
							'Content-Range': responseRange,
							'Content-Type': 'video/mp4; charset=binary',
						},
						status: 206,
					})
			)
			const gateway = makeGateway(makeVideoRequest(), config, videoFetch)

			const video = await gateway.getVersionVideo(201, 301, 901, range)
			expect(video).toMatchObject({
				contentLength: length,
				contentRange: responseRange,
				status: 206,
			})
			await video.dispose()
			expect(new Headers(videoFetch.mock.calls[0][1]?.headers).get('Range')).toBe(requestRange)
		}
	)

	test('rejects an Attachment race before starting a video download', async () => {
		const request = makeVideoRequest({ attachmentId: 902 })
		const videoFetch = vi.fn<typeof fetch>()
		const gateway = makeGateway(request, config, videoFetch)

		await expect(gateway.getVersionVideo(201, 301, 901, null)).rejects.toMatchObject({
			code: 'NOT_FOUND',
			status: 404,
		})
		expect(videoFetch).not.toHaveBeenCalled()
	})

	test('hands off the upstream video stream without buffering and cancels it on disposal', async () => {
		const cancel = vi.fn()
		const videoFetch = vi.fn<typeof fetch>(
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						cancel,
						start(controller) {
							controller.enqueue(Uint8Array.from([1]))
						},
					}),
					{
						headers: {
							'Accept-Ranges': 'bytes',
							'Content-Length': '10',
							'Content-Type': 'video/mp4',
						},
					}
				)
		)
		const gateway = makeGateway(makeVideoRequest(), config, videoFetch)

		const video = await gateway.getVersionVideo(201, 301, 901, null)
		expect(cancel).not.toHaveBeenCalled()
		await video.dispose()
		expect(cancel).toHaveBeenCalledOnce()
		expect(videoFetch.mock.calls[0][1]?.signal?.aborted).toBe(true)
	})

	test('times out a stalled upstream video read and releases the stream', async () => {
		const videoFetch = vi.fn<typeof fetch>(async (_url, init) => {
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')), {
						once: true,
					})
				},
			})
			return new Response(body, {
				headers: {
					'Accept-Ranges': 'bytes',
					'Content-Length': '10',
					'Content-Type': 'video/mp4',
				},
			})
		})
		const gateway = makeGateway(makeVideoRequest(), { ...config, timeoutMs: 1 }, videoFetch)
		const video = await gateway.getVersionVideo(201, 301, 901, null)
		const reader = video.body.getReader()

		await expect(reader.read()).rejects.toMatchObject({
			code: 'SHOTGRID_TIMEOUT',
			status: 504,
		})
		reader.releaseLock()
		await video.dispose()
	})

	test('bounds concurrent video streams and releases capacity on disposal', async () => {
		const videoFetch = vi.fn<typeof fetch>(
			async () =>
				new Response(new ReadableStream(), {
					headers: {
						'Accept-Ranges': 'bytes',
						'Content-Length': '10',
						'Content-Type': 'video/mp4',
					},
				})
		)
		const gateway = makeGateway(makeVideoRequest(), config, videoFetch)
		const videos = await Promise.all(
			Array.from({ length: 8 }, () => gateway.getVersionVideo(201, 301, 901, null))
		)

		await expect(gateway.getVersionVideo(201, 301, 901, null)).rejects.toMatchObject({
			code: 'SHOTGRID_RATE_LIMITED',
			retryable: true,
			status: 429,
		})
		await Promise.all(videos.map((video) => video.dispose()))
		const afterRelease = await gateway.getVersionVideo(201, 301, 901, null)
		await afterRelease.dispose()
	})

	test('holds video capacity until asynchronous upstream cancellation finishes', async () => {
		let releaseCancel!: () => void
		const cancelGate = new Promise<void>((resolve) => {
			releaseCancel = resolve
		})
		const videoFetch = vi.fn<typeof fetch>(
			async () =>
				new Response(new ReadableStream({ cancel: () => cancelGate }), {
					headers: {
						'Accept-Ranges': 'bytes',
						'Content-Length': '10',
						'Content-Type': 'video/mp4',
					},
				})
		)
		const gateway = makeGateway(makeVideoRequest(), config, videoFetch)
		const videos = await Promise.all(
			Array.from({ length: 8 }, () => gateway.getVersionVideo(201, 301, 901, null))
		)
		const disposing = videos[0].dispose()

		await expect(gateway.getVersionVideo(201, 301, 901, null)).rejects.toMatchObject({
			code: 'SHOTGRID_RATE_LIMITED',
			status: 429,
		})
		releaseCancel()
		await disposing
		const replacement = await gateway.getVersionVideo(201, 301, 901, null)
		await Promise.all([...videos.slice(1).map((video) => video.dispose()), replacement.dispose()])
	})

	test.each([
		['missing Accept-Ranges', { 'Content-Length': '10', 'Content-Type': 'video/mp4' }],
		[
			'wrong content type',
			{ 'Accept-Ranges': 'bytes', 'Content-Length': '10', 'Content-Type': 'text/html' },
		],
		[
			'encoded body',
			{
				'Accept-Ranges': 'bytes',
				'Content-Encoding': 'gzip',
				'Content-Length': '10',
				'Content-Type': 'video/mp4',
			},
		],
		[
			'oversized body',
			{
				'Accept-Ranges': 'bytes',
				'Content-Length': String(2 * 1024 * 1024 * 1024 + 1),
				'Content-Type': 'video/mp4',
			},
		],
	] as const)('rejects and cancels a video with %s', async (_name, headers) => {
		const cancel = vi.fn()
		const videoFetch = vi.fn<typeof fetch>(
			async () => new Response(new ReadableStream({ cancel }), { headers })
		)
		const gateway = makeGateway(makeVideoRequest(), config, videoFetch)

		await expect(gateway.getVersionVideo(201, 301, 901, null)).rejects.toMatchObject({
			code: 'SHOTGRID_INVALID_RESPONSE',
			status: 502,
		})
		expect(cancel).toHaveBeenCalledOnce()
	})

	test('applies an overall video-transfer deadline in addition to per-read timeouts', async () => {
		const videoFetch = vi.fn<typeof fetch>(async (_url, init) => {
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')), {
						once: true,
					})
				},
			})
			return new Response(body, {
				headers: {
					'Accept-Ranges': 'bytes',
					'Content-Length': '10',
					'Content-Type': 'video/mp4',
				},
			})
		})
		const gateway = makeGateway(makeVideoRequest(), config, videoFetch, {
			videoTransferTimeoutMs: 1,
		})
		const video = await gateway.getVersionVideo(201, 301, 901, null)
		const reader = video.body.getReader()

		await expect(reader.read()).rejects.toMatchObject({
			code: 'SHOTGRID_TIMEOUT',
			status: 504,
		})
		reader.releaseLock()
		await video.dispose()
	})

	test('rejects and cancels a mismatched partial-video response', async () => {
		const cancel = vi.fn()
		const videoFetch = vi.fn<typeof fetch>(
			async () =>
				new Response(new ReadableStream({ cancel }), {
					headers: {
						'Accept-Ranges': 'bytes',
						'Content-Length': '5',
						'Content-Range': 'bytes 3-7/10',
						'Content-Type': 'video/mp4',
					},
					status: 206,
				})
		)
		const gateway = makeGateway(makeVideoRequest(), config, videoFetch)

		await expect(
			gateway.getVersionVideo(201, 301, 901, { end: 5, kind: 'closed', start: 2 })
		).rejects.toMatchObject({ code: 'SHOTGRID_INVALID_RESPONSE', status: 502 })
		expect(cancel).toHaveBeenCalledOnce()
	})

	test('maps an unsatisfiable upstream byte range without exposing its body', async () => {
		const cancel = vi.fn()
		const videoFetch = vi.fn<typeof fetch>(
			async () =>
				new Response(new ReadableStream({ cancel }), {
					headers: { 'Content-Range': 'bytes */10' },
					status: 416,
				})
		)
		const gateway = makeGateway(makeVideoRequest(), config, videoFetch)

		await expect(
			gateway.getVersionVideo(201, 301, 901, { kind: 'open', start: 10 })
		).rejects.toMatchObject({
			code: 'INVALID_REQUEST',
			rangeResourceLength: 10,
			status: 416,
			upstreamStatus: 416,
		})
		expect(cancel).toHaveBeenCalledOnce()
	})

	test('rejects and cancels an unsatisfied range without a valid resource length', async () => {
		const cancel = vi.fn()
		const videoFetch = vi.fn<typeof fetch>(
			async () => new Response(new ReadableStream({ cancel }), { status: 416 })
		)
		const gateway = makeGateway(makeVideoRequest(), config, videoFetch)

		await expect(
			gateway.getVersionVideo(201, 301, 901, { kind: 'open', start: 10 })
		).rejects.toMatchObject({ code: 'SHOTGRID_INVALID_RESPONSE', status: 502 })
		expect(cancel).toHaveBeenCalledOnce()
	})

	test.each([
		['untrusted source', 'https://evil.example/review.mp4', null],
		[
			'untrusted redirect',
			'https://studio.example.com/media/review.mp4',
			'https://evil.example/review.mp4',
		],
	] as const)('rejects an %s video URL', async (_name, source, redirect) => {
		const cancel = vi.fn()
		const videoFetch = vi.fn<typeof fetch>(
			async () =>
				new Response(new ReadableStream({ cancel }), {
					headers: redirect ? { Location: redirect } : undefined,
					status: redirect ? 302 : 200,
				})
		)
		const gateway = makeGateway(makeVideoRequest({ url: source }), config, videoFetch)

		await expect(gateway.getVersionVideo(201, 301, 901, null)).rejects.toMatchObject({
			code: 'SHOTGRID_INVALID_RESPONSE',
			status: 502,
		})
		if (redirect) {
			expect(videoFetch).toHaveBeenCalledOnce()
			expect(cancel).toHaveBeenCalledOnce()
		} else {
			expect(videoFetch).not.toHaveBeenCalled()
		}
	})

	test('allows a bounded redirect to a validated regional S3 image', async () => {
		const request = makeStillImageRequest('https://studio.example.com/media/redirect')
		const imageBytes = makeStaticWebp()
		const imageFetch = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(null, {
					headers: {
						Location:
							'https://review-bucket.s3.us-east-1.amazonaws.com/image.webp?X-Amz-Signature=safe',
					},
					status: 302,
				})
			)
			.mockResolvedValueOnce(
				new Response(imageBytes, { headers: { 'Content-Type': 'image/webp' } })
			)
		const gateway = makeGateway(request, config, imageFetch)

		await expect(gateway.getVersionImage(201, 301)).resolves.toMatchObject({
			contentType: 'image/webp',
		})
		expect(imageFetch).toHaveBeenCalledTimes(2)
		expect(imageFetch.mock.calls[1][0].toString()).toContain(
			'review-bucket.s3.us-east-1.amazonaws.com/image.webp'
		)
	})

	test('rejects an image after the bounded redirect limit', async () => {
		const imageFetch = vi.fn<typeof fetch>(
			async () =>
				new Response(null, {
					headers: { Location: '/media/redirect-again' },
					status: 302,
				})
		)
		const gateway = makeGateway(makeStillImageRequest(), config, imageFetch)

		await expect(gateway.getVersionImage(201, 301)).rejects.toMatchObject({
			code: 'SHOTGRID_INVALID_RESPONSE',
			status: 502,
		})
		expect(imageFetch).toHaveBeenCalledTimes(4)
	})

	test('times out and cancels a stalled image request', async () => {
		const imageFetch = vi.fn<typeof fetch>(async (_url, init) => {
			return await new Promise<Response>((_resolve, reject) => {
				const signal = init?.signal
				if (signal?.aborted) {
					reject(new Error('aborted'))
					return
				}
				signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
			})
		})
		const gateway = makeGateway(makeStillImageRequest(), { ...config, timeoutMs: 1 }, imageFetch)

		await expect(gateway.getVersionImage(201, 301)).rejects.toMatchObject({
			code: 'SHOTGRID_TIMEOUT',
			status: 504,
		})
		expect(imageFetch).toHaveBeenCalledOnce()
		expect(imageFetch.mock.calls[0][1]?.signal?.aborted).toBe(true)
	})

	test('bounds concurrent image work before buffering more response bodies', async () => {
		let release!: () => void
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		const imageFetch = vi.fn<typeof fetch>(async () => {
			await gate
			return new Response(makePng(false), { headers: { 'Content-Type': 'image/png' } })
		})
		const gateway = makeGateway(makeStillImageRequest(), config, imageFetch)
		const pending = Array.from({ length: 4 }, () => gateway.getVersionImage(201, 301))
		await vi.waitFor(() => expect(imageFetch).toHaveBeenCalledTimes(4))

		await expect(gateway.getVersionImage(201, 301)).rejects.toMatchObject({
			code: 'SHOTGRID_RATE_LIMITED',
			retryable: true,
			status: 429,
		})

		release()
		await expect(Promise.all(pending)).resolves.toHaveLength(4)
	})

	test.each([
		['untrusted source', 'https://evil.example/image.jpg', null],
		[
			'untrusted redirect',
			'https://studio.example.com/media/redirect',
			'https://evil.example/image.jpg',
		],
		[
			'lookalike S3 redirect',
			'https://studio.example.com/media/redirect',
			'https://bucket.s3.us-east-1.amazonaws.com.evil.example/image.jpg',
		],
	] as const)('rejects an %s URL before downloading its body', async (_name, source, redirect) => {
		const request = makeStillImageRequest(source)
		const cancel = vi.fn()
		const imageFetch = vi.fn<typeof fetch>(
			async () =>
				new Response(
					new ReadableStream({
						cancel,
						start() {
							// Keep the redirect body pending so cancellation is observable.
						},
					}),
					redirect ? { headers: { Location: redirect }, status: 302 } : { status: 200 }
				)
		)
		const gateway = makeGateway(request, config, imageFetch)

		await expect(gateway.getVersionImage(201, 301)).rejects.toMatchObject({
			code: 'SHOTGRID_INVALID_RESPONSE',
			status: 502,
		})
		if (redirect) {
			expect(imageFetch).toHaveBeenCalledOnce()
			expect(cancel).toHaveBeenCalledOnce()
		} else {
			expect(imageFetch).not.toHaveBeenCalled()
		}
	})

	test('rejects a Version that no longer belongs to the exact Playlist before fetching media', async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce({ data: { id: 201, type: 'Playlist' } })
			.mockResolvedValueOnce(makeStillVersionResponse('https://studio.example.com/image.jpg', 202))
		const imageFetch = vi.fn<typeof fetch>()
		const gateway = makeGateway(request, config, imageFetch)

		await expect(gateway.getVersionImage(201, 301)).rejects.toMatchObject({
			code: 'NOT_FOUND',
			status: 404,
		})
		expect(imageFetch).not.toHaveBeenCalled()
	})

	test('rejects and cancels image bodies over the declared or streamed 32 MiB cap', async () => {
		const overLimit = 32 * 1024 * 1024 + 1
		const headerCancel = vi.fn()
		const streamCancel = vi.fn()
		const imageFetch = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				new Response(new ReadableStream({ cancel: headerCancel }), {
					headers: {
						'Content-Length': String(overLimit),
						'Content-Type': 'image/jpeg',
					},
				})
			)
			.mockResolvedValueOnce(
				new Response(
					new ReadableStream<Uint8Array>({
						cancel: streamCancel,
						start(controller) {
							controller.enqueue(new Uint8Array(32 * 1024 * 1024))
							controller.enqueue(new Uint8Array(1))
						},
					}),
					{ headers: { 'Content-Type': 'image/jpeg' } }
				)
			)
		const gateway = makeGateway(makeStillImageRequest(), config, imageFetch)

		await expect(gateway.getVersionImage(201, 301)).rejects.toMatchObject({
			code: 'SHOTGRID_INVALID_RESPONSE',
		})
		await expect(gateway.getVersionImage(201, 301)).rejects.toMatchObject({
			code: 'SHOTGRID_INVALID_RESPONSE',
		})
		expect(headerCancel).toHaveBeenCalledOnce()
		expect(streamCancel).toHaveBeenCalledOnce()
	})

	test.each([
		['forged JPEG', 'image/jpeg', Buffer.from('<html>not an image</html>')],
		['animated PNG', 'image/png', makePng(true)],
		['animated WebP', 'image/webp', makeAnimatedWebp()],
		['SVG', 'image/svg+xml', Buffer.from('<svg/>')],
	] as const)('rejects %s media', async (_name, contentType, body) => {
		const imageFetch = vi.fn<typeof fetch>(
			async () => new Response(body, { headers: { 'Content-Type': contentType } })
		)
		const gateway = makeGateway(makeStillImageRequest(), config, imageFetch)

		await expect(gateway.getVersionImage(201, 301)).rejects.toMatchObject({
			code: 'SHOTGRID_INVALID_RESPONSE',
			status: 502,
		})
	})

	test.each([
		['PNG', 'image/png', makePng(false)],
		['WebP', 'image/webp', makeStaticWebp()],
	] as const)(
		'accepts static %s media with matching magic bytes',
		async (_name, contentType, body) => {
			const imageFetch = vi.fn<typeof fetch>(
				async () => new Response(body, { headers: { 'Content-Type': contentType } })
			)
			const gateway = makeGateway(makeStillImageRequest(), config, imageFetch)

			await expect(gateway.getVersionImage(201, 301)).resolves.toMatchObject({ contentType })
		}
	)

	test('rejects static raster headers whose dimensions exceed the review limits', async () => {
		const imageFetch = vi.fn<typeof fetch>(
			async () =>
				new Response(makePng(false, 8192, 8192), {
					headers: { 'Content-Type': 'image/png' },
				})
		)
		const gateway = makeGateway(makeStillImageRequest(), config, imageFetch)

		await expect(gateway.getVersionImage(201, 301)).rejects.toMatchObject({
			code: 'SHOTGRID_INVALID_RESPONSE',
			status: 502,
		})
	})

	test('rejects a selected version whose typed playlist relationship does not match', async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce({ data: { id: 201, type: 'Playlist' } })
			.mockResolvedValueOnce(
				makeVersionResponse('https://media.example.com/review.mp4', 201, 'Project')
			)
		const gateway = makeGateway(request)

		await expect(gateway.getVersion(201, 301)).rejects.toMatchObject({
			code: 'NOT_FOUND',
			status: 404,
		})
	})

	test('rejects a selected version whose response id does not match the requested id', async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce({ data: { id: 201, type: 'Playlist' } })
			.mockResolvedValueOnce(
				makeVersionResponse('https://media.example.com/review.mp4', 201, 'Playlist', 302)
			)
		const gateway = makeGateway(request)

		await expect(gateway.getVersion(201, 301)).rejects.toMatchObject({
			code: 'SHOTGRID_INVALID_RESPONSE',
			status: 502,
		})
	})

	test('follows bounded ShotGrid search pages without trusting the next URL', async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce({
				data: [{ attributes: { name: 'Page one' }, id: 101, type: 'Project' }],
				links: { next: 'https://studio.example.com/api/v1.1/entity/projects?page[number]=2' },
			})
			.mockResolvedValueOnce({
				data: [{ attributes: { name: 'Page two' }, id: 102, type: 'Project' }],
				links: { next: null },
			})
		const gateway = makeGateway(request)

		await expect(gateway.listProjects()).resolves.toMatchObject([
			{ id: 101, name: 'Page one' },
			{ id: 102, name: 'Page two' },
		])
		expect(request.mock.calls[0][1]).toMatchObject({
			query: { 'page[number]': 1, 'page[size]': 500 },
		})
		expect(request.mock.calls[1][1]).toMatchObject({
			query: { 'page[number]': 2, 'page[size]': 500 },
		})
	})

	test('rejects search pagination that exceeds the aggregate entity limit', async () => {
		let pageNumber = 0
		const request = vi.fn(async () => {
			pageNumber += 1
			return {
				data: Array.from({ length: 500 }, (_, index) => ({
					attributes: { name: `Project ${pageNumber}-${index}` },
					id: (pageNumber - 1) * 500 + index + 1,
					type: 'Project',
				})),
				links: { next: `page-${pageNumber + 1}` },
			}
		})
		const gateway = makeGateway(request)

		await expect(gateway.listProjects()).rejects.toMatchObject({
			code: 'SHOTGRID_INVALID_RESPONSE',
			status: 502,
		})
		expect(request).toHaveBeenCalledTimes(20)
	})

	test('rejects search pagination that exceeds the aggregate byte limit', async () => {
		const largeName = 'x'.repeat(1024 * 1024)
		let pageNumber = 0
		const request = vi.fn(async () => {
			pageNumber += 1
			return {
				data: Array.from({ length: 8 }, (_, index) => ({
					attributes: { name: largeName },
					id: (pageNumber - 1) * 8 + index + 1,
					type: 'Project',
				})),
				links: { next: `page-${pageNumber + 1}` },
			}
		})
		const gateway = makeGateway(request)

		await expect(gateway.listProjects()).rejects.toMatchObject({
			code: 'SHOTGRID_INVALID_RESPONSE',
			status: 502,
		})
		expect(request).toHaveBeenCalledTimes(4)
	})

	test('keeps script identity server-side and maps an optional sudo reviewer', async () => {
		const serviceRequest = vi.fn()
		const serviceGateway = makeGateway(serviceRequest)
		await expect(serviceGateway.getCurrentReviewer()).resolves.toEqual({
			avatarUrl: null,
			id: null,
			kind: 'service',
			login: 'review-gateway',
			name: 'ShotGrid script · review-gateway',
		})
		expect(serviceRequest).not.toHaveBeenCalled()

		const sudoRequest = vi.fn().mockResolvedValue({
			data: [
				{
					attributes: {
						image: 'https://media.example.com/reviewer.jpg',
						login: 'reviewer@example.com',
						name: 'Review Lead',
					},
					id: 7,
					type: 'HumanUser',
				},
			],
		})
		const sudoGateway = makeGateway(sudoRequest, { ...config, sudoAsLogin: 'reviewer@example.com' })
		await expect(sudoGateway.getCurrentReviewer()).resolves.toMatchObject({
			id: 7,
			kind: 'human',
			login: 'reviewer@example.com',
			name: 'Review Lead',
		})
	})

	test('maps an ApiUser note creator to a service identity', async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce({
				data: {
					id: 301,
					relationships: {
						project: { data: { id: 101, name: 'Northstar', type: 'Project' } },
					},
					type: 'Version',
				},
			})
			.mockResolvedValueOnce({
				data: {
					attributes: {
						content: 'Reduce the rim light',
						created_at: '2026-07-20T00:00:00Z',
						subject: 'Lighting note',
					},
					id: 401,
					relationships: {
						created_by: { data: { id: 10, name: 'Publish Bot', type: 'ApiUser' } },
					},
					type: 'Note',
				},
			})
		const gateway = makeGateway(request)

		await expect(
			gateway.createNote({
				content: 'Reduce the rim light',
				frame: 1042,
				projectId: 101,
				subject: 'Lighting note',
				versionId: 301,
			})
		).resolves.toMatchObject({
			createdBy: {
				id: 10,
				kind: 'service',
				login: null,
				name: 'Publish Bot',
			},
		})
	})

	test('derives project-scoped note options from the selected playlist version', async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce({ data: { id: 201, type: 'Playlist' } })
			.mockResolvedValueOnce(makeVersionResponse(''))
			.mockResolvedValueOnce({
				data: [
					{
						attributes: { image: null, login: 'reviewer', name: 'Review Lead' },
						id: 7,
						type: 'HumanUser',
					},
				],
			})
		const gateway = makeGateway(request)

		await expect(gateway.getNoteOptions(201, 301)).resolves.toEqual({
			links: {
				entity: { id: 501, name: 'shot_010', type: 'Shot' },
				project: { id: 101, name: 'Northstar', type: 'Project' },
				task: { id: 601, name: 'Lighting' },
				version: { id: 301, name: 'shot_010_lgt_v014', type: 'Version' },
			},
			recipients: [
				{
					avatarUrl: null,
					id: 7,
					kind: 'human',
					login: 'reviewer',
					name: 'Review Lead',
				},
			],
		})
		expect(request.mock.calls[2][0]).toBe('/entity/human_users/_search')
		expect(request.mock.calls[2][1]?.body).toEqual({
			filters: [
				['projects', 'in', [{ id: 101, type: 'Project' }]],
				['sg_status_list', 'is', 'act'],
			],
		})
	})

	test('publishes only server-derived links, tasks, and active project recipients', async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce({ data: { id: 201, type: 'Playlist' } })
			.mockResolvedValueOnce(makeVersionResponse(''))
			.mockResolvedValueOnce({ data: [{ id: 7, type: 'HumanUser' }] })
			.mockResolvedValueOnce({
				data: {
					attributes: {
						content: 'Move the highlight left',
						created_at: '2026-07-20T00:00:00Z',
						subject: 'Lighting note',
					},
					id: 401,
					type: 'Note',
				},
			})
		const gateway = makeGateway(request)

		await expect(
			gateway.createPublicationNote(201, 301, {
				content: 'Move the highlight left',
				recipientIds: [7],
				subject: 'Lighting note',
			})
		).resolves.toMatchObject({
			note: { id: 401, projectId: 101, versionId: 301 },
		})
		expect(request.mock.calls[2][1]?.body).toEqual({
			filters: [
				['id', 'in', [7]],
				['projects', 'in', [{ id: 101, type: 'Project' }]],
				['sg_status_list', 'is', 'act'],
			],
		})
		expect(request.mock.calls[3]).toEqual([
			'/entity/notes',
			{
				body: {
					addressings_to: [{ id: 7, type: 'HumanUser' }],
					content: 'Move the highlight left',
					note_links: [
						{ id: 301, type: 'Version' },
						{ id: 501, type: 'Shot' },
					],
					project: { id: 101, type: 'Project' },
					subject: 'Lighting note',
					tasks: [{ id: 601, type: 'Task' }],
				},
				method: 'POST',
			},
		])
	})

	test('does not create a note for an unavailable publication recipient', async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce({ data: { id: 201, type: 'Playlist' } })
			.mockResolvedValueOnce(makeVersionResponse(''))
			.mockResolvedValueOnce({ data: [] })
		const gateway = makeGateway(request)

		await expect(
			gateway.createPublicationNote(201, 301, {
				content: 'Move the highlight left',
				recipientIds: [999],
				subject: 'Lighting note',
			})
		).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 })
		expect(request).toHaveBeenCalledTimes(3)
	})

	test('bounds publication links and binds the durable Note to canonical request values', async () => {
		const versionResponse = makeVersionResponse('')
		versionResponse.data.attributes.code = 'v'.repeat(1_000)
		versionResponse.data.relationships.project.data.name = 'p'.repeat(1_000)
		versionResponse.data.relationships.entity.data.name = 'e'.repeat(1_000)
		versionResponse.data.relationships.sg_task.data.name = 't'.repeat(1_000)
		const request = vi
			.fn()
			.mockResolvedValueOnce({ data: { id: 201, type: 'Playlist' } })
			.mockResolvedValueOnce(versionResponse)
			.mockResolvedValueOnce({ data: [{ id: 7, type: 'HumanUser' }] })
			.mockResolvedValueOnce({
				data: {
					attributes: {
						content: 'x'.repeat(20_000),
						created_at: 'not-a-date',
						subject: 'x'.repeat(1_000),
					},
					id: 401,
					relationships: {
						created_by: { data: { id: 20, name: 'Unexpected', type: 'Group' } },
					},
					type: 'Note',
				},
			})
		const gateway = makeGateway(request, { ...config, scriptName: 's'.repeat(255) })

		const result = await gateway.createPublicationNote(201, 301, {
			content: 'Move the highlight left',
			recipientIds: [7],
			subject: 'Lighting note',
		})

		expect(result.links).toEqual({
			entity: { id: 501, name: 'Shot 501', type: 'Shot' },
			project: { id: 101, name: 'Project 101', type: 'Project' },
			task: { id: 601, name: 'Task 601' },
			version: { id: 301, name: 'Version 301', type: 'Version' },
		})
		expect(result.note).toMatchObject({
			content: 'Move the highlight left',
			createdAt: '2026-07-20T00:00:00.000Z',
			createdBy: { kind: 'service', login: 's'.repeat(255), name: 'ShotGrid service' },
			subject: 'Lighting note',
		})
		expect(result.note.createdBy.login).toHaveLength(255)
		expect(result.note.createdBy.name).toHaveLength(16)
	})

	test('bounds a maximum-length configured sudo actor in a publication result', async () => {
		const sudoAsLogin = 'u'.repeat(255)
		const request = vi
			.fn()
			.mockResolvedValueOnce({ data: { id: 201, type: 'Playlist' } })
			.mockResolvedValueOnce(makeVersionResponse(''))
			.mockResolvedValueOnce({ data: { id: 401, type: 'Note' } })
		const gateway = makeGateway(request, { ...config, sudoAsLogin })

		const result = await gateway.createPublicationNote(201, 301, {
			content: 'Move the highlight left',
			recipientIds: [],
			subject: 'Lighting note',
		})

		expect(result.note.createdBy).toMatchObject({
			kind: 'human',
			login: sudoAsLogin,
			name: sudoAsLogin,
		})
		expect(result.note.createdBy.login).toHaveLength(255)
		expect(result.note.createdBy.name).toHaveLength(255)
	})

	test('rejects an invalid publication entity type before creating a Note', async () => {
		const versionResponse = makeVersionResponse('')
		versionResponse.data.relationships.entity.data.type = 'Shot-Type!'
		const request = vi
			.fn()
			.mockResolvedValueOnce({ data: { id: 201, type: 'Playlist' } })
			.mockResolvedValueOnce(versionResponse)
		const gateway = makeGateway(request)

		await expect(
			gateway.createPublicationNote(201, 301, {
				content: 'Move the highlight left',
				recipientIds: [7],
				subject: 'Lighting note',
			})
		).rejects.toMatchObject({ code: 'SHOTGRID_INVALID_RESPONSE', status: 502 })
		expect(request).toHaveBeenCalledTimes(2)
	})

	test('reads only bounded status changes from the official activity stream', async () => {
		const request = makeDecisionRequest({
			activityUpdates: [
				{
					created_at: '2026-07-20T00:00:04Z',
					created_by: { id: 8, name: 'Review API', type: 'ApiUser' },
					id: 704,
					meta: {
						attribute_name: 'sg_status_list',
						entity_id: 301,
						entity_type: 'Version',
						field_data_type: 'status_list',
						new_value: 'chg',
						old_value: 'apr',
						type: 'attribute_change',
					},
					update_type: 'update',
				},
				{
					created_at: '2026-07-20T00:00:03Z',
					created_by: { id: 501, name: 'shot_010', type: 'Shot' },
					id: 703,
					meta: {
						attribute_name: 'sg_status_list',
						entity_id: 301,
						entity_type: 'Version',
						field_data_type: 'status_list',
						new_value: 'rev',
						old_value: 'chg',
						type: 'attribute_change',
					},
					update_type: 'update',
				},
				{
					created_at: '2026-07-20T00:00:02Z',
					created_by: {
						id: 7,
						image: null,
						name: 'Reviewer',
						type: 'HumanUser',
					},
					id: 702,
					meta: {
						attribute_name: 'sg_status_list',
						entity_id: 301,
						entity_type: 'Version',
						field_data_type: 'status_list',
						new_value: 'apr',
						old_value: 'rev',
						type: 'attribute_change',
					},
					update_type: 'update',
				},
				{
					content: 'must not be exposed',
					id: 999,
					meta: { attribute_name: 'content' },
					update_type: 'update',
				},
				{
					created_at: '2026-07-19T00:00:00Z',
					created_by: null,
					id: 701,
					meta: {
						attribute_name: 'sg_status_list',
						entity_id: 301,
						entity_type: 'Version',
						field_data_type: 'status_list',
						new_value: 'unmapped',
						old_value: null,
						type: 'attribute_change',
					},
					update_type: 'update',
				},
			],
		})
		const gateway = makeGateway(request)

		await expect(gateway.getDecisionContext(201, 301, DECISIONS)).resolves.toEqual({
			currentStatusCode: 'rev',
			decisions: [...DECISIONS],
			history: [
				{
					decidedAt: '2026-07-20T00:00:04.000Z',
					decisionKey: 'needs-changes',
					id: 704,
					previousStatusCode: 'apr',
					resultingStatusCode: 'chg',
					reviewer: {
						avatarUrl: null,
						id: 8,
						kind: 'service',
						login: null,
						name: 'Review API',
					},
				},
				{
					decidedAt: '2026-07-20T00:00:03.000Z',
					decisionKey: null,
					id: 703,
					previousStatusCode: 'chg',
					resultingStatusCode: 'rev',
					reviewer: null,
				},
				{
					decidedAt: '2026-07-20T00:00:02.000Z',
					decisionKey: 'approve',
					id: 702,
					previousStatusCode: 'rev',
					resultingStatusCode: 'apr',
					reviewer: {
						avatarUrl: null,
						id: 7,
						kind: 'human',
						login: null,
						name: 'Reviewer',
					},
				},
				{
					decidedAt: '2026-07-19T00:00:00.000Z',
					decisionKey: null,
					id: 701,
					previousStatusCode: null,
					resultingStatusCode: 'unmapped',
					reviewer: null,
				},
			],
			historyTruncated: false,
			playlistId: 201,
			versionId: 301,
		})
		expect(request).toHaveBeenCalledWith('/schema/versions/fields/sg_status_list', {
			query: { project_id: 101 },
		})
		expect(request).toHaveBeenCalledWith('/entity/versions/301/activity_stream', {
			query: { limit: 500 },
		})
	})

	test('marks decision history as truncated when the activity endpoint reaches its limit', async () => {
		const activityUpdates = Array.from({ length: 500 }, (_, index) => ({
			id: index + 1,
			meta: { attribute_name: 'content' },
			update_type: 'update',
		}))
		const gateway = makeGateway(makeDecisionRequest({ activityUpdates }))

		await expect(gateway.getDecisionContext(201, 301, DECISIONS)).resolves.toMatchObject({
			history: [],
			historyTruncated: true,
		})
	})

	test.each([
		['not editable', makeStatusSchemaResponse({ editable: false }), 'CONFIGURATION_ERROR'],
		['not visible', makeStatusSchemaResponse({ visible: false }), 'CONFIGURATION_ERROR'],
		[
			'missing a configured code',
			makeStatusSchemaResponse({ validValues: ['rev', 'apr'] }),
			'CONFIGURATION_ERROR',
		],
		[
			'hidden configured code',
			makeStatusSchemaResponse({ hiddenValues: ['apr'] }),
			'CONFIGURATION_ERROR',
		],
		[
			'duplicate valid code',
			makeStatusSchemaResponse({ validValues: ['rev', 'apr', 'apr', 'chg'] }),
			'SHOTGRID_INVALID_RESPONSE',
		],
		[
			'hidden code outside valid values',
			makeStatusSchemaResponse({ hiddenValues: ['other'] }),
			'SHOTGRID_INVALID_RESPONSE',
		],
		[
			'missing hidden values',
			makeStatusSchemaResponse({ omitHiddenValues: true }),
			'SHOTGRID_INVALID_RESPONSE',
		],
	])('fails closed when the project status schema is %s', async (_name, schema, code) => {
		const gateway = makeGateway(makeDecisionRequest({ schema }))

		await expect(gateway.getDecisionContext(201, 301, DECISIONS)).rejects.toMatchObject({
			code,
		})
	})

	test('rejects a malformed status activity instead of silently omitting it', async () => {
		const gateway = makeGateway(
			makeDecisionRequest({
				activityUpdates: [
					{
						created_at: 'not-a-time',
						id: 701,
						meta: {
							attribute_name: 'sg_status_list',
							entity_id: 301,
							entity_type: 'Version',
							field_data_type: 'status_list',
							new_value: 'apr',
							old_value: 'rev',
							type: 'attribute_change',
						},
						update_type: 'update',
					},
				],
			})
		)

		await expect(gateway.getDecisionContext(201, 301, DECISIONS)).rejects.toMatchObject({
			code: 'SHOTGRID_INVALID_RESPONSE',
		})
	})

	test('rejects duplicate status activity ids', async () => {
		const statusUpdate = {
			created_at: '2026-07-20T00:00:00Z',
			id: 701,
			meta: {
				attribute_name: 'sg_status_list',
				entity_id: 301,
				entity_type: 'Version',
				field_data_type: 'status_list',
				new_value: 'apr',
				old_value: 'rev',
				type: 'attribute_change',
			},
			update_type: 'update',
		}
		const gateway = makeGateway(
			makeDecisionRequest({ activityUpdates: [statusUpdate, { ...statusUpdate }] })
		)

		await expect(gateway.getDecisionContext(201, 301, DECISIONS)).rejects.toMatchObject({
			code: 'SHOTGRID_INVALID_RESPONSE',
		})
	})

	test('returns an audit-neutral no-op and rejects a stale expected status before mutation', async () => {
		const pending = {
			key: 'pending-clarification',
			label: 'Pending clarification',
			statusCode: 'rev',
		} as const
		const decisions = [...DECISIONS, pending]
		const noOpRequest = makeDecisionRequest()
		const gateway = makeGateway(noOpRequest, { ...config, sudoAsLogin: 'reviewer' })

		await expect(
			gateway.updateVersionDecision({
				decision: pending,
				decisions,
				expectedStatusCode: 'rev',
				playlistId: 201,
				versionId: 301,
			})
		).resolves.toEqual({
			changed: false,
			decisionKey: 'pending-clarification',
			playlistId: 201,
			previousStatusCode: 'rev',
			reviewer: null,
			statusCode: 'rev',
			updatedAt: null,
			versionId: 301,
		})
		expect(noOpRequest).toHaveBeenCalledTimes(3)

		const conflictRequest = makeDecisionRequest()
		const conflictingGateway = makeGateway(conflictRequest, {
			...config,
			sudoAsLogin: 'reviewer',
		})
		await expect(
			conflictingGateway.updateVersionDecision({
				decision: DECISIONS[0],
				decisions: DECISIONS,
				expectedStatusCode: 'chg',
				playlistId: 201,
				versionId: 301,
			})
		).rejects.toMatchObject({ code: 'DECISION_CONFLICT', status: 409 })
		expect(conflictRequest).toHaveBeenCalledTimes(2)
	})

	test('rejects a Playlist mismatch before schema, reviewer, or update calls', async () => {
		const request = vi.fn(async (path: string) => {
			if (path === '/entity/playlists/201') return { data: { id: 201, type: 'Playlist' } }
			if (path === '/entity/versions/301') return makeVersionResponse('', 202)
			throw new Error('A later decision request must not be made')
		})
		const gateway = makeGateway(request, { ...config, sudoAsLogin: 'reviewer' })

		await expect(
			gateway.updateVersionDecision({
				decision: DECISIONS[0],
				decisions: DECISIONS,
				expectedStatusCode: 'rev',
				playlistId: 201,
				versionId: 301,
			})
		).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 })
		expect(request).toHaveBeenCalledTimes(2)
	})

	test.each([
		[
			'a malformed success echo',
			{
				data: {
					attributes: { sg_status_list: 'apr', updated_at: 'not-a-time' },
					id: 301,
					type: 'Version',
				},
			},
			undefined,
			'DECISION_INDETERMINATE',
		],
		[
			'a success echo for another Version',
			{
				data: {
					attributes: {
						sg_status_list: 'apr',
						updated_at: '2026-07-20T00:00:01Z',
					},
					id: 999,
					type: 'Version',
				},
			},
			undefined,
			'DECISION_INDETERMINATE',
		],
		[
			'a success echo with the wrong status',
			{
				data: {
					attributes: {
						sg_status_list: 'chg',
						updated_at: '2026-07-20T00:00:01Z',
					},
					id: 301,
					type: 'Version',
				},
			},
			undefined,
			'DECISION_INDETERMINATE',
		],
		[
			'a success echo without attributes',
			{ data: { id: 301, type: 'Version' } },
			undefined,
			'DECISION_INDETERMINATE',
		],
		[
			'a timeout after dispatch',
			undefined,
			new ReviewGatewayError({
				code: 'SHOTGRID_TIMEOUT',
				retryable: false,
				status: 504,
			}),
			'DECISION_INDETERMINATE',
		],
		[
			'an upstream unavailable response after dispatch',
			undefined,
			new ReviewGatewayError({
				code: 'SHOTGRID_UNAVAILABLE',
				retryable: false,
				status: 503,
				upstreamStatus: 503,
			}),
			'DECISION_INDETERMINATE',
		],
		[
			'an explicit permission rejection',
			undefined,
			new ReviewGatewayError({
				code: 'SHOTGRID_PERMISSION_DENIED',
				retryable: false,
				status: 403,
				upstreamStatus: 403,
			}),
			'SHOTGRID_PERMISSION_DENIED',
		],
	])('classifies %s truthfully', async (_name, updateResponse, updateError, code) => {
		const request = makeDecisionRequest({ updateError, updateResponse })
		const gateway = makeGateway(request, { ...config, sudoAsLogin: 'reviewer' })

		await expect(
			gateway.updateVersionDecision({
				decision: DECISIONS[0],
				decisions: DECISIONS,
				expectedStatusCode: 'rev',
				playlistId: 201,
				versionId: 301,
			})
		).rejects.toMatchObject({ code })
		const updateCalls = request.mock.calls.filter(
			([path, options]) => path === '/entity/versions/301' && options?.method === 'PUT'
		)
		expect(updateCalls).toHaveLength(1)
	})

	test('refuses a mismatched sudo reviewer identity before sending the update', async () => {
		const request = makeDecisionRequest({ userLogin: 'another-reviewer' })
		const gateway = makeGateway(request, { ...config, sudoAsLogin: 'reviewer' })

		await expect(
			gateway.updateVersionDecision({
				decision: DECISIONS[0],
				decisions: DECISIONS,
				expectedStatusCode: 'rev',
				playlistId: 201,
				versionId: 301,
			})
		).rejects.toMatchObject({ code: 'SHOTGRID_INVALID_RESPONSE' })
		expect(
			request.mock.calls.some(
				([path, options]) => path === '/entity/versions/301' && options?.method === 'PUT'
			)
		).toBe(false)
	})

	test('does not mark note or decision mutations as retryable and confirms the update echo', async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce({
				data: {
					id: 301,
					relationships: {
						project: { data: { id: 101, name: 'Northstar', type: 'Project' } },
					},
					type: 'Version',
				},
			})
			.mockResolvedValueOnce({
				data: {
					attributes: {
						content: 'Reduce the rim light',
						created_at: '2026-07-20T00:00:00Z',
						subject: 'Lighting note',
					},
					id: 401,
					type: 'Note',
				},
			})
			.mockResolvedValueOnce({
				data: { id: 201, type: 'Playlist' },
			})
			.mockResolvedValueOnce(makeVersionResponse(''))
			.mockResolvedValueOnce(makeStatusSchemaResponse())
			.mockResolvedValueOnce({
				data: [
					{
						attributes: { image: null, login: 'reviewer', name: 'Reviewer' },
						id: 7,
						type: 'HumanUser',
					},
				],
			})
			.mockResolvedValueOnce({
				data: {
					attributes: {
						sg_status_list: 'apr',
						updated_at: '2026-07-20T00:00:01Z',
					},
					id: 301,
					type: 'Version',
				},
			})
		const gateway = makeGateway(request, { ...config, sudoAsLogin: 'reviewer' })

		await gateway.createNote({
			content: 'Reduce the rim light',
			frame: 1042,
			projectId: 101,
			subject: 'Lighting note',
			versionId: 301,
		})
		await expect(
			gateway.updateVersionDecision({
				decision: DECISIONS[0],
				decisions: DECISIONS,
				expectedStatusCode: 'rev',
				playlistId: 201,
				versionId: 301,
			})
		).resolves.toEqual({
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
			updatedAt: '2026-07-20T00:00:01.000Z',
			versionId: 301,
		})

		expect(request.mock.calls[0][0]).toBe('/entity/versions/301')
		expect(request.mock.calls[1][0]).toBe('/entity/notes')
		expect(request.mock.calls[1][1]).not.toHaveProperty('idempotent')
		expect(request.mock.calls[6][0]).toBe('/entity/versions/301')
		expect(request.mock.calls[6][1]).toMatchObject({
			body: { sg_status_list: 'apr' },
			method: 'PUT',
			query: { 'options[fields]': 'sg_status_list,updated_at' },
		})
		expect(request.mock.calls[6][1]).not.toHaveProperty('idempotent')
	})

	test('rejects a note whose project does not own the selected version', async () => {
		const request = vi.fn().mockResolvedValue({
			data: {
				id: 301,
				relationships: {
					project: { data: { id: 999, name: 'Another project', type: 'Project' } },
				},
				type: 'Version',
			},
		})
		const gateway = makeGateway(request)

		await expect(
			gateway.createNote({
				content: 'This should not cross projects',
				frame: null,
				projectId: 101,
				subject: 'Invalid link',
				versionId: 301,
			})
		).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 })
		expect(request).toHaveBeenCalledOnce()
	})

	test('uses the bounded three-step attachment contract without forwarding credentials', async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce({
				data: {
					multipart_upload: false,
					original_filename: 'annotation.png',
					storage_service: 'sg',
					timestamp: '2026-07-20T00:00:00Z',
					upload_id: null,
					upload_type: 'Attachment',
				},
				links: {
					complete_upload: '/api/v1.1/entity/notes/401/_upload',
					upload: 'https://studio.example.com/api/v1.1/entity/notes/401/_upload?signature=safe',
				},
			})
			.mockResolvedValueOnce(undefined)
		const uploadFetch = vi.fn<typeof fetch>(async () =>
			Response.json({ data: { original_filename: 'annotation.png', upload_id: 'upload-1' } })
		)
		const gateway = makeGateway(request, config, uploadFetch)

		await expect(
			gateway.uploadAttachment({
				contentBase64: Buffer.from('png-bytes').toString('base64'),
				contentType: 'image/png',
				fileName: 'annotation.png',
				noteId: 401,
			})
		).resolves.toEqual({
			contentType: 'image/png',
			fileName: 'annotation.png',
			id: null,
			noteId: 401,
			sizeBytes: 9,
		})

		expect(uploadFetch).toHaveBeenCalledOnce()
		const uploadInit = uploadFetch.mock.calls[0][1]
		expect(new Headers(uploadInit?.headers).has('Authorization')).toBe(false)
		expect(uploadInit?.redirect).toBe('error')
		expect(request.mock.calls[1][0]).toBe('/entity/notes/401/_upload')
		expect(request.mock.calls[1][1]).not.toHaveProperty('idempotent')
	})

	test('classifies a malformed attachment completion as indeterminate', async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce({
				data: {
					multipart_upload: false,
					original_filename: 'annotation.png',
					storage_service: 'sg',
					timestamp: '2026-07-20T00:00:00Z',
					upload_id: null,
					upload_type: 'Attachment',
				},
				links: {
					complete_upload: '/api/v1.1/entity/notes/401/_upload',
					upload: 'https://studio.example.com/api/v1.1/entity/notes/401/_upload?signature=safe',
				},
			})
			.mockResolvedValueOnce({ data: { id: 'not-an-id' } })
		const uploadFetch = vi.fn<typeof fetch>(async () => new Response(undefined, { status: 204 }))
		const gateway = makeGateway(request, config, uploadFetch)

		await expect(
			gateway.uploadAttachment({
				contentBase64: Buffer.from('png').toString('base64'),
				contentType: 'image/png',
				fileName: 'annotation.png',
				noteId: 401,
			})
		).rejects.toMatchObject({
			code: 'PUBLICATION_INDETERMINATE',
			retryable: false,
			status: 502,
		})
	})

	test('rejects and cancels an oversized upload response body', async () => {
		const request = vi.fn().mockResolvedValue({
			data: {
				multipart_upload: false,
				original_filename: 'annotation.png',
				storage_service: 'sg',
				timestamp: '2026-07-20T00:00:00Z',
				upload_id: null,
				upload_type: 'Attachment',
			},
			links: {
				complete_upload: '/api/v1.1/entity/notes/401/_upload',
				upload: 'https://studio.example.com/api/v1.1/entity/notes/401/_upload?signature=safe',
			},
		})
		const cancel = vi.fn()
		const uploadFetch = vi.fn<typeof fetch>(
			async () =>
				new Response(
					new ReadableStream<Uint8Array>({
						cancel,
						start(controller) {
							controller.enqueue(new Uint8Array(64 * 1024))
							controller.enqueue(new Uint8Array(1))
						},
					}),
					{ status: 200 }
				)
		)
		const gateway = makeGateway(request, config, uploadFetch)

		await expect(
			gateway.uploadAttachment({
				contentBase64: Buffer.from('png-bytes').toString('base64'),
				contentType: 'image/png',
				fileName: 'annotation.png',
				noteId: 401,
			})
		).rejects.toMatchObject({ code: 'SHOTGRID_INVALID_RESPONSE', status: 502 })
		expect(cancel).toHaveBeenCalledOnce()
		expect(request).toHaveBeenCalledOnce()
	})

	test('accepts a presigned regional S3 upload endpoint', async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce({
				data: {
					multipart_upload: false,
					original_filename: 'annotation.png',
					storage_service: 's3',
					timestamp: '2026-07-20T00:00:00Z',
					upload_id: 'upload-1',
					upload_type: 'Attachment',
				},
				links: {
					complete_upload: '/api/v1.1/entity/notes/401/_upload',
					upload:
						'https://review-bucket.s3.us-east-1.amazonaws.com/annotation.png?X-Amz-Signature=safe',
				},
			})
			.mockResolvedValueOnce(undefined)
		const uploadFetch = vi.fn<typeof fetch>(async () => new Response(undefined, { status: 204 }))
		const gateway = makeGateway(request, config, uploadFetch)

		await expect(
			gateway.uploadAttachment({
				contentBase64: Buffer.from('png').toString('base64'),
				contentType: 'image/png',
				fileName: 'annotation.png',
				noteId: 401,
			})
		).resolves.toMatchObject({ fileName: 'annotation.png', sizeBytes: 3 })
		expect(uploadFetch).toHaveBeenCalledOnce()
	})

	test.each([
		[
			'API Gateway host',
			's3',
			'https://abc.execute-api.us-east-1.amazonaws.com/upload?X-Amz-Signature=safe',
		],
		['EC2 host', 's3', 'https://ec2.us-east-1.amazonaws.com/upload?X-Amz-Signature=safe'],
		[
			'alternate ShotGrid port',
			'sg',
			'https://studio.example.com:444/api/v1.1/entity/notes/401/_upload?signature=safe',
		],
		[
			'wrong ShotGrid path',
			'sg',
			'https://studio.example.com/api/v1.1/entity/projects/101/_upload?signature=safe',
		],
		['unsigned S3 URL', 's3', 'https://review-bucket.s3.us-east-1.amazonaws.com/annotation.png'],
	] as const)('rejects an untrusted %s before uploading', async (_name, storageService, upload) => {
		const request = vi.fn().mockResolvedValue({
			data: {
				multipart_upload: false,
				original_filename: 'annotation.png',
				storage_service: storageService,
				timestamp: '2026-07-20T00:00:00Z',
				upload_id: 'upload-1',
				upload_type: 'Attachment',
			},
			links: {
				complete_upload: '/api/v1.1/entity/notes/401/_upload',
				upload,
			},
		})
		const uploadFetch = vi.fn<typeof fetch>()
		const gateway = makeGateway(request, config, uploadFetch)

		await expect(
			gateway.uploadAttachment({
				contentBase64: Buffer.from('png').toString('base64'),
				contentType: 'image/png',
				fileName: 'annotation.png',
				noteId: 401,
			})
		).rejects.toMatchObject({ code: 'SHOTGRID_INVALID_RESPONSE', status: 502 })
		expect(uploadFetch).not.toHaveBeenCalled()
	})
})

function makeDecisionRequest(
	options: {
		activityUpdates?: unknown[]
		schema?: unknown
		statusCode?: string | null
		updateError?: unknown
		updateResponse?: unknown
		userLogin?: string
	} = {}
) {
	return vi.fn(async (path: string, requestOptions?: { method?: string }) => {
		if (path === '/entity/playlists/201') return { data: { id: 201, type: 'Playlist' } }
		if (path === '/entity/versions/301' && requestOptions?.method === 'PUT') {
			if (options.updateError !== undefined) throw options.updateError
			return (
				options.updateResponse ?? {
					data: {
						attributes: {
							sg_status_list: 'apr',
							updated_at: '2026-07-20T00:00:01Z',
						},
						id: 301,
						type: 'Version',
					},
				}
			)
		}
		if (path === '/entity/versions/301') {
			const response = makeVersionResponse('')
			;(response.data.attributes as Record<string, unknown>).sg_status_list =
				options.statusCode === undefined ? 'rev' : options.statusCode
			return response
		}
		if (path === '/schema/versions/fields/sg_status_list') {
			return options.schema ?? makeStatusSchemaResponse()
		}
		if (path === '/entity/versions/301/activity_stream') {
			return {
				data: {
					earliest_update_id: 1,
					entity_id: 301,
					entity_type: 'Version',
					latest_update_id: 999,
					updates: options.activityUpdates ?? [],
				},
			}
		}
		if (path === '/entity/human_users/_search') {
			const login = options.userLogin ?? 'reviewer'
			return {
				data: [
					{
						attributes: { image: null, login, name: 'Reviewer' },
						id: 7,
						type: 'HumanUser',
					},
				],
			}
		}
		throw new Error(`Unexpected request: ${path}`)
	})
}

function makeStatusSchemaResponse(
	options: {
		editable?: boolean
		hiddenValues?: string[]
		omitHiddenValues?: boolean
		validValues?: string[]
		visible?: boolean
	} = {}
) {
	return {
		data: {
			data_type: { editable: false, value: 'status_list' },
			editable: { editable: false, value: options.editable ?? true },
			entity_type: { editable: false, value: 'Version' },
			properties: {
				...(options.omitHiddenValues
					? undefined
					: {
							hidden_values: {
								editable: false,
								value: options.hiddenValues ?? [],
							},
						}),
				valid_values: {
					editable: false,
					value: options.validValues ?? ['rev', 'apr', 'chg'],
				},
			},
			visible: { editable: false, value: options.visible ?? true },
		},
	}
}

function makeVersionResponse(
	movieUrl: string,
	playlistId = 201,
	playlistType = 'Playlist',
	versionId = 301,
	attachmentId = 901
) {
	return {
		data: {
			attributes: {
				code: 'shot_010_lgt_v014',
				created_at: '2026-07-20T00:00:00Z',
				description: 'Lighting polish',
				frame_count: 120,
				frame_rate: 24,
				image: 'https://media.example.com/thumb.jpg',
				sg_first_frame: 1001,
				sg_last_frame: 1120,
				sg_status_list: 'rev',
				sg_uploaded_movie: {
					content_type: 'video/mp4',
					id: attachmentId,
					name: 'shot_010_lgt_v014.mp4',
					type: 'Attachment',
					url: movieUrl,
				},
			},
			id: versionId,
			relationships: {
				entity: { data: { id: 501, name: 'shot_010', type: 'Shot' } },
				playlists: {
					data: [{ id: playlistId, name: `Playlist ${playlistId}`, type: playlistType }],
				},
				project: { data: { id: 101, name: 'Northstar', type: 'Project' } },
				sg_task: { data: { id: 601, name: 'Lighting', type: 'Task' } },
			},
			type: 'Version',
		},
	}
}

function makeStillVersionResponse(
	imageUrl: string,
	playlistId = 201,
	playlistType = 'Playlist',
	versionId = 301
) {
	const response = makeVersionResponse('', playlistId, playlistType, versionId)
	const { sg_uploaded_movie: _movie, ...attributes } = response.data.attributes
	return { data: { ...response.data, attributes: { ...attributes, image: imageUrl } } }
}

function makeStillImageRequest(imageUrl = 'https://studio.example.com/media/image.jpg') {
	return vi.fn(async (path: string) => {
		if (path === '/entity/playlists/201') return { data: { id: 201, type: 'Playlist' } }
		if (path === '/entity/versions/301') return makeStillVersionResponse(imageUrl)
		throw new Error(`Unexpected request: ${path}`)
	})
}

function makeVideoRequest(options: { attachmentId?: number; url?: string } = {}) {
	return vi.fn(async (path: string) => {
		if (path === '/entity/playlists/201') return { data: { id: 201, type: 'Playlist' } }
		if (path === '/entity/versions/301') {
			const response = makeVersionResponse(
				options.url ?? 'https://studio.example.com/media/review.mp4',
				201,
				'Playlist',
				301,
				options.attachmentId ?? 901
			)
			response.data.attributes.image = 'https://studio.example.com/media/thumb.jpg'
			return response
		}
		throw new Error(`Unexpected request: ${path}`)
	})
}

async function readStream(stream: ReadableStream<Uint8Array>) {
	const reader = stream.getReader()
	const chunks: Buffer[] = []
	let length = 0
	try {
		for (;;) {
			const { done, value } = await reader.read()
			if (done) break
			const chunk = Buffer.from(value)
			chunks.push(chunk)
			length += chunk.byteLength
		}
	} finally {
		reader.releaseLock()
	}
	return Buffer.concat(chunks, length)
}

function makeJpeg(width = 1, height = 1) {
	const startOfFrame = Buffer.alloc(11)
	startOfFrame.writeUInt16BE(11, 0)
	startOfFrame[2] = 8
	startOfFrame.writeUInt16BE(height, 3)
	startOfFrame.writeUInt16BE(width, 5)
	startOfFrame[7] = 1
	startOfFrame[8] = 1
	startOfFrame[9] = 0x11
	return Buffer.concat([
		Buffer.from([0xff, 0xd8, 0xff, 0xc0]),
		startOfFrame,
		Buffer.from([0xff, 0xd9]),
	])
}

function makePng(animated: boolean, width = 1, height = 1) {
	const header = Buffer.alloc(13)
	header.writeUInt32BE(width, 0)
	header.writeUInt32BE(height, 4)
	header[8] = 8
	header[9] = 6
	return Buffer.concat([
		Buffer.from('89504e470d0a1a0a', 'hex'),
		makePngChunk('IHDR', header),
		...(animated ? [makePngChunk('acTL', Buffer.alloc(8))] : []),
		makePngChunk('IDAT', Buffer.alloc(0)),
		makePngChunk('IEND', Buffer.alloc(0)),
	])
}

function makePngChunk(type: string, data: Buffer) {
	const header = Buffer.alloc(8)
	header.writeUInt32BE(data.byteLength, 0)
	header.write(type, 4, 4, 'ascii')
	return Buffer.concat([header, data, Buffer.alloc(4)])
}

function makeStaticWebp() {
	return makeWebp([
		makeWebpChunk('VP8X', Buffer.alloc(10)),
		makeWebpChunk('VP8 ', Buffer.from([0])),
	])
}

function makeAnimatedWebp() {
	const extendedHeader = Buffer.alloc(10)
	extendedHeader[0] = 0x02
	return makeWebp([
		makeWebpChunk('VP8X', extendedHeader),
		makeWebpChunk('ANIM', Buffer.alloc(6)),
		makeWebpChunk('VP8 ', Buffer.from([0])),
	])
}

function makeWebp(chunks: Buffer[]) {
	const payload = Buffer.concat([Buffer.from('WEBP'), ...chunks])
	const header = Buffer.alloc(8)
	header.write('RIFF', 0, 4, 'ascii')
	header.writeUInt32LE(payload.byteLength, 4)
	return Buffer.concat([header, payload])
}

function makeWebpChunk(type: string, data: Buffer) {
	const header = Buffer.alloc(8)
	header.write(type, 0, 4, 'ascii')
	header.writeUInt32LE(data.byteLength, 4)
	return Buffer.concat([header, data, ...(data.byteLength % 2 ? [Buffer.alloc(1)] : [])])
}

function makeGateway(
	request: ReturnType<typeof vi.fn>,
	connectionConfig = config,
	uploadFetch?: typeof fetch,
	options: {
		allowedProjectIds?: readonly number[]
		maxVideoResponseBytes?: number
		videoTransferTimeoutMs?: number
	} = {}
) {
	const client = { request } as unknown as Pick<ShotGridClient, 'request'>
	return new ShotGridReviewGateway(client, connectionConfig, {
		fetch: uploadFetch,
		now: () => Date.parse('2026-07-20T00:00:00Z'),
		...options,
	})
}
