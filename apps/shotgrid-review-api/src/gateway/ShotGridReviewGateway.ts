import type { ShotGridConnectionConfig } from '../config'
import { isSafeReviewUrl } from '../contracts'
import type {
	CreateReviewNoteRequest,
	ReviewAttachmentResult,
	ReviewDecisionContext,
	ReviewDecisionHistoryEntry,
	ReviewDecisionOption,
	ReviewDecisionResult,
	ReviewEntityLink,
	ReviewMedia,
	ReviewNote,
	ReviewNoteOptions,
	ReviewPlaylist,
	ReviewProject,
	ReviewPublicationLinks,
	ReviewTaskLink,
	ReviewUser,
	ReviewVersion,
	UploadReviewAttachmentRequest,
} from '../contracts'
import { isReviewGatewayError, ReviewGatewayError } from '../errors'
import type { ShotGridClient } from '../shotgrid/ShotGridClient'
import type {
	CreateReviewPublicationNoteRequest,
	ReviewGateway,
	ReviewImageProxyPayload,
	ReviewPublicationNoteResult,
	ReviewVideoByteRange,
	ReviewVideoProxyPayload,
	UpdateReviewDecisionGatewayRequest,
} from './ReviewGateway'

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

interface ShotGridActivityStreamResponse {
	data: {
		earliest_update_id?: number
		entity_id: number
		entity_type: string
		latest_update_id?: number
		updates: unknown[]
	}
}

interface ShotGridReviewGatewayOptions {
	fetch?: FetchImplementation
	maxVideoResponseBytes?: number
	now?(): number
	videoTransferTimeoutMs?: number
}

const SEARCH_PAGE_SIZE = 500
const MAX_SEARCH_PAGES = 100
const MAX_SEARCH_ENTITIES = 10_000
const MAX_SEARCH_AGGREGATE_BYTES = 32 * 1024 * 1024
const MAX_REVIEW_IMAGE_BYTES = 32 * 1024 * 1024
const MAX_CONCURRENT_REVIEW_IMAGE_REQUESTS = 4
const MAX_REVIEW_IMAGE_DIMENSION = 8_192
const MAX_REVIEW_IMAGE_PIXELS = 16_777_216
const MAX_REVIEW_IMAGE_REDIRECTS = 3
const MAX_CONCURRENT_REVIEW_VIDEO_REQUESTS = 8
const DEFAULT_MAX_REVIEW_VIDEO_RESPONSE_BYTES = 2 * 1024 * 1024 * 1024
const MAX_REVIEW_VIDEO_REDIRECTS = 3
const DEFAULT_REVIEW_VIDEO_TRANSFER_TIMEOUT_MS = 30 * 60 * 1_000
const MAX_UPLOAD_RESPONSE_BODY_BYTES = 64 * 1024
const MAX_NOTE_RECIPIENT_OPTIONS = 500
const MAX_DECISION_ACTIVITY_UPDATES = 500
const MAX_PUBLICATION_DISPLAY_TEXT_LENGTH = 255
const MAX_PUBLICATION_CREATED_AT_SKEW_MS = 24 * 60 * 60 * 1000
const SHOTGRID_ENTITY_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const DECISION_STATUS_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const REVIEW_IMAGE_CONTENT_TYPES = new Set<ReviewImageProxyPayload['contentType']>([
	'image/jpeg',
	'image/png',
	'image/webp',
])
const REVIEW_IMAGE_ACCEPT = [...REVIEW_IMAGE_CONTENT_TYPES].join(', ')
const REVIEW_VIDEO_CONTENT_TYPE = 'video/mp4' as const
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const VERSION_FIELDS = [
	'code',
	'description',
	'project',
	'playlists',
	'sg_status_list',
	'created_at',
	'created_by',
	'user',
	'entity',
	'sg_task',
	'image',
	'sg_uploaded_movie',
	'sg_first_frame',
	'sg_last_frame',
	'frame_count',
	'frame_rate',
]

export class ShotGridReviewGateway implements ReviewGateway {
	private activeReviewImageRequests = 0
	private activeReviewVideoRequests = 0
	private readonly fetch: FetchImplementation
	private readonly maxVideoResponseBytes: number
	private readonly now: () => number
	private readonly videoTransferTimeoutMs: number

	constructor(
		private readonly client: Pick<ShotGridClient, 'request'>,
		private readonly config: ShotGridConnectionConfig,
		options: ShotGridReviewGatewayOptions = {}
	) {
		this.fetch = options.fetch ?? fetch
		this.maxVideoResponseBytes =
			options.maxVideoResponseBytes ?? DEFAULT_MAX_REVIEW_VIDEO_RESPONSE_BYTES
		this.now = options.now ?? Date.now
		this.videoTransferTimeoutMs =
			options.videoTransferTimeoutMs ?? DEFAULT_REVIEW_VIDEO_TRANSFER_TIMEOUT_MS
		if (!Number.isSafeInteger(this.maxVideoResponseBytes) || this.maxVideoResponseBytes <= 0) {
			throw new RangeError('maxVideoResponseBytes must be a positive safe integer')
		}
		if (!Number.isSafeInteger(this.videoTransferTimeoutMs) || this.videoTransferTimeoutMs <= 0) {
			throw new RangeError('videoTransferTimeoutMs must be a positive safe integer')
		}
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

	async createPublicationNote(
		playlistId: number,
		versionId: number,
		request: CreateReviewPublicationNoteRequest
	): Promise<ReviewPublicationNoteResult> {
		const version = await this.readVersionForPlaylist(playlistId, versionId)
		const links = buildPublicationLinks(version)
		const recipients = await this.requirePublicationRecipients(
			links.project.id,
			request.recipientIds
		)
		const noteLinks: ShotGridRelationship[] = [
			{ id: versionId, type: 'Version' },
			...(links.entity ? [{ id: links.entity.id, type: links.entity.type }] : []),
		]
		let note: ReviewNote
		try {
			const response = await this.client.request<ShotGridRecordResponse>('/entity/notes', {
				body: {
					addressings_to: recipients.map(({ id }) => ({ id, type: 'HumanUser' })),
					content: request.content,
					note_links: noteLinks,
					project: { id: links.project.id, type: 'Project' },
					subject: request.subject,
					tasks: links.task ? [{ id: links.task.id, type: 'Task' }] : [],
				},
				method: 'POST',
			})
			const entity = requireResponseEntity(response, 'Note')
			note = {
				content: request.content,
				createdAt: publicationCreatedAt(entity.attributes?.created_at, this.now()),
				createdBy: this.getConfiguredActor(),
				frame: null,
				id: entity.id,
				projectId: links.project.id,
				subject: request.subject,
				versionId,
			}
		} catch (error) {
			throw publicationIndeterminate(error)
		}

		return {
			links,
			note,
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
		if (users.length === 0) {
			throw new ReviewGatewayError({
				code: 'SHOTGRID_AUTH_FAILED',
				retryable: false,
				status: 502,
			})
		}
		if (
			users.length !== 1 ||
			user.type !== 'HumanUser' ||
			readString(user.attributes, 'login') !== this.config.sudoAsLogin
		) {
			throw invalidShotGridResponse()
		}
		return mapUser(user)
	}

	async getDecisionContext(
		playlistId: number,
		versionId: number,
		decisions: readonly ReviewDecisionOption[]
	): Promise<ReviewDecisionContext> {
		const version = await this.readVersionForPlaylist(playlistId, versionId)
		const project = readRelationship(version.relationships, 'project')
		if (!project || project.type !== 'Project') throw invalidShotGridResponse()
		const currentStatusCode = readDecisionStatusCode(version.attributes?.sg_status_list)
		const [, audit] = await Promise.all([
			this.validateDecisionSchema(project.id, decisions),
			this.readDecisionHistory(versionId, decisions),
		])
		return {
			currentStatusCode,
			decisions: decisions.map((decision) => ({ ...decision })),
			history: audit.history,
			historyTruncated: audit.historyTruncated,
			playlistId,
			versionId,
		}
	}

	async getNoteOptions(playlistId: number, versionId: number): Promise<ReviewNoteOptions> {
		const version = await this.readVersionForPlaylist(playlistId, versionId)
		const links = buildPublicationLinks(version)
		const users = await this.search(
			'human_users',
			[
				['projects', 'in', [{ id: links.project.id, type: 'Project' }]],
				['sg_status_list', 'is', 'act'],
			],
			['image', 'login', 'name', 'sg_status_list'],
			'name',
			MAX_NOTE_RECIPIENT_OPTIONS
		)
		if (
			users.some((user) => user.type !== 'HumanUser') ||
			new Set(users.map((user) => user.id)).size !== users.length
		) {
			throw invalidShotGridResponse()
		}
		return {
			links,
			recipients: users.map(mapUser),
		}
	}

	async getVersion(playlistId: number, versionId: number): Promise<ReviewVersion> {
		const entity = await this.readVersionForPlaylist(playlistId, versionId)
		return mapVersion(entity, playlistId, this.config.frameRateMode)
	}

	async getVersionImage(
		playlistId: number,
		versionId: number,
		signal?: AbortSignal
	): Promise<ReviewImageProxyPayload> {
		if (this.activeReviewImageRequests >= MAX_CONCURRENT_REVIEW_IMAGE_REQUESTS) {
			throw reviewImageCapacityExceeded()
		}
		this.activeReviewImageRequests++
		try {
			const entity = await this.readVersionForPlaylist(playlistId, versionId)
			const imageUrl = readVersionImageSourceUrl(entity.attributes)
			if (!imageUrl) throw reviewItemNotFound()
			return await this.fetchReviewImage(imageUrl, signal)
		} finally {
			this.activeReviewImageRequests--
		}
	}

	async getVersionVideo(
		playlistId: number,
		versionId: number,
		attachmentId: number,
		range: ReviewVideoByteRange | null,
		signal?: AbortSignal
	): Promise<ReviewVideoProxyPayload> {
		if (this.activeReviewVideoRequests >= MAX_CONCURRENT_REVIEW_VIDEO_REQUESTS) {
			throw reviewVideoCapacityExceeded()
		}
		this.activeReviewVideoRequests++
		let retained = false
		try {
			const entity = await this.readVersionForPlaylist(playlistId, versionId)
			const movie = readVersionMovie(entity.attributes)
			if (!movie || movie.attachmentId !== attachmentId) throw reviewItemNotFound()
			const payload = await this.fetchReviewVideo(movie.url, range, signal)
			retained = true
			return payload
		} finally {
			if (!retained) this.activeReviewVideoRequests--
		}
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
			VERSION_FIELDS,
			'code'
		)

		return entities.map((entity) => mapVersion(entity, playlistId, this.config.frameRateMode))
	}

	async updateVersionDecision(
		request: UpdateReviewDecisionGatewayRequest
	): Promise<ReviewDecisionResult> {
		const configuredDecision = request.decisions.find(({ key }) => key === request.decision.key)
		if (!configuredDecision || configuredDecision.statusCode !== request.decision.statusCode) {
			throw invalidDecisionRequest()
		}

		const version = await this.readVersionForPlaylist(request.playlistId, request.versionId)
		const project = readRelationship(version.relationships, 'project')
		if (!project || project.type !== 'Project') throw invalidShotGridResponse()
		const previousStatusCode = readDecisionStatusCode(version.attributes?.sg_status_list)
		if (previousStatusCode !== request.expectedStatusCode) throw decisionConflict()
		await this.validateDecisionSchema(project.id, request.decisions)

		if (previousStatusCode === request.decision.statusCode) {
			return {
				changed: false,
				decisionKey: request.decision.key,
				playlistId: request.playlistId,
				previousStatusCode,
				reviewer: null,
				statusCode: request.decision.statusCode,
				updatedAt: null,
				versionId: request.versionId,
			}
		}

		const reviewer = boundDecisionReviewer(await this.getCurrentReviewer())
		if (reviewer.kind !== 'human' || reviewer.id === null || !this.config.sudoAsLogin) {
			throw new ReviewGatewayError({
				code: 'PERMISSION_DENIED',
				retryable: false,
				status: 403,
			})
		}

		let updatedAt: string
		try {
			const response = await this.client.request<ShotGridRecordResponse>(
				`/entity/versions/${request.versionId}`,
				{
					body: { sg_status_list: request.decision.statusCode },
					method: 'PUT',
					query: { 'options[fields]': 'sg_status_list,updated_at' },
				}
			)
			const entity = requireResponseEntity(response, 'Version', request.versionId)
			if (entity.attributes?.sg_status_list !== request.decision.statusCode) {
				throw invalidShotGridResponse()
			}
			updatedAt = requireDecisionTimestamp(entity.attributes?.updated_at)
		} catch (error) {
			if (isKnownRejectedDecision(error)) throw error
			throw decisionIndeterminate(error)
		}

		return {
			changed: true,
			decisionKey: request.decision.key,
			playlistId: request.playlistId,
			previousStatusCode,
			reviewer,
			statusCode: request.decision.statusCode,
			updatedAt,
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
		let attachmentId: number | null
		try {
			const completion = await this.client.request<UploadResponse | undefined>(uploadPath, {
				body: {
					upload_data: { display_name: request.fileName, tags: [] },
					upload_info: uploadInfo,
				},
				method: 'POST',
			})
			attachmentId = readCompletedAttachmentId(completion)
		} catch (error) {
			throw publicationIndeterminate(error)
		}

		return {
			contentType: request.contentType,
			fileName: request.fileName,
			id: attachmentId,
			noteId: request.noteId,
			sizeBytes: bytes.byteLength,
		}
	}

	private async requirePublicationRecipients(projectId: number, ids: number[]) {
		if (ids.length === 0) return []
		const uniqueIds = [...new Set(ids)]
		if (uniqueIds.length !== ids.length) throw invalidPublicationRecipient()
		const users = await this.search(
			'human_users',
			[
				['id', 'in', uniqueIds],
				['projects', 'in', [{ id: projectId, type: 'Project' }]],
				['sg_status_list', 'is', 'act'],
			],
			['sg_status_list'],
			undefined,
			50
		)
		const returnedIds = new Set(users.map((user) => user.id))
		if (
			users.length !== uniqueIds.length ||
			returnedIds.size !== uniqueIds.length ||
			users.some((user) => user.type !== 'HumanUser' || !uniqueIds.includes(user.id))
		) {
			throw invalidPublicationRecipient()
		}
		return users
	}

	private async validateDecisionSchema(
		projectId: number,
		decisions: readonly ReviewDecisionOption[]
	): Promise<void> {
		const response = await this.client.request<unknown>('/schema/versions/fields/sg_status_list', {
			query: { project_id: projectId },
		})
		const envelope = readRecord(response)
		const data = readRecord(envelope?.data)
		const entityType = readRecord(data?.entity_type)
		const dataType = readRecord(data?.data_type)
		const editable = readRecord(data?.editable)
		const properties = readRecord(data?.properties)
		const validValues = readRecord(properties?.valid_values)
		const hiddenValues = readRecord(properties?.hidden_values)
		const visible = readRecord(data?.visible)
		if (
			!data ||
			entityType?.value !== 'Version' ||
			dataType?.value !== 'status_list' ||
			typeof editable?.value !== 'boolean' ||
			typeof visible?.value !== 'boolean' ||
			!Array.isArray(validValues?.value) ||
			validValues.value.length > 1_000 ||
			!validValues.value.every(isDecisionStatusCode) ||
			!hiddenValues ||
			!Array.isArray(hiddenValues.value) ||
			hiddenValues.value.length > 1_000 ||
			!hiddenValues.value.every(isDecisionStatusCode)
		) {
			throw invalidShotGridResponse()
		}
		const validStatusValues = validValues.value as string[]
		const hiddenStatusValues = hiddenValues.value as string[]
		const allowedStatusCodes = new Set(validStatusValues)
		const hiddenStatusCodes = new Set(hiddenStatusValues)
		if (
			allowedStatusCodes.size !== validStatusValues.length ||
			hiddenStatusCodes.size !== hiddenStatusValues.length ||
			hiddenStatusValues.some((statusCode) => !allowedStatusCodes.has(statusCode))
		) {
			throw invalidShotGridResponse()
		}
		if (
			editable.value !== true ||
			visible.value !== true ||
			decisions.some(
				({ statusCode }) => !allowedStatusCodes.has(statusCode) || hiddenStatusCodes.has(statusCode)
			)
		) {
			throw decisionConfigurationError()
		}
	}

	private async readDecisionHistory(
		versionId: number,
		decisions: readonly ReviewDecisionOption[]
	): Promise<{
		history: ReviewDecisionHistoryEntry[]
		historyTruncated: boolean
	}> {
		const response = await this.client.request<ShotGridActivityStreamResponse>(
			`/entity/versions/${versionId}/activity_stream`,
			{ query: { limit: MAX_DECISION_ACTIVITY_UPDATES } }
		)
		const envelope = readRecord(response)
		const data = readRecord(envelope?.data)
		if (
			!data ||
			data.entity_type !== 'Version' ||
			data.entity_id !== versionId ||
			!Array.isArray(data.updates) ||
			data.updates.length > MAX_DECISION_ACTIVITY_UPDATES
		) {
			throw invalidShotGridResponse()
		}

		const history: ReviewDecisionHistoryEntry[] = []
		const ids = new Set<number>()
		for (const rawUpdate of data.updates) {
			const update = readRecord(rawUpdate)
			if (!update) throw invalidShotGridResponse()
			const meta = readRecord(update.meta)
			if (meta?.attribute_name !== 'sg_status_list') continue
			if (
				update.update_type !== 'update' ||
				meta.type !== 'attribute_change' ||
				meta.entity_type !== 'Version' ||
				meta.entity_id !== versionId ||
				meta.field_data_type !== 'status_list' ||
				!Number.isSafeInteger(update.id) ||
				Number(update.id) <= 0 ||
				ids.has(Number(update.id))
			) {
				throw invalidShotGridResponse()
			}
			const previousStatusCode = readDecisionStatusCode(meta.old_value)
			const resultingStatusCode = readDecisionStatusCode(meta.new_value)
			const id = Number(update.id)
			ids.add(id)
			history.push({
				decidedAt: requireDecisionTimestamp(update.created_at),
				decisionKey:
					decisions.find(({ statusCode }) => statusCode === resultingStatusCode)?.key ?? null,
				id,
				previousStatusCode,
				resultingStatusCode,
				reviewer: mapActivityReviewer(update.created_by),
			})
		}
		return {
			history,
			historyTruncated: data.updates.length === MAX_DECISION_ACTIVITY_UPDATES,
		}
	}

	private async search(
		entity: string,
		filters: unknown[],
		fields: string[],
		sort?: string,
		maxEntities = MAX_SEARCH_ENTITIES
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
				if (entities.length >= maxEntities || aggregateBytes > MAX_SEARCH_AGGREGATE_BYTES) {
					throw invalidShotGridResponse()
				}
				entities.push(entity)
			}

			if (!readNextLink(response)) return entities
			if (entities.length >= maxEntities) throw invalidShotGridResponse()
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
		return requireResponseEntity(response, expectedType, id)
	}

	private async readVersionForPlaylist(playlistId: number, versionId: number) {
		await this.readEntity('playlists', playlistId, 'Playlist')
		const entity = await this.readEntity('versions', versionId, 'Version', VERSION_FIELDS)
		const belongsToPlaylist = readRelationshipList(entity.relationships, 'playlists').some(
			(playlist) => playlist.type === 'Playlist' && playlist.id === playlistId
		)
		if (!belongsToPlaylist) throw reviewItemNotFound()
		return entity
	}

	private async fetchReviewImage(
		urlValue: string,
		externalSignal?: AbortSignal
	): Promise<ReviewImageProxyPayload> {
		let url = validateReviewImageUrl(urlValue, this.config.siteUrl)
		const controller = new AbortController()
		let timedOut = false
		const handleExternalAbort = () => controller.abort()
		externalSignal?.addEventListener('abort', handleExternalAbort, { once: true })
		if (externalSignal?.aborted) controller.abort()
		const timeout = setTimeout(() => {
			timedOut = true
			controller.abort()
		}, this.config.timeoutMs)

		try {
			for (let redirectCount = 0; ; redirectCount++) {
				const response = await this.fetch(url, {
					cache: 'no-store',
					credentials: 'omit',
					headers: {
						Accept: REVIEW_IMAGE_ACCEPT,
						'Accept-Encoding': 'identity',
					},
					method: 'GET',
					redirect: 'manual',
					referrerPolicy: 'no-referrer',
					signal: controller.signal,
				})

				if (REDIRECT_STATUSES.has(response.status)) {
					await cancelResponseBody(response)
					if (redirectCount >= MAX_REVIEW_IMAGE_REDIRECTS) throw invalidShotGridResponse()
					const location = response.headers.get('location')
					if (!location) throw invalidShotGridResponse()
					url = resolveReviewImageRedirect(location, url, this.config.siteUrl)
					continue
				}

				if (response.status >= 300 && response.status < 400) {
					await cancelResponseBody(response)
					throw invalidShotGridResponse()
				}
				if (!response.ok) {
					await cancelResponseBody(response)
					throw reviewImageRequestFailed(response.status)
				}

				let contentType: ReviewImageProxyPayload['contentType']
				let declaredLength: number | null
				try {
					contentType = readReviewImageContentType(response)
					declaredLength = readReviewImageContentLength(response)
				} catch (error) {
					await cancelResponseBody(response)
					throw error
				}
				const body = await readReviewImageBody(response, declaredLength)
				validateReviewImageBytes(contentType, body)
				return { body, contentType }
			}
		} catch (error) {
			if (error instanceof ReviewGatewayError) throw error
			throw new ReviewGatewayError({
				code: timedOut ? 'SHOTGRID_TIMEOUT' : 'SHOTGRID_REQUEST_FAILED',
				retryable: false,
				status: timedOut ? 504 : 502,
			})
		} finally {
			clearTimeout(timeout)
			externalSignal?.removeEventListener('abort', handleExternalAbort)
		}
	}

	private async fetchReviewVideo(
		urlValue: string,
		range: ReviewVideoByteRange | null,
		externalSignal?: AbortSignal
	): Promise<ReviewVideoProxyPayload> {
		let url = validateReviewImageUrl(urlValue, this.config.siteUrl)
		const controller = new AbortController()
		let timedOut = false
		let handedOff = false
		let response: Response | undefined
		const handleExternalAbort = () => controller.abort()
		externalSignal?.addEventListener('abort', handleExternalAbort, { once: true })
		if (externalSignal?.aborted) controller.abort()
		const timeout = setTimeout(() => {
			timedOut = true
			controller.abort()
		}, this.config.timeoutMs)

		try {
			for (let redirectCount = 0; ; redirectCount++) {
				response = await this.fetch(url, {
					cache: 'no-store',
					credentials: 'omit',
					headers: {
						Accept: REVIEW_VIDEO_CONTENT_TYPE,
						'Accept-Encoding': 'identity',
						...(range ? { Range: formatReviewVideoRange(range) } : undefined),
					},
					method: 'GET',
					redirect: 'manual',
					referrerPolicy: 'no-referrer',
					signal: controller.signal,
				})

				if (REDIRECT_STATUSES.has(response.status)) {
					await cancelResponseBody(response)
					if (redirectCount >= MAX_REVIEW_VIDEO_REDIRECTS) throw invalidShotGridResponse()
					const location = response.headers.get('location')
					if (!location) throw invalidShotGridResponse()
					url = resolveReviewImageRedirect(location, url, this.config.siteUrl)
					continue
				}

				if (response.status >= 300 && response.status < 400) {
					await cancelResponseBody(response)
					throw invalidShotGridResponse()
				}
				if (!response.ok) {
					let rangeResourceLength: number | undefined
					try {
						rangeResourceLength =
							response.status === 416 ? readUnsatisfiedVideoRangeLength(response) : undefined
					} finally {
						await cancelResponseBody(response)
					}
					throw reviewVideoRequestFailed(response.status, rangeResourceLength)
				}

				let metadata: Omit<ReviewVideoProxyPayload, 'body' | 'dispose'>
				try {
					metadata = readReviewVideoResponseMetadata(response, range, this.maxVideoResponseBytes)
				} catch (error) {
					await cancelResponseBody(response)
					throw error
				}
				const body = response.body
				if (!body) throw invalidShotGridResponse()
				clearTimeout(timeout)
				const streamedBody = createTimedReviewVideoStream(
					body,
					controller,
					this.config.timeoutMs,
					this.videoTransferTimeoutMs
				)

				let disposed = false
				handedOff = true
				return {
					...metadata,
					body: streamedBody.body,
					dispose: async () => {
						if (disposed) return
						disposed = true
						controller.abort()
						clearTimeout(timeout)
						externalSignal?.removeEventListener('abort', handleExternalAbort)
						try {
							await streamedBody.cancel()
						} finally {
							this.activeReviewVideoRequests--
						}
					},
				}
			}
		} catch (error) {
			if (error instanceof ReviewGatewayError) throw error
			throw new ReviewGatewayError({
				code: timedOut ? 'SHOTGRID_TIMEOUT' : 'SHOTGRID_REQUEST_FAILED',
				retryable: false,
				status: timedOut ? 504 : 502,
			})
		} finally {
			if (!handedOff) {
				clearTimeout(timeout)
				externalSignal?.removeEventListener('abort', handleExternalAbort)
			}
		}
	}

	private getConfiguredActor(): ReviewUser {
		if (this.config.sudoAsLogin) {
			const login = publicationDisplayText(this.config.sudoAsLogin, 'ShotGrid reviewer')
			return {
				avatarUrl: null,
				id: null,
				kind: 'human',
				login,
				name: login,
			}
		}
		const login = publicationDisplayText(this.config.scriptName, 'shotgrid-review-service')
		return {
			avatarUrl: null,
			id: null,
			kind: 'service',
			login,
			name: publicationDisplayText(`ShotGrid script · ${login}`, 'ShotGrid service'),
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

function requireResponseEntity(value: unknown, expectedType: string, expectedId?: number) {
	const response = readRecord(value)
	const entity = requireEntity(response?.data, expectedType)
	if (expectedId !== undefined && entity.id !== expectedId) throw invalidShotGridResponse()
	return entity
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

function boundDecisionReviewer(user: ReviewUser): ReviewUser {
	return {
		avatarUrl: user.avatarUrl,
		id: user.id,
		kind: user.kind,
		login:
			user.login === null
				? null
				: decisionDisplayText(user.login, 'User ' + (user.id ?? 'unknown')),
		name: decisionDisplayText(user.name, 'User ' + (user.id ?? 'unknown')),
	}
}

function mapActivityReviewer(value: unknown): ReviewUser | null {
	if (value === undefined || value === null) return null
	const record = readRecord(value)
	if (
		!record ||
		!Number.isSafeInteger(record.id) ||
		Number(record.id) <= 0 ||
		typeof record.type !== 'string' ||
		(record.type !== 'HumanUser' && record.type !== 'ApiUser')
	) {
		return null
	}
	const id = Number(record.id)
	const avatarUrl =
		record.image === undefined || record.image === null
			? null
			: isSafeReviewUrl(record.image)
				? record.image
				: null
	return {
		avatarUrl,
		id,
		kind: record.type === 'HumanUser' ? 'human' : 'service',
		login: null,
		name: decisionDisplayText(record.name, record.type + ' ' + id),
	}
}

function mapVersion(
	entity: ShotGridEntity,
	playlistId: number,
	frameRateMode: ShotGridConnectionConfig['frameRateMode']
): ReviewVersion {
	const project = readRelationship(entity.relationships, 'project')
	const createdBy = readRelationship(entity.relationships, 'created_by')
	const submittedBy = readRelationship(entity.relationships, 'user')
	if (!project || project.type !== 'Project') throw invalidShotGridResponse()
	return {
		createdAt: readString(entity.attributes, 'created_at'),
		createdBy: createdBy ? mapRelationshipUser(createdBy) : null,
		description: readNullableString(entity.attributes, 'description'),
		entity: mapVersionEntity(readRelationship(entity.relationships, 'entity')),
		id: entity.id,
		media: mapVersionMedia(entity.attributes, playlistId, entity.id, frameRateMode),
		name: readString(entity.attributes, 'code') || `Version ${entity.id}`,
		playlistId,
		projectId: project.id,
		statusCode: readNullableString(entity.attributes, 'sg_status_list'),
		submittedBy: submittedBy ? mapRelationshipUser(submittedBy) : null,
		task: mapVersionTask(readRelationship(entity.relationships, 'sg_task')),
	}
}

function readCompletedAttachmentId(value: unknown) {
	if (value === undefined) return null
	const response = readRecord(value)
	if (!response) throw invalidShotGridResponse()
	if (!Object.prototype.hasOwnProperty.call(response, 'data')) return null
	const data = readRecord(response.data)
	if (!data) throw invalidShotGridResponse()
	if (!Object.prototype.hasOwnProperty.call(data, 'id')) return null
	if (!Number.isSafeInteger(data.id) || Number(data.id) <= 0) throw invalidShotGridResponse()
	return Number(data.id)
}

function buildPublicationLinks(entity: ShotGridEntity): ReviewPublicationLinks {
	const project = readRelationship(entity.relationships, 'project')
	if (!project || project.type !== 'Project') throw invalidShotGridResponse()
	return {
		entity: mapVersionEntity(readRelationship(entity.relationships, 'entity')),
		project: {
			id: project.id,
			name: publicationDisplayText(project.name, `Project ${project.id}`),
			type: 'Project',
		},
		task: mapVersionTask(readRelationship(entity.relationships, 'sg_task')),
		version: {
			id: entity.id,
			name: publicationDisplayText(entity.attributes?.code, `Version ${entity.id}`),
			type: 'Version',
		},
	}
}

function mapVersionEntity(relationship: ShotGridRelationship | null): ReviewEntityLink | null {
	if (!relationship) return null
	if (!SHOTGRID_ENTITY_TYPE_PATTERN.test(relationship.type)) throw invalidShotGridResponse()
	return {
		id: relationship.id,
		name: publicationDisplayText(relationship.name, `${relationship.type} ${relationship.id}`),
		type: relationship.type,
	}
}

function mapVersionTask(relationship: ShotGridRelationship | null): ReviewTaskLink | null {
	if (!relationship) return null
	if (relationship.type !== 'Task') throw invalidShotGridResponse()
	return {
		id: relationship.id,
		name: publicationDisplayText(relationship.name, `Task ${relationship.id}`),
	}
}

function publicationDisplayText(value: unknown, fallback: string) {
	if (typeof value !== 'string') return fallback
	const normalized = value.trim()
	return normalized.length > 0 &&
		normalized.length <= MAX_PUBLICATION_DISPLAY_TEXT_LENGTH &&
		!/[\p{Bidi_Control}\p{Cc}]/u.test(normalized)
		? normalized
		: fallback
}

function decisionDisplayText(value: unknown, fallback: string) {
	if (typeof value !== 'string') return fallback
	const normalized = value.trim()
	return normalized.length > 0 &&
		normalized.length <= MAX_PUBLICATION_DISPLAY_TEXT_LENGTH &&
		!/[\p{Bidi_Control}\p{Cc}]/u.test(normalized)
		? normalized
		: fallback
}

function isDecisionStatusCode(value: unknown): value is string {
	return typeof value === 'string' && DECISION_STATUS_CODE_PATTERN.test(value)
}

function readDecisionStatusCode(value: unknown): string | null {
	if (value === null) return null
	if (!isDecisionStatusCode(value)) throw invalidShotGridResponse()
	return value
}

function requireDecisionTimestamp(value: unknown) {
	const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
	if (
		typeof value !== 'string' ||
		value.length === 0 ||
		value.length > 32 ||
		!Number.isFinite(parsed)
	) {
		throw invalidShotGridResponse()
	}
	return new Date(parsed).toISOString()
}

function publicationCreatedAt(value: unknown, nowMs: number) {
	const fallback = new Date(nowMs).toISOString()
	if (typeof value !== 'string' || value.length > 32) return fallback
	const parsed = Date.parse(value)
	if (!Number.isFinite(parsed) || Math.abs(parsed - nowMs) > MAX_PUBLICATION_CREATED_AT_SKEW_MS) {
		return fallback
	}
	return new Date(parsed).toISOString()
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

function mapVersionMedia(
	attributes: Record<string, unknown> | undefined,
	playlistId: number,
	versionId: number,
	frameRateMode: ShotGridConnectionConfig['frameRateMode']
): ReviewMedia | null {
	const movie = readSupportedVersionMovie(attributes)
	const thumbnailUrl = readNullableUrl(attributes, 'image')
	if (movie) {
		const firstFrame = readOptionalNonNegativeInteger(attributes, 'sg_first_frame')
		const lastFrame = readOptionalNonNegativeInteger(attributes, 'sg_last_frame')
		if (firstFrame !== null && lastFrame !== null && lastFrame < firstFrame) {
			throw invalidShotGridResponse()
		}
		return {
			attachmentId: movie.attachmentId,
			contentType: REVIEW_VIDEO_CONTENT_TYPE,
			durationSeconds: null,
			fileName: movie.fileName,
			firstFrame,
			frameCount: readOptionalPositiveInteger(attributes, 'frame_count'),
			frameRate: readOptionalPositiveNumber(attributes, 'frame_rate'),
			frameRateMode,
			height: null,
			kind: 'video',
			lastFrame,
			thumbnailUrl: thumbnailUrl ? buildReviewImageProxyUrl(playlistId, versionId) : null,
			url: buildReviewVideoProxyUrl(playlistId, versionId, movie.attachmentId),
			width: null,
		}
	}
	if (!thumbnailUrl) return null
	const proxyUrl = buildReviewImageProxyUrl(playlistId, versionId)
	return {
		contentType: 'image/jpeg',
		height: null,
		kind: 'image',
		thumbnailUrl: proxyUrl,
		url: proxyUrl,
		width: null,
	}
}

function buildReviewImageProxyUrl(playlistId: number, versionId: number) {
	return `/review/playlists/${playlistId}/versions/${versionId}/media/image`
}

function buildReviewVideoProxyUrl(playlistId: number, versionId: number, attachmentId: number) {
	return `/review/playlists/${playlistId}/versions/${versionId}/media/video/${attachmentId}`
}

function readVersionImageSourceUrl(attributes: Record<string, unknown> | undefined) {
	return readNullableUrl(attributes, 'image')
}

function readVersionMovie(attributes: Record<string, unknown> | undefined) {
	const value = attributes?.sg_uploaded_movie
	if (value === undefined || value === null) return null
	const movie = readRecord(value)
	const attachmentId = movie?.id
	const fileName = movie?.name
	const url = readUrlValue(movie?.url)
	if (
		!movie ||
		!Number.isSafeInteger(attachmentId) ||
		Number(attachmentId) <= 0 ||
		movie.type !== 'Attachment' ||
		movie.content_type !== REVIEW_VIDEO_CONTENT_TYPE ||
		!isMp4Basename(fileName) ||
		!url
	) {
		throw invalidShotGridResponse()
	}
	return { attachmentId: Number(attachmentId), fileName, url }
}

function readSupportedVersionMovie(attributes: Record<string, unknown> | undefined) {
	const value = attributes?.sg_uploaded_movie
	if (value === undefined || value === null) return null
	const movie = readRecord(value)
	if (
		!movie ||
		!Number.isSafeInteger(movie.id) ||
		Number(movie.id) <= 0 ||
		movie.type !== 'Attachment' ||
		!isSafeMediaBasename(movie.name)
	) {
		throw invalidShotGridResponse()
	}
	if (movie.content_type !== REVIEW_VIDEO_CONTENT_TYPE || !isMp4Basename(movie.name)) return null
	const url = readUrlValue(movie.url)
	if (!url) return null
	return { attachmentId: Number(movie.id), fileName: movie.name, url }
}

function readString(source: Record<string, unknown> | undefined, key: string) {
	const value = source?.[key]
	return typeof value === 'string' ? value : ''
}

function readNullableString(source: Record<string, unknown> | undefined, key: string) {
	return readString(source, key) || null
}

function readOptionalPositiveNumber(source: Record<string, unknown> | undefined, key: string) {
	const value = source?.[key]
	if (value === undefined || value === null) return null
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
		throw invalidShotGridResponse()
	}
	return value
}

function readOptionalPositiveInteger(source: Record<string, unknown> | undefined, key: string) {
	const value = source?.[key]
	if (value === undefined || value === null) return null
	if (!Number.isSafeInteger(value) || Number(value) <= 0) throw invalidShotGridResponse()
	return Number(value)
}

function readOptionalNonNegativeInteger(source: Record<string, unknown> | undefined, key: string) {
	const value = source?.[key]
	if (value === undefined || value === null) return null
	if (!Number.isSafeInteger(value) || Number(value) < 0) throw invalidShotGridResponse()
	return Number(value)
}

function readRecord(value: unknown) {
	return value && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined
}

function readUrlValue(value: unknown) {
	if (!isSafeReviewUrl(value)) return null
	return value.startsWith('/') ? value : new URL(value).toString()
}

function readNullableUrl(source: Record<string, unknown> | undefined, key: string) {
	const value = source?.[key]
	if (typeof value === 'string') return readUrlValue(value)
	const record = readRecord(value)
	return readUrlValue(record?.url)
}

function isMp4Basename(value: unknown): value is string {
	return isSafeMediaBasename(value) && value.toLowerCase().endsWith('.mp4')
}

function isSafeMediaBasename(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= MAX_PUBLICATION_DISPLAY_TEXT_LENGTH &&
		value.trim() === value &&
		value !== '.' &&
		value !== '..' &&
		value === value.replaceAll('\\', '/').split('/').at(-1) &&
		!/[\p{Bidi_Control}\p{Cc}]/u.test(value)
	)
}

function readRelationship(
	relationships: Record<string, unknown> | undefined,
	key: string
): ShotGridRelationship | null {
	const raw = relationships?.[key]
	const record = readRecord(raw)
	return readRelationshipValue(record?.data ?? record)
}

function readRelationshipValue(raw: unknown): ShotGridRelationship | null {
	const value = readRecord(raw)
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
	return value
		.map((item) => readRelationshipValue(item))
		.filter((item): item is ShotGridRelationship => item !== null)
}

function validateReviewImageUrl(value: string, siteUrl: string) {
	let url: URL
	try {
		url = new URL(value, siteUrl)
	} catch {
		throw invalidShotGridResponse()
	}

	const site = new URL(siteUrl)
	if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '') {
		throw invalidShotGridResponse()
	}
	if (url.origin === site.origin) return url
	if (url.port === '' && url.pathname !== '/' && isAmazonS3Hostname(url.hostname)) return url
	throw invalidShotGridResponse()
}

function resolveReviewImageRedirect(location: string, currentUrl: URL, siteUrl: string) {
	try {
		return validateReviewImageUrl(new URL(location, currentUrl).toString(), siteUrl)
	} catch {
		throw invalidShotGridResponse()
	}
}

function readReviewImageContentType(response: Response): ReviewImageProxyPayload['contentType'] {
	const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
	if (
		!contentType ||
		!REVIEW_IMAGE_CONTENT_TYPES.has(contentType as ReviewImageProxyPayload['contentType'])
	) {
		throw invalidShotGridResponse()
	}
	return contentType as ReviewImageProxyPayload['contentType']
}

function readReviewImageContentLength(response: Response) {
	const value = response.headers.get('content-length')
	if (value === null) return null
	if (!/^(?:0|[1-9]\d*)$/.test(value)) throw invalidShotGridResponse()
	const length = Number(value)
	if (!Number.isSafeInteger(length) || length > MAX_REVIEW_IMAGE_BYTES) {
		throw invalidShotGridResponse()
	}
	return length
}

async function readReviewImageBody(response: Response, declaredLength: number | null) {
	if (!response.body) throw invalidShotGridResponse()

	const reader = response.body.getReader()
	const chunks: Buffer[] = []
	let byteLength = 0
	try {
		for (;;) {
			const { done, value } = await reader.read()
			if (done) break
			byteLength += value.byteLength
			if (byteLength > MAX_REVIEW_IMAGE_BYTES) {
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

	if (declaredLength !== null && declaredLength !== byteLength) throw invalidShotGridResponse()
	return Buffer.concat(chunks, byteLength)
}

async function cancelResponseBody(response: Response) {
	try {
		await response.body?.cancel()
	} catch {
		// The response is already being rejected; cancellation is best-effort cleanup.
	}
}

function createTimedReviewVideoStream(
	upstream: ReadableStream<Uint8Array>,
	controller: AbortController,
	timeoutMs: number,
	transferTimeoutMs: number
) {
	const reader = upstream.getReader()
	let released = false
	let timeout: ReturnType<typeof setTimeout> | undefined
	let transferTimedOut = false
	const transferTimeout = setTimeout(() => {
		transferTimedOut = true
		controller.abort()
	}, transferTimeoutMs)
	transferTimeout.unref?.()
	const release = () => {
		if (released) return
		released = true
		if (timeout !== undefined) clearTimeout(timeout)
		clearTimeout(transferTimeout)
		reader.releaseLock()
	}
	const cancel = async (reason?: unknown) => {
		if (released) return
		controller.abort()
		if (timeout !== undefined) clearTimeout(timeout)
		try {
			await reader.cancel(reason)
		} catch {
			// Cancellation is best-effort; the owning request is already closing.
		} finally {
			release()
		}
	}
	const body = new ReadableStream<Uint8Array>(
		{
			async cancel(reason) {
				await cancel(reason)
			},
			async pull(streamController) {
				if (transferTimedOut) {
					release()
					streamController.error(reviewVideoTimeoutError())
					return
				}
				let timedOut = false
				timeout = setTimeout(() => {
					timedOut = true
					controller.abort()
				}, timeoutMs)
				try {
					const result = await reader.read()
					clearTimeout(timeout)
					timeout = undefined
					if (result.done) {
						release()
						streamController.close()
						return
					}
					streamController.enqueue(result.value)
				} catch (error) {
					release()
					streamController.error(timedOut || transferTimedOut ? reviewVideoTimeoutError() : error)
				}
			},
		},
		{ highWaterMark: 0 }
	)
	return { body, cancel }
}

function reviewVideoTimeoutError() {
	return new ReviewGatewayError({
		code: 'SHOTGRID_TIMEOUT',
		retryable: false,
		status: 504,
	})
}

function formatReviewVideoRange(range: ReviewVideoByteRange) {
	if (range.kind === 'closed') {
		if (
			!Number.isSafeInteger(range.start) ||
			range.start < 0 ||
			!Number.isSafeInteger(range.end) ||
			range.end < range.start
		) {
			throw invalidReviewVideoRange()
		}
		return `bytes=${range.start}-${range.end}`
	}
	if (range.kind === 'open') {
		if (!Number.isSafeInteger(range.start) || range.start < 0) throw invalidReviewVideoRange()
		return `bytes=${range.start}-`
	}
	if (!Number.isSafeInteger(range.length) || range.length <= 0) throw invalidReviewVideoRange()
	return `bytes=-${range.length}`
}

function readReviewVideoResponseMetadata(
	response: Response,
	range: ReviewVideoByteRange | null,
	maxResponseBytes: number
): Omit<ReviewVideoProxyPayload, 'body' | 'dispose'> {
	if (response.status !== (range ? 206 : 200)) throw invalidShotGridResponse()
	const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
	if (contentType !== REVIEW_VIDEO_CONTENT_TYPE) throw invalidShotGridResponse()
	if (response.headers.get('accept-ranges')?.trim().toLowerCase() !== 'bytes') {
		throw invalidShotGridResponse()
	}
	const contentEncoding = response.headers.get('content-encoding')
	if (contentEncoding !== null && contentEncoding.trim().toLowerCase() !== 'identity') {
		throw invalidShotGridResponse()
	}
	const contentLength = readRequiredReviewVideoIntegerHeader(response, 'content-length')
	if (contentLength <= 0 || contentLength > maxResponseBytes) throw invalidShotGridResponse()

	const contentRange = response.headers.get('content-range')
	if (!range) {
		if (contentRange !== null) throw invalidShotGridResponse()
		return {
			contentLength,
			contentRange: null,
			contentType: REVIEW_VIDEO_CONTENT_TYPE,
			status: 200,
		}
	}

	if (!contentRange) throw invalidShotGridResponse()
	const match = /^bytes (0|[1-9]\d*)-(0|[1-9]\d*)\/(0|[1-9]\d*)$/.exec(contentRange)
	if (!match) throw invalidShotGridResponse()
	const start = Number(match[1])
	const end = Number(match[2])
	const total = Number(match[3])
	if (
		!Number.isSafeInteger(start) ||
		!Number.isSafeInteger(end) ||
		!Number.isSafeInteger(total) ||
		total <= 0 ||
		start > end ||
		end >= total ||
		contentLength !== end - start + 1 ||
		!matchesReviewVideoRange(range, start, end, total)
	) {
		throw invalidShotGridResponse()
	}
	return {
		contentLength,
		contentRange,
		contentType: REVIEW_VIDEO_CONTENT_TYPE,
		status: 206,
	}
}

function readRequiredReviewVideoIntegerHeader(response: Response, name: string) {
	const value = response.headers.get(name)
	if (!value || !/^(?:0|[1-9]\d*)$/.test(value)) throw invalidShotGridResponse()
	const number = Number(value)
	if (!Number.isSafeInteger(number)) throw invalidShotGridResponse()
	return number
}

function readUnsatisfiedVideoRangeLength(response: Response) {
	const value = response.headers.get('content-range')
	const match = value ? /^bytes \*\/(0|[1-9]\d*)$/.exec(value) : null
	if (!match) throw invalidShotGridResponse()
	const total = Number(match[1])
	if (!Number.isSafeInteger(total) || total <= 0) throw invalidShotGridResponse()
	return total
}

function matchesReviewVideoRange(
	range: ReviewVideoByteRange,
	start: number,
	end: number,
	total: number
) {
	if (range.kind === 'closed') {
		return range.start < total && start === range.start && end === Math.min(range.end, total - 1)
	}
	if (range.kind === 'open') {
		return range.start < total && start === range.start && end === total - 1
	}
	return start === Math.max(total - range.length, 0) && end === total - 1
}

function validateReviewImageBytes(
	contentType: ReviewImageProxyPayload['contentType'],
	body: Uint8Array
) {
	const bytes = Buffer.from(body.buffer, body.byteOffset, body.byteLength)
	const dimensions =
		contentType === 'image/jpeg'
			? readJpegDimensions(bytes)
			: contentType === 'image/png'
				? readStaticPngDimensions(bytes)
				: readStaticWebpDimensions(bytes)
	if (
		!dimensions ||
		dimensions.width <= 0 ||
		dimensions.height <= 0 ||
		dimensions.width > MAX_REVIEW_IMAGE_DIMENSION ||
		dimensions.height > MAX_REVIEW_IMAGE_DIMENSION ||
		dimensions.width * dimensions.height > MAX_REVIEW_IMAGE_PIXELS
	) {
		throw invalidShotGridResponse()
	}
}

function readJpegDimensions(bytes: Buffer) {
	if (
		bytes.length < 12 ||
		bytes[0] !== 0xff ||
		bytes[1] !== 0xd8 ||
		bytes[bytes.length - 2] !== 0xff ||
		bytes[bytes.length - 1] !== 0xd9
	) {
		return null
	}

	let offset = 2
	while (offset < bytes.length - 2) {
		if (bytes[offset] !== 0xff) return null
		while (offset < bytes.length && bytes[offset] === 0xff) offset++
		const marker = bytes[offset++]
		if (marker === undefined || marker === 0x00) return null
		if (marker === 0xd9 || marker === 0xda) break
		if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
		if (offset + 2 > bytes.length) return null
		const segmentLength = bytes.readUInt16BE(offset)
		if (segmentLength < 2 || offset + segmentLength > bytes.length) return null
		if (isJpegStartOfFrame(marker)) {
			if (segmentLength < 7) return null
			return {
				height: bytes.readUInt16BE(offset + 3),
				width: bytes.readUInt16BE(offset + 5),
			}
		}
		offset += segmentLength
	}
	return null
}

function isJpegStartOfFrame(marker: number) {
	return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc
}

function readStaticPngDimensions(bytes: Buffer) {
	const signature = Buffer.from('89504e470d0a1a0a', 'hex')
	if (bytes.length < 8 || !bytes.subarray(0, 8).equals(signature)) return null

	let offset = 8
	let sawHeader = false
	let sawImageData = false
	let dimensions: { height: number; width: number } | null = null
	while (offset + 12 <= bytes.length) {
		const dataLength = bytes.readUInt32BE(offset)
		const chunkEnd = offset + 12 + dataLength
		if (chunkEnd > bytes.length) return null
		const chunkType = bytes.toString('ascii', offset + 4, offset + 8)
		if (!sawHeader) {
			if (chunkType !== 'IHDR' || dataLength !== 13) return null
			sawHeader = true
			dimensions = {
				height: bytes.readUInt32BE(offset + 12),
				width: bytes.readUInt32BE(offset + 8),
			}
		}
		if (chunkType === 'acTL' || chunkType === 'fcTL' || chunkType === 'fdAT') return null
		if (chunkType === 'IDAT') sawImageData = true
		if (chunkType === 'IEND') {
			return dataLength === 0 && sawHeader && sawImageData && chunkEnd === bytes.length
				? dimensions
				: null
		}
		offset = chunkEnd
	}
	return null
}

function readStaticWebpDimensions(bytes: Buffer) {
	if (
		bytes.length < 20 ||
		bytes.toString('ascii', 0, 4) !== 'RIFF' ||
		bytes.toString('ascii', 8, 12) !== 'WEBP' ||
		bytes.readUInt32LE(4) + 8 !== bytes.length
	) {
		return null
	}

	let offset = 12
	let sawImageData = false
	let dimensions: { height: number; width: number } | null = null
	while (offset + 8 <= bytes.length) {
		const chunkType = bytes.toString('ascii', offset, offset + 4)
		const dataLength = bytes.readUInt32LE(offset + 4)
		const dataStart = offset + 8
		const chunkEnd = dataStart + dataLength
		if (chunkEnd > bytes.length) return null
		if (chunkType === 'ANIM' || chunkType === 'ANMF') return null
		if (chunkType === 'VP8X') {
			if (dataLength < 10 || (bytes[dataStart] & 0x02) !== 0) return null
			dimensions = {
				height: readUInt24LE(bytes, dataStart + 7) + 1,
				width: readUInt24LE(bytes, dataStart + 4) + 1,
			}
		}
		if (chunkType === 'VP8 ') {
			sawImageData = true
			if (!dimensions) dimensions = readLossyWebpDimensions(bytes, dataStart, dataLength)
		}
		if (chunkType === 'VP8L') {
			sawImageData = true
			if (!dimensions) dimensions = readLosslessWebpDimensions(bytes, dataStart, dataLength)
		}
		offset = chunkEnd + (dataLength % 2)
	}
	return sawImageData && offset === bytes.length ? dimensions : null
}

function readLossyWebpDimensions(bytes: Buffer, dataStart: number, dataLength: number) {
	if (
		dataLength < 10 ||
		bytes[dataStart + 3] !== 0x9d ||
		bytes[dataStart + 4] !== 0x01 ||
		bytes[dataStart + 5] !== 0x2a
	) {
		return null
	}
	return {
		height: bytes.readUInt16LE(dataStart + 8) & 0x3fff,
		width: bytes.readUInt16LE(dataStart + 6) & 0x3fff,
	}
}

function readLosslessWebpDimensions(bytes: Buffer, dataStart: number, dataLength: number) {
	if (dataLength < 5 || bytes[dataStart] !== 0x2f) return null
	const bits = bytes.readUInt32LE(dataStart + 1)
	return {
		height: ((bits >>> 14) & 0x3fff) + 1,
		width: (bits & 0x3fff) + 1,
	}
}

function readUInt24LE(bytes: Buffer, offset: number) {
	return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16)
}

function reviewImageRequestFailed(upstreamStatus: number) {
	const permissionDenied = upstreamStatus === 401 || upstreamStatus === 403
	return new ReviewGatewayError({
		code: permissionDenied ? 'SHOTGRID_PERMISSION_DENIED' : 'SHOTGRID_REQUEST_FAILED',
		retryable: upstreamStatus === 429 || upstreamStatus >= 500,
		status: permissionDenied ? 403 : 502,
		upstreamStatus,
	})
}

function reviewImageCapacityExceeded() {
	return new ReviewGatewayError({
		code: 'SHOTGRID_RATE_LIMITED',
		retryable: true,
		status: 429,
	})
}

function reviewVideoRequestFailed(upstreamStatus: number, rangeResourceLength?: number) {
	if (upstreamStatus === 416) return invalidReviewVideoRange(upstreamStatus, rangeResourceLength)
	return reviewImageRequestFailed(upstreamStatus)
}

function reviewVideoCapacityExceeded() {
	return new ReviewGatewayError({
		code: 'SHOTGRID_RATE_LIMITED',
		retryable: true,
		status: 429,
	})
}

function invalidReviewVideoRange(upstreamStatus?: number, rangeResourceLength?: number) {
	return new ReviewGatewayError({
		code: 'INVALID_REQUEST',
		message: 'The requested video byte range is invalid or unavailable.',
		retryable: false,
		status: 416,
		...(rangeResourceLength === undefined ? undefined : { rangeResourceLength }),
		...(upstreamStatus === undefined ? undefined : { upstreamStatus }),
	})
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

function invalidDecisionRequest() {
	return new ReviewGatewayError({
		code: 'INVALID_REQUEST',
		retryable: false,
		status: 400,
	})
}

function decisionConflict() {
	return new ReviewGatewayError({
		code: 'DECISION_CONFLICT',
		retryable: false,
		status: 409,
	})
}

function decisionConfigurationError() {
	return new ReviewGatewayError({
		code: 'CONFIGURATION_ERROR',
		retryable: false,
		status: 500,
	})
}

function isKnownRejectedDecision(error: unknown) {
	if (!isReviewGatewayError(error)) return false
	if (
		error.code === 'AUTHENTICATION_REQUIRED' ||
		error.code === 'PERMISSION_DENIED' ||
		error.code === 'NOT_FOUND' ||
		error.code === 'SHOTGRID_AUTH_FAILED' ||
		error.code === 'SHOTGRID_PERMISSION_DENIED' ||
		error.code === 'SHOTGRID_RATE_LIMITED'
	) {
		return true
	}
	return (
		error.code === 'SHOTGRID_REQUEST_FAILED' &&
		error.upstreamStatus !== undefined &&
		error.upstreamStatus >= 400 &&
		error.upstreamStatus < 500
	)
}

function decisionIndeterminate(cause: unknown) {
	return new ReviewGatewayError({
		cause,
		code: 'DECISION_INDETERMINATE',
		retryable: false,
		status: 502,
	})
}

function reviewItemNotFound() {
	return new ReviewGatewayError({
		code: 'NOT_FOUND',
		retryable: false,
		status: 404,
	})
}

function invalidPublicationRecipient() {
	return new ReviewGatewayError({
		code: 'INVALID_REQUEST',
		message: 'A selected recipient is unavailable',
		retryable: false,
		status: 400,
	})
}

function publicationIndeterminate(cause: unknown) {
	return new ReviewGatewayError({
		cause,
		code: 'PUBLICATION_INDETERMINATE',
		retryable: false,
		status: 502,
	})
}
