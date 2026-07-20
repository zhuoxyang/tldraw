import {
	type ReviewPublicationErrorContext,
	type ReviewPublicationRequest,
	type ReviewPublicationResult,
	isReviewPublicationErrorContext,
	isReviewPublicationResult,
} from '@tldraw/shotgrid-review-contracts'
import {
	MAX_REVIEW_PUBLICATION_CONTENT_LENGTH,
	MAX_REVIEW_PUBLICATION_PNG_BYTES,
	MAX_REVIEW_PUBLICATION_RECIPIENTS,
	MAX_REVIEW_PUBLICATION_SUBJECT_LENGTH,
	type PreparedReviewPublication,
} from './reviewPublication'

const DATABASE_NAME = 'shotgrid-review-publications'
const DATABASE_VERSION = 1
const STORE_NAME = 'pending-publications'
const RECORD_KIND = 'shotgrid-review-publication'
const RECORD_VERSION = 4
const MAX_BASE64_LENGTH = Math.ceil(MAX_REVIEW_PUBLICATION_PNG_BYTES / 3) * 4
export const REVIEW_PUBLICATION_COMPLETED_TTL_MS = 7 * 24 * 60 * 60 * 1000

export type StoredReviewPublicationStatus = 'completed' | 'idle' | 'indeterminate' | 'pending'

interface StoredReviewPublicationBase {
	documentKey: string
	generation: number
	kind: typeof RECORD_KIND
	updatedAt: string
	version: typeof RECORD_VERSION
}

export interface ReviewPublicationSendClaim {
	claimedAt: string
	id: string
}

export interface StoredIdleReviewPublication extends StoredReviewPublicationBase {
	status: 'idle'
}

export interface StoredPendingReviewPublication extends StoredReviewPublicationBase {
	claim: ReviewPublicationSendClaim | null
	prepared: PreparedReviewPublication
	requestId: string | null
	sharedRetry: boolean
	status: 'indeterminate' | 'pending'
	uncertainty: ReviewPublicationErrorContext | null
}

export interface StoredCompletedReviewPublication extends StoredReviewPublicationBase {
	completedAt: string
	expiresAt: string
	publicationId: string
	requestFingerprint: string
	result: ReviewPublicationResult
	status: 'completed'
}

export type StoredReviewPublication =
	| StoredCompletedReviewPublication
	| StoredIdleReviewPublication
	| StoredPendingReviewPublication

export type PublicationClaimResult =
	| { record: StoredPendingReviewPublication; status: 'busy' | 'claimed' | 'shared' }
	| { record: StoredCompletedReviewPublication; status: 'completed' }
	| { record: StoredReviewPublication | null; status: 'conflict' }

export type FinishSafePublicationResult =
	| { record: StoredIdleReviewPublication; status: 'advanced' }
	| { record: StoredCompletedReviewPublication; status: 'completed' }
	| { record: StoredReviewPublication | null; status: 'conflict' }

export interface ReviewPublicationStore {
	addIfAbsent(record: StoredPendingReviewPublication): Promise<{
		created: boolean
		record: StoredReviewPublication
	}>
	claimForSend(
		documentKey: string,
		publicationId: string,
		generation: number,
		claimId: string,
		allowSharedRetry?: boolean
	): Promise<PublicationClaimResult>
	finishSafeFailure(
		documentKey: string,
		publicationId: string,
		generation: number,
		claimId: string
	): Promise<FinishSafePublicationResult>
	get(documentKey: string): Promise<StoredReviewPublication | null>
	markCompleted(
		documentKey: string,
		publicationId: string,
		generation: number,
		claimId: string,
		result: ReviewPublicationResult
	): Promise<StoredCompletedReviewPublication>
	markIndeterminate(
		documentKey: string,
		publicationId: string,
		generation: number,
		claimId: string,
		requestId?: string,
		uncertainty?: ReviewPublicationErrorContext
	): Promise<StoredCompletedReviewPublication | StoredPendingReviewPublication>
	startNextAttempt(
		documentKey: string,
		expectedGeneration: number
	): Promise<StoredReviewPublication>
}

export function createStoredReviewPublication(options: {
	claim?: ReviewPublicationSendClaim | null
	documentKey: string
	prepared: PreparedReviewPublication
	requestId?: string
	sharedRetry?: boolean
	status: 'indeterminate' | 'pending'
	uncertainty?: ReviewPublicationErrorContext
	updatedAt?: string
}): StoredPendingReviewPublication {
	return validateStoredReviewPublication({
		claim: options.status === 'indeterminate' ? null : (options.claim ?? null),
		documentKey: options.documentKey,
		generation: options.prepared.generation,
		kind: RECORD_KIND,
		prepared: options.prepared,
		requestId: options.requestId ?? null,
		sharedRetry: options.sharedRetry ?? false,
		status: options.status,
		uncertainty: options.status === 'indeterminate' ? (options.uncertainty ?? null) : null,
		updatedAt: options.updatedAt ?? new Date().toISOString(),
		version: RECORD_VERSION,
	}) as StoredPendingReviewPublication
}

export function createIdleReviewPublication(options: {
	documentKey: string
	generation: number
	updatedAt?: string
}): StoredIdleReviewPublication {
	return validateStoredReviewPublication({
		documentKey: options.documentKey,
		generation: options.generation,
		kind: RECORD_KIND,
		status: 'idle',
		updatedAt: options.updatedAt ?? new Date().toISOString(),
		version: RECORD_VERSION,
	}) as StoredIdleReviewPublication
}

export function createCompletedReviewPublication(options: {
	completedAt?: string
	documentKey: string
	prepared: PreparedReviewPublication
	result: ReviewPublicationResult
}): StoredCompletedReviewPublication {
	const completedAt = options.completedAt ?? new Date().toISOString()
	const completedTime = Date.parse(completedAt)
	return validateStoredReviewPublication({
		completedAt,
		documentKey: options.documentKey,
		expiresAt: new Date(completedTime + REVIEW_PUBLICATION_COMPLETED_TTL_MS).toISOString(),
		generation: options.prepared.generation,
		kind: RECORD_KIND,
		publicationId: options.prepared.publicationId,
		requestFingerprint: options.prepared.fingerprint,
		result: options.result,
		status: 'completed',
		updatedAt: completedAt,
		version: RECORD_VERSION,
	}) as StoredCompletedReviewPublication
}

export function validateStoredReviewPublication(
	value: unknown,
	expectedDocumentKey?: string
): StoredReviewPublication {
	if (!isObject(value)) throw invalidRecord()
	const migrated = migrateStoredReviewPublication(value)
	if (
		migrated.kind !== RECORD_KIND ||
		migrated.version !== RECORD_VERSION ||
		!isDocumentKey(migrated.documentKey) ||
		(expectedDocumentKey !== undefined && migrated.documentKey !== expectedDocumentKey) ||
		!isGeneration(migrated.generation) ||
		!isIsoTimestamp(migrated.updatedAt)
	) {
		throw invalidRecord()
	}
	if (migrated.status === 'idle') {
		if (
			!hasExactKeys(migrated, [
				'documentKey',
				'generation',
				'kind',
				'status',
				'updatedAt',
				'version',
			])
		) {
			throw invalidRecord()
		}
		return migrated as unknown as StoredIdleReviewPublication
	}
	if (migrated.status === 'completed') {
		if (
			!hasExactKeys(migrated, [
				'completedAt',
				'documentKey',
				'expiresAt',
				'generation',
				'kind',
				'publicationId',
				'requestFingerprint',
				'result',
				'status',
				'updatedAt',
				'version',
			]) ||
			!isIsoTimestamp(migrated.completedAt) ||
			!isIsoTimestamp(migrated.expiresAt) ||
			Date.parse(migrated.expiresAt) - Date.parse(migrated.completedAt) !==
				REVIEW_PUBLICATION_COMPLETED_TTL_MS ||
			!isPublicationId(migrated.publicationId) ||
			!isFingerprint(migrated.requestFingerprint) ||
			!isReviewPublicationResult(migrated.result) ||
			migrated.result.publicationId !== migrated.publicationId
		) {
			throw invalidRecord()
		}
		return migrated as unknown as StoredCompletedReviewPublication
	}
	if (
		(migrated.status !== 'pending' && migrated.status !== 'indeterminate') ||
		!hasExactKeys(migrated, [
			'claim',
			'documentKey',
			'generation',
			'kind',
			'prepared',
			'requestId',
			'sharedRetry',
			'status',
			'uncertainty',
			'updatedAt',
			'version',
		]) ||
		!isRequestId(migrated.requestId) ||
		typeof migrated.sharedRetry !== 'boolean' ||
		!isPreparedReviewPublication(migrated.prepared) ||
		migrated.prepared.generation !== migrated.generation ||
		!isSendClaim(migrated.claim) ||
		(migrated.status === 'indeterminate' && migrated.claim !== null) ||
		!isPublicationUncertainty(
			migrated.uncertainty,
			migrated.prepared.publicationId,
			migrated.documentKey
		) ||
		(migrated.status === 'pending' && migrated.uncertainty !== null)
	) {
		throw invalidRecord()
	}
	return migrated as unknown as StoredPendingReviewPublication
}

export function migrateStoredReviewPublication(value: Record<string, unknown>) {
	if (
		value.kind !== RECORD_KIND ||
		(value.version !== 0 && value.version !== 1 && value.version !== 2 && value.version !== 3)
	) {
		return value
	}
	const legacyPrepared = value.version === 0 ? value.pending : value.prepared
	const generation = isGeneration(value.generation)
		? value.generation
		: isObject(legacyPrepared) && isGeneration(legacyPrepared.generation)
			? legacyPrepared.generation
			: 0
	if (value.status === 'completed') {
		return {
			completedAt: value.completedAt,
			documentKey: value.documentKey,
			expiresAt: value.expiresAt,
			generation,
			kind: RECORD_KIND,
			publicationId: value.publicationId,
			requestFingerprint: value.requestFingerprint,
			result: value.result,
			status: 'completed',
			updatedAt: value.updatedAt,
			version: RECORD_VERSION,
		}
	}
	return {
		claim: value.version === 3 ? value.claim : null,
		documentKey: value.documentKey,
		generation,
		kind: RECORD_KIND,
		prepared: migratePreparedReviewPublication(legacyPrepared, generation),
		requestId: value.version === 0 ? null : value.requestId,
		sharedRetry: value.version === 3 ? value.sharedRetry : false,
		status: value.version === 0 ? 'pending' : value.status,
		uncertainty: null,
		updatedAt: value.updatedAt,
		version: RECORD_VERSION,
	}
}

export function upgradeReviewPublicationDatabase(database: IDBDatabase, oldVersion: number) {
	if (oldVersion < 1 && !database.objectStoreNames.contains(STORE_NAME)) {
		database.createObjectStore(STORE_NAME, { keyPath: 'documentKey' })
	}
}

export function createIndexedDbReviewPublicationStore(
	indexedDb: IDBFactory | undefined = globalThis.indexedDB,
	now: () => number = Date.now
): ReviewPublicationStore {
	let databasePromise: Promise<IDBDatabase> | undefined
	const openDatabase = () => {
		if (!indexedDb) return Promise.reject(new Error('IndexedDB is unavailable in this browser.'))
		if (databasePromise) return databasePromise
		let failed = false
		const pending = new Promise<IDBDatabase>((resolve, reject) => {
			const request = indexedDb.open(DATABASE_NAME, DATABASE_VERSION)
			const fail = (error: Error) => {
				failed = true
				if (databasePromise === pending) databasePromise = undefined
				reject(error)
			}
			request.onupgradeneeded = (event) => {
				upgradeReviewPublicationDatabase(request.result, event.oldVersion)
			}
			request.onerror = () => fail(storageError(request.error))
			request.onblocked = () => fail(new Error('Publication storage is blocked by another tab.'))
			request.onsuccess = () => {
				const database = request.result
				if (failed || databasePromise !== pending) {
					database.close()
					return
				}
				const clearDatabase = () => {
					if (databasePromise === pending) databasePromise = undefined
				}
				database.onversionchange = () => {
					database.close()
					clearDatabase()
				}
				database.addEventListener('close', clearDatabase)
				resolve(database)
			}
		})
		databasePromise = pending
		void pending.catch(() => {
			if (databasePromise === pending) databasePromise = undefined
		})
		return pending
	}

	return {
		async addIfAbsent(record) {
			const validated = validateStoredReviewPublication(record)
			if (validated.status !== 'pending') throw new Error('Only pending publications can start.')
			const database = await openDatabase()
			const transaction = database.transaction(STORE_NAME, 'readwrite')
			const store = transaction.objectStore(STORE_NAME)
			const existing = await waitForRequest<unknown>(store.get(validated.documentKey))
			if (existing !== undefined) {
				let current = validateStoredReviewPublication(existing, validated.documentKey)
				current = advanceExpiredCompleted(current, now())
				if (current !== existing) store.put(current)
				if (current.status === 'idle' && current.generation === validated.generation) {
					store.put(validated)
					await waitForTransaction(transaction)
					return { created: true, record: validated }
				}
				await waitForTransaction(transaction)
				return { created: false, record: current }
			}
			if (validated.generation !== 0) {
				transaction.abort()
				throw new Error('The publication generation is stale.')
			}
			store.add(validated)
			await waitForTransaction(transaction)
			return { created: true, record: validated }
		},

		async claimForSend(documentKey, publicationId, generation, claimId, allowSharedRetry = false) {
			requireCasInputs(documentKey, publicationId, generation, claimId)
			const database = await openDatabase()
			const transaction = database.transaction(STORE_NAME, 'readwrite')
			const store = transaction.objectStore(STORE_NAME)
			const existing = await waitForRequest<unknown>(store.get(documentKey))
			if (existing === undefined) {
				await waitForTransaction(transaction)
				return { record: null, status: 'conflict' }
			}
			let current = validateStoredReviewPublication(existing, documentKey)
			current = advanceExpiredCompleted(current, now())
			if (current !== existing) store.put(current)
			if (
				current.status === 'completed' &&
				current.generation === generation &&
				current.publicationId === publicationId
			) {
				await waitForTransaction(transaction)
				return { record: current, status: 'completed' }
			}
			if (
				current.status !== 'pending' ||
				current.generation !== generation ||
				current.prepared.publicationId !== publicationId
			) {
				await waitForTransaction(transaction)
				return { record: current, status: 'conflict' }
			}
			if (current.claim !== null && current.claim.id !== claimId) {
				if (allowSharedRetry) {
					const shared = createStoredReviewPublication({
						claim: current.claim,
						documentKey,
						prepared: current.prepared,
						sharedRetry: true,
						status: 'pending',
						updatedAt: new Date(now()).toISOString(),
					})
					store.put(shared)
					await waitForTransaction(transaction)
					return { record: shared, status: 'shared' }
				}
				await waitForTransaction(transaction)
				return { record: current, status: 'busy' }
			}
			const claimed = createStoredReviewPublication({
				claim: {
					claimedAt: new Date(now()).toISOString(),
					id: claimId,
				},
				documentKey,
				prepared: current.prepared,
				sharedRetry: current.sharedRetry,
				status: 'pending',
				updatedAt: new Date(now()).toISOString(),
			})
			store.put(claimed)
			await waitForTransaction(transaction)
			return { record: claimed, status: 'claimed' }
		},

		async finishSafeFailure(documentKey, publicationId, generation, claimId) {
			requireCasInputs(documentKey, publicationId, generation, claimId)
			const database = await openDatabase()
			const transaction = database.transaction(STORE_NAME, 'readwrite')
			const store = transaction.objectStore(STORE_NAME)
			const existing = await waitForRequest<unknown>(store.get(documentKey))
			if (existing === undefined) {
				await waitForTransaction(transaction)
				return { record: null, status: 'conflict' }
			}
			const current = validateStoredReviewPublication(existing, documentKey)
			if (
				current.status === 'completed' &&
				current.generation === generation &&
				current.publicationId === publicationId
			) {
				await waitForTransaction(transaction)
				return { record: current, status: 'completed' }
			}
			if (
				current.status !== 'pending' ||
				current.generation !== generation ||
				current.prepared.publicationId !== publicationId ||
				current.claim?.id !== claimId ||
				current.sharedRetry
			) {
				await waitForTransaction(transaction)
				return { record: current, status: 'conflict' }
			}
			const idle = createIdleReviewPublication({
				documentKey,
				generation: generation + 1,
				updatedAt: new Date(now()).toISOString(),
			})
			store.put(idle)
			await waitForTransaction(transaction)
			return { record: idle, status: 'advanced' }
		},

		async get(documentKey) {
			requireDocumentKey(documentKey)
			const database = await openDatabase()
			const transaction = database.transaction(STORE_NAME, 'readwrite')
			const store = transaction.objectStore(STORE_NAME)
			const result = await waitForRequest<unknown>(store.get(documentKey))
			if (result === undefined) {
				await waitForTransaction(transaction)
				return null
			}
			const validated = validateStoredReviewPublication(result, documentKey)
			const current = advanceExpiredCompleted(validated, now())
			if (current !== validated) store.put(current)
			await waitForTransaction(transaction)
			return current
		},

		async markCompleted(documentKey, publicationId, generation, claimId, result) {
			requireCasInputs(documentKey, publicationId, generation, claimId)
			const database = await openDatabase()
			const transaction = database.transaction(STORE_NAME, 'readwrite')
			const store = transaction.objectStore(STORE_NAME)
			const existing = await waitForRequest<unknown>(store.get(documentKey))
			if (existing === undefined) {
				transaction.abort()
				throw new Error('The saved publication no longer exists.')
			}
			const current = validateStoredReviewPublication(existing, documentKey)
			if (current.status === 'completed') {
				if (current.generation !== generation || current.publicationId !== publicationId) {
					transaction.abort()
					throw new Error('Another publication now owns this review generation.')
				}
				await waitForTransaction(transaction)
				return current
			}
			if (
				(current.status !== 'pending' && current.status !== 'indeterminate') ||
				current.generation !== generation ||
				current.prepared.publicationId !== publicationId ||
				(!current.sharedRetry && current.claim?.id !== claimId)
			) {
				transaction.abort()
				throw new Error('Only the claimed pending publication can be completed.')
			}
			const completed = createCompletedReviewPublication({
				completedAt: new Date(now()).toISOString(),
				documentKey,
				prepared: current.prepared,
				result,
			})
			store.put(completed)
			await waitForTransaction(transaction)
			return completed
		},

		async markIndeterminate(
			documentKey,
			publicationId,
			generation,
			claimId,
			requestId,
			uncertainty
		) {
			requireCasInputs(documentKey, publicationId, generation, claimId)
			const database = await openDatabase()
			const transaction = database.transaction(STORE_NAME, 'readwrite')
			const store = transaction.objectStore(STORE_NAME)
			const existing = await waitForRequest<unknown>(store.get(documentKey))
			if (existing === undefined) {
				transaction.abort()
				throw new Error('The saved publication no longer exists.')
			}
			const current = validateStoredReviewPublication(existing, documentKey)
			if (current.status === 'completed') {
				if (current.generation !== generation || current.publicationId !== publicationId) {
					transaction.abort()
					throw new Error('Another publication now owns this review generation.')
				}
				await waitForTransaction(transaction)
				return current
			}
			if (
				(current.status !== 'pending' &&
					!(current.status === 'indeterminate' && current.sharedRetry)) ||
				current.generation !== generation ||
				current.prepared.publicationId !== publicationId ||
				(!current.sharedRetry && current.claim?.id !== claimId)
			) {
				transaction.abort()
				throw new Error('Only the claimed pending publication can become indeterminate.')
			}
			const currentUncertainty = current.status === 'indeterminate' ? current.uncertainty : null
			const mergedUncertainty = mergePublicationUncertainty(currentUncertainty, uncertainty)
			const indeterminate = createStoredReviewPublication({
				documentKey,
				prepared: current.prepared,
				requestId:
					mergedUncertainty === currentUncertainty ? (current.requestId ?? requestId) : requestId,
				sharedRetry: current.sharedRetry,
				status: 'indeterminate',
				uncertainty: mergedUncertainty ?? undefined,
				updatedAt: new Date(now()).toISOString(),
			})
			store.put(indeterminate)
			await waitForTransaction(transaction)
			return indeterminate
		},

		async startNextAttempt(documentKey, expectedGeneration) {
			requireDocumentKey(documentKey)
			if (!isGeneration(expectedGeneration))
				throw new Error('The publication generation is invalid.')
			const database = await openDatabase()
			const transaction = database.transaction(STORE_NAME, 'readwrite')
			const store = transaction.objectStore(STORE_NAME)
			const existing = await waitForRequest<unknown>(store.get(documentKey))
			if (existing === undefined) {
				transaction.abort()
				throw new Error('The completed publication no longer exists.')
			}
			let current = validateStoredReviewPublication(existing, documentKey)
			current = advanceExpiredCompleted(current, now())
			if (current !== existing) store.put(current)
			if (current.status === 'completed' && current.generation === expectedGeneration) {
				const idle = createIdleReviewPublication({
					documentKey,
					generation: expectedGeneration + 1,
					updatedAt: new Date(now()).toISOString(),
				})
				store.put(idle)
				await waitForTransaction(transaction)
				return idle
			}
			await waitForTransaction(transaction)
			return current
		},
	}
}

export const reviewPublicationStore = createIndexedDbReviewPublicationStore()

function advanceExpiredCompleted(
	record: StoredReviewPublication,
	now: number
): StoredReviewPublication {
	if (record.status !== 'completed' || Date.parse(record.expiresAt) > now) return record
	return createIdleReviewPublication({
		documentKey: record.documentKey,
		generation: record.generation + 1,
		updatedAt: new Date(now).toISOString(),
	})
}

function migratePreparedReviewPublication(value: unknown, generation: number) {
	if (!isObject(value)) return value
	const fingerprint = isFingerprint(value.fingerprint)
		? value.fingerprint
		: isObject(value.request) &&
			  isObject(value.request.attachment) &&
			  isFingerprint(value.request.attachment.sha256)
			? value.request.attachment.sha256
			: value.fingerprint
	return { ...value, fingerprint, generation }
}

function isPreparedReviewPublication(value: unknown): value is PreparedReviewPublication {
	if (
		!isObject(value) ||
		!hasExactKeys(value, ['fingerprint', 'generation', 'publicationId', 'request'])
	) {
		return false
	}
	return (
		isFingerprint(value.fingerprint) &&
		isGeneration(value.generation) &&
		isPublicationId(value.publicationId) &&
		isPublicationRequest(value.request)
	)
}

function isSendClaim(value: unknown): value is ReviewPublicationSendClaim | null {
	return (
		value === null ||
		(isObject(value) &&
			hasExactKeys(value, ['claimedAt', 'id']) &&
			isIsoTimestamp(value.claimedAt) &&
			isPublicationId(value.id))
	)
}

function isPublicationUncertainty(value: unknown, publicationId: string, documentKey: string) {
	if (value === null) return true
	if (!isReviewPublicationErrorContext(value) || value.publicationId !== publicationId) return false
	if (value.stage === 'note-creation') return true
	const versionId = /:version-(\d+)$/.exec(documentKey)?.[1]
	return versionId !== undefined && Number(versionId) === value.links.version.id
}

function mergePublicationUncertainty(
	current: ReviewPublicationErrorContext | null,
	next: ReviewPublicationErrorContext | undefined
) {
	if (!current) return next ?? null
	if (!next) return current
	if (
		current.stage !== 'note-creation' &&
		next.stage !== 'note-creation' &&
		current.noteId !== next.noteId
	) {
		throw new Error('Conflicting known Note ids were returned for one publication.')
	}
	if (current.stage === 'attachment-completion' && next.stage === 'attachment-completion') {
		if (current.attachmentId && next.attachmentId && current.attachmentId !== next.attachmentId) {
			throw new Error('Conflicting known Attachment ids were returned for one publication.')
		}
		return next.attachmentId ? next : current
	}
	return publicationUncertaintyRank(next) > publicationUncertaintyRank(current) ? next : current
}

function publicationUncertaintyRank(value: ReviewPublicationErrorContext) {
	return value.stage === 'note-creation' ? 0 : value.stage === 'note-created' ? 1 : 2
}

function isFingerprint(value: unknown): value is string {
	return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function isGeneration(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) >= 0
}

function isPublicationRequest(value: unknown): value is ReviewPublicationRequest {
	if (
		!isObject(value) ||
		!hasExactKeys(value, ['attachment', 'content', 'recipientIds', 'subject'])
	) {
		return false
	}
	if (
		typeof value.subject !== 'string' ||
		value.subject.trim() !== value.subject ||
		value.subject.length === 0 ||
		value.subject.length > MAX_REVIEW_PUBLICATION_SUBJECT_LENGTH ||
		typeof value.content !== 'string' ||
		value.content.trim() !== value.content ||
		value.content.length === 0 ||
		value.content.length > MAX_REVIEW_PUBLICATION_CONTENT_LENGTH ||
		!Array.isArray(value.recipientIds) ||
		value.recipientIds.length > MAX_REVIEW_PUBLICATION_RECIPIENTS ||
		!value.recipientIds.every((id) => Number.isSafeInteger(id) && id > 0) ||
		new Set(value.recipientIds).size !== value.recipientIds.length ||
		!isObject(value.attachment) ||
		!hasExactKeys(value.attachment, ['contentBase64', 'contentType', 'fileName', 'sha256'])
	) {
		return false
	}
	const attachment = value.attachment
	return (
		attachment.contentType === 'image/png' &&
		typeof attachment.fileName === 'string' &&
		attachment.fileName.trim() === attachment.fileName &&
		attachment.fileName.length > 0 &&
		attachment.fileName.length <= 255 &&
		!/[\p{Cc}\p{Bidi_Control}]/u.test(attachment.fileName) &&
		attachment.fileName === attachment.fileName.split(/[\\/]/).at(-1) &&
		attachment.fileName.toLowerCase().endsWith('.png') &&
		isBoundedBase64(attachment.contentBase64) &&
		typeof attachment.sha256 === 'string' &&
		/^[0-9a-f]{64}$/.test(attachment.sha256)
	)
}

function isBoundedBase64(value: unknown): value is string {
	if (
		typeof value !== 'string' ||
		value.length === 0 ||
		value.length > MAX_BASE64_LENGTH ||
		value.length % 4 !== 0 ||
		!/^[A-Za-z0-9+/]*={0,2}$/.test(value)
	) {
		return false
	}
	const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
	const decodedBytes = (value.length / 4) * 3 - padding
	return decodedBytes > 0 && decodedBytes <= MAX_REVIEW_PUBLICATION_PNG_BYTES
}

function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]) {
	const actual = Object.keys(value).sort()
	const expected = keys.slice().sort()
	return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function isPublicationId(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
	)
}

function isDocumentKey(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= 2048 &&
		![...value].some((character) => (character.codePointAt(0) ?? 0) <= 0x1f)
	)
}

function requireDocumentKey(value: string) {
	if (!isDocumentKey(value)) throw new Error('The publication storage key is invalid.')
}

function requireCasInputs(
	documentKey: string,
	publicationId: string,
	generation: number,
	claimId: string
) {
	requireDocumentKey(documentKey)
	if (!isPublicationId(publicationId)) throw new Error('The publication id is invalid.')
	if (!isGeneration(generation)) throw new Error('The publication generation is invalid.')
	if (!isPublicationId(claimId)) throw new Error('The publication sender claim is invalid.')
}

function isRequestId(value: unknown): value is string | null {
	return value === null || (typeof value === 'string' && value.length > 0 && value.length <= 256)
}

function isIsoTimestamp(value: unknown): value is string {
	if (typeof value !== 'string') return false
	const date = new Date(value)
	return !Number.isNaN(date.getTime()) && date.toISOString() === value
}

function invalidRecord() {
	return new Error('The saved publication record is invalid.')
}

function storageError(error: DOMException | null) {
	return new Error(
		error?.name === 'QuotaExceededError'
			? 'Publication storage is full. Free browser storage before publishing.'
			: 'Publication storage could not be accessed.'
	)
}

function waitForRequest<T>(request: IDBRequest<T>) {
	return new Promise<T>((resolve, reject) => {
		request.onerror = () => reject(storageError(request.error))
		request.onsuccess = () => resolve(request.result)
	})
}

function waitForTransaction(transaction: IDBTransaction) {
	return new Promise<void>((resolve, reject) => {
		transaction.onabort = () => reject(storageError(transaction.error))
		transaction.onerror = () => reject(storageError(transaction.error))
		transaction.oncomplete = () => resolve()
	})
}
