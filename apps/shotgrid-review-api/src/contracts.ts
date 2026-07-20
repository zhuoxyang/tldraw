/** A positive ShotGrid entity id. */
export type ReviewEntityId = number

export interface ReviewUser {
	id: ReviewEntityId | null
	kind: 'human' | 'service'
	name: string
	login: string | null
	avatarUrl: string | null
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

export interface ReviewImageMedia {
	kind: 'image'
	url: string
	thumbnailUrl: string | null
	contentType: string
	width: number | null
	height: number | null
}

export interface ReviewVideoMedia {
	kind: 'video'
	url: string
	thumbnailUrl: string | null
	contentType: string
	width: number | null
	height: number | null
	durationSeconds: number | null
	frameRate: number | null
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

export interface UpdateReviewStatusRequest {
	versionId: ReviewEntityId
	statusCode: string
}

export interface ReviewStatusResult {
	versionId: ReviewEntityId
	previousStatusCode: string | null
	statusCode: string
	updatedAt: string
}

export type ReviewApiErrorCode =
	| 'INVALID_REQUEST'
	| 'AUTHENTICATION_REQUIRED'
	| 'PERMISSION_DENIED'
	| 'NOT_FOUND'
	| 'INVALID_SHOTGRID_PATH'
	| 'SHOTGRID_AUTH_FAILED'
	| 'SHOTGRID_PERMISSION_DENIED'
	| 'SHOTGRID_RATE_LIMITED'
	| 'SHOTGRID_TIMEOUT'
	| 'SHOTGRID_UNAVAILABLE'
	| 'SHOTGRID_INVALID_RESPONSE'
	| 'SHOTGRID_REQUEST_FAILED'
	| 'CONFIGURATION_ERROR'
	| 'INTERNAL_ERROR'

export interface ReviewApiErrorEnvelope {
	error: {
		code: ReviewApiErrorCode
		message: string
		retryable: boolean
		upstreamStatus?: number
		requestId?: string
	}
}
