import {
	chmodSync,
	closeSync,
	constants,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	openSync,
	rmSync,
	symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
	InMemoryReviewAuditStore,
	SqliteReviewAuditStore,
	type ReviewAuditIntent,
	type ReviewAuditOutcome,
} from './ReviewAuditStore'

const FIRST_ATTEMPT_ID = '10000000-0000-4000-8000-000000000001'
const SECOND_ATTEMPT_ID = '10000000-0000-4000-8000-000000000002'

const intent: ReviewAuditIntent = {
	action: 'publication',
	effectiveActor: { id: 42, kind: 'human' },
	playlistId: 201,
	principalId: 'principal:8f2a17',
	projectId: 101,
	requestId: 'request-1',
	versionId: 301,
}

const success: ReviewAuditOutcome = {
	decisionStatus: null,
	errorCode: null,
	resultAttachmentId: 501,
	resultNoteId: 401,
	status: 'succeeded',
}

const temporaryDirectories: string[] = []
const sqliteStores: SqliteReviewAuditStore[] = []

afterEach(() => {
	vi.restoreAllMocks()
	for (const store of sqliteStores.splice(0)) store.close()
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { force: true, recursive: true })
	}
})

describe('InMemoryReviewAuditStore', () => {
	test('appends a fixed attempt and outcome schema with monotonic sequences', async () => {
		const timestamps = [1_000, 2_000]
		const store = new InMemoryReviewAuditStore({
			now: () => timestamps.shift() ?? 3_000,
			randomUUID: () => FIRST_ATTEMPT_ID,
		})
		const mutableIntent = { ...intent, effectiveActor: { ...intent.effectiveActor } }

		const attemptId = await store.begin(mutableIntent)
		mutableIntent.requestId = 'changed-after-begin'
		mutableIntent.effectiveActor.id = 99
		await store.finish(attemptId, success)

		expect(store.getEntries()).toEqual([
			{
				...intent,
				attemptId: FIRST_ATTEMPT_ID,
				decisionStatus: null,
				entryKind: 'attempt',
				errorCode: null,
				outcome: null,
				resultAttachmentId: null,
				resultNoteId: null,
				sequence: 1,
				timestampMs: 1_000,
			},
			{
				...intent,
				attemptId: FIRST_ATTEMPT_ID,
				decisionStatus: null,
				entryKind: 'outcome',
				errorCode: null,
				outcome: 'succeeded',
				resultAttachmentId: 501,
				resultNoteId: 401,
				sequence: 2,
				timestampMs: 2_000,
			},
		])

		const snapshot = store.getEntries()
		snapshot[0].effectiveActor.id = 777
		expect(store.getEntries()[0].effectiveActor.id).toBe(42)
	})

	test('rejects additional or unbounded fields rather than persisting sensitive payloads', async () => {
		const store = new InMemoryReviewAuditStore()
		await expect(
			store.begin({ ...intent, token: 'must-not-be-stored' } as ReviewAuditIntent)
		).rejects.toMatchObject({ code: 'INVALID_INTENT' })
		await expect(
			store.begin({
				...intent,
				effectiveActor: { ...intent.effectiveActor, login: 'reviewer@example.com' },
			} as ReviewAuditIntent)
		).rejects.toMatchObject({ code: 'INVALID_INTENT' })

		const attemptId = await store.begin(intent)
		await expect(
			store.finish(attemptId, { ...success, png: 'base64-data' } as ReviewAuditOutcome)
		).rejects.toMatchObject({ code: 'INVALID_OUTCOME' })
		expect(store.getEntries()).toHaveLength(1)
	})

	test('reserves outcome capacity before allowing a caller to mutate', async () => {
		const ids = [FIRST_ATTEMPT_ID, SECOND_ATTEMPT_ID]
		const store = new InMemoryReviewAuditStore({
			maxEntries: 4,
			randomUUID: () => ids.shift() ?? '10000000-0000-4000-8000-000000000003',
		})
		const first = await store.begin(intent)
		const second = await store.begin({ ...intent, requestId: 'request-2' })
		let externalMutationRan = false

		try {
			await store.begin({ ...intent, requestId: 'request-3' })
			externalMutationRan = true
		} catch (error) {
			expect(error).toMatchObject({ code: 'STORE_CAPACITY_EXCEEDED' })
		}
		expect(externalMutationRan).toBe(false)

		await store.finish(first, success)
		await store.finish(second, success)
		expect(store.getEntries().map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4])
	})

	test('rejects unknown attempts, duplicate outcomes, invalid status combinations, and invalid clocks', async () => {
		const store = new InMemoryReviewAuditStore({ randomUUID: () => FIRST_ATTEMPT_ID })
		await expect(store.finish(FIRST_ATTEMPT_ID, success)).rejects.toMatchObject({
			code: 'ATTEMPT_NOT_FOUND',
		})
		const attemptId = await store.begin(intent)
		await expect(
			store.finish(attemptId, { ...success, errorCode: 'INTERNAL_ERROR' })
		).rejects.toMatchObject({ code: 'INVALID_OUTCOME' })
		await store.finish(attemptId, success)
		await expect(store.finish(attemptId, success)).rejects.toMatchObject({
			code: 'ATTEMPT_ALREADY_FINISHED',
		})

		const invalidClock = new InMemoryReviewAuditStore({ now: () => Number.NaN })
		await expect(invalidClock.begin(intent)).rejects.toMatchObject({
			code: 'STORE_STATE_UNAVAILABLE',
		})
	})
})

describe('SqliteReviewAuditStore', () => {
	test('durably appends complete rows and preserves sequence monotonicity across restarts', async () => {
		const directory = makeStoreDirectory()
		let timestamp = 10_000
		const firstStore = track(
			new SqliteReviewAuditStore(directory, {
				now: () => timestamp++,
				randomUUID: () => FIRST_ATTEMPT_ID,
			})
		)
		const first = await firstStore.begin(intent)
		await firstStore.finish(first, success)
		firstStore.close()

		const secondStore = track(
			new SqliteReviewAuditStore(directory, {
				now: () => timestamp++,
				randomUUID: () => SECOND_ATTEMPT_ID,
			})
		)
		const second = await secondStore.begin({
			...intent,
			action: 'decision',
			requestId: 'request-2',
		})
		await secondStore.finish(second, {
			decisionStatus: 'apr',
			errorCode: null,
			resultAttachmentId: null,
			resultNoteId: null,
			status: 'succeeded',
		})
		secondStore.close()

		const rows = readAuditRows(directory)
		expect(rows.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4])
		expect(rows).toEqual([
			expect.objectContaining({
				action: 'publication',
				attempt_id: FIRST_ATTEMPT_ID,
				entry_kind: 'attempt',
				outcome: null,
				principal_id: intent.principalId,
				request_id: intent.requestId,
				sequence: 1,
			}),
			expect.objectContaining({
				attempt_id: FIRST_ATTEMPT_ID,
				entry_kind: 'outcome',
				outcome: 'succeeded',
				result_attachment_id: 501,
				result_note_id: 401,
				sequence: 2,
			}),
			expect.objectContaining({
				action: 'decision',
				attempt_id: SECOND_ATTEMPT_ID,
				entry_kind: 'attempt',
				request_id: 'request-2',
				sequence: 3,
			}),
			expect.objectContaining({
				attempt_id: SECOND_ATTEMPT_ID,
				decision_status: 'apr',
				entry_kind: 'outcome',
				sequence: 4,
			}),
		])

		expect(Object.keys(rows[0]).sort()).toEqual(
			[
				'action',
				'attempt_id',
				'decision_status',
				'effective_actor_id',
				'effective_actor_kind',
				'entry_kind',
				'error_code',
				'outcome',
				'playlist_id',
				'principal_id',
				'project_id',
				'request_id',
				'result_attachment_id',
				'result_note_id',
				'sequence',
				'timestamp_ms',
				'version_id',
			].sort()
		)
	})

	test('enforces append-only rows in SQLite itself', async () => {
		const directory = makeStoreDirectory()
		const store = track(
			new SqliteReviewAuditStore(directory, { randomUUID: () => FIRST_ATTEMPT_ID })
		)
		await store.begin(intent)
		store.close()

		const database = new DatabaseSync(join(directory, 'review-audit.sqlite'))
		try {
			expect(() =>
				database.prepare('UPDATE review_audit_entries SET request_id = ?').run('rewritten')
			).toThrow(/append-only/)
			expect(() => database.prepare('DELETE FROM review_audit_entries').run()).toThrow(
				/append-only/
			)
			expect(
				(
					database.prepare('SELECT COUNT(*) AS value FROM review_audit_entries').get() as {
						value: number
					}
				).value
			).toBe(1)
		} finally {
			database.close()
		}
	})

	test('persists unfinished capacity reservations and still permits their outcome', async () => {
		const directory = makeStoreDirectory()
		const firstStore = track(
			new SqliteReviewAuditStore(directory, {
				maxEntries: 2,
				randomUUID: () => FIRST_ATTEMPT_ID,
			})
		)
		const attemptId = await firstStore.begin(intent)
		firstStore.close()

		const secondStore = track(
			new SqliteReviewAuditStore(directory, {
				maxEntries: 2,
				randomUUID: () => SECOND_ATTEMPT_ID,
			})
		)
		await expect(secondStore.begin({ ...intent, requestId: 'request-2' })).rejects.toMatchObject({
			code: 'STORE_CAPACITY_EXCEEDED',
		})
		await secondStore.finish(attemptId, success)
		expect(readAuditRowsAfterClose(secondStore, directory)).toHaveLength(2)
	})

	test('does not append invalid intents or outcomes', async () => {
		const directory = makeStoreDirectory()
		const store = track(
			new SqliteReviewAuditStore(directory, { randomUUID: () => FIRST_ATTEMPT_ID })
		)
		await expect(
			store.begin({ ...intent, url: 'https://secret.invalid' } as ReviewAuditIntent)
		).rejects.toMatchObject({ code: 'INVALID_INTENT' })
		const attemptId = await store.begin(intent)
		await expect(
			store.finish(attemptId, {
				...success,
				errorCode: 'SHOTGRID_TIMEOUT',
				status: 'succeeded',
			})
		).rejects.toMatchObject({ code: 'INVALID_OUTCOME' })
		store.close()
		expect(readAuditRows(directory)).toHaveLength(1)
	})

	test('rejects relative directories and unsafe existing database entries', () => {
		expect(() => new SqliteReviewAuditStore('relative/audit')).toThrow(
			expect.objectContaining({ code: 'INVALID_PATH' })
		)
		expect(() => new SqliteReviewAuditStore('\\\\server\\share\\audit')).toThrow(
			expect.objectContaining({ code: 'INVALID_PATH' })
		)
		const directory = makeStoreDirectory()
		const databasePath = join(directory, 'review-audit.sqlite')
		mkdirSync(directory, { mode: 0o700 })
		mkdirSync(databasePath)
		expect(() => new SqliteReviewAuditStore(directory)).toThrow(
			expect.objectContaining({ code: 'INVALID_PATH' })
		)
	})
})

describe.skipIf(process.platform === 'win32')('SqliteReviewAuditStore POSIX path security', () => {
	test('creates an owner-only directory and database', () => {
		const directory = makeStoreDirectory()
		const store = track(new SqliteReviewAuditStore(directory))
		expect(lstatSync(directory).mode & 0o777).toBe(0o700)
		expect(lstatSync(join(directory, 'review-audit.sqlite')).mode & 0o777).toBe(0o600)
		store.close()
	})

	test('rejects a symlink component and a symlink database', () => {
		const root = makeTemporaryRoot()
		const realDirectory = join(root, 'real')
		const linkedDirectory = join(root, 'linked')
		mkdirSync(realDirectory, { mode: 0o700 })
		symlinkSync(realDirectory, linkedDirectory, 'dir')
		expect(() => new SqliteReviewAuditStore(linkedDirectory)).toThrow(
			expect.objectContaining({ code: 'INVALID_PATH' })
		)

		const secureDirectory = join(root, 'secure')
		mkdirSync(secureDirectory, { mode: 0o700 })
		const target = join(root, 'target.sqlite')
		const descriptor = openSync(
			target,
			constants.O_CREAT | constants.O_EXCL | constants.O_RDWR,
			0o600
		)
		closeSync(descriptor)
		symlinkSync(target, join(secureDirectory, 'review-audit.sqlite'), 'file')
		expect(() => new SqliteReviewAuditStore(secureDirectory)).toThrow(
			expect.objectContaining({ code: 'INVALID_PATH' })
		)
	})

	test('rejects broad permissions on an existing directory or database', () => {
		const root = makeTemporaryRoot()
		const broadDirectory = join(root, 'broad')
		mkdirSync(broadDirectory, { mode: 0o700 })
		chmodSync(broadDirectory, 0o755)
		expect(() => new SqliteReviewAuditStore(broadDirectory)).toThrow(
			expect.objectContaining({ code: 'INVALID_PATH' })
		)

		const secureDirectory = join(root, 'secure')
		const store = track(new SqliteReviewAuditStore(secureDirectory))
		store.close()
		chmodSync(join(secureDirectory, 'review-audit.sqlite'), 0o644)
		expect(() => new SqliteReviewAuditStore(secureDirectory)).toThrow(
			expect.objectContaining({ code: 'INVALID_PATH' })
		)
	})

	test('rejects a store not owned by the current uid', () => {
		const directory = makeStoreDirectory()
		mkdirSync(directory, { mode: 0o700 })
		const actualUid = process.getuid?.()
		if (actualUid === undefined) throw new Error('Expected process.getuid on POSIX')
		vi.spyOn(process, 'getuid').mockReturnValue(actualUid + 1)
		expect(() => new SqliteReviewAuditStore(directory)).toThrow(
			expect.objectContaining({ code: 'INVALID_PATH' })
		)
	})
})

function makeTemporaryRoot() {
	const directory = mkdtempSync(join(tmpdir(), 'shotgrid-review-audit-'))
	temporaryDirectories.push(directory)
	return directory
}

function makeStoreDirectory() {
	return join(makeTemporaryRoot(), 'store')
}

function track(store: SqliteReviewAuditStore) {
	sqliteStores.push(store)
	return store
}

function readAuditRows(directory: string) {
	const database = new DatabaseSync(join(directory, 'review-audit.sqlite'))
	try {
		return database
			.prepare('SELECT * FROM review_audit_entries ORDER BY sequence ASC')
			.all() as unknown as Array<Record<string, string | number | null>>
	} finally {
		database.close()
	}
}

function readAuditRowsAfterClose(store: SqliteReviewAuditStore, directory: string) {
	store.close()
	return readAuditRows(directory)
}
