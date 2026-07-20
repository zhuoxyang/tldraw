import type {
	CreateReviewNoteRequest,
	ReviewAttachmentResult,
	ReviewDecisionContext,
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

export interface UpdateReviewDecisionGatewayRequest {
	decision: ReviewDecisionOption
	decisions: readonly ReviewDecisionOption[]
	expectedStatusCode: string | null
	playlistId: number
	versionId: number
}

export interface ReviewGateway {
	createNote(request: CreateReviewNoteRequest): Promise<ReviewNote>
	createPublicationNote(
		playlistId: number,
		versionId: number,
		request: CreateReviewPublicationNoteRequest
	): Promise<ReviewPublicationNoteResult>
	getCurrentReviewer(): Promise<ReviewUser>
	getDecisionContext(
		playlistId: number,
		versionId: number,
		decisions: readonly ReviewDecisionOption[]
	): Promise<ReviewDecisionContext>
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
	updateVersionDecision(request: UpdateReviewDecisionGatewayRequest): Promise<ReviewDecisionResult>
	uploadAttachment(request: UploadReviewAttachmentRequest): Promise<ReviewAttachmentResult>
}
