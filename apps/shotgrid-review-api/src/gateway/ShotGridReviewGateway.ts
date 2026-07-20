import type { ShotGridConnectionConfig } from '../config'
import type {
	CreateReviewNoteRequest,
	ReviewAttachmentResult,
	ReviewMedia,
	ReviewNote,
	ReviewPlaylist,
	ReviewProject,
	ReviewStatusResult,
	ReviewUser,
	ReviewVersion,
	UpdateReviewStatusRequest,
	UploadReviewAttachmentRequest,
} from '../contracts'
import { ReviewGatewayError } from '../errors'
import type { ShotGridClient } from '../shotgrid/ShotGridClient'
import type { ReviewGateway } from './ReviewGateway'

type FetchImplementation = typeof fetch

interface ShotGridEntity {
	id: number
	type: string
	attributes?: Record<string, unknown>
	relationships?: Record<string, unknown>
}

interface ShotGridListResponse {
	data: ShotGridEntity[]
}

interface ShotGridRecordResponse {
	data: ShotGridEntity
}

interface UploadTicket {
	data: {
		multipart_upload: boolean
		original_filename: string
		storage_service: 's3' | 'sg'
		timestamp: string
		upload_id: null | string
		upload_type: 'Attachment'
	}
	links: {
		complete_upload: string
		upload: string
	}
}

interface UploadResponse {
	data?: {
		id?: number
		original_filename?: string
		upload_id?: string
	}
}

interface ShotGridReviewGatewayOptions {
	fetch?: FetchImplementation
	now?(): number
}

export class ShotGridReviewGateway implements ReviewGateway {
	private readonly fetch: FetchImplementation
	private readonly now: () => number

	constructor(
		private readonly client: Pick<ShotGridClient, 'request'>,
		private readonly config: ShotGridConnectionConfig,
		options: ShotGridReviewGatewayOptions = {}
	) {
		this.fetch = options.fetch ?? fetch
		this.now = options.now ?? Date.now
	}

	async createNote(request: CreateReviewNoteRequest): Promise<ReviewNote> {
		const response = await this.client.request<ShotGridRecordResponse>('/entity/notes', {
			body: {
				content: request.content,
				note_links: [{ id: request.versionId, type: 'Version' }],
				project: { id: request.projectId, type: 'Project' },
				subject: request.subject,
			},
			method: 'POST',
		})
		const entity = requireResponseEntity(response, 'Note')

		return {
			content: readString(entity.attributes, 'content') || request.content,
			createdAt: readString(entity.attributes, 'created_at') || new Date(this.now()).toISOString(),
			createdBy:
				mapOptionalRelationshipUser(readRelationship(entity.relationships, 'created_by')) ??
				this.getConfiguredActor(),
			frame: request.frame,
			id: entity.id,
			projectId: request.projectId,
			subject: readString(entity.attributes, 'subject') || request.subject,
			versionId: request.versionId,
		}
	}

	async getCurrentReviewer(): Promise<ReviewUser> {
		if (!this.config.sudoAsLogin) {
			return this.getConfiguredActor()
		}

		const users = await this.search(
			'human_users',
			[['login', 'is', this.config.sudoAsLogin]],
			['login', 'name', 'image']
		)
		const user = users[0]
		if (!user) {
			throw new ReviewGatewayError({
				code: 'SHOTGRID_AUTH_FAILED',
				retryable: false,
				status: 502,
			})
		}
		return mapUser(user)
	}

	async listProjects(): Promise<ReviewProject[]> {
		const entities = await this.search(
			'projects',
			[['sg_status', 'is_not', 'Archive']],
			['name', 'sg_status', 'image'],
			'name'
		)
		return entities.map((entity) => ({
			id: entity.id,
			name: readString(entity.attributes, 'name') || `Project ${entity.id}`,
			statusCode: readNullableString(entity.attributes, 'sg_status'),
			thumbnailUrl: readNullableUrl(entity.attributes, 'image'),
		}))
	}

	async listPlaylists(projectId: number): Promise<ReviewPlaylist[]> {
		const entities = await this.search(
			'playlists',
			[['project', 'is', { id: projectId, type: 'Project' }]],
			['code', 'description', 'project', 'updated_at', 'versions'],
			'-updated_at'
		)
		return entities.map((entity) => ({
			description: readNullableString(entity.attributes, 'description'),
			id: entity.id,
			name: readString(entity.attributes, 'code') || `Playlist ${entity.id}`,
			projectId,
			updatedAt: readString(entity.attributes, 'updated_at'),
			versionCount: readRelationshipList(entity.relationships, 'versions').length,
		}))
	}

	async listVersions(playlistId: number): Promise<ReviewVersion[]> {
		const entities = await this.search(
			'versions',
			[['playlists', 'in', [{ id: playlistId, type: 'Playlist' }]]],
			[
				'code',
				'description',
				'project',
				'playlists',
				'sg_status_list',
				'created_at',
				'user',
				'image',
				'sg_uploaded_movie',
				'frame_count',
				'frame_rate',
			],
			'code'
		)

		return entities.map((entity) => {
			const project = readRelationship(entity.relationships, 'project')
			const createdBy = readRelationship(entity.relationships, 'user')
			if (!project) throw invalidShotGridResponse()
			return {
				createdAt: readString(entity.attributes, 'created_at'),
				createdBy: createdBy ? mapRelationshipUser(createdBy) : null,
				description: readNullableString(entity.attributes, 'description'),
				id: entity.id,
				media: mapVersionMedia(entity.attributes),
				name: readString(entity.attributes, 'code') || `Version ${entity.id}`,
				playlistId,
				projectId: project.id,
				statusCode: readNullableString(entity.attributes, 'sg_status_list'),
			}
		})
	}

	async updateVersionStatus(request: UpdateReviewStatusRequest): Promise<ReviewStatusResult> {
		const response = await this.client.request<ShotGridRecordResponse>(
			`/entity/versions/${request.versionId}`,
			{
				body: { sg_status_list: request.statusCode },
				method: 'PUT',
				query: { fields: 'sg_status_list' },
			}
		)
		const entity = requireResponseEntity(response, 'Version')
		return {
			previousStatusCode: null,
			statusCode: readString(entity.attributes, 'sg_status_list') || request.statusCode,
			updatedAt: new Date(this.now()).toISOString(),
			versionId: request.versionId,
		}
	}

	async uploadAttachment(request: UploadReviewAttachmentRequest): Promise<ReviewAttachmentResult> {
		const uploadPath = `/entity/notes/${request.noteId}/_upload`
		const completeUploadPath = `/api/v1.1${uploadPath}`
		const ticketResponse = await this.client.request<UploadTicket>(uploadPath, {
			query: { filename: request.fileName },
		})
		const ticket = requireUploadTicket(ticketResponse)
		if (ticket.data.original_filename !== request.fileName) throw invalidShotGridResponse()
		if (ticket.data.multipart_upload) {
			throw new ReviewGatewayError({
				code: 'SHOTGRID_REQUEST_FAILED',
				retryable: false,
				status: 502,
			})
		}
		if (ticket.links.complete_upload !== completeUploadPath) {
			throw invalidShotGridResponse()
		}

		const bytes = Buffer.from(request.contentBase64, 'base64')
		const uploadResponse = await this.putUpload(ticket.links.upload, bytes, request.contentType)
		const uploadInfo = {
			...ticket.data,
			...(uploadResponse.data?.upload_id
				? { upload_id: uploadResponse.data.upload_id }
				: undefined),
		}
		const completion = await this.client.request<UploadResponse | undefined>(uploadPath, {
			body: {
				upload_data: { display_name: request.fileName, tags: [] },
				upload_info: uploadInfo,
			},
			method: 'POST',
		})

		return {
			contentType: request.contentType,
			fileName: request.fileName,
			id: completion?.data?.id ?? null,
			noteId: request.noteId,
			sizeBytes: bytes.byteLength,
		}
	}

	private async search(
		entity: string,
		filters: unknown[],
		fields: string[],
		sort?: string
	): Promise<ShotGridEntity[]> {
		const response = await this.client.request<ShotGridListResponse>(`/entity/${entity}/_search`, {
			body: { filters },
			idempotent: true,
			method: 'POST',
			query: { fields: fields.join(','), ...(sort ? { sort } : undefined) },
		})
		if (!response || !Array.isArray(response.data)) throw invalidShotGridResponse()
		return response.data.map((item) => requireEntity(item))
	}

	private getConfiguredActor(): ReviewUser {
		if (this.config.sudoAsLogin) {
			return {
				avatarUrl: null,
				id: null,
				kind: 'human',
				login: this.config.sudoAsLogin,
				name: this.config.sudoAsLogin,
			}
		}
		return {
			avatarUrl: null,
			id: null,
			kind: 'service',
			login: this.config.scriptName,
			name: `ShotGrid script · ${this.config.scriptName}`,
		}
	}

	private async putUpload(urlValue: string, body: Buffer, contentType: string) {
		const url = validateUploadUrl(urlValue, this.config.siteUrl)
		const uploadBody = Uint8Array.from(body).buffer
		const controller = new AbortController()
		const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs)
		try {
			const response = await this.fetch(url, {
				body: uploadBody,
				headers: {
					'Content-Length': String(body.byteLength),
					'Content-Type': contentType,
				},
				method: 'PUT',
				redirect: 'error',
				signal: controller.signal,
			})
			if (!response.ok) {
				throw new ReviewGatewayError({
					code: response.status === 403 ? 'SHOTGRID_PERMISSION_DENIED' : 'SHOTGRID_REQUEST_FAILED',
					retryable: false,
					status: response.status === 403 ? 403 : 502,
					upstreamStatus: response.status,
				})
			}
			if (response.status === 204 || response.headers.get('content-length') === '0') return {}
			try {
				return (await response.json()) as UploadResponse
			} catch {
				return {}
			}
		} catch (error) {
			if (error instanceof ReviewGatewayError) throw error
			throw new ReviewGatewayError({
				code: controller.signal.aborted ? 'SHOTGRID_TIMEOUT' : 'SHOTGRID_REQUEST_FAILED',
				retryable: false,
				status: controller.signal.aborted ? 504 : 502,
			})
		} finally {
			clearTimeout(timeout)
		}
	}
}

function requireEntity(value: unknown, expectedType?: string): ShotGridEntity {
	if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidShotGridResponse()
	const entity = value as Partial<ShotGridEntity>
	if (
		!Number.isSafeInteger(entity.id) ||
		Number(entity.id) <= 0 ||
		typeof entity.type !== 'string' ||
		(expectedType && entity.type !== expectedType)
	) {
		throw invalidShotGridResponse()
	}
	return entity as ShotGridEntity
}

function requireResponseEntity(value: unknown, expectedType: string) {
	const response = readRecord(value)
	return requireEntity(response?.data, expectedType)
}

function requireUploadTicket(value: unknown): UploadTicket {
	const ticket = readRecord(value)
	const data = readRecord(ticket?.data)
	const links = readRecord(ticket?.links)
	if (
		!data ||
		!links ||
		typeof data.multipart_upload !== 'boolean' ||
		typeof data.original_filename !== 'string' ||
		(data.storage_service !== 's3' && data.storage_service !== 'sg') ||
		typeof data.timestamp !== 'string' ||
		(data.upload_id !== null && typeof data.upload_id !== 'string') ||
		data.upload_type !== 'Attachment' ||
		typeof links.complete_upload !== 'string' ||
		typeof links.upload !== 'string'
	) {
		throw invalidShotGridResponse()
	}
	return { data, links } as UploadTicket
}

function mapUser(entity: ShotGridEntity): ReviewUser {
	return {
		avatarUrl: readNullableUrl(entity.attributes, 'image'),
		id: entity.id,
		kind: 'human',
		login: readNullableString(entity.attributes, 'login'),
		name: readString(entity.attributes, 'name') || `User ${entity.id}`,
	}
}

function mapRelationshipUser(relationship: { id: number; name?: string }): ReviewUser {
	return {
		avatarUrl: null,
		id: relationship.id,
		kind: 'human',
		login: null,
		name: relationship.name || `User ${relationship.id}`,
	}
}

function mapOptionalRelationshipUser(
	relationship: { id: number; name?: string } | null
): ReviewUser | null {
	return relationship ? mapRelationshipUser(relationship) : null
}

function mapVersionMedia(attributes: Record<string, unknown> | undefined): ReviewMedia | null {
	const movie = readRecord(attributes?.sg_uploaded_movie)
	const movieUrl = readUrlValue(movie?.url)
	const thumbnailUrl = readNullableUrl(attributes, 'image')
	if (movieUrl) {
		const frameCount = readNumber(attributes, 'frame_count')
		const frameRate = readNumber(attributes, 'frame_rate')
		return {
			contentType: readString(movie, 'content_type') || 'video/mp4',
			durationSeconds: frameCount && frameRate ? frameCount / frameRate : null,
			firstFrame: null,
			frameRate,
			height: null,
			kind: 'video',
			lastFrame: frameCount,
			thumbnailUrl,
			url: movieUrl,
			width: null,
		}
	}
	if (!thumbnailUrl) return null
	return {
		contentType: 'image/jpeg',
		height: null,
		kind: 'image',
		thumbnailUrl,
		url: thumbnailUrl,
		width: null,
	}
}

function readString(source: Record<string, unknown> | undefined, key: string) {
	const value = source?.[key]
	return typeof value === 'string' ? value : ''
}

function readNullableString(source: Record<string, unknown> | undefined, key: string) {
	return readString(source, key) || null
}

function readNumber(source: Record<string, unknown> | undefined, key: string) {
	const value = source?.[key]
	return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readRecord(value: unknown) {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined
}

function readUrlValue(value: unknown) {
	if (typeof value !== 'string') return null
	try {
		const url = new URL(value)
		return url.protocol === 'https:' ? url.toString() : null
	} catch {
		return value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') ? value : null
	}
}

function readNullableUrl(source: Record<string, unknown> | undefined, key: string) {
	const value = source?.[key]
	if (typeof value === 'string') return readUrlValue(value)
	const record = readRecord(value)
	return readUrlValue(record?.url)
}

function readRelationship(
	relationships: Record<string, unknown> | undefined,
	key: string
): { id: number; name?: string } | null {
	const raw = relationships?.[key]
	const record = readRecord(raw)
	const value = readRecord(record?.data) ?? record
	if (!value || !Number.isSafeInteger(value.id) || Number(value.id) <= 0) return null
	return {
		id: Number(value.id),
		...(typeof value.name === 'string' ? { name: value.name } : undefined),
	}
}

function readRelationshipList(relationships: Record<string, unknown> | undefined, key: string) {
	const raw = relationships?.[key]
	const record = readRecord(raw)
	const value = Array.isArray(record?.data) ? record.data : Array.isArray(raw) ? raw : []
	return value.filter((item) => readRecord(item) && Number.isSafeInteger(readRecord(item)?.id))
}

function validateUploadUrl(value: string, siteUrl: string) {
	let url: URL
	try {
		url = new URL(value, siteUrl)
	} catch {
		throw invalidShotGridResponse()
	}
	const site = new URL(siteUrl)
	const isTrustedStorage = url.hostname === site.hostname || url.hostname.endsWith('.amazonaws.com')
	if (
		url.protocol !== 'https:' ||
		url.username !== '' ||
		url.password !== '' ||
		!isTrustedStorage
	) {
		throw invalidShotGridResponse()
	}
	return url
}

function invalidShotGridResponse() {
	return new ReviewGatewayError({
		code: 'SHOTGRID_INVALID_RESPONSE',
		retryable: false,
		status: 502,
	})
}
