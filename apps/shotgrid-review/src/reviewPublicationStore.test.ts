import type { ReviewPublicationResult } from '@tldraw/shotgrid-review-contracts'
import { IDBFactory } from 'fake-indexeddb'
import { describe, expect, it, vi } from 'vitest'
import type { PreparedReviewPublication } from './reviewPublication'
import {
	REVIEW_PUBLICATION_COMPLETED_TTL_MS,
	createIndexedDbReviewPublicationStore,
	createStoredReviewPublication,
	migrateStoredReviewPublication,
	upgradeReviewPublicationDatabase,
	validateStoredReviewPublication,
} from './reviewPublicationStore'

const documentKey = 'review:user-7:playlist-201:version-301'
const publicationId = '11111111-1111-4111-8111-111111111111'
const secondPublicationId = '22222222-2222-4222-8222-222222222222'
const firstClaimId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const secondClaimId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function preparedFor(
	generation = 0,
	id = publicationId,
	content = 'Please address marker 1.'
): PreparedReviewPublication {
	return {
		fingerprint: (generation === 0 ? 'c' : 'd').repeat(64),
		generation,
		publicationId: id,
		request: {
			attachment: {
				contentBase64: 'cG5n',
				contentType: 'image/png',
				fileName: 'shot_010.annotated.png',
				sha256: 'a'.repeat(64),
			},
			content,
			recipientIds: [7],
			subject: 'Review: shot_010',
		},
	}
}

function resultFor(
	id = publicationId,
	content = 'Please address marker 1.',
	noteId = 801
): ReviewPublicationResult {
	return {
		attachment: {
			contentType: 'image/png',
			fileName: 'shot_010.annotated.png',
			id: noteId + 100,
			noteId,
			sizeBytes: 3,
		},
		links: {
			entity: { id: 401, name: 'shot_010', type: 'Shot' },
			project: { id: 101, name: 'Northstar', type: 'Project' },
			task: { id: 501, name: 'Compositing' },
			version: { id: 301, name: 'shot_010', type: 'Version' },
		},
		note: {
			content,
			createdAt: '2026-07-21T00:00:00.000Z',
			createdBy: {
				avatarUrl: null,
				id: 7,
				kind: 'human',
				login: 'reviewer',
				name: 'Reviewer',
			},
			frame: null,
			id: noteId,
			projectId: 101,
			subject: 'Review: shot_010',
			versionId: 301,
		},
		publicationId: id,
		status: 'complete',
	}
}

describe('review publication storage records', () => {
	it('round-trips a generation-bound pending publication', () => {
		const stored = createStoredReviewPublication({
			documentKey,
			prepared: preparedFor(),
			status: 'pending',
		})
		expect(validateStoredReviewPublication(stored, documentKey)).toEqual(stored)
	})

	it('migrates a version-zero pending payload without changing its id or request', () => {
		const currentPrepared = preparedFor()
		const {
			fingerprint: _fingerprint,
			generation: _generation,
			...legacyPrepared
		} = currentPrepared
		const migrated = migrateStoredReviewPublication({
			documentKey,
			kind: 'shotgrid-review-publication',
			pending: legacyPrepared,
			updatedAt: '2026-07-21T00:00:00.000Z',
			version: 0,
		})
		expect(migrated).toEqual({
			claim: null,
			documentKey,
			generation: 0,
			kind: 'shotgrid-review-publication',
			prepared: { ...legacyPrepared, fingerprint: 'a'.repeat(64), generation: 0 },
			requestId: null,
			sharedRetry: false,
			status: 'pending',
			uncertainty: null,
			updatedAt: '2026-07-21T00:00:00.000Z',
			version: 4,
		})
		expect(validateStoredReviewPublication(migrated)).toEqual(migrated)
	})

	it('preserves a version-three non-expiring sender claim during uncertainty migration', () => {
		const current = createStoredReviewPublication({
			claim: { claimedAt: '2026-07-21T00:00:00.000Z', id: firstClaimId },
			documentKey,
			prepared: preparedFor(),
			status: 'pending',
			updatedAt: '2026-07-21T00:00:00.000Z',
		})
		const { uncertainty: _uncertainty, version: _version, ...legacy } = current
		const migrated = validateStoredReviewPublication({ ...legacy, version: 3 })

		expect(migrated).toMatchObject({
			claim: { id: firstClaimId },
			sharedRetry: false,
			uncertainty: null,
			version: 4,
		})
	})

	it('rejects a record under the wrong reviewer and Version key', () => {
		const stored = createStoredReviewPublication({
			documentKey,
			prepared: preparedFor(),
			status: 'pending',
		})
		expect(() =>
			validateStoredReviewPublication(stored, 'review:user-8:playlist-201:version-301')
		).toThrow(/invalid/)
	})

	it('rejects uncertainty metadata for a different publication id', () => {
		expect(() =>
			createStoredReviewPublication({
				documentKey,
				prepared: preparedFor(),
				status: 'indeterminate',
				uncertainty: {
					publicationId: secondPublicationId,
					stage: 'note-creation',
				},
			})
		).toThrow(/invalid/i)
	})

	it('creates the key-path object store only during the first database upgrade', () => {
		const createObjectStore = vi.fn()
		const database = {
			createObjectStore,
			objectStoreNames: { contains: vi.fn(() => false) },
		} as unknown as IDBDatabase

		upgradeReviewPublicationDatabase(database, 0)
		upgradeReviewPublicationDatabase(database, 1)

		expect(createObjectStore).toHaveBeenCalledOnce()
		expect(createObjectStore).toHaveBeenCalledWith('pending-publications', {
			keyPath: 'documentKey',
		})
	})
})

describe('IndexedDB review publication store', () => {
	it('atomically elects one payload writer and recovers that payload in another store', async () => {
		const indexedDb = new IDBFactory()
		const firstStore = createIndexedDbReviewPublicationStore(indexedDb)
		const secondStore = createIndexedDbReviewPublicationStore(indexedDb)
		const first = createStoredReviewPublication({
			documentKey,
			prepared: preparedFor(),
			status: 'pending',
		})
		const competing = createStoredReviewPublication({
			documentKey,
			prepared: preparedFor(0, secondPublicationId),
			status: 'pending',
		})

		const outcomes = await Promise.all([
			firstStore.addIfAbsent(first),
			secondStore.addIfAbsent(competing),
		])
		const winner = outcomes.find((outcome) => outcome.created)
		const follower = outcomes.find((outcome) => !outcome.created)

		expect(winner).toBeDefined()
		expect(follower?.record).toMatchObject({
			prepared: { publicationId: expect.any(String) },
			status: 'pending',
		})
		expect(follower?.record).toEqual(winner?.record)
		await expect(
			createIndexedDbReviewPublicationStore(indexedDb).get(documentKey)
		).resolves.toEqual(winner?.record)
	})

	it('never steals a sender claim, even after arbitrary time, so the original send can finish', async () => {
		let now = Date.parse('2026-07-21T00:00:00.000Z')
		const store = createIndexedDbReviewPublicationStore(new IDBFactory(), () => now)
		await store.addIfAbsent(
			createStoredReviewPublication({
				documentKey,
				prepared: preparedFor(),
				status: 'pending',
			})
		)

		await expect(
			store.claimForSend(documentKey, publicationId, 0, firstClaimId)
		).resolves.toMatchObject({ status: 'claimed' })
		now += 365 * 24 * 60 * 60 * 1000
		await expect(
			store.claimForSend(documentKey, publicationId, 0, secondClaimId)
		).resolves.toMatchObject({ status: 'busy' })
		await expect(
			store.finishSafeFailure(documentKey, publicationId, 0, secondClaimId)
		).resolves.toMatchObject({ status: 'conflict' })
		await expect(
			store.markCompleted(documentKey, publicationId, 0, firstClaimId, resultFor())
		).resolves.toMatchObject({ generation: 0, status: 'completed' })
		await expect(store.get(documentKey)).resolves.toMatchObject({ status: 'completed' })
	})

	it('allows an explicit same-UUID recovery but prevents every safe response from advancing it', async () => {
		const store = createIndexedDbReviewPublicationStore(new IDBFactory())
		await store.addIfAbsent(
			createStoredReviewPublication({
				documentKey,
				prepared: preparedFor(),
				status: 'pending',
			})
		)
		await store.claimForSend(documentKey, publicationId, 0, firstClaimId)

		await expect(
			store.claimForSend(documentKey, publicationId, 0, secondClaimId, true)
		).resolves.toMatchObject({ record: { sharedRetry: true }, status: 'shared' })
		await expect(
			store.finishSafeFailure(documentKey, publicationId, 0, firstClaimId)
		).resolves.toMatchObject({ status: 'conflict' })
		await expect(
			store.finishSafeFailure(documentKey, publicationId, 0, secondClaimId)
		).resolves.toMatchObject({ status: 'conflict' })
		await store.markIndeterminate(documentKey, publicationId, 0, firstClaimId, 'request-note', {
			links: resultFor().links,
			noteId: 801,
			publicationId,
			stage: 'note-created',
		})
		await expect(
			store.markIndeterminate(documentKey, publicationId, 0, secondClaimId, 'request-attachment', {
				attachmentId: 901,
				links: resultFor().links,
				noteId: 801,
				publicationId,
				stage: 'attachment-completion',
			})
		).resolves.toMatchObject({
			uncertainty: { attachmentId: 901, stage: 'attachment-completion' },
		})
		await expect(
			store.markCompleted(documentKey, publicationId, 0, secondClaimId, resultFor())
		).resolves.toMatchObject({ generation: 0, status: 'completed' })
	})

	it('advances generation after a proven-safe owner failure and rejects its stale late success', async () => {
		const store = createIndexedDbReviewPublicationStore(new IDBFactory())
		await store.addIfAbsent(
			createStoredReviewPublication({
				documentKey,
				prepared: preparedFor(),
				status: 'pending',
			})
		)
		await store.claimForSend(documentKey, publicationId, 0, firstClaimId)

		await expect(
			store.finishSafeFailure(documentKey, publicationId, 0, firstClaimId)
		).resolves.toMatchObject({ record: { generation: 1, status: 'idle' }, status: 'advanced' })
		await expect(
			store.markCompleted(documentKey, publicationId, 0, firstClaimId, resultFor())
		).rejects.toThrow(/claimed pending/i)
		await expect(
			store.addIfAbsent(
				createStoredReviewPublication({
					documentKey,
					prepared: preparedFor(),
					status: 'pending',
				})
			)
		).resolves.toMatchObject({ created: false, record: { generation: 1, status: 'idle' } })
	})

	it('keeps completion as a tombstone and explicitly starts a second legal Note generation', async () => {
		const indexedDb = new IDBFactory()
		const store = createIndexedDbReviewPublicationStore(indexedDb)
		await store.addIfAbsent(
			createStoredReviewPublication({
				documentKey,
				prepared: preparedFor(),
				status: 'pending',
			})
		)
		await store.claimForSend(documentKey, publicationId, 0, firstClaimId)
		const completed = await store.markCompleted(
			documentKey,
			publicationId,
			0,
			firstClaimId,
			resultFor()
		)

		await expect(
			createIndexedDbReviewPublicationStore(indexedDb).get(documentKey)
		).resolves.toEqual(completed)
		await expect(
			store.addIfAbsent(
				createStoredReviewPublication({
					documentKey,
					prepared: preparedFor(0, secondPublicationId),
					status: 'pending',
				})
			)
		).resolves.toMatchObject({ created: false, record: { status: 'completed' } })

		await expect(store.startNextAttempt(documentKey, 0)).resolves.toMatchObject({
			generation: 1,
			status: 'idle',
		})
		const secondPrepared = preparedFor(1, secondPublicationId, 'Second review Note.')
		await expect(
			store.addIfAbsent(
				createStoredReviewPublication({
					documentKey,
					prepared: secondPrepared,
					status: 'pending',
				})
			)
		).resolves.toMatchObject({ created: true, record: { generation: 1, status: 'pending' } })
		await store.claimForSend(documentKey, secondPublicationId, 1, secondClaimId)
		await expect(
			store.markCompleted(
				documentKey,
				secondPublicationId,
				1,
				secondClaimId,
				resultFor(secondPublicationId, 'Second review Note.', 802)
			)
		).resolves.toMatchObject({
			generation: 1,
			result: { note: { id: 802 } },
			status: 'completed',
		})
	})

	it('turns an expired completion into the next idle generation without losing its epoch', async () => {
		let now = Date.parse('2026-07-21T00:00:00.000Z')
		const store = createIndexedDbReviewPublicationStore(new IDBFactory(), () => now)
		await store.addIfAbsent(
			createStoredReviewPublication({
				documentKey,
				prepared: preparedFor(),
				status: 'pending',
			})
		)
		await store.claimForSend(documentKey, publicationId, 0, firstClaimId)
		await store.markCompleted(documentKey, publicationId, 0, firstClaimId, resultFor())
		now += REVIEW_PUBLICATION_COMPLETED_TTL_MS

		await expect(store.get(documentKey)).resolves.toMatchObject({ generation: 1, status: 'idle' })
		await expect(
			store.addIfAbsent(
				createStoredReviewPublication({
					documentKey,
					prepared: preparedFor(),
					status: 'pending',
				})
			)
		).resolves.toMatchObject({ created: false, record: { generation: 1, status: 'idle' } })
	})

	it('returns a completed terminal record instead of downgrading it to indeterminate', async () => {
		const store = createIndexedDbReviewPublicationStore(new IDBFactory())
		await store.addIfAbsent(
			createStoredReviewPublication({
				documentKey,
				prepared: preparedFor(),
				status: 'pending',
			})
		)
		await store.claimForSend(documentKey, publicationId, 0, firstClaimId)
		await store.markCompleted(documentKey, publicationId, 0, firstClaimId, resultFor())

		await expect(
			store.markIndeterminate(documentKey, publicationId, 0, firstClaimId, 'request-late')
		).resolves.toMatchObject({ status: 'completed' })
		await expect(store.get(documentKey)).resolves.toMatchObject({ status: 'completed' })
	})

	it('persists the known Note and attachment uncertainty across store recreation', async () => {
		const indexedDb = new IDBFactory()
		const store = createIndexedDbReviewPublicationStore(indexedDb)
		await store.addIfAbsent(
			createStoredReviewPublication({
				documentKey,
				prepared: preparedFor(),
				status: 'pending',
			})
		)
		await store.claimForSend(documentKey, publicationId, 0, firstClaimId)
		const uncertainty = {
			attachmentId: 901,
			links: resultFor().links,
			noteId: 801,
			publicationId,
			stage: 'attachment-completion' as const,
		}

		await expect(
			store.markIndeterminate(
				documentKey,
				publicationId,
				0,
				firstClaimId,
				'request-attachment',
				uncertainty
			)
		).resolves.toMatchObject({ uncertainty })
		await expect(
			createIndexedDbReviewPublicationStore(indexedDb).get(documentKey)
		).resolves.toMatchObject({
			requestId: 'request-attachment',
			status: 'indeterminate',
			uncertainty,
		})
	})

	it('clears a blocked open attempt, retries, and closes a late successful database', async () => {
		const realIndexedDb = new IDBFactory()
		let attempts = 0
		let firstRequest: (IDBOpenDBRequest & { result: IDBDatabase }) | undefined
		const lateDatabase = { close: vi.fn() } as unknown as IDBDatabase
		const indexedDb = {
			open(name: string, version?: number) {
				attempts += 1
				if (attempts > 1) return realIndexedDb.open(name, version)
				const request = { error: null } as unknown as IDBOpenDBRequest & {
					result: IDBDatabase
				}
				firstRequest = request
				queueMicrotask(() => request.onblocked?.(new Event('blocked') as IDBVersionChangeEvent))
				return request
			},
		} as IDBFactory
		const store = createIndexedDbReviewPublicationStore(indexedDb)

		await expect(store.get(documentKey)).rejects.toThrow(/blocked/i)
		await expect(store.get(documentKey)).resolves.toBeNull()
		Object.defineProperty(firstRequest, 'result', { configurable: true, value: lateDatabase })
		firstRequest?.onsuccess?.(new Event('success'))
		expect(lateDatabase.close).toHaveBeenCalledOnce()
	})

	it('clears a synchronously thrown open attempt so the next open can recover', async () => {
		const realIndexedDb = new IDBFactory()
		let attempts = 0
		const indexedDb = {
			open(name: string, version?: number) {
				attempts += 1
				if (attempts === 1) throw new Error('Synchronous open failure')
				return realIndexedDb.open(name, version)
			},
		} as IDBFactory
		const store = createIndexedDbReviewPublicationStore(indexedDb)

		await expect(store.get(documentKey)).rejects.toThrow('Synchronous open failure')
		await expect(store.get(documentKey)).resolves.toBeNull()
		expect(attempts).toBe(2)
	})

	it('surfaces database open failures', async () => {
		const indexedDb = {
			open() {
				throw new Error('Database open failed')
			},
		} as unknown as IDBFactory
		const store = createIndexedDbReviewPublicationStore(indexedDb)
		await expect(store.get(documentKey)).rejects.toThrow(/Database open failed/)
	})
})
