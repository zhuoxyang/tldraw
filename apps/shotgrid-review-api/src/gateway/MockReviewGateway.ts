import type {
	CreateReviewNoteRequest,
	ReviewAttachmentResult,
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
import type { ReviewGateway } from './ReviewGateway'

const reviewer: ReviewUser = {
	avatarUrl: null,
	id: 7,
	kind: 'human',
	login: 'local.reviewer',
	name: 'Local Reviewer',
}

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
		description: 'Lighting polish pass',
		id: 301,
		media: {
			contentType: 'image/jpeg',
			height: 1080,
			kind: 'image',
			thumbnailUrl: '/mock-media/shot_010_lgt_v014-thumb.jpg',
			url: '/mock-media/shot_010_lgt_v014.jpg',
			width: 1920,
		},
		name: 'shot_010_lgt_v014',
		playlistId: 201,
		projectId: 101,
		statusCode: 'rev',
	},
	{
		createdAt: '2026-07-20T01:35:00.000Z',
		createdBy: { avatarUrl: null, id: 12, kind: 'human', login: 'akim', name: 'Alex Kim' },
		description: null,
		id: 302,
		media: {
			contentType: 'video/mp4',
			durationSeconds: 5,
			firstFrame: 1001,
			frameRate: 24,
			height: 1080,
			kind: 'video',
			lastFrame: 1120,
			thumbnailUrl: '/mock-media/shot_020_comp_v008-thumb.jpg',
			url: '/mock-media/shot_020_comp_v008.mp4',
			width: 1920,
		},
		name: 'shot_020_comp_v008',
		playlistId: 201,
		projectId: 101,
		statusCode: 'chg',
	},
	{
		createdAt: '2026-07-19T08:45:00.000Z',
		createdBy: { avatarUrl: null, id: 13, kind: 'human', login: 'srivera', name: 'Sam Rivera' },
		description: 'Drone animation final',
		id: 303,
		media: {
			contentType: 'image/jpeg',
			height: 1080,
			kind: 'image',
			thumbnailUrl: null,
			url: '/mock-media/drone_v021.jpg',
			width: 1920,
		},
		name: 'asset_drone_anim_v021',
		playlistId: 202,
		projectId: 101,
		statusCode: 'apr',
	},
	{
		createdAt: '2026-07-18T05:10:00.000Z',
		createdBy: { avatarUrl: null, id: 14, kind: 'human', login: 'jlee', name: 'Jordan Lee' },
		description: null,
		id: 304,
		media: {
			contentType: 'image/jpeg',
			height: 1080,
			kind: 'image',
			thumbnailUrl: null,
			url: '/mock-media/market_v005.jpg',
			width: 1920,
		},
		name: 'env_market_v005',
		playlistId: 203,
		projectId: 102,
		statusCode: 'rev',
	},
]

export class MockReviewGateway implements ReviewGateway {
	private nextAttachmentId = 501
	private nextNoteId = 401
	private readonly versions = initialVersions.map((version) => ({ ...version }))

	async createNote(request: CreateReviewNoteRequest): Promise<ReviewNote> {
		this.requireVersion(request.versionId)

		return {
			content: request.content,
			createdAt: new Date(0).toISOString(),
			createdBy: reviewer,
			frame: request.frame,
			id: this.nextNoteId++,
			projectId: request.projectId,
			subject: request.subject,
			versionId: request.versionId,
		}
	}

	async getCurrentReviewer() {
		return reviewer
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

	async updateVersionStatus(request: UpdateReviewStatusRequest): Promise<ReviewStatusResult> {
		const version = this.requireVersion(request.versionId)
		const previousStatusCode = version.statusCode
		version.statusCode = request.statusCode
		return {
			previousStatusCode,
			statusCode: version.statusCode,
			updatedAt: new Date(0).toISOString(),
			versionId: request.versionId,
		}
	}

	async uploadAttachment(request: UploadReviewAttachmentRequest): Promise<ReviewAttachmentResult> {
		return {
			contentType: request.contentType,
			fileName: request.fileName,
			id: this.nextAttachmentId++,
			noteId: request.noteId,
			sizeBytes: Buffer.byteLength(request.contentBase64, 'base64'),
		}
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
