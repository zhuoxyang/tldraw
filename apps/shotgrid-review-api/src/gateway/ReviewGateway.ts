import type {
	CreateReviewNoteRequest,
	ReviewAttachmentResult,
	ReviewNote,
	ReviewNoteOptions,
	ReviewPlaylist,
	ReviewProject,
	ReviewPublicationLinks,
	ReviewStatusResult,
	ReviewUser,
	ReviewVersion,
	UpdateReviewStatusRequest,
	UploadReviewAttachmentRequest,
} from '../contracts'

export interface ReviewImageProxyPayload {
	body: Uint8Array
	contentType: 'image/jpeg' | 'image/png' | 'image/webp'
}

export interface CreateReviewPublicationNoteRequest {
	content: string
	recipientIds: number[]
	subject: string
}

export interface ReviewPublicationNoteResult {
	links: ReviewPublicationLinks
	note: ReviewNote
}

export interface ReviewGateway {
	createNote(request: CreateReviewNoteRequest): Promise<ReviewNote>
	createPublicationNote(
		playlistId: number,
		versionId: number,
		request: CreateReviewPublicationNoteRequest
	): Promise<ReviewPublicationNoteResult>
	getCurrentReviewer(): Promise<ReviewUser>
	getNoteOptions(playlistId: number, versionId: number): Promise<ReviewNoteOptions>
	getVersion(playlistId: number, versionId: number): Promise<ReviewVersion>
	getVersionImage(
		playlistId: number,
		versionId: number,
		signal?: AbortSignal
	): Promise<ReviewImageProxyPayload>
	listPlaylists(projectId: number): Promise<ReviewPlaylist[]>
	listProjects(): Promise<ReviewProject[]>
	listVersions(playlistId: number): Promise<ReviewVersion[]>
	updateVersionStatus(request: UpdateReviewStatusRequest): Promise<ReviewStatusResult>
	uploadAttachment(request: UploadReviewAttachmentRequest): Promise<ReviewAttachmentResult>
}
