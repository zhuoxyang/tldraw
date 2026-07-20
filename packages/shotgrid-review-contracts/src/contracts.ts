/** A positive ShotGrid entity id. */
export type ReviewEntityId = number

export interface ReviewApiDataEnvelope<T> {
	data: T
}

export interface ReviewHealth {
	mode: 'mock' | 'shotgrid'
	status: 'ok'
}

export type ReviewCollaborationPermission = 'editor' | 'viewer'

export interface ReviewCollaborationSession {
	permission: ReviewCollaborationPermission
	roomId: string
	socketUrl: string
	ticketExpiresAt: string
}

export interface ReviewCollaborationPresence {
	color: string
	userId: string
	userName: string
}

export interface ReviewUser {
	id: ReviewEntityId | null
	kind: 'human' | 'service'
	name: string
	login: string | null
	avatarUrl: string | null
}

const REVIEW_COLLABORATION_COLORS = [
	'#FF6B6B',
	'#4ECDC4',
	'#45B7D1',
	'#96CEB4',
	'#FFEAA7',
	'#DDA0DD',
	'#FF9F43',
	'#6C5CE7',
] as const

export function createReviewCollaborationPresence(
	reviewer: ReviewUser
): ReviewCollaborationPresence {
	if (
		reviewer.kind === 'human' &&
		(!Number.isSafeInteger(reviewer.id) || Number(reviewer.id) <= 0)
	) {
		throw new Error('A human reviewer must have a ShotGrid id.')
	}

	const identity =
		reviewer.kind === 'human'
			? `human:${reviewer.id}`
			: `service:${reviewer.id ?? ''}:${reviewer.login ?? ''}:${reviewer.name}`
	const identityHash = fnv1a(identity)
	const userId =
		reviewer.kind === 'human'
			? `user:shotgrid-human-${reviewer.id}`
			: `user:shotgrid-service-${identityHash.toString(16).padStart(8, '0')}`

	return {
		color: REVIEW_COLLABORATION_COLORS[identityHash % REVIEW_COLLABORATION_COLORS.length],
		userId,
		userName: reviewer.name,
	}
}

function fnv1a(value: string) {
	let hash = 0x811c9dc5
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index)
		hash = Math.imul(hash, 0x01000193)
	}
	return hash >>> 0
}

export interface ReviewProject {
	id: ReviewEntityId
	name: string
	statusCode: string | null
	thumbnailUrl: string | null
}

export interface ReviewPlaylist {
	id: ReviewEntityId
	projectId: ReviewEntityId
	name: string
	description: string | null
	versionCount: number
	updatedAt: string
}

export interface ReviewEntityLink {
	id: ReviewEntityId
	type: string
	name: string
}

export interface ReviewTaskLink {
	id: ReviewEntityId
	name: string
}

export interface ReviewImageMedia {
	kind: 'image'
	url: string
	thumbnailUrl: string | null
	contentType: string
	width: number | null
	height: number | null
}

export interface ReviewVideoMedia {
	attachmentId: ReviewEntityId
	kind: 'video'
	fileName: string
	url: string
	thumbnailUrl: string | null
	contentType: 'video/mp4'
	width: number | null
	height: number | null
	durationSeconds: number | null
	frameCount: number | null
	frameRate: number | null
	frameRateMode: 'constant' | 'unknown' | 'variable'
	firstFrame: number | null
	lastFrame: number | null
}

export type ReviewMedia = ReviewImageMedia | ReviewVideoMedia

export interface ReviewVersion {
	id: ReviewEntityId
	projectId: ReviewEntityId
	playlistId: ReviewEntityId | null
	name: string
	description: string | null
	statusCode: string | null
	createdAt: string
	createdBy: ReviewUser | null
	submittedBy: ReviewUser | null
	entity: ReviewEntityLink | null
	task: ReviewTaskLink | null
	media: ReviewMedia | null
}

export interface CreateReviewNoteRequest {
	projectId: ReviewEntityId
	versionId: ReviewEntityId
	subject: string
	content: string
	frame: number | null
}

export interface ReviewNote {
	id: ReviewEntityId
	projectId: ReviewEntityId
	versionId: ReviewEntityId
	subject: string
	content: string
	frame: number | null
	createdAt: string
	createdBy: ReviewUser
}

export interface ReviewPublicationLinks {
	project: ReviewEntityLink
	version: ReviewEntityLink
	entity: ReviewEntityLink | null
	task: ReviewTaskLink | null
}

export interface ReviewNoteOptions {
	recipients: ReviewUser[]
	links: ReviewPublicationLinks
}

export interface ReviewPublicationAttachmentRequest {
	fileName: string
	contentType: 'image/png'
	contentBase64: string
	sha256: string
}

export interface ReviewPublicationRequest {
	subject: string
	content: string
	recipientIds: ReviewEntityId[]
	attachment: ReviewPublicationAttachmentRequest
}

export interface ReviewPublicationResult {
	publicationId: string
	status: 'complete'
	note: ReviewNote
	attachment: ReviewAttachmentResult
	links: ReviewPublicationLinks
}

export type ReviewPublicationErrorContext =
	| {
			publicationId: string
			stage: 'note-creation'
	  }
	| {
			links: ReviewPublicationLinks
			noteId: ReviewEntityId
			publicationId: string
			stage: 'note-created'
	  }
	| {
			attachmentId?: ReviewEntityId
			links: ReviewPublicationLinks
			noteId: ReviewEntityId
			publicationId: string
			stage: 'attachment-completion'
	  }

export interface UploadReviewAttachmentRequest {
	noteId: ReviewEntityId
	fileName: string
	contentType: string
	contentBase64: string
}

export interface ReviewAttachmentResult {
	id: ReviewEntityId | null
	noteId: ReviewEntityId
	fileName: string
	contentType: string
	sizeBytes: number
}

export interface ReviewDecisionOption {
	key: string
	label: string
	statusCode: string
}

export interface ReviewDecisionHistoryEntry {
	id: ReviewEntityId
	decisionKey: string | null
	decidedAt: string
	reviewer: ReviewUser | null
	previousStatusCode: string | null
	resultingStatusCode: string | null
}

export interface ReviewDecisionContext {
	playlistId: ReviewEntityId
	versionId: ReviewEntityId
	currentStatusCode: string | null
	decisions: ReviewDecisionOption[]
	history: ReviewDecisionHistoryEntry[]
	historyTruncated: boolean
}

export interface ReviewDecisionRequest {
	decisionKey: string
	expectedStatusCode: string | null
}

export interface ReviewDecisionResult {
	changed: boolean
	playlistId: ReviewEntityId
	versionId: ReviewEntityId
	decisionKey: string
	previousStatusCode: string | null
	statusCode: string
	updatedAt: string | null
	reviewer: ReviewUser | null
}

export const REVIEW_API_ERROR_CODES = [
	'INVALID_REQUEST',
	'AUTHENTICATION_REQUIRED',
	'PERMISSION_DENIED',
	'NOT_FOUND',
	'COLLABORATION_UNAVAILABLE',
	'DECISION_CONFLICT',
	'DECISION_INDETERMINATE',
	'PUBLICATION_CONFLICT',
	'PUBLICATION_INCOMPLETE',
	'PUBLICATION_INDETERMINATE',
	'INVALID_SHOTGRID_PATH',
	'SHOTGRID_AUTH_FAILED',
	'SHOTGRID_PERMISSION_DENIED',
	'SHOTGRID_RATE_LIMITED',
	'SHOTGRID_TIMEOUT',
	'SHOTGRID_UNAVAILABLE',
	'SHOTGRID_INVALID_RESPONSE',
	'SHOTGRID_REQUEST_FAILED',
	'CONFIGURATION_ERROR',
	'INTERNAL_ERROR',
] as const

export type ReviewApiErrorCode = (typeof REVIEW_API_ERROR_CODES)[number]

export interface ReviewApiErrorEnvelope {
	error: {
		code: ReviewApiErrorCode
		message: string
		publication?: ReviewPublicationErrorContext
		retryable: boolean
		upstreamStatus?: number
		requestId?: string
	}
}
