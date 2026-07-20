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

export interface ReviewGateway {
	createNote(request: CreateReviewNoteRequest): Promise<ReviewNote>
	getCurrentReviewer(): Promise<ReviewUser>
	listPlaylists(projectId: number): Promise<ReviewPlaylist[]>
	listProjects(): Promise<ReviewProject[]>
	listVersions(playlistId: number): Promise<ReviewVersion[]>
	updateVersionStatus(request: UpdateReviewStatusRequest): Promise<ReviewStatusResult>
	uploadAttachment(request: UploadReviewAttachmentRequest): Promise<ReviewAttachmentResult>
}
