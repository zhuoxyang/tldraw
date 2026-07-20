import { describe, expect, test, vi } from 'vitest'
import type { ShotGridConnectionConfig } from '../config'
import type { ShotGridClient } from '../shotgrid/ShotGridClient'
import { ShotGridReviewGateway } from './ShotGridReviewGateway'

const config: ShotGridConnectionConfig = {
	maxRetries: 2,
	scriptKey: 'server-only-key',
	scriptName: 'review-gateway',
	siteUrl: 'https://studio.example.com',
	timeoutMs: 1000,
}

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
								content_type: 'video/mp4',
								url: 'https://media.example.com/review.mp4',
							},
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
				thumbnailUrl: 'https://media.example.com/project.jpg',
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
					contentType: 'video/mp4',
					durationSeconds: 5,
					firstFrame: null,
					frameCount: 120,
					frameRate: 24,
					height: null,
					kind: 'video',
					lastFrame: null,
					thumbnailUrl: 'https://media.example.com/thumb.jpg',
					url: 'https://media.example.com/review.mp4',
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
	})

	test('re-reads a selected version to refresh media and map standard context', async () => {
		const playlistResponse = { data: { id: 201, type: 'Playlist' } }
		const request = vi
			.fn()
			.mockResolvedValueOnce(playlistResponse)
			.mockResolvedValueOnce(makeVersionResponse('https://media.example.com/review-old.mp4'))
			.mockResolvedValueOnce(playlistResponse)
			.mockResolvedValueOnce(makeVersionResponse('https://media.example.com/review-fresh.mp4'))
		const gateway = makeGateway(request)

		await expect(gateway.getVersion(201, 301)).resolves.toMatchObject({
			entity: { id: 501, name: 'shot_010', type: 'Shot' },
			id: 301,
			media: { url: 'https://media.example.com/review-old.mp4' },
			playlistId: 201,
			task: { id: 601, name: 'Lighting' },
		})
		await expect(gateway.getVersion(201, 301)).resolves.toMatchObject({
			media: { url: 'https://media.example.com/review-fresh.mp4' },
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

	test('does not mark note or status mutations as retryable', async () => {
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
				data: {
					attributes: { sg_status_list: 'apr' },
					id: 301,
					type: 'Version',
				},
			})
		const gateway = makeGateway(request)

		await gateway.createNote({
			content: 'Reduce the rim light',
			frame: 1042,
			projectId: 101,
			subject: 'Lighting note',
			versionId: 301,
		})
		await gateway.updateVersionStatus({ statusCode: 'apr', versionId: 301 })

		expect(request.mock.calls[0][0]).toBe('/entity/versions/301')
		expect(request.mock.calls[1][0]).toBe('/entity/notes')
		expect(request.mock.calls[1][1]).not.toHaveProperty('idempotent')
		expect(request.mock.calls[2][0]).toBe('/entity/versions/301')
		expect(request.mock.calls[2][1]).toMatchObject({
			query: { 'options[fields]': 'sg_status_list' },
		})
		expect(request.mock.calls[2][1]).not.toHaveProperty('idempotent')
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

function makeVersionResponse(
	movieUrl: string,
	playlistId = 201,
	playlistType = 'Playlist',
	versionId = 301
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
				sg_status_list: 'rev',
				sg_uploaded_movie: { content_type: 'video/mp4', url: movieUrl },
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
	uploadFetch?: typeof fetch
) {
	const client = { request } as unknown as Pick<ShotGridClient, 'request'>
	return new ShotGridReviewGateway(client, connectionConfig, {
		fetch: uploadFetch,
		now: () => Date.parse('2026-07-20T00:00:00Z'),
	})
}
