import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { ReviewPublicationRequest } from '../contracts'
import { ReviewGatewayError } from '../errors'
import type { ReviewGateway } from '../gateway/ReviewGateway'
import { ReviewPublicationCoordinator } from './ReviewPublicationCoordinator'
import {
	FileReviewPublicationStore,
	InMemoryReviewPublicationStore,
	minimumReviewPublicationJournalBytes,
	ReviewPublicationStoreError,
	type ReviewPublicationSaveOptions,
	type ReviewPublicationStore,
	type ReviewPublicationStoreErrorCode,
	type ReviewPublicationStoreKey,
	type ReviewPublicationStoreSession,
} from './ReviewPublicationStore'

const PUBLICATION_ID = '018f3f72-1d6b-4c51-8f4b-a12c9d2e3478'
const SECOND_PUBLICATION_ID = '018f3f72-1d6b-4c51-8f4b-a12c9d2e3479'
const REQUEST: ReviewPublicationRequest = {
	attachment: {
		contentBase64: 'cG5n',
		contentType: 'image/png',
		fileName: 'annotation.png',
		sha256: '0'.repeat(64),
	},
	content: 'Move the highlight left',
	recipientIds: [7],
	subject: 'Lighting note',
}
const temporaryDirectories: string[] = []

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true }))
	)
})

describe('ReviewPublicationCoordinator', () => {
	test('reuses a completed result and rejects a changed payload', async () => {
		const gateway = makeGateway()
		const coordinator = new ReviewPublicationCoordinator(gateway)

		const first = await coordinator.publish('actor', PUBLICATION_ID, 201, 301, REQUEST)
		const repeated = await coordinator.publish('actor', PUBLICATION_ID, 201, 301, REQUEST)

		expect(repeated).toEqual(first)
		expect(gateway.createPublicationNote).toHaveBeenCalledOnce()
		expect(gateway.uploadAttachment).toHaveBeenCalledOnce()
		await expect(
			coordinator.publish('actor', PUBLICATION_ID, 201, 301, {
				...REQUEST,
				content: 'Different content',
			})
		).rejects.toMatchObject({ code: 'PUBLICATION_CONFLICT', status: 409 })
	})

	test('continues only the attachment after a safe attachment failure', async () => {
		const uploadAttachment = vi
			.fn<ReviewGateway['uploadAttachment']>()
			.mockRejectedValueOnce(
				new ReviewGatewayError({
					code: 'SHOTGRID_PERMISSION_DENIED',
					retryable: false,
					status: 403,
				})
			)
			.mockResolvedValueOnce(attachmentResult())
		const gateway = makeGateway({ uploadAttachment })
		const coordinator = new ReviewPublicationCoordinator(gateway)

		await expect(
			coordinator.publish('actor', PUBLICATION_ID, 201, 301, REQUEST)
		).rejects.toMatchObject({ code: 'PUBLICATION_INCOMPLETE', retryable: true })
		await expect(
			coordinator.publish('actor', PUBLICATION_ID, 201, 301, REQUEST)
		).resolves.toMatchObject({ status: 'complete' })

		expect(gateway.createPublicationNote).toHaveBeenCalledOnce()
		expect(uploadAttachment).toHaveBeenCalledTimes(2)
	})

	test('single-flights concurrent requests for the same actor and id', async () => {
		let finishUpload!: () => void
		const uploadReady = new Promise<void>((resolve) => (finishUpload = resolve))
		const uploadAttachment = vi.fn<ReviewGateway['uploadAttachment']>(async () => {
			await uploadReady
			return attachmentResult()
		})
		const gateway = makeGateway({ uploadAttachment })
		const coordinator = new ReviewPublicationCoordinator(gateway)

		const first = coordinator.publish('actor', PUBLICATION_ID, 201, 301, REQUEST)
		const second = coordinator.publish('actor', PUBLICATION_ID, 201, 301, REQUEST)
		finishUpload()

		expect(await second).toEqual(await first)
		expect(gateway.createPublicationNote).toHaveBeenCalledOnce()
		expect(uploadAttachment).toHaveBeenCalledOnce()
	})

	test('freezes an indeterminate mutation outcome for the same actor and id', async () => {
		const createPublicationNote = vi.fn<ReviewGateway['createPublicationNote']>(async () => {
			throw new ReviewGatewayError({
				code: 'PUBLICATION_INDETERMINATE',
				retryable: false,
				status: 502,
			})
		})
		const gateway = makeGateway({ createPublicationNote })
		const coordinator = new ReviewPublicationCoordinator(gateway)

		for (let attempt = 0; attempt < 2; attempt++) {
			let caught: unknown
			try {
				await coordinator.publish('actor', PUBLICATION_ID, 201, 301, REQUEST)
			} catch (error) {
				caught = error
			}
			expect(caught).toMatchObject({ code: 'PUBLICATION_INDETERMINATE', retryable: false })
			expect((caught as ReviewGatewayError).publication).toEqual({
				publicationId: PUBLICATION_ID,
				stage: 'note-creation',
			})
		}
		expect(createPublicationNote).toHaveBeenCalledOnce()
		expect(gateway.uploadAttachment).not.toHaveBeenCalled()
	})

	test('freezes unknown gateway failures instead of treating them as safe validation errors', async () => {
		const createPublicationNote = vi.fn<ReviewGateway['createPublicationNote']>(async () => {
			throw new Error('Unexpected regression after the mutation boundary')
		})
		const gateway = makeGateway({ createPublicationNote })
		const coordinator = new ReviewPublicationCoordinator(gateway)

		for (let attempt = 0; attempt < 2; attempt++) {
			await expect(
				coordinator.publish('actor', PUBLICATION_ID, 201, 301, REQUEST)
			).rejects.toMatchObject({ code: 'PUBLICATION_INDETERMINATE', retryable: false })
		}
		expect(createPublicationNote).toHaveBeenCalledOnce()
	})

	test('freezes an unknown attachment failure instead of replaying the upload', async () => {
		const uploadAttachment = vi.fn<ReviewGateway['uploadAttachment']>(async () => {
			throw new Error('Unexpected upload failure')
		})
		const gateway = makeGateway({ uploadAttachment })
		const coordinator = new ReviewPublicationCoordinator(gateway)

		for (let attempt = 0; attempt < 2; attempt++) {
			await expect(
				coordinator.publish('actor', PUBLICATION_ID, 201, 301, REQUEST)
			).rejects.toMatchObject({
				code: 'PUBLICATION_INDETERMINATE',
				publication: {
					noteId: 401,
					publicationId: PUBLICATION_ID,
					stage: 'attachment-completion',
				},
				retryable: false,
			})
		}
		expect(gateway.createPublicationNote).toHaveBeenCalledOnce()
		expect(uploadAttachment).toHaveBeenCalledOnce()
	})

	test('reports a known Note without claiming attachment completion when note persistence fails', async () => {
		const gateway = makeGateway()
		const coordinator = new ReviewPublicationCoordinator(
			gateway,
			new FailOnSaveNumberReviewPublicationStore(2)
		)

		await expect(
			coordinator.publish('actor', PUBLICATION_ID, 201, 301, REQUEST)
		).rejects.toMatchObject({
			code: 'PUBLICATION_INDETERMINATE',
			publication: {
				noteId: 401,
				publicationId: PUBLICATION_ID,
				stage: 'note-created',
			},
		})
		expect(gateway.uploadAttachment).not.toHaveBeenCalled()
	})

	test('retains a known Attachment id when completing the journal fails', async () => {
		const store = new FailOnSaveNumberReviewPublicationStore(4)
		const gateway = makeGateway()
		const coordinator = new ReviewPublicationCoordinator(gateway, store)

		for (let attempt = 0; attempt < 2; attempt++) {
			await expect(
				coordinator.publish('actor', PUBLICATION_ID, 201, 301, REQUEST)
			).rejects.toMatchObject({
				code: 'PUBLICATION_INDETERMINATE',
				publication: {
					attachmentId: 501,
					noteId: 401,
					publicationId: PUBLICATION_ID,
					stage: 'attachment-completion',
				},
			})
		}
		expect(gateway.createPublicationNote).toHaveBeenCalledOnce()
		expect(gateway.uploadAttachment).toHaveBeenCalledOnce()
	})

	test('does not evict an idempotency record when capacity is reached', async () => {
		const gateway = makeGateway()
		const coordinator = new ReviewPublicationCoordinator(
			gateway,
			new InMemoryReviewPublicationStore(1)
		)

		const first = await coordinator.publish('actor', PUBLICATION_ID, 201, 301, REQUEST)
		await expect(
			coordinator.publish('actor', SECOND_PUBLICATION_ID, 201, 301, REQUEST)
		).rejects.toMatchObject({ code: 'SHOTGRID_RATE_LIMITED', status: 429 })
		await expect(coordinator.publish('actor', PUBLICATION_ID, 201, 301, REQUEST)).resolves.toEqual(
			first
		)
	})

	test('does not retain journals for safe pre-mutation ShotGrid failures', async () => {
		const directory = await makeTemporaryStoreDirectory()
		const createPublicationNote = vi.fn<ReviewGateway['createPublicationNote']>(async () => {
			throw new ReviewGatewayError({ code: 'NOT_FOUND', retryable: false, status: 404 })
		})
		const gateway = makeGateway({ createPublicationNote })
		const coordinator = new ReviewPublicationCoordinator(
			gateway,
			new FileReviewPublicationStore(directory, { maxJournalCount: 1 })
		)
		const publicationIds = [
			'018f3f72-1d6b-4c51-8f4b-a12c9d2e3470',
			'018f3f72-1d6b-4c51-8f4b-a12c9d2e3471',
			'018f3f72-1d6b-4c51-8f4b-a12c9d2e3472',
		]

		for (const publicationId of publicationIds) {
			await expect(
				coordinator.publish('actor', publicationId, 201, 301, REQUEST)
			).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 })
		}
		expect(createPublicationNote).toHaveBeenCalledTimes(publicationIds.length)
		expect((await readdir(directory)).filter((name) => name.endsWith('.jsonl'))).toEqual([])
	})

	test('rejects a new durable key at capacity before mutation but still reads an existing result', async () => {
		const directory = await makeTemporaryStoreDirectory()
		const store = new FileReviewPublicationStore(directory, { maxJournalCount: 1 })
		const gateway = makeGateway()
		const coordinator = new ReviewPublicationCoordinator(gateway, store)
		const first = await coordinator.publish('actor', PUBLICATION_ID, 201, 301, REQUEST)

		await expect(
			coordinator.publish('actor', SECOND_PUBLICATION_ID, 201, 301, REQUEST)
		).rejects.toMatchObject({ code: 'SHOTGRID_RATE_LIMITED', retryable: true, status: 429 })
		await expect(coordinator.publish('actor', PUBLICATION_ID, 201, 301, REQUEST)).resolves.toEqual(
			first
		)
		expect(gateway.createPublicationNote).toHaveBeenCalledOnce()
		expect(gateway.uploadAttachment).toHaveBeenCalledOnce()
	})

	test('reuses a complete publication after a durable-store restart', async () => {
		const directory = await makeTemporaryStoreDirectory()
		const firstStore = new FileReviewPublicationStore(directory)
		await firstStore.initialize()
		const firstGateway = makeGateway()
		const first = await new ReviewPublicationCoordinator(firstGateway, firstStore).publish(
			'actor',
			PUBLICATION_ID,
			201,
			301,
			REQUEST
		)
		const journal = (await readdir(directory)).find((fileName) => fileName.endsWith('.jsonl'))
		expect(journal).toBeDefined()
		const journalText = await readFile(join(directory, journal!), 'utf8')
		expect(journalText).not.toContain(REQUEST.attachment.contentBase64)
		expect(journalText).toContain('uploading-attachment')
		expect(journalText).toContain('complete')

		const secondStore = new FileReviewPublicationStore(directory)
		await secondStore.initialize()
		const secondGateway = makeGateway()
		await expect(
			new ReviewPublicationCoordinator(secondGateway, secondStore).publish(
				'actor',
				PUBLICATION_ID,
				201,
				301,
				REQUEST
			)
		).resolves.toEqual(first)
		expect(secondGateway.createPublicationNote).not.toHaveBeenCalled()
		expect(secondGateway.uploadAttachment).not.toHaveBeenCalled()
	})

	test('resumes only the attachment from a durable note-created stage', async () => {
		const directory = await makeTemporaryStoreDirectory()
		const firstStore = new FileReviewPublicationStore(directory)
		await firstStore.initialize()
		const firstGateway = makeGateway({
			uploadAttachment: vi.fn(async () => {
				throw new ReviewGatewayError({
					code: 'SHOTGRID_PERMISSION_DENIED',
					retryable: false,
					status: 403,
				})
			}),
		})
		await expect(
			new ReviewPublicationCoordinator(firstGateway, firstStore).publish(
				'actor',
				PUBLICATION_ID,
				201,
				301,
				REQUEST
			)
		).rejects.toMatchObject({ code: 'PUBLICATION_INCOMPLETE', retryable: true })

		const secondStore = new FileReviewPublicationStore(directory)
		await secondStore.initialize()
		const secondGateway = makeGateway()
		await expect(
			new ReviewPublicationCoordinator(secondGateway, secondStore).publish(
				'actor',
				PUBLICATION_ID,
				201,
				301,
				REQUEST
			)
		).resolves.toMatchObject({ status: 'complete' })
		expect(secondGateway.createPublicationNote).not.toHaveBeenCalled()
		expect(secondGateway.uploadAttachment).toHaveBeenCalledOnce()
	})

	test('freezes a durable uploading stage after a simulated process crash', async () => {
		const directory = await makeTemporaryStoreDirectory()
		const store = new FileReviewPublicationStore(directory)
		await store.initialize()
		const failingGateway = makeGateway({
			uploadAttachment: vi.fn(async () => {
				throw new ReviewGatewayError({
					code: 'SHOTGRID_PERMISSION_DENIED',
					retryable: false,
					status: 403,
				})
			}),
		})
		await expect(
			new ReviewPublicationCoordinator(failingGateway, store).publish(
				'actor',
				PUBLICATION_ID,
				201,
				301,
				REQUEST
			)
		).rejects.toMatchObject({ code: 'PUBLICATION_INCOMPLETE' })
		await store.runExclusive<Record<string, unknown>, void>(
			{ actorScope: 'actor', playlistId: 201, publicationId: PUBLICATION_ID, versionId: 301 },
			async (session) => {
				if (!session.record) throw new Error('Expected a note-created publication record')
				await session.save({ ...session.record, stage: 'uploading-attachment' })
			}
		)

		const restartedStore = new FileReviewPublicationStore(directory)
		await restartedStore.initialize()
		const restartedGateway = makeGateway()
		const restarted = new ReviewPublicationCoordinator(restartedGateway, restartedStore)
		for (let attempt = 0; attempt < 2; attempt++) {
			await expect(
				restarted.publish('actor', PUBLICATION_ID, 201, 301, REQUEST)
			).rejects.toMatchObject({
				code: 'PUBLICATION_INDETERMINATE',
				publication: {
					noteId: 401,
					publicationId: PUBLICATION_ID,
					stage: 'attachment-completion',
				},
				retryable: false,
			})
		}
		const journalText = await readFile(
			join(directory, (await readdir(directory)).find((name) => name.endsWith('.jsonl'))!),
			'utf8'
		)
		expect(journalText).toContain('attachment-completion-indeterminate')
		expect(journalText).toContain('"id":401')
		expect(restartedGateway.createPublicationNote).not.toHaveBeenCalled()
		expect(restartedGateway.uploadAttachment).not.toHaveBeenCalled()
	})

	test('treats store corruption as indeterminate so the publication id is retained', async () => {
		const gateway = makeGateway()
		const coordinator = new ReviewPublicationCoordinator(
			gateway,
			new FailingReviewPublicationStore('CORRUPT_JOURNAL')
		)

		await expect(
			coordinator.publish('actor', PUBLICATION_ID, 201, 301, REQUEST)
		).rejects.toMatchObject({ code: 'PUBLICATION_INDETERMINATE', retryable: false })
		expect(gateway.createPublicationNote).not.toHaveBeenCalled()
	})

	test('treats unavailable pre-action publication history as indeterminate', async () => {
		const gateway = makeGateway()
		const coordinator = new ReviewPublicationCoordinator(
			gateway,
			new FailingReviewPublicationStore('STORE_STATE_UNAVAILABLE')
		)

		await expect(
			coordinator.publish('actor', PUBLICATION_ID, 201, 301, REQUEST)
		).rejects.toMatchObject({ code: 'PUBLICATION_INDETERMINATE', retryable: false })
		expect(gateway.createPublicationNote).not.toHaveBeenCalled()
		expect(gateway.uploadAttachment).not.toHaveBeenCalled()
	})

	test('treats a semantically corrupt stored record as indeterminate', async () => {
		const gateway = makeGateway()
		const coordinator = new ReviewPublicationCoordinator(
			gateway,
			new CorruptRecordReviewPublicationStore()
		)

		await expect(
			coordinator.publish('actor', PUBLICATION_ID, 201, 301, REQUEST)
		).rejects.toMatchObject({ code: 'PUBLICATION_INDETERMINATE', retryable: false })
		expect(gateway.createPublicationNote).not.toHaveBeenCalled()
	})

	test('fails safely when the initial durable write fails before a mutation', async () => {
		const gateway = makeGateway()
		const coordinator = new ReviewPublicationCoordinator(
			gateway,
			new InitialSaveFailureReviewPublicationStore()
		)

		await expect(
			coordinator.publish('actor', PUBLICATION_ID, 201, 301, REQUEST)
		).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR', retryable: false })
		expect(gateway.createPublicationNote).not.toHaveBeenCalled()
	})

	test('does not create a Note when mutation-boundary capacity cannot be reserved', async () => {
		const gateway = makeGateway()
		const coordinator = new ReviewPublicationCoordinator(
			gateway,
			new RejectReservedSaveReviewPublicationStore()
		)

		await expect(
			coordinator.publish('actor', PUBLICATION_ID, 201, 301, REQUEST)
		).rejects.toMatchObject({ code: 'SHOTGRID_RATE_LIMITED', retryable: true, status: 429 })
		expect(gateway.createPublicationNote).not.toHaveBeenCalled()
		expect(gateway.uploadAttachment).not.toHaveBeenCalled()
	})

	test('retains a known Note when attachment capacity cannot be reserved across retries and restart', async () => {
		const directory = await makeTemporaryStoreDirectory()
		const maxRecordBytes = 1_024
		const options = {
			maxJournalBytes: minimumReviewPublicationJournalBytes(maxRecordBytes),
			maxJournalReadBytes: 4_096,
			maxRecordBytes,
		} as const
		const firstGateway = makeGateway()
		const firstCoordinator = new ReviewPublicationCoordinator(
			firstGateway,
			new FileReviewPublicationStore(directory, options)
		)

		for (let attempt = 0; attempt < 2; attempt++) {
			await expect(
				firstCoordinator.publish('actor', PUBLICATION_ID, 201, 301, REQUEST)
			).rejects.toMatchObject({ code: 'PUBLICATION_INCOMPLETE', retryable: true })
		}
		expect(firstGateway.createPublicationNote).toHaveBeenCalledOnce()
		expect(firstGateway.uploadAttachment).not.toHaveBeenCalled()

		const restartedGateway = makeGateway()
		await expect(
			new ReviewPublicationCoordinator(
				restartedGateway,
				new FileReviewPublicationStore(directory, options)
			).publish('actor', PUBLICATION_ID, 201, 301, REQUEST)
		).rejects.toMatchObject({ code: 'PUBLICATION_INCOMPLETE', retryable: true })
		expect(restartedGateway.createPublicationNote).not.toHaveBeenCalled()
		expect(restartedGateway.uploadAttachment).not.toHaveBeenCalled()
		const journalText = await readFile(
			join(directory, (await readdir(directory)).find((name) => name.endsWith('.jsonl'))!),
			'utf8'
		)
		expect(journalText).toContain('note-created')
		expect(journalText).not.toContain('uploading-attachment')
	})

	test('maps publication store lock contention to a retryable response', async () => {
		const gateway = makeGateway()
		const coordinator = new ReviewPublicationCoordinator(
			gateway,
			new FailingReviewPublicationStore('LOCK_TIMEOUT')
		)

		await expect(
			coordinator.publish('actor', PUBLICATION_ID, 201, 301, REQUEST)
		).rejects.toMatchObject({ code: 'SHOTGRID_RATE_LIMITED', retryable: true, status: 429 })
		expect(gateway.createPublicationNote).not.toHaveBeenCalled()
	})

	test('treats an IO failure after reading a complete record as indeterminate', async () => {
		const innerStore = new InMemoryReviewPublicationStore()
		const firstGateway = makeGateway()
		await new ReviewPublicationCoordinator(firstGateway, innerStore).publish(
			'actor',
			PUBLICATION_ID,
			201,
			301,
			REQUEST
		)
		const secondGateway = makeGateway()
		const coordinator = new ReviewPublicationCoordinator(
			secondGateway,
			new FailAfterActionReviewPublicationStore(innerStore)
		)

		await expect(
			coordinator.publish('actor', PUBLICATION_ID, 201, 301, REQUEST)
		).rejects.toMatchObject({ code: 'PUBLICATION_INDETERMINATE', retryable: false })
		expect(secondGateway.createPublicationNote).not.toHaveBeenCalled()
		expect(secondGateway.uploadAttachment).not.toHaveBeenCalled()
	})

	test('treats capacity ambiguity after reading prior mutation state as indeterminate', async () => {
		const innerStore = new InMemoryReviewPublicationStore()
		await new ReviewPublicationCoordinator(makeGateway(), innerStore).publish(
			'actor',
			PUBLICATION_ID,
			201,
			301,
			REQUEST
		)
		const gateway = makeGateway()
		const coordinator = new ReviewPublicationCoordinator(
			gateway,
			new FailAfterActionReviewPublicationStore(innerStore, 'STORE_CAPACITY_EXCEEDED')
		)

		await expect(
			coordinator.publish('actor', PUBLICATION_ID, 201, 301, REQUEST)
		).rejects.toMatchObject({ code: 'PUBLICATION_INDETERMINATE', retryable: false })
		expect(gateway.createPublicationNote).not.toHaveBeenCalled()
		expect(gateway.uploadAttachment).not.toHaveBeenCalled()
	})
})

function makeGateway(overrides: Partial<ReviewGateway> = {}) {
	return {
		createPublicationNote: vi.fn<ReviewGateway['createPublicationNote']>(async () => ({
			links: {
				entity: { id: 501, name: 'shot_010', type: 'Shot' },
				project: { id: 101, name: 'Project', type: 'Project' },
				task: { id: 601, name: 'Lighting' },
				version: { id: 301, name: 'shot_v001', type: 'Version' },
			},
			note: {
				content: REQUEST.content,
				createdAt: '2026-07-20T00:00:00.000Z',
				createdBy: {
					avatarUrl: null,
					id: 7,
					kind: 'human',
					login: 'reviewer',
					name: 'Reviewer',
				},
				frame: null,
				id: 401,
				projectId: 101,
				subject: REQUEST.subject,
				versionId: 301,
			},
		})),
		uploadAttachment: vi.fn<ReviewGateway['uploadAttachment']>(async () => attachmentResult()),
		...overrides,
	} as ReviewGateway
}

function attachmentResult() {
	return {
		contentType: 'image/png',
		fileName: 'annotation.png',
		id: 501,
		noteId: 401,
		sizeBytes: 3,
	}
}

async function makeTemporaryStoreDirectory() {
	const directory = await mkdtemp(join(tmpdir(), 'shotgrid-review-publications-'))
	temporaryDirectories.push(directory)
	return directory
}

class FailingReviewPublicationStore implements ReviewPublicationStore {
	constructor(private readonly code: ReviewPublicationStoreErrorCode) {}

	async initialize() {}

	async runExclusive<TRecord, TResult>(
		_key: ReviewPublicationStoreKey,
		_action: (session: ReviewPublicationStoreSession<TRecord>) => Promise<TResult>
	): Promise<TResult> {
		throw new ReviewPublicationStoreError(this.code, 'Simulated store failure')
	}
}

class InitialSaveFailureReviewPublicationStore implements ReviewPublicationStore {
	async initialize() {}

	async runExclusive<TRecord, TResult>(
		_key: ReviewPublicationStoreKey,
		action: (session: ReviewPublicationStoreSession<TRecord>) => Promise<TResult>
	): Promise<TResult> {
		return await action({
			clear: async () => {},
			record: null,
			save: async () => {
				throw new ReviewPublicationStoreError('IO_ERROR', 'Simulated initial write failure')
			},
		})
	}
}

class RejectReservedSaveReviewPublicationStore implements ReviewPublicationStore {
	async initialize() {}

	async runExclusive<TRecord, TResult>(
		_key: ReviewPublicationStoreKey,
		action: (session: ReviewPublicationStoreSession<TRecord>) => Promise<TResult>
	): Promise<TResult> {
		return await action({
			clear: async () => {},
			record: null,
			save: async (_record: TRecord, options?: ReviewPublicationSaveOptions) => {
				if (options?.reserveNextRecord) {
					throw new ReviewPublicationStoreError(
						'STORE_CAPACITY_EXCEEDED',
						'Simulated reservation failure'
					)
				}
			},
		})
	}
}

class CorruptRecordReviewPublicationStore implements ReviewPublicationStore {
	async initialize() {}

	async runExclusive<TRecord, TResult>(
		_key: ReviewPublicationStoreKey,
		action: (session: ReviewPublicationStoreSession<TRecord>) => Promise<TResult>
	): Promise<TResult> {
		return await action({
			clear: async () => {},
			record: {
				fingerprint: '0'.repeat(64),
				stage: 'complete',
				unexpected: true,
				version: 1,
			} as TRecord,
			save: async () => {},
		})
	}
}

class FailAfterActionReviewPublicationStore implements ReviewPublicationStore {
	constructor(
		private readonly inner: ReviewPublicationStore,
		private readonly code: ReviewPublicationStoreErrorCode = 'IO_ERROR'
	) {}

	async initialize() {
		await this.inner.initialize()
	}

	async runExclusive<TRecord, TResult>(
		key: ReviewPublicationStoreKey,
		action: (session: ReviewPublicationStoreSession<TRecord>) => Promise<TResult>
	): Promise<TResult> {
		await this.inner.runExclusive<TRecord, TResult>(key, action)
		throw new ReviewPublicationStoreError(this.code, 'Simulated release failure')
	}
}

class FailOnSaveNumberReviewPublicationStore implements ReviewPublicationStore {
	private readonly inner = new InMemoryReviewPublicationStore()
	private saveCount = 0

	constructor(private readonly failOnSave: number) {}

	async initialize() {}

	async runExclusive<TRecord, TResult>(
		key: ReviewPublicationStoreKey,
		action: (session: ReviewPublicationStoreSession<TRecord>) => Promise<TResult>
	): Promise<TResult> {
		return await this.inner.runExclusive<TRecord, TResult>(key, async (session) =>
			action({
				clear: () => session.clear(),
				record: session.record,
				save: async (record) => {
					this.saveCount += 1
					if (this.saveCount === this.failOnSave) {
						throw new ReviewPublicationStoreError('IO_ERROR', 'Simulated save failure')
					}
					await session.save(record)
				},
			})
		)
	}
}
