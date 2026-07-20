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
	links?: {
		next?: null | string
	}
}

interface ShotGridRecordResponse {
	data: ShotGridEntity
}

interface ShotGridRelationship {
	id: number
	name?: string
	type: string
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

const SEARCH_PAGE_SIZE = 500
const MAX_SEARCH_PAGES = 100
const MAX_SEARCH_ENTITIES = 10_000
const MAX_SEARCH_AGGREGATE_BYTES = 32 * 1024 * 1024
const MAX_UPLOAD_RESPONSE_BODY_BYTES = 64 * 1024

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
		const version = await this.readEntity('versions', request.versionId, 'Version', ['project'])
		const versionProject = readRelationship(version.relationships, 'project')
		if (!versionProject || versionProject.type !== 'Project') throw invalidShotGridResponse()
		if (versionProject.id !== request.projectId) {
			throw new ReviewGatewayError({
				code: 'INVALID_REQUEST',
				retryable: false,
				status: 400,
			})
		}
		const response = await this.client.request<ShotGridRecordResponse>('/entity/notes', {
			body: {
				content: request.content,
				note_links: [{ id: request.versionId, type: 'Version' }],
				project: { id: versionProject.id, type: 'Project' },
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
		await this.readEntity('projects', projectId, 'Project')
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
		await this.readEntity('playlists', playlistId, 'Playlist')
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
				'created_by',
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
			const createdBy = readRelationship(entity.relationships, 'created_by')
			const submittedBy = readRelationship(entity.relationships, 'user')
			if (!project || project.type !== 'Project') throw invalidShotGridResponse()
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
				submittedBy: submittedBy ? mapRelationshipUser(submittedBy) : null,
			}
		})
	}

	async updateVersionStatus(request: UpdateReviewStatusRequest): Promise<ReviewStatusResult> {
		const response = await this.client.request<ShotGridRecordResponse>(
			`/entity/versions/${request.versionId}`,
			{
				body: { sg_status_list: request.statusCode },
				method: 'PUT',
				query: { 'options[fields]': 'sg_status_list' },
			}
		)
		const entity = requireResponseEntity(response, 'Version')
		return {
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
		const uploadResponse = await this.putUpload(
			ticket.links.upload,
			bytes,
			request.contentType,
			request.noteId,
			ticket.data.storage_service
		)
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
		const entities: ShotGridEntity[] = []
		let aggregateBytes = 0
		for (let pageNumber = 1; pageNumber <= MAX_SEARCH_PAGES; pageNumber++) {
			const response = await this.client.request<ShotGridListResponse>(
				`/entity/${entity}/_search`,
				{
					body: { filters },
					headers: { 'Content-Type': 'application/vnd+shotgun.api3_array+json' },
					idempotent: true,
					method: 'POST',
					query: {
						fields: fields.join(','),
						'page[number]': pageNumber,
						'page[size]': SEARCH_PAGE_SIZE,
						...(sort ? { sort } : undefined),
					},
				}
			)
			if (!response || !Array.isArray(response.data) || response.data.length > SEARCH_PAGE_SIZE) {
				throw invalidShotGridResponse()
			}
			for (const item of response.data) {
				const entity = requireEntity(item)
				aggregateBytes += estimateEntityJsonBytes(entity)
				if (entities.length >= MAX_SEARCH_ENTITIES || aggregateBytes > MAX_SEARCH_AGGREGATE_BYTES) {
					throw invalidShotGridResponse()
				}
				entities.push(entity)
			}

			if (!readNextLink(response)) return entities
			if (entities.length >= MAX_SEARCH_ENTITIES) throw invalidShotGridResponse()
		}
		throw invalidShotGridResponse()
	}

	private async readEntity(
		entity: string,
		id: number,
		expectedType: string,
		fields: string[] = []
	): Promise<ShotGridEntity> {
		const response = await this.client.request<ShotGridRecordResponse>(`/entity/${entity}/${id}`, {
			query: { fields: fields.join(',') },
		})
		return requireResponseEntity(response, expectedType)
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

	private async putUpload(
		urlValue: string,
		body: Buffer,
		contentType: string,
		noteId: number,
		storageService: 's3' | 'sg'
	) {
		const url = validateUploadUrl(urlValue, this.config.siteUrl, noteId, storageService)
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
			return await this.readUploadResponse(response)
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

	private async readUploadResponse(response: Response): Promise<UploadResponse> {
		if (!response.body) return {}

		const reader = response.body.getReader()
		const chunks: Buffer[] = []
		let byteLength = 0
		try {
			for (;;) {
				const { done, value } = await reader.read()
				if (done) break

				byteLength += value.byteLength
				if (byteLength > MAX_UPLOAD_RESPONSE_BODY_BYTES) {
					try {
						await reader.cancel()
					} catch {
						// Preserve the invalid-response classification that caused cancellation.
					}
					throw invalidShotGridResponse()
				}
				chunks.push(Buffer.from(value))
			}
		} finally {
			reader.releaseLock()
		}

		try {
			return JSON.parse(Buffer.concat(chunks, byteLength).toString('utf8')) as UploadResponse
		} catch {
			return {}
		}
	}
}

function estimateEntityJsonBytes(entity: ShotGridEntity) {
	try {
		const serialized = JSON.stringify(entity)
		if (serialized === undefined) throw new Error('Entity is not JSON serializable')
		return Buffer.byteLength(serialized, 'utf8') + 1
	} catch {
		throw invalidShotGridResponse()
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

function readNextLink(response: ShotGridListResponse): string | null {
	if (
		response.links === undefined ||
		response.links.next === undefined ||
		response.links.next === null
	) {
		return null
	}
	if (typeof response.links.next !== 'string' || response.links.next.length === 0) {
		throw invalidShotGridResponse()
	}
	return response.links.next
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

function mapRelationshipUser(relationship: ShotGridRelationship): ReviewUser {
	if (relationship.type !== 'HumanUser' && relationship.type !== 'ApiUser') {
		throw invalidShotGridResponse()
	}
	return {
		avatarUrl: null,
		id: relationship.id,
		kind: relationship.type === 'ApiUser' ? 'service' : 'human',
		login: null,
		name: relationship.name || `User ${relationship.id}`,
	}
}

function mapOptionalRelationshipUser(relationship: ShotGridRelationship | null): ReviewUser | null {
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
			frameCount,
			frameRate,
			height: null,
			kind: 'video',
			lastFrame: null,
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
): ShotGridRelationship | null {
	const raw = relationships?.[key]
	const record = readRecord(raw)
	const value = readRecord(record?.data) ?? record
	if (
		!value ||
		!Number.isSafeInteger(value.id) ||
		Number(value.id) <= 0 ||
		typeof value.type !== 'string' ||
		value.type.length === 0
	) {
		return null
	}
	return {
		id: Number(value.id),
		...(typeof value.name === 'string' ? { name: value.name } : undefined),
		type: value.type,
	}
}

function readRelationshipList(relationships: Record<string, unknown> | undefined, key: string) {
	const raw = relationships?.[key]
	const record = readRecord(raw)
	const value = Array.isArray(record?.data) ? record.data : Array.isArray(raw) ? raw : []
	return value.filter((item) => readRecord(item) && Number.isSafeInteger(readRecord(item)?.id))
}

function validateUploadUrl(
	value: string,
	siteUrl: string,
	noteId: number,
	storageService: 's3' | 'sg'
) {
	let url: URL
	try {
		url = new URL(value, siteUrl)
	} catch {
		throw invalidShotGridResponse()
	}
	const site = new URL(siteUrl)
	if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
		throw invalidShotGridResponse()
	}

	if (storageService === 'sg') {
		const expectedPath = `/api/v1.1/entity/notes/${noteId}/_upload`
		if (url.origin !== site.origin || url.pathname !== expectedPath || !hasUploadSignature(url)) {
			throw invalidShotGridResponse()
		}
		return url
	}

	if (
		url.port !== '' ||
		!isAmazonS3Hostname(url.hostname) ||
		url.pathname === '/' ||
		!hasUploadSignature(url)
	) {
		throw invalidShotGridResponse()
	}
	return url
}

function hasUploadSignature(url: URL) {
	return [...url.searchParams.keys()].some((key) => {
		const normalized = key.toLowerCase()
		return normalized === 'signature' || normalized === 'x-amz-signature'
	})
}

function isAmazonS3Hostname(hostname: string) {
	const suffix = '.amazonaws.com'
	if (!hostname.endsWith(suffix)) return false
	const labels = hostname.slice(0, -suffix.length).split('.')
	const s3Index = labels.findIndex((label) => label === 's3' || label.startsWith('s3-'))
	if (s3Index < 0) return false

	const s3Label = labels[s3Index]
	const tail = labels.slice(s3Index + 1)
	if (s3Label === 's3-accelerate') {
		return tail.length === 0 || (tail.length === 1 && tail[0] === 'dualstack')
	}
	if (s3Label.startsWith('s3-')) {
		return tail.length === 0 && isAwsRegion(s3Label.slice(3))
	}
	if (tail.length === 0) return true
	if (tail.length === 1) return isAwsRegion(tail[0])
	return tail.length === 2 && tail[0] === 'dualstack' && isAwsRegion(tail[1])
}

function isAwsRegion(value: string) {
	return /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(value)
}

function invalidShotGridResponse() {
	return new ReviewGatewayError({
		code: 'SHOTGRID_INVALID_RESPONSE',
		retryable: false,
		status: 502,
	})
}
