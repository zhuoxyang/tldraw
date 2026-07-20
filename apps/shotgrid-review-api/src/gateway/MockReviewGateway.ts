import type {
	CreateReviewNoteRequest,
	ReviewAttachmentResult,
	ReviewDecisionContext,
	ReviewDecisionHistoryEntry,
	ReviewDecisionOption,
	ReviewDecisionResult,
	ReviewNote,
	ReviewNoteOptions,
	ReviewPlaylist,
	ReviewProject,
	ReviewPublicationLinks,
	ReviewUser,
	ReviewVersion,
	UploadReviewAttachmentRequest,
} from '../contracts'
import { ReviewGatewayError } from '../errors'
import type {
	CreateReviewPublicationNoteRequest,
	ReviewGateway,
	ReviewImageProxyPayload,
	ReviewPublicationNoteResult,
	UpdateReviewDecisionGatewayRequest,
} from './ReviewGateway'

const reviewer: ReviewUser = {
	avatarUrl: null,
	id: 7,
	kind: 'human',
	login: 'local.reviewer',
	name: 'Local Reviewer',
}

const DEFAULT_RETAINED_NOTE_ID_LIMIT = 10_000

const recipients: ReviewUser[] = [
	reviewer,
	{ avatarUrl: null, id: 11, kind: 'human', login: 'mchen', name: 'Mei Chen' },
	{ avatarUrl: null, id: 12, kind: 'human', login: 'akim', name: 'Alex Kim' },
	{ avatarUrl: null, id: 13, kind: 'human', login: 'srivera', name: 'Sam Rivera' },
	{ avatarUrl: null, id: 14, kind: 'human', login: 'jlee', name: 'Jordan Lee' },
]

const recipientProjectIds = new Map<number, readonly number[]>([
	[101, [7, 11, 12, 13]],
	[102, [7, 14]],
])

const projects: ReviewProject[] = [
	{ id: 101, name: 'Project Northstar', statusCode: 'act', thumbnailUrl: null },
	{ id: 102, name: 'Project Sundial', statusCode: 'act', thumbnailUrl: null },
]

const playlists: ReviewPlaylist[] = [
	{
		description: 'Daily lighting review',
		id: 201,
		name: 'Lighting dailies',
		projectId: 101,
		updatedAt: '2026-07-20T02:30:00.000Z',
		versionCount: 2,
	},
	{
		description: null,
		id: 202,
		name: 'Animation review',
		projectId: 101,
		updatedAt: '2026-07-19T09:15:00.000Z',
		versionCount: 1,
	},
	{
		description: 'Final environment review',
		id: 203,
		name: 'Environment final',
		projectId: 102,
		updatedAt: '2026-07-18T05:40:00.000Z',
		versionCount: 1,
	},
]

const initialVersions: ReviewVersion[] = [
	{
		createdAt: '2026-07-20T02:15:00.000Z',
		createdBy: { avatarUrl: null, id: 11, kind: 'human', login: 'mchen', name: 'Mei Chen' },
		submittedBy: { avatarUrl: null, id: 11, kind: 'human', login: 'mchen', name: 'Mei Chen' },
		description: 'Lighting polish pass',
		entity: { id: 501, name: 'shot_010', type: 'Shot' },
		id: 301,
		media: {
			contentType: 'image/png',
			height: 1080,
			kind: 'image',
			thumbnailUrl: '/mock-media/northstar-lighting.png',
			url: '/mock-media/northstar-lighting.png',
			width: 1920,
		},
		name: 'shot_010_lgt_v014',
		playlistId: 201,
		projectId: 101,
		statusCode: 'rev',
		task: { id: 601, name: 'Lighting' },
	},
	{
		createdAt: '2026-07-20T01:35:00.000Z',
		createdBy: { avatarUrl: null, id: 12, kind: 'human', login: 'akim', name: 'Alex Kim' },
		submittedBy: { avatarUrl: null, id: 12, kind: 'human', login: 'akim', name: 'Alex Kim' },
		description: null,
		entity: { id: 502, name: 'shot_020', type: 'Shot' },
		id: 302,
		media: {
			contentType: 'image/png',
			height: 1080,
			kind: 'image',
			thumbnailUrl: '/mock-media/shot-comp.png',
			url: '/mock-media/shot-comp.png',
			width: 1920,
		},
		name: 'shot_020_comp_v008',
		playlistId: 201,
		projectId: 101,
		statusCode: 'chg',
		task: { id: 602, name: 'Compositing' },
	},
	{
		createdAt: '2026-07-19T08:45:00.000Z',
		createdBy: { avatarUrl: null, id: 13, kind: 'human', login: 'srivera', name: 'Sam Rivera' },
		submittedBy: { avatarUrl: null, id: 13, kind: 'human', login: 'srivera', name: 'Sam Rivera' },
		description: 'Drone animation final',
		entity: { id: 503, name: 'Drone', type: 'Asset' },
		id: 303,
		media: {
			contentType: 'image/png',
			height: 1080,
			kind: 'image',
			thumbnailUrl: '/mock-media/drone-animation.png',
			url: '/mock-media/drone-animation.png',
			width: 1920,
		},
		name: 'asset_drone_anim_v021',
		playlistId: 202,
		projectId: 101,
		statusCode: 'apr',
		task: { id: 603, name: 'Animation' },
	},
	{
		createdAt: '2026-07-18T05:10:00.000Z',
		createdBy: { avatarUrl: null, id: 14, kind: 'human', login: 'jlee', name: 'Jordan Lee' },
		submittedBy: { avatarUrl: null, id: 14, kind: 'human', login: 'jlee', name: 'Jordan Lee' },
		description: null,
		entity: { id: 504, name: 'Market Environment', type: 'Asset' },
		id: 304,
		media: {
			contentType: 'image/png',
			height: 1080,
			kind: 'image',
			thumbnailUrl: '/mock-media/market-environment.png',
			url: '/mock-media/market-environment.png',
			width: 1920,
		},
		name: 'env_market_v005',
		playlistId: 203,
		projectId: 102,
		statusCode: 'rev',
		task: { id: 604, name: 'Surfacing' },
	},
]

export class MockReviewGateway implements ReviewGateway {
	private nextAttachmentId = 501
	private nextDecisionHistoryId = 701
	private nextNoteId = 401
	private readonly decisionHistory = new Map<number, ReviewDecisionHistoryEntry[]>()
	private readonly retainedNoteIds = new Set<number>()
	private readonly versions = initialVersions.map((version) => ({ ...version }))

	constructor(private readonly retainedNoteIdLimit = DEFAULT_RETAINED_NOTE_ID_LIMIT) {
		if (!Number.isSafeInteger(retainedNoteIdLimit) || retainedNoteIdLimit <= 0) {
			throw new RangeError('retainedNoteIdLimit must be a positive integer')
		}
	}

	async createNote(request: CreateReviewNoteRequest): Promise<ReviewNote> {
		const version = this.requireVersion(request.versionId)
		if (version.projectId !== request.projectId) {
			throw new ReviewGatewayError({
				code: 'INVALID_REQUEST',
				retryable: false,
				status: 400,
			})
		}

		const note: ReviewNote = {
			content: request.content,
			createdAt: new Date(0).toISOString(),
			createdBy: reviewer,
			frame: request.frame,
			id: this.nextNoteId++,
			projectId: request.projectId,
			subject: request.subject,
			versionId: request.versionId,
		}
		this.retainNoteId(note.id)
		return note
	}

	async createPublicationNote(
		playlistId: number,
		versionId: number,
		request: CreateReviewPublicationNoteRequest
	): Promise<ReviewPublicationNoteResult> {
		const version = await this.getVersion(playlistId, versionId)
		this.requireRecipients(version.projectId, request.recipientIds)
		return {
			links: this.buildPublicationLinks(version),
			note: await this.createNote({
				content: request.content,
				frame: null,
				projectId: version.projectId,
				subject: request.subject,
				versionId,
			}),
		}
	}

	async getCurrentReviewer() {
		return reviewer
	}

	async getDecisionContext(
		playlistId: number,
		versionId: number,
		decisions: readonly ReviewDecisionOption[]
	): Promise<ReviewDecisionContext> {
		const version = await this.getVersion(playlistId, versionId)
		return {
			currentStatusCode: version.statusCode,
			decisions: decisions.map((decision) => ({ ...decision })),
			history: (this.decisionHistory.get(versionId) ?? []).map((entry) => ({
				...entry,
				reviewer: entry.reviewer ? { ...entry.reviewer } : null,
			})),
			historyTruncated: false,
			playlistId,
			versionId,
		}
	}

	async getNoteOptions(playlistId: number, versionId: number): Promise<ReviewNoteOptions> {
		const version = await this.getVersion(playlistId, versionId)
		return {
			links: this.buildPublicationLinks(version),
			recipients: this.getProjectRecipients(version.projectId),
		}
	}

	async getVersion(playlistId: number, versionId: number) {
		this.requirePlaylist(playlistId)
		const version = this.requireVersion(versionId)
		if (version.playlistId !== playlistId) throw this.notFound('Version')
		return version
	}

	async getVersionImage(
		_playlistId: number,
		_versionId: number,
		_signal?: AbortSignal
	): Promise<ReviewImageProxyPayload> {
		throw this.notFound('Version image')
	}

	async listPlaylists(projectId: number) {
		this.requireProject(projectId)
		return playlists.filter((playlist) => playlist.projectId === projectId)
	}

	async listProjects() {
		return projects
	}

	async listVersions(playlistId: number) {
		this.requirePlaylist(playlistId)
		return this.versions.filter((version) => version.playlistId === playlistId)
	}

	async updateVersionDecision(
		request: UpdateReviewDecisionGatewayRequest
	): Promise<ReviewDecisionResult> {
		const version = await this.getVersion(request.playlistId, request.versionId)
		const configuredDecision = request.decisions.find(({ key }) => key === request.decision.key)
		if (!configuredDecision || configuredDecision.statusCode !== request.decision.statusCode) {
			throw new ReviewGatewayError({
				code: 'INVALID_REQUEST',
				retryable: false,
				status: 400,
			})
		}
		if (version.statusCode !== request.expectedStatusCode) throw decisionConflict()

		const previousStatusCode = version.statusCode
		const updatedAt = new Date(0).toISOString()
		if (previousStatusCode !== request.decision.statusCode) {
			version.statusCode = request.decision.statusCode
			const entry: ReviewDecisionHistoryEntry = {
				decidedAt: updatedAt,
				decisionKey: request.decision.key,
				id: this.nextDecisionHistoryId++,
				previousStatusCode,
				resultingStatusCode: version.statusCode,
				reviewer,
			}
			this.decisionHistory.set(request.versionId, [
				entry,
				...(this.decisionHistory.get(request.versionId) ?? []),
			])
		}
		return {
			changed: previousStatusCode !== request.decision.statusCode,
			decisionKey: request.decision.key,
			playlistId: request.playlistId,
			previousStatusCode,
			reviewer: previousStatusCode === request.decision.statusCode ? null : reviewer,
			statusCode: request.decision.statusCode,
			updatedAt: previousStatusCode === request.decision.statusCode ? null : updatedAt,
			versionId: request.versionId,
		}
	}

	async uploadAttachment(request: UploadReviewAttachmentRequest): Promise<ReviewAttachmentResult> {
		this.requireNote(request.noteId)
		return {
			contentType: request.contentType,
			fileName: request.fileName,
			id: this.nextAttachmentId++,
			noteId: request.noteId,
			sizeBytes: Buffer.byteLength(request.contentBase64, 'base64'),
		}
	}

	private requireNote(id: number) {
		if (!this.retainedNoteIds.has(id)) throw this.notFound('Note')
	}

	private requireRecipients(projectId: number, ids: number[]) {
		const projectRecipients = this.getProjectRecipients(projectId)
		for (const id of ids) {
			if (!projectRecipients.some((recipient) => recipient.id === id)) {
				throw new ReviewGatewayError({
					code: 'INVALID_REQUEST',
					message: 'A selected recipient is unavailable',
					retryable: false,
					status: 400,
				})
			}
		}
	}

	private getProjectRecipients(projectId: number) {
		const ids = recipientProjectIds.get(projectId) ?? []
		return recipients.filter((recipient) => recipient.id !== null && ids.includes(recipient.id))
	}

	private buildPublicationLinks(version: ReviewVersion): ReviewPublicationLinks {
		const project = this.requireProject(version.projectId)
		return {
			entity: version.entity,
			project: { id: project.id, name: project.name, type: 'Project' },
			task: version.task,
			version: { id: version.id, name: version.name, type: 'Version' },
		}
	}

	private retainNoteId(id: number) {
		this.retainedNoteIds.add(id)
		if (this.retainedNoteIds.size <= this.retainedNoteIdLimit) return

		const oldest = this.retainedNoteIds.values().next()
		if (!oldest.done) this.retainedNoteIds.delete(oldest.value)
	}

	private requirePlaylist(id: number) {
		const playlist = playlists.find((candidate) => candidate.id === id)
		if (!playlist) throw this.notFound('Playlist')
		return playlist
	}

	private requireProject(id: number) {
		const project = projects.find((candidate) => candidate.id === id)
		if (!project) throw this.notFound('Project')
		return project
	}

	private requireVersion(id: number) {
		const version = this.versions.find((candidate) => candidate.id === id)
		if (!version) throw this.notFound('Version')
		return version
	}

	private notFound(entity: string) {
		return new ReviewGatewayError({
			code: 'NOT_FOUND',
			message: `${entity} was not found`,
			retryable: false,
			status: 404,
		})
	}
}

function decisionConflict() {
	return new ReviewGatewayError({
		code: 'DECISION_CONFLICT',
		retryable: false,
		status: 409,
	})
}
