import { createHash } from 'node:crypto'
import {
	isReviewNote,
	isReviewPublicationLinks,
	isReviewPublicationResult,
	type ReviewPublicationErrorContext,
	type ReviewPublicationRequest,
	type ReviewPublicationResult,
} from '../contracts'
import { ReviewGatewayError } from '../errors'
import type { ReviewGateway, ReviewPublicationNoteResult } from '../gateway/ReviewGateway'
import {
	InMemoryReviewPublicationStore,
	ReviewPublicationStoreError,
	type ReviewPublicationStore,
	type ReviewPublicationStoreSession,
} from './ReviewPublicationStore'

const PUBLICATION_RECORD_VERSION = 1

type StoredPublicationRecord =
	| {
			fingerprint: string
			stage: 'creating-note'
			version: typeof PUBLICATION_RECORD_VERSION
	  }
	| {
			fingerprint: string
			note: ReviewPublicationNoteResult
			stage: 'note-created' | 'uploading-attachment'
			version: typeof PUBLICATION_RECORD_VERSION
	  }
	| {
			fingerprint: string
			result: ReviewPublicationResult
			stage: 'complete'
			version: typeof PUBLICATION_RECORD_VERSION
	  }
	| {
			fingerprint: string
			stage: 'note-creation-indeterminate'
			version: typeof PUBLICATION_RECORD_VERSION
	  }
	| {
			attachmentId?: number
			fingerprint: string
			note: ReviewPublicationNoteResult
			stage: 'attachment-completion-indeterminate'
			version: typeof PUBLICATION_RECORD_VERSION
	  }

export class ReviewPublicationCoordinator {
	constructor(
		private readonly gateway: ReviewGateway,
		private readonly store: ReviewPublicationStore = new InMemoryReviewPublicationStore()
	) {}

	async publish(
		actorScope: string,
		publicationId: string,
		playlistId: number,
		versionId: number,
		request: ReviewPublicationRequest
	): Promise<ReviewPublicationResult> {
		const fingerprint = fingerprintPublication(request)
		let mutationMayHaveOccurred = false
		let publicationContext = noteCreationErrorContext(publicationId)
		const setMutationPossible = (value: boolean) => (mutationMayHaveOccurred = value)
		const setKnownNote = (value: ReviewPublicationNoteResult) =>
			(publicationContext = knownNoteErrorContext(publicationId, 'note-created', value))
		try {
			return await this.store.runExclusive<StoredPublicationRecord, ReviewPublicationResult>(
				{ actorScope, playlistId, publicationId, versionId },
				async (session) => {
					const stored = requireStoredRecord(session.record, publicationId, versionId)
					mutationMayHaveOccurred = stored !== null
					if (stored && stored.fingerprint !== fingerprint) throw publicationConflict()
					if (stored?.stage === 'complete') {
						publicationContext = knownNoteErrorContext(
							publicationId,
							'attachment-completion',
							{ links: stored.result.links, note: stored.result.note },
							stored.result.attachment.id ?? undefined
						)
						return stored.result
					}
					if (stored?.stage === 'note-creation-indeterminate') {
						throw publicationIndeterminate(undefined, noteCreationErrorContext(publicationId))
					}
					if (stored?.stage === 'attachment-completion-indeterminate') {
						publicationContext = knownNoteErrorContext(
							publicationId,
							'attachment-completion',
							stored.note,
							stored.attachmentId
						)
						throw publicationIndeterminate(undefined, publicationContext)
					}
					if (stored?.stage === 'creating-note') {
						await saveNoteCreationIndeterminate(session, fingerprint, publicationId)
						throw publicationIndeterminate(undefined, noteCreationErrorContext(publicationId))
					}
					if (stored?.stage === 'uploading-attachment') {
						publicationContext = knownNoteErrorContext(
							publicationId,
							'attachment-completion',
							stored.note
						)
						await saveAttachmentIndeterminate(session, fingerprint, publicationId, stored.note)
						throw publicationIndeterminate(undefined, publicationContext)
					}
					if (stored?.stage === 'note-created') setKnownNote(stored.note)

					const note =
						stored?.stage === 'note-created'
							? stored.note
							: await this.createNote(
									session,
									fingerprint,
									playlistId,
									versionId,
									request,
									setMutationPossible,
									setKnownNote,
									publicationId
								)
					return await this.uploadAttachment(
						session,
						fingerprint,
						publicationId,
						note,
						request,
						() => {
							publicationContext = knownNoteErrorContext(
								publicationId,
								'attachment-completion',
								note
							)
						},
						(attachmentId) => {
							publicationContext = knownNoteErrorContext(
								publicationId,
								'attachment-completion',
								note,
								attachmentId
							)
						}
					)
				}
			)
		} catch (error) {
			throw normalizeStoreError(error, mutationMayHaveOccurred, publicationContext)
		}
	}

	private async createNote(
		session: ReviewPublicationStoreSession<StoredPublicationRecord>,
		fingerprint: string,
		playlistId: number,
		versionId: number,
		request: ReviewPublicationRequest,
		setMutationPossible: (value: boolean) => void,
		setKnownNote: (value: ReviewPublicationNoteResult) => void,
		publicationId: string
	) {
		await session.save(record(fingerprint, 'creating-note'), { reserveNextRecord: true })
		setMutationPossible(true)
		let note: ReviewPublicationNoteResult
		try {
			note = await this.gateway.createPublicationNote(playlistId, versionId, {
				content: request.content,
				recipientIds: request.recipientIds,
				subject: request.subject,
			})
		} catch (error) {
			if (isIndeterminate(error)) {
				await saveNoteCreationIndeterminate(session, fingerprint, publicationId)
				throw publicationIndeterminate(error, noteCreationErrorContext(publicationId))
			}
			if (!(error instanceof ReviewGatewayError)) {
				await saveNoteCreationIndeterminate(session, fingerprint, publicationId)
				throw publicationIndeterminate(error, noteCreationErrorContext(publicationId))
			}
			await session.clear()
			setMutationPossible(false)
			throw error
		}
		if (!isPublicationNoteResult(note, versionId)) {
			await saveNoteCreationIndeterminate(session, fingerprint, publicationId)
			throw publicationIndeterminate(undefined, noteCreationErrorContext(publicationId))
		}
		setKnownNote(note)

		try {
			await session.save({
				...record(fingerprint, 'note-created'),
				note,
			})
		} catch (error) {
			throw publicationIndeterminate(
				error,
				knownNoteErrorContext(publicationId, 'note-created', note)
			)
		}
		return note
	}

	private async uploadAttachment(
		session: ReviewPublicationStoreSession<StoredPublicationRecord>,
		fingerprint: string,
		publicationId: string,
		note: ReviewPublicationNoteResult,
		request: ReviewPublicationRequest,
		markAttachmentCompletion: () => void,
		rememberAttachmentId: (attachmentId: number | undefined) => void
	) {
		try {
			await session.save(
				{
					...record(fingerprint, 'uploading-attachment'),
					note,
				},
				{ reserveNextRecord: true }
			)
		} catch (error) {
			if (
				error instanceof ReviewPublicationStoreError &&
				error.code === 'STORE_CAPACITY_EXCEEDED'
			) {
				throw publicationIncomplete(error)
			}
			throw error
		}
		markAttachmentCompletion()

		let attachment
		try {
			attachment = await this.gateway.uploadAttachment({
				contentBase64: request.attachment.contentBase64,
				contentType: request.attachment.contentType,
				fileName: request.attachment.fileName,
				noteId: note.note.id,
			})
		} catch (error) {
			if (isIndeterminate(error)) {
				await saveAttachmentIndeterminate(session, fingerprint, publicationId, note)
				throw publicationIndeterminate(
					error,
					knownNoteErrorContext(publicationId, 'attachment-completion', note)
				)
			}
			if (!(error instanceof ReviewGatewayError)) {
				await saveAttachmentIndeterminate(session, fingerprint, publicationId, note)
				throw publicationIndeterminate(
					error,
					knownNoteErrorContext(publicationId, 'attachment-completion', note)
				)
			}
			try {
				await session.save({
					...record(fingerprint, 'note-created'),
					note,
				})
			} catch (storeError) {
				throw publicationIndeterminate(
					storeError,
					knownNoteErrorContext(publicationId, 'attachment-completion', note)
				)
			}
			throw publicationIncomplete(error)
		}

		const result: ReviewPublicationResult = {
			attachment,
			links: note.links,
			note: note.note,
			publicationId,
			status: 'complete',
		}
		if (!isReviewPublicationResult(result)) {
			await saveAttachmentIndeterminate(session, fingerprint, publicationId, note)
			throw publicationIndeterminate(
				undefined,
				knownNoteErrorContext(publicationId, 'attachment-completion', note)
			)
		}
		rememberAttachmentId(result.attachment.id ?? undefined)
		try {
			await session.save({
				...record(fingerprint, 'complete'),
				result,
			})
		} catch (error) {
			try {
				await saveAttachmentIndeterminate(
					session,
					fingerprint,
					publicationId,
					note,
					result.attachment.id ?? undefined
				)
			} catch (storeError) {
				throw publicationIndeterminate(
					storeError,
					knownNoteErrorContext(
						publicationId,
						'attachment-completion',
						note,
						result.attachment.id ?? undefined
					)
				)
			}
			throw publicationIndeterminate(
				error,
				knownNoteErrorContext(
					publicationId,
					'attachment-completion',
					note,
					result.attachment.id ?? undefined
				)
			)
		}
		return result
	}
}

function fingerprintPublication(request: ReviewPublicationRequest) {
	return createHash('sha256')
		.update(
			JSON.stringify({
				attachment: {
					contentType: request.attachment.contentType,
					fileName: request.attachment.fileName,
					sha256: request.attachment.sha256,
				},
				content: request.content,
				recipientIds: request.recipientIds,
				subject: request.subject,
			})
		)
		.digest('hex')
}

function record<TStage extends StoredPublicationRecord['stage']>(
	fingerprint: string,
	stage: TStage
) {
	return { fingerprint, stage, version: PUBLICATION_RECORD_VERSION } as const
}

async function saveNoteCreationIndeterminate(
	session: ReviewPublicationStoreSession<StoredPublicationRecord>,
	fingerprint: string,
	publicationId: string
) {
	try {
		await session.save(record(fingerprint, 'note-creation-indeterminate'))
	} catch (error) {
		throw publicationIndeterminate(error, noteCreationErrorContext(publicationId))
	}
}

async function saveAttachmentIndeterminate(
	session: ReviewPublicationStoreSession<StoredPublicationRecord>,
	fingerprint: string,
	publicationId: string,
	note: ReviewPublicationNoteResult,
	attachmentId?: number
) {
	try {
		await session.save({
			...record(fingerprint, 'attachment-completion-indeterminate'),
			...(attachmentId === undefined ? undefined : { attachmentId }),
			note,
		})
	} catch (error) {
		throw publicationIndeterminate(
			error,
			knownNoteErrorContext(publicationId, 'attachment-completion', note, attachmentId)
		)
	}
}

function requireStoredRecord(
	value: StoredPublicationRecord | null,
	publicationId: string,
	versionId: number
): StoredPublicationRecord | null {
	if (value === null) return null
	if (!isPlainRecord(value) || value.version !== PUBLICATION_RECORD_VERSION) {
		throw corruptStoredPublication()
	}
	if (typeof value.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(value.fingerprint)) {
		throw corruptStoredPublication()
	}

	if (value.stage === 'creating-note' || value.stage === 'note-creation-indeterminate') {
		if (!hasOnlyKeys(value, ['fingerprint', 'stage', 'version'])) {
			throw corruptStoredPublication()
		}
		return value
	}
	if (value.stage === 'note-created' || value.stage === 'uploading-attachment') {
		if (
			!hasOnlyKeys(value, ['fingerprint', 'note', 'stage', 'version']) ||
			!isPublicationNoteResult(value.note, versionId)
		) {
			throw corruptStoredPublication()
		}
		return value
	}
	if (value.stage === 'attachment-completion-indeterminate') {
		if (
			!hasOnlyKeys(
				value,
				'attachmentId' in value
					? ['attachmentId', 'fingerprint', 'note', 'stage', 'version']
					: ['fingerprint', 'note', 'stage', 'version']
			) ||
			('attachmentId' in value &&
				(!Number.isSafeInteger(value.attachmentId) || Number(value.attachmentId) <= 0)) ||
			!isPublicationNoteResult(value.note, versionId)
		) {
			throw corruptStoredPublication()
		}
		return value
	}
	if (value.stage === 'complete') {
		if (
			!hasOnlyKeys(value, ['fingerprint', 'result', 'stage', 'version']) ||
			!isReviewPublicationResult(value.result) ||
			value.result.publicationId !== publicationId ||
			value.result.note.versionId !== versionId
		) {
			throw corruptStoredPublication()
		}
		return value
	}
	throw corruptStoredPublication()
}

function isPublicationNoteResult(
	value: unknown,
	versionId: number
): value is ReviewPublicationNoteResult {
	if (!isPlainRecord(value)) return false
	return (
		hasOnlyKeys(value, ['links', 'note']) &&
		isReviewNote(value.note) &&
		isReviewPublicationLinks(value.links) &&
		value.note.projectId === value.links.project.id &&
		value.note.versionId === value.links.version.id &&
		value.note.versionId === versionId
	)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false
	const prototype = Object.getPrototypeOf(value)
	return prototype === Object.prototype || prototype === null
}

function hasOnlyKeys(value: Record<string, unknown>, keys: readonly string[]) {
	const actualKeys = Object.keys(value)
	return actualKeys.length === keys.length && actualKeys.every((key) => keys.includes(key))
}

function isIndeterminate(error: unknown) {
	return error instanceof ReviewGatewayError && error.code === 'PUBLICATION_INDETERMINATE'
}

function normalizeStoreError(
	error: unknown,
	mutationMayHaveOccurred: boolean,
	publication: ReviewPublicationErrorContext
) {
	if (error instanceof ReviewGatewayError) {
		return error.code === 'PUBLICATION_INDETERMINATE' && !error.publication
			? publicationIndeterminate(error, publication)
			: error
	}
	if (!(error instanceof ReviewPublicationStoreError)) {
		return mutationMayHaveOccurred ? publicationIndeterminate(error, publication) : error
	}
	if (error.code === 'STORE_CAPACITY_EXCEEDED' && mutationMayHaveOccurred) {
		return publicationIndeterminate(error, publication)
	}
	if (error.code === 'LOCK_TIMEOUT' || error.code === 'STORE_CAPACITY_EXCEEDED') {
		return new ReviewGatewayError({
			cause: error,
			code: 'SHOTGRID_RATE_LIMITED',
			retryable: true,
			status: 429,
		})
	}
	if (
		error.code === 'LOCK_LOST' ||
		error.code === 'CORRUPT_JOURNAL' ||
		error.code === 'JOURNAL_KEY_MISMATCH' ||
		error.code === 'INVALID_PATH' ||
		error.code === 'STORE_STATE_UNAVAILABLE' ||
		((error.code === 'IO_ERROR' || error.code === 'INVALID_RECORD') && mutationMayHaveOccurred)
	) {
		return publicationIndeterminate(error, publication)
	}
	return new ReviewGatewayError({
		cause: error,
		code: 'CONFIGURATION_ERROR',
		retryable: false,
		status: 500,
	})
}

function publicationConflict() {
	return new ReviewGatewayError({
		code: 'PUBLICATION_CONFLICT',
		retryable: false,
		status: 409,
	})
}

function publicationIncomplete(cause: unknown) {
	return new ReviewGatewayError({
		cause,
		code: 'PUBLICATION_INCOMPLETE',
		retryable: true,
		status: 502,
	})
}

function publicationIndeterminate(cause?: unknown, publication?: ReviewPublicationErrorContext) {
	return new ReviewGatewayError({
		cause,
		code: 'PUBLICATION_INDETERMINATE',
		publication,
		retryable: false,
		status: 502,
	})
}

function noteCreationErrorContext(publicationId: string): ReviewPublicationErrorContext {
	return { publicationId, stage: 'note-creation' }
}

function knownNoteErrorContext(
	publicationId: string,
	stage: 'attachment-completion' | 'note-created',
	note: ReviewPublicationNoteResult,
	attachmentId?: number
): ReviewPublicationErrorContext {
	if (stage === 'note-created') {
		return {
			links: note.links,
			noteId: note.note.id,
			publicationId,
			stage,
		}
	}
	return {
		...(attachmentId === undefined ? undefined : { attachmentId }),
		links: note.links,
		noteId: note.note.id,
		publicationId,
		stage,
	}
}

function corruptStoredPublication() {
	return publicationIndeterminate()
}
