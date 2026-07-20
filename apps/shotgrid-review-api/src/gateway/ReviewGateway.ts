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

export interface ReviewImageProxyPayload {
	body: Uint8Array
	contentType: 'image/jpeg' | 'image/png' | 'image/webp'
}

export interface ReviewGateway {
	createNote(request: CreateReviewNoteRequest): Promise<ReviewNote>
	getCurrentReviewer(): Promise<ReviewUser>
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
