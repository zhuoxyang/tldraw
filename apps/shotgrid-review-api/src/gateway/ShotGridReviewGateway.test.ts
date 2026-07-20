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
						relationships: { versions: [{ id: 301 }, { id: 302 }] },
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
							created_by: { data: { id: 10, name: 'Publish Bot' } },
							project: { data: { id: 101, name: 'Northstar' } },
							user: { data: { id: 11, name: 'Mei Chen' } },
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
					kind: 'human',
					login: null,
					name: 'Publish Bot',
				},
				description: 'Lighting polish',
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

	test('does not mark note or status mutations as retryable', async () => {
		const request = vi
			.fn()
			.mockResolvedValueOnce({
				data: {
					id: 301,
					relationships: { project: { data: { id: 101, name: 'Northstar' } } },
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
				relationships: { project: { data: { id: 999, name: 'Another project' } } },
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
