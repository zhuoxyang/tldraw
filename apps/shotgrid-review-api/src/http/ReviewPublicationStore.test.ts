import {
	appendFile,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	utimes,
	writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
	FileReviewPublicationStore,
	InMemoryReviewPublicationStore,
	minimumReviewPublicationJournalBytes,
	type ReviewPublicationStoreKey,
} from './ReviewPublicationStore'

const key: ReviewPublicationStoreKey = {
	actorScope: 'reviewer:42',
	playlistId: 101,
	publicationId: '5c32e7d8-4e3e-4a86-b302-c813b43e5db8',
	versionId: 202,
}

const temporaryDirectories: string[] = []

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true }))
	)
})

describe('InMemoryReviewPublicationStore', () => {
	test('serializes concurrent work for the same structured key', async () => {
		const store = new InMemoryReviewPublicationStore()
		const events: string[] = []
		let releaseFirst!: () => void
		let firstEntered!: () => void
		const firstStarted = new Promise<void>((resolve) => (firstEntered = resolve))
		const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve))

		const first = store.runExclusive<{ step: number }, void>(key, async (session) => {
			events.push('first-start')
			firstEntered()
			await firstGate
			await session.save({ step: 1 })
			events.push('first-end')
		})
		await firstStarted
		const second = store.runExclusive<{ step: number }, void>(key, async (session) => {
			events.push(`second:${session.record?.step}`)
		})

		await Promise.resolve()
		expect(events).toEqual(['first-start'])
		releaseFirst()
		await Promise.all([first, second])
		expect(events).toEqual(['first-start', 'first-end', 'second:1'])
	})

	test('clones records and applies clear as an atomic in-memory tombstone', async () => {
		const store = new InMemoryReviewPublicationStore()
		const input = { nested: { value: 1 } }
		await store.runExclusive(key, async (session) => session.save(input))
		input.nested.value = 2

		await store.runExclusive<typeof input, void>(key, async (session) => {
			expect(session.record).toEqual({ nested: { value: 1 } })
			await session.clear()
		})
		await store.runExclusive(key, async (session) => expect(session.record).toBeNull())
	})
})

describe('FileReviewPublicationStore', () => {
	test('fails initialization before serving when the configured base path is unusable', async () => {
		const directory = await makeTemporaryDirectory()
		const filePath = join(directory, 'not-a-directory')
		await writeFile(filePath, 'occupied')
		const store = new FileReviewPublicationStore(filePath)

		await expect(store.initialize()).rejects.toMatchObject({ code: 'IO_ERROR' })
	})

	test('shares durable state and a critical section across store instances', async () => {
		const directory = await makeTemporaryDirectory()
		const options = {
			heartbeatMs: null,
			lockPollMs: 2,
			lockTimeoutMs: 1_000,
			staleLockMs: 60_000,
		} as const
		const firstStore = new FileReviewPublicationStore(directory, options)
		const secondStore = new FileReviewPublicationStore(directory, options)
		let releaseFirst!: () => void
		let firstEntered!: () => void
		let secondEntered = false
		const firstStarted = new Promise<void>((resolve) => (firstEntered = resolve))
		const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve))

		const first = firstStore.runExclusive<{ step: string }, void>(key, async (session) => {
			firstEntered()
			await firstGate
			await session.save({ step: 'note-created' })
		})
		await firstStarted
		const second = secondStore.runExclusive<{ step: string }, string>(key, async (session) => {
			secondEntered = true
			return session.record?.step ?? 'missing'
		})
		await new Promise((resolve) => setTimeout(resolve, 15))
		expect(secondEntered).toBe(false)

		releaseFirst()
		expect(await second).toBe('note-created')
		await first
	})

	test('recovers records and durably removes a safely cleared journal', async () => {
		const directory = await makeTemporaryDirectory()
		await new FileReviewPublicationStore(directory).runExclusive(key, async (session) => {
			await session.save({ noteId: 303, stage: 'note-created' })
		})

		await new FileReviewPublicationStore(directory).runExclusive<
			{ noteId: number; stage: string },
			void
		>(key, async (session) => {
			expect(session.record).toEqual({ noteId: 303, stage: 'note-created' })
			await session.clear()
		})
		await new FileReviewPublicationStore(directory).runExclusive(key, async (session) => {
			expect(session.record).toBeNull()
		})
		expect((await readdir(directory)).filter((name) => name.endsWith('.jsonl'))).toEqual([])
	})

	test('enforces a cross-instance global journal count while preserving existing keys', async () => {
		const directory = await makeTemporaryDirectory()
		const options = {
			heartbeatMs: null,
			lockPollMs: 2,
			lockTimeoutMs: 1_000,
			maxJournalCount: 1,
			staleLockMs: 60_000,
		} as const
		const secondKey = {
			...key,
			publicationId: '6d43f8e9-5f4f-4b97-a413-d924c54f6ec9',
		}
		const results = await Promise.allSettled([
			new FileReviewPublicationStore(directory, options).runExclusive(key, async (session) =>
				session.save({ owner: 'first' })
			),
			new FileReviewPublicationStore(directory, options).runExclusive(secondKey, async (session) =>
				session.save({ owner: 'second' })
			),
		])

		expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
		expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
		expect(results.find((result) => result.status === 'rejected')).toMatchObject({
			reason: { code: 'STORE_CAPACITY_EXCEEDED' },
		})
		expect((await readdir(directory)).filter((name) => name.endsWith('.jsonl'))).toHaveLength(1)

		const successfulKey = results[0].status === 'fulfilled' ? key : secondKey
		await expect(
			new FileReviewPublicationStore(directory, options).runExclusive<
				{ owner: string },
				string | undefined
			>(successfulKey, async (session) => session.record?.owner)
		).resolves.toMatch(/^(?:first|second)$/)
	})

	test('enforces a hard byte limit without damaging the last durable record', async () => {
		const directory = await makeTemporaryDirectory()
		const maxRecordBytes = 256
		const options = {
			maxJournalBytes: minimumReviewPublicationJournalBytes(maxRecordBytes),
			maxJournalReadBytes: 1_024,
			maxRecordBytes,
		} as const
		const store = new FileReviewPublicationStore(directory, options)
		await store.runExclusive(key, async (session) =>
			session.save({ padding: 'x'.repeat(210), revision: 1 })
		)
		await store.runExclusive(key, async (session) =>
			session.save({ padding: 'x'.repeat(210), revision: 2 })
		)
		await expect(
			store.runExclusive(key, async (session) =>
				session.save({ padding: 'x'.repeat(210), revision: 3 })
			)
		).rejects.toMatchObject({ code: 'STORE_CAPACITY_EXCEEDED' })

		const journal = await readFile(await findJournal(directory))
		expect(journal.byteLength).toBeLessThanOrEqual(options.maxJournalBytes)
		await expect(
			new FileReviewPublicationStore(directory, options).runExclusive<
				{ padding: string; revision: number },
				number | undefined
			>(key, async (session) => session.record?.revision)
		).resolves.toBe(2)
	})

	test('reserves one maximum record atomically before a mutation boundary', async () => {
		const directory = await makeTemporaryDirectory()
		const maxRecordBytes = 256
		const minimumBytes = minimumReviewPublicationJournalBytes(maxRecordBytes)
		expect(
			() =>
				new FileReviewPublicationStore(directory, {
					maxJournalBytes: minimumBytes - 1,
					maxJournalReadBytes: 1_024,
					maxRecordBytes,
				})
		).toThrow(/two maximum publication journal lines/i)

		const store = new FileReviewPublicationStore(directory, {
			maxJournalBytes: minimumBytes,
			maxJournalReadBytes: 1_024,
			maxRecordBytes,
		})
		await store.runExclusive(key, async (session) =>
			session.save({ stage: 'creating-note' }, { reserveNextRecord: true })
		)
		await store.runExclusive(key, async (session) =>
			session.save({ padding: 'x'.repeat(210), stage: 'note-created' })
		)
		await expect(
			store.runExclusive(key, async (session) =>
				session.save({ stage: 'uploading-attachment' }, { reserveNextRecord: true })
			)
		).rejects.toMatchObject({ code: 'STORE_CAPACITY_EXCEEDED' })
		await expect(
			new FileReviewPublicationStore(directory, {
				maxJournalBytes: minimumBytes,
				maxJournalReadBytes: 1_024,
				maxRecordBytes,
			}).runExclusive<{ padding: string; stage: string }, string | undefined>(
				key,
				async (session) => session.record?.stage
			)
		).resolves.toBe('note-created')
	})

	test('falls back from a partial tail and isolates it before the next append', async () => {
		const directory = await makeTemporaryDirectory()
		const store = new FileReviewPublicationStore(directory)
		await store.runExclusive(key, async (session) => {
			await session.save({ revision: 1 })
		})
		const journalPath = await findJournal(directory)
		await appendFile(journalPath, '{"operation":"save"')

		await new FileReviewPublicationStore(directory).runExclusive<{ revision: number }, void>(
			key,
			async (session) => {
				expect(session.record).toEqual({ revision: 1 })
				await session.save({ revision: 2 })
			}
		)
		await new FileReviewPublicationStore(directory).runExclusive<{ revision: number }, void>(
			key,
			async (session) => expect(session.record).toEqual({ revision: 2 })
		)
	})

	test('rejects an envelope verifier mismatch under the same SHA-256 file name', async () => {
		const directory = await makeTemporaryDirectory()
		await new FileReviewPublicationStore(directory).runExclusive(key, async (session) => {
			await session.save({ stage: 'creating-note' })
		})
		const journalPath = await findJournal(directory)
		const envelope = JSON.parse(await readFile(journalPath, 'utf8'))
		envelope.keyVerifier = '0'.repeat(128)
		await writeFile(journalPath, `${JSON.stringify(envelope)}\n`)

		await expect(
			new FileReviewPublicationStore(directory).runExclusive(key, async () => undefined)
		).rejects.toMatchObject({ code: 'JOURNAL_KEY_MISMATCH' })
	})

	test('times out without entering a critical section held by another instance', async () => {
		const directory = await makeTemporaryDirectory()
		const firstStore = new FileReviewPublicationStore(directory, {
			heartbeatMs: null,
			staleLockMs: 60_000,
		})
		let releaseFirst!: () => void
		let firstEntered!: () => void
		const firstStarted = new Promise<void>((resolve) => (firstEntered = resolve))
		const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve))
		const first = firstStore.runExclusive(key, async () => {
			firstEntered()
			await firstGate
		})
		await firstStarted

		let currentTime = Date.now()
		const contender = new FileReviewPublicationStore(directory, {
			heartbeatMs: null,
			lockPollMs: 2,
			lockTimeoutMs: 10,
			now: () => currentTime,
			sleep: async (milliseconds) => {
				currentTime += milliseconds
			},
			staleLockMs: 60_000,
		})
		await expect(contender.runExclusive(key, async () => undefined)).rejects.toMatchObject({
			code: 'LOCK_TIMEOUT',
		})
		releaseFirst()
		await first
	})

	test('conservatively recovers a stale empty lock with injectable timing', async () => {
		const directory = await makeTemporaryDirectory()
		await new FileReviewPublicationStore(directory).runExclusive(key, async (session) => {
			await session.save({ stage: 'ready' })
		})
		const journalName = (await readdir(directory)).find((name) => name.endsWith('.jsonl'))!
		const lockPath = join(directory, journalName.replace(/\.jsonl$/, '.lock'))
		await mkdir(lockPath)
		const currentTime = Date.now()
		const oldTime = new Date(currentTime - 10_000)
		await utimes(lockPath, oldTime, oldTime)
		let observedTime = currentTime

		const store = new FileReviewPublicationStore(directory, {
			heartbeatMs: null,
			lockPollMs: 2,
			lockTimeoutMs: 100,
			now: () => observedTime,
			sleep: async (milliseconds) => {
				observedTime += milliseconds
			},
			staleLockMs: 1_000,
		})
		await store.runExclusive<{ stage: string }, void>(key, async (session) => {
			expect(session.record).toEqual({ stage: 'ready' })
		})
		expect((await readdir(directory)).some((name) => name.endsWith('.lock'))).toBe(false)
	})

	test('heartbeats prevent a live lock from being recovered as stale', async () => {
		const directory = await makeTemporaryDirectory()
		const liveStore = new FileReviewPublicationStore(directory, {
			heartbeatMs: 5,
			staleLockMs: 40,
		})
		let releaseLive!: () => void
		let liveEntered!: () => void
		const liveStarted = new Promise<void>((resolve) => (liveEntered = resolve))
		const liveGate = new Promise<void>((resolve) => (releaseLive = resolve))
		const live = liveStore.runExclusive(key, async () => {
			liveEntered()
			await liveGate
		})
		await liveStarted

		const contender = new FileReviewPublicationStore(directory, {
			heartbeatMs: null,
			lockPollMs: 5,
			lockTimeoutMs: 60,
			staleLockMs: 40,
		})
		await expect(contender.runExclusive(key, async () => undefined)).rejects.toMatchObject({
			code: 'LOCK_TIMEOUT',
		})
		releaseLive()
		await live
	})

	test('hashes hostile key text into safe child file names without persisting actor text', async () => {
		const directory = await makeTemporaryDirectory()
		const hostileKey: ReviewPublicationStoreKey = {
			actorScope: '..\\..\\private/reviewer@example.com',
			playlistId: 1,
			publicationId: '../../publication',
			versionId: 2,
		}
		await new FileReviewPublicationStore(directory).runExclusive(hostileKey, async (session) => {
			await session.save({ stage: 'safe' })
		})

		const names = await readdir(directory)
		expect(names).toHaveLength(1)
		expect(names[0]).toMatch(/^[0-9a-f]{64}\.jsonl$/)
		const journal = await readFile(join(directory, names[0]), 'utf8')
		expect(journal).not.toContain('reviewer@example.com')
		expect(journal).not.toContain('../../publication')
	})

	test('rejects non-JSON and oversized records before appending', async () => {
		const directory = await makeTemporaryDirectory()
		const store = new FileReviewPublicationStore(directory, {
			maxJournalReadBytes: 1_024,
			maxRecordBytes: 64,
		})
		const cyclic: { self?: unknown } = {}
		cyclic.self = cyclic
		await expect(
			store.runExclusive(key, async (session) => session.save(cyclic))
		).rejects.toMatchObject({ code: 'INVALID_RECORD' })
		await expect(
			store.runExclusive(key, async (session) => session.save({ value: 'x'.repeat(100) }))
		).rejects.toMatchObject({ code: 'INVALID_RECORD' })
		expect(await readdir(directory)).toEqual([])
	})
})

async function makeTemporaryDirectory() {
	const directory = await mkdtemp(join(tmpdir(), 'shotgrid-review-publication-store-'))
	temporaryDirectories.push(directory)
	return directory
}

async function findJournal(directory: string) {
	const journalName = (await readdir(directory)).find((name) => name.endsWith('.jsonl'))
	if (!journalName) throw new Error('Expected a publication journal')
	return join(directory, journalName)
}
