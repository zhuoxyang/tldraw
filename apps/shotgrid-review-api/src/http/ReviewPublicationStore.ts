import { createHash } from 'node:crypto'
import {
	lstat,
	mkdir,
	open,
	readdir,
	realpath,
	rmdir,
	stat,
	unlink,
	utimes,
} from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

const JOURNAL_VERSION = 1
const DEFAULT_HEARTBEAT_MS = 5_000
const DEFAULT_STALE_LOCK_MS = 10 * 60_000
const DEFAULT_LOCK_TIMEOUT_MS = 20_000
const DEFAULT_LOCK_POLL_MS = 50
const DEFAULT_MAX_JOURNAL_READ_BYTES = 1024 * 1024
const DEFAULT_MAX_JOURNAL_BYTES = 4 * 1024 * 1024
const DEFAULT_MAX_JOURNAL_COUNT = 10_000
export const DEFAULT_REVIEW_PUBLICATION_MAX_RECORD_BYTES = 256 * 1024
const DEFAULT_MEMORY_RECORD_LIMIT = 10_000
const MAX_KEY_TEXT_LENGTH = 4_096
const CAPACITY_LOCK_HASH = createHash('sha256')
	.update('shotgrid-review-publication-capacity-lock-v1')
	.digest('hex')

export interface ReviewPublicationStoreKey {
	actorScope: string
	playlistId: number
	publicationId: string
	versionId: number
}

export interface ReviewPublicationStoreSession<TRecord = unknown> {
	/** A clone of the last durably saved record, or null after a durable clear. */
	readonly record: TRecord | null
	/** Append a clear tombstone after the caller has established that no mutation occurred. */
	clear(): Promise<void>
	/** Durably append a JSON-safe record before or after an external mutation. */
	save(record: TRecord, options?: ReviewPublicationSaveOptions): Promise<void>
}

export interface ReviewPublicationSaveOptions {
	/** Refuse this write unless one more maximum-sized record can also be appended. */
	reserveNextRecord?: boolean
}

export interface ReviewPublicationStore {
	/** Validate and prepare backing storage before the API starts accepting traffic. */
	initialize(): Promise<void>
	runExclusive<TRecord, TResult>(
		key: ReviewPublicationStoreKey,
		action: (session: ReviewPublicationStoreSession<TRecord>) => Promise<TResult>
	): Promise<TResult>
}

export type ReviewPublicationStoreErrorCode =
	| 'CORRUPT_JOURNAL'
	| 'INVALID_KEY'
	| 'INVALID_PATH'
	| 'INVALID_RECORD'
	| 'IO_ERROR'
	| 'JOURNAL_KEY_MISMATCH'
	| 'LOCK_LOST'
	| 'LOCK_TIMEOUT'
	| 'STORE_CAPACITY_EXCEEDED'
	| 'STORE_STATE_UNAVAILABLE'

export class ReviewPublicationStoreError extends Error {
	constructor(
		readonly code: ReviewPublicationStoreErrorCode,
		message: string,
		options?: ErrorOptions
	) {
		super(message, options)
		this.name = 'ReviewPublicationStoreError'
	}
}

export interface FileReviewPublicationStoreOptions {
	heartbeatMs?: number | null
	lockPollMs?: number
	lockTimeoutMs?: number
	maxJournalBytes?: number
	maxJournalCount?: number
	maxJournalReadBytes?: number
	maxRecordBytes?: number
	now?(): number
	sleep?(milliseconds: number): Promise<void>
	staleLockMs?: number
}

interface ResolvedFileStoreOptions {
	heartbeatMs: number | null
	lockPollMs: number
	lockTimeoutMs: number
	maxJournalBytes: number
	maxJournalCount: number
	maxJournalReadBytes: number
	maxRecordBytes: number
	now(): number
	sleep(milliseconds: number): Promise<void>
	staleLockMs: number
}

interface KeyIdentity {
	canonical: string
	hash: string
	verifier: string
}

interface JournalEnvelope {
	keyHash: string
	keyVerifier: string
	operation: 'clear' | 'save'
	record?: unknown
	version: typeof JOURNAL_VERSION
	writtenAtMs: number
}

interface LockIdentity {
	birthtimeMs: string
	dev: string
	ino: string
}

export class InMemoryReviewPublicationStore implements ReviewPublicationStore {
	private readonly locks = new Map<string, Promise<void>>()
	private readonly records = new Map<string, unknown>()

	constructor(private readonly recordLimit = DEFAULT_MEMORY_RECORD_LIMIT) {
		requirePositiveInteger(recordLimit, 'recordLimit')
	}

	async initialize() {}

	async runExclusive<TRecord, TResult>(
		key: ReviewPublicationStoreKey,
		action: (session: ReviewPublicationStoreSession<TRecord>) => Promise<TResult>
	): Promise<TResult> {
		const identity = identifyKey(key)
		const previous = this.locks.get(identity.canonical) ?? Promise.resolve()
		let release!: () => void
		const gate = new Promise<void>((resolveGate) => (release = resolveGate))
		const tail = previous.then(() => gate)
		this.locks.set(identity.canonical, tail)
		await previous

		const session = new MemoryStoreSession<TRecord>(
			identity.canonical,
			this.records,
			this.recordLimit
		)
		try {
			return await action(session)
		} finally {
			release()
			if (this.locks.get(identity.canonical) === tail) {
				this.locks.delete(identity.canonical)
			}
		}
	}
}

class MemoryStoreSession<TRecord> implements ReviewPublicationStoreSession<TRecord> {
	record: TRecord | null

	constructor(
		private readonly key: string,
		private readonly records: Map<string, unknown>,
		private readonly recordLimit: number
	) {
		this.record = cloneJson(records.get(key) as TRecord | undefined) ?? null
	}

	async clear() {
		this.records.delete(this.key)
		this.record = null
	}

	async save(record: TRecord, _options?: ReviewPublicationSaveOptions) {
		const cloned = serializeAndCloneRecord(record, Number.POSITIVE_INFINITY)
		if (!this.records.has(this.key) && this.records.size >= this.recordLimit) {
			throw storeError(
				'STORE_CAPACITY_EXCEEDED',
				'The in-memory publication store reached its record limit.'
			)
		}
		this.records.set(this.key, cloned)
		this.record = cloneJson(cloned)
	}
}

export class FileReviewPublicationStore implements ReviewPublicationStore {
	private baseDirectory: string | null = null
	private readonly initialization: Promise<void>
	private readonly options: ResolvedFileStoreOptions

	constructor(baseDirectory: string, options: FileReviewPublicationStoreOptions = {}) {
		if (typeof baseDirectory !== 'string' || baseDirectory.trim() === '') {
			throw storeError('INVALID_PATH', 'The publication store base directory is invalid.')
		}
		this.options = resolveOptions(options)
		this.initialization = this.prepareBaseDirectory(resolve(baseDirectory))
	}

	async initialize() {
		await this.initialization
	}

	async runExclusive<TRecord, TResult>(
		key: ReviewPublicationStoreKey,
		action: (session: ReviewPublicationStoreSession<TRecord>) => Promise<TResult>
	): Promise<TResult> {
		const keyIdentity = identifyKey(key)
		let paths: ReturnType<FileReviewPublicationStore['getPaths']>
		let lock: DirectoryLock
		try {
			await this.initialize()
			paths = this.getPaths(keyIdentity.hash)
			lock = await this.acquireLock(paths.lock)
		} catch (error) {
			throw markStateUnavailable(error)
		}
		let failed = false
		let failure: unknown
		let result: TResult | undefined

		try {
			let record: TRecord | null
			try {
				record = await readLatestRecord<TRecord>(
					paths.journal,
					keyIdentity,
					this.options.maxJournalReadBytes
				)
			} catch (error) {
				throw markStateUnavailable(error)
			}
			if (!this.baseDirectory) {
				throw storeError('IO_ERROR', 'The publication store directory is not ready.')
			}
			const session = new FileStoreSession<TRecord>(
				this.baseDirectory,
				paths.journal,
				keyIdentity,
				lock,
				record,
				this.options,
				(action) => this.runWithCapacityLock(paths.capacityLock, action)
			)
			result = await action(session)
			await lock.assertOwned()
		} catch (error) {
			failed = true
			failure = error
		}

		try {
			await lock.release()
		} catch (error) {
			if (!failed) {
				failed = true
				failure = error
			}
		}

		if (failed) throw asError(failure)
		return result as TResult
	}

	private async prepareBaseDirectory(configuredPath: string) {
		try {
			await mkdir(configuredPath, { mode: 0o700, recursive: true })
			const resolvedPath = resolve(await realpath(configuredPath))
			const info = await lstat(resolvedPath)
			if (!info.isDirectory()) {
				throw storeError('INVALID_PATH', 'The publication store path is not a directory.')
			}
			validatePosixEntry(info, 'directory')
			this.baseDirectory = resolvedPath
		} catch (error) {
			throw wrapIoError(error, 'Could not prepare the publication store directory.')
		}
	}

	private getPaths(keyHash: string) {
		if (!this.baseDirectory) {
			throw storeError('IO_ERROR', 'The publication store directory is not ready.')
		}
		return {
			capacityLock: resolveChildPath(this.baseDirectory, `${CAPACITY_LOCK_HASH}.lock`),
			journal: resolveChildPath(this.baseDirectory, `${keyHash}.jsonl`),
			lock: resolveChildPath(this.baseDirectory, `${keyHash}.lock`),
		}
	}

	private async runWithCapacityLock<TResult>(
		capacityLockPath: string,
		action: () => Promise<TResult>
	): Promise<TResult> {
		const lock = await this.acquireLock(capacityLockPath)
		let failed = false
		let failure: unknown
		let result: TResult | undefined
		try {
			result = await action()
			await lock.assertOwned()
		} catch (error) {
			failed = true
			failure = error
		}
		try {
			await lock.release()
		} catch (error) {
			if (!failed) {
				failed = true
				failure = error
			}
		}
		if (failed) throw asError(failure)
		return result as TResult
	}

	private async acquireLock(lockPath: string) {
		const startedAt = this.options.now()
		for (;;) {
			try {
				await mkdir(lockPath, { mode: 0o700 })
				const lockInfo = await lstat(lockPath)
				validatePosixEntry(lockInfo, 'lock')
				const identity = toLockIdentity(lockInfo)
				return new DirectoryLock(lockPath, identity, this.options)
			} catch (error) {
				if (!hasErrorCode(error, 'EEXIST')) {
					throw wrapIoError(error, 'Could not acquire the publication store lock.')
				}
			}

			if (await this.recoverStaleLock(lockPath)) continue
			const elapsed = this.options.now() - startedAt
			if (elapsed >= this.options.lockTimeoutMs) {
				throw storeError('LOCK_TIMEOUT', 'Timed out waiting for the publication store lock.')
			}
			await this.options.sleep(
				Math.min(this.options.lockPollMs, this.options.lockTimeoutMs - elapsed)
			)
		}
	}

	private async recoverStaleLock(lockPath: string) {
		const first = await readLockStats(lockPath)
		if (!first) return true
		if (!first.isDirectory() || first.isSymbolicLink()) {
			throw storeError('INVALID_PATH', 'The publication lock path is not a directory.')
		}
		if (this.options.now() - first.mtimeMs < this.options.staleLockMs) return false

		// Observe the same inode twice. A live owner gets a heartbeat opportunity before recovery.
		await this.options.sleep(this.options.lockPollMs)
		const second = await readLockStats(lockPath)
		if (!second) return true
		if (
			!sameLockIdentity(toLockIdentity(first), toLockIdentity(second)) ||
			second.mtimeMs !== first.mtimeMs ||
			this.options.now() - second.mtimeMs < this.options.staleLockMs
		) {
			return false
		}

		try {
			// Never recursively remove a lock. A non-empty lock is conservatively left in place.
			await rmdir(lockPath)
			return true
		} catch (error) {
			if (hasErrorCode(error, 'ENOENT')) return true
			if (hasErrorCode(error, 'ENOTEMPTY') || hasErrorCode(error, 'EEXIST')) return false
			throw wrapIoError(error, 'Could not recover a stale publication store lock.')
		}
	}
}

class FileStoreSession<TRecord> implements ReviewPublicationStoreSession<TRecord> {
	record: TRecord | null

	constructor(
		private readonly baseDirectory: string,
		private readonly journalPath: string,
		private readonly key: KeyIdentity,
		private readonly lock: DirectoryLock,
		record: TRecord | null,
		private readonly options: ResolvedFileStoreOptions,
		private readonly runWithCapacityLock: <TResult>(
			action: () => Promise<TResult>
		) => Promise<TResult>
	) {
		this.record = cloneJson(record)
	}

	async clear() {
		await this.lock.assertOwned()
		await this.runWithCapacityLock(async () => {
			await this.lock.assertOwned()
			if (!(await rejectSymbolicLink(this.journalPath))) return
			const info = await lstat(this.journalPath)
			if (!info.isFile()) {
				throw storeError('INVALID_PATH', 'The publication journal path is not a file.')
			}
			validatePosixEntry(info, 'journal')
			await unlink(this.journalPath)
			await syncDirectory(this.baseDirectory)
			await this.lock.assertOwned()
		})
		this.record = null
	}

	async save(record: TRecord, options: ReviewPublicationSaveOptions = {}) {
		const cloned = serializeAndCloneRecord(record, this.options.maxRecordBytes)
		await this.append(
			{ operation: 'save', record: cloned },
			options.reserveNextRecord ? maximumSaveJournalLineBytes(this.options.maxRecordBytes) : 0
		)
		this.record = cloneJson(cloned)
	}

	private async append(
		operation: Pick<JournalEnvelope, 'operation' | 'record'>,
		reservedBytes: number
	) {
		await this.lock.assertOwned()
		const envelope: JournalEnvelope = {
			...operation,
			keyHash: this.key.hash,
			keyVerifier: this.key.verifier,
			version: JOURNAL_VERSION,
			writtenAtMs: requireTimestamp(this.options.now()),
		}
		const line = `${JSON.stringify(envelope)}\n`
		if (Buffer.byteLength(line, 'utf8') + reservedBytes > this.options.maxJournalBytes) {
			throw storeError('STORE_CAPACITY_EXCEEDED', 'The publication journal reached its byte limit.')
		}
		const journalExisted = await rejectSymbolicLink(this.journalPath)
		if (journalExisted) {
			await this.appendToJournal(line, true, reservedBytes)
			return
		}

		await this.runWithCapacityLock(async () => {
			await this.lock.assertOwned()
			const existsAfterCapacityLock = await rejectSymbolicLink(this.journalPath)
			if (!existsAfterCapacityLock) {
				const journalCount = await countPublicationJournals(this.baseDirectory)
				if (journalCount >= this.options.maxJournalCount) {
					throw storeError(
						'STORE_CAPACITY_EXCEEDED',
						'The publication store reached its journal count limit.'
					)
				}
			}
			await this.appendToJournal(line, existsAfterCapacityLock, reservedBytes)
		})
	}

	private async appendToJournal(line: string, journalExisted: boolean, reservedBytes: number) {
		let handle
		try {
			handle = await open(this.journalPath, 'a+', 0o600)
			const info = await handle.stat()
			if (!info.isFile()) {
				throw storeError('INVALID_PATH', 'The publication journal path is not a file.')
			}
			validatePosixEntry(info, 'journal')
			const prefix = (await requiresLineBoundary(handle, info.size)) ? '\n' : ''
			if (
				info.size + Buffer.byteLength(prefix, 'utf8') + Buffer.byteLength(line, 'utf8') >
				this.options.maxJournalBytes - reservedBytes
			) {
				throw storeError(
					'STORE_CAPACITY_EXCEEDED',
					'The publication journal reached its byte limit.'
				)
			}
			await handle.writeFile(`${prefix}${line}`, 'utf8')
			await handle.sync()
			if (!journalExisted) await syncDirectory(dirname(this.journalPath))
			await this.lock.assertOwned()
		} catch (error) {
			throw wrapIoError(error, 'Could not durably append the publication record.')
		} finally {
			await handle?.close().catch(() => undefined)
		}
	}
}

class DirectoryLock {
	private heartbeat: ReturnType<typeof setInterval> | null = null
	private heartbeatWork: Promise<void> = Promise.resolve()
	private lost: ReviewPublicationStoreError | null = null

	constructor(
		private readonly path: string,
		private readonly identity: LockIdentity,
		private readonly options: ResolvedFileStoreOptions
	) {
		if (options.heartbeatMs !== null) {
			this.heartbeat = setInterval(() => {
				this.heartbeatWork = this.heartbeatWork
					.then(() => this.refresh())
					.catch((error) => this.markLost(error))
			}, options.heartbeatMs)
			this.heartbeat.unref()
		}
	}

	async assertOwned() {
		if (this.lost) throw this.lost
		try {
			const current = await lstat(this.path)
			validatePosixEntry(current, 'lock')
			if (!current.isDirectory() || !sameLockIdentity(this.identity, toLockIdentity(current))) {
				throw lockLost()
			}
		} catch (error) {
			this.markLost(error)
			throw this.lost
		}
	}

	async release() {
		if (this.heartbeat) clearInterval(this.heartbeat)
		await this.heartbeatWork
		await this.assertOwned()
		try {
			// The lock directory is intentionally empty; only remove that exact directory.
			await rmdir(this.path)
		} catch (error) {
			throw wrapIoError(error, 'Could not release the publication store lock.')
		}
	}

	private markLost(error: unknown) {
		if (this.heartbeat) clearInterval(this.heartbeat)
		this.lost ??= lockLost(error)
	}

	private async refresh() {
		await this.assertOwned()
		const instant = new Date(requireTimestamp(this.options.now()))
		await utimes(this.path, instant, instant)
		await this.assertOwned()
	}
}

async function readLatestRecord<TRecord>(
	journalPath: string,
	key: KeyIdentity,
	maxReadBytes: number
): Promise<TRecord | null> {
	await rejectSymbolicLink(journalPath)
	let handle
	try {
		handle = await open(journalPath, 'r')
		const info = await handle.stat()
		if (!info.isFile()) {
			throw storeError('INVALID_PATH', 'The publication journal path is not a file.')
		}
		validatePosixEntry(info, 'journal')
		if (info.size === 0) return null

		const length = Math.min(info.size, maxReadBytes)
		const start = info.size - length
		const buffer = Buffer.allocUnsafe(length)
		let offset = 0
		while (offset < length) {
			const read = await handle.read(buffer, offset, length - offset, start + offset)
			if (read.bytesRead === 0) break
			offset += read.bytesRead
		}
		const bytes = buffer.subarray(0, offset)
		const bounded = start === 0 ? bytes : discardFirstPartialLine(bytes)
		const line = lastCompleteLine(bounded)
		if (line === null) {
			if (start > 0) {
				throw storeError(
					'CORRUPT_JOURNAL',
					'The latest publication journal entry exceeds the read limit.'
				)
			}
			return null
		}

		return readEnvelope<TRecord>(line, key)
	} catch (error) {
		if (hasErrorCode(error, 'ENOENT')) return null
		throw wrapIoError(error, 'Could not read the publication journal.')
	} finally {
		await handle?.close().catch(() => undefined)
	}
}

function readEnvelope<TRecord>(line: Buffer, key: KeyIdentity): TRecord | null {
	let value: unknown
	try {
		value = JSON.parse(line.toString('utf8'))
	} catch (error) {
		throw storeError('CORRUPT_JOURNAL', 'The publication journal is not valid JSON.', error)
	}
	if (!isPlainObject(value)) {
		throw storeError('CORRUPT_JOURNAL', 'The publication journal envelope is invalid.')
	}
	if (value.keyHash !== key.hash || value.keyVerifier !== key.verifier) {
		throw storeError(
			'JOURNAL_KEY_MISMATCH',
			'The publication journal does not belong to the requested key.'
		)
	}
	if (
		value.version !== JOURNAL_VERSION ||
		(value.operation !== 'save' && value.operation !== 'clear') ||
		!Number.isSafeInteger(value.writtenAtMs) ||
		Number(value.writtenAtMs) < 0
	) {
		throw storeError('CORRUPT_JOURNAL', 'The publication journal envelope is invalid.')
	}
	if (value.operation === 'clear') return null
	if (!('record' in value) || value.record === null) {
		throw storeError('CORRUPT_JOURNAL', 'The publication journal record is missing.')
	}
	try {
		validateJsonValue(value.record)
	} catch (error) {
		throw storeError(
			'CORRUPT_JOURNAL',
			'The publication journal contains an invalid record.',
			error
		)
	}
	return cloneJson(value.record as TRecord)
}

function identifyKey(key: ReviewPublicationStoreKey): KeyIdentity {
	if (!isPlainObject(key)) throw storeError('INVALID_KEY', 'The publication key is invalid.')
	const { actorScope, playlistId, publicationId, versionId } = key
	if (
		typeof actorScope !== 'string' ||
		actorScope.length === 0 ||
		actorScope.length > MAX_KEY_TEXT_LENGTH ||
		typeof publicationId !== 'string' ||
		publicationId.length === 0 ||
		publicationId.length > MAX_KEY_TEXT_LENGTH ||
		!Number.isSafeInteger(playlistId) ||
		playlistId <= 0 ||
		!Number.isSafeInteger(versionId) ||
		versionId <= 0
	) {
		throw storeError('INVALID_KEY', 'The publication key is invalid.')
	}
	const canonical = JSON.stringify([actorScope, playlistId, versionId, publicationId])
	return {
		canonical,
		hash: createHash('sha256').update(canonical).digest('hex'),
		verifier: createHash('sha512')
			.update('shotgrid-review-publication-key-v1\0')
			.update(canonical)
			.digest('hex'),
	}
}

function resolveOptions(options: FileReviewPublicationStoreOptions): ResolvedFileStoreOptions {
	const heartbeatMs = options.heartbeatMs === undefined ? DEFAULT_HEARTBEAT_MS : options.heartbeatMs
	const staleLockMs = options.staleLockMs ?? DEFAULT_STALE_LOCK_MS
	const lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS
	const lockPollMs = options.lockPollMs ?? DEFAULT_LOCK_POLL_MS
	const maxJournalReadBytes = options.maxJournalReadBytes ?? DEFAULT_MAX_JOURNAL_READ_BYTES
	const maxJournalBytes = options.maxJournalBytes ?? DEFAULT_MAX_JOURNAL_BYTES
	const maxJournalCount = options.maxJournalCount ?? DEFAULT_MAX_JOURNAL_COUNT
	const maxRecordBytes = options.maxRecordBytes ?? DEFAULT_REVIEW_PUBLICATION_MAX_RECORD_BYTES

	if (heartbeatMs !== null) requirePositiveFinite(heartbeatMs, 'heartbeatMs')
	requirePositiveFinite(staleLockMs, 'staleLockMs')
	requirePositiveFinite(lockTimeoutMs, 'lockTimeoutMs')
	requirePositiveFinite(lockPollMs, 'lockPollMs')
	requirePositiveInteger(maxJournalReadBytes, 'maxJournalReadBytes')
	requirePositiveInteger(maxJournalBytes, 'maxJournalBytes')
	requirePositiveInteger(maxJournalCount, 'maxJournalCount')
	requirePositiveInteger(maxRecordBytes, 'maxRecordBytes')
	const maximumLineBytes = maximumSaveJournalLineBytes(maxRecordBytes)
	if (maxJournalReadBytes <= maximumLineBytes) {
		throw new RangeError('maxJournalReadBytes must exceed one maximum publication journal line')
	}
	if (maxJournalBytes < minimumReviewPublicationJournalBytes(maxRecordBytes)) {
		throw new RangeError(
			'maxJournalBytes must fit two maximum publication journal lines for mutation reservation'
		)
	}
	if (heartbeatMs !== null && heartbeatMs * 3 >= staleLockMs) {
		throw new RangeError('staleLockMs must be more than three heartbeat intervals')
	}
	return {
		heartbeatMs,
		lockPollMs,
		lockTimeoutMs,
		maxJournalBytes,
		maxJournalCount,
		maxJournalReadBytes,
		maxRecordBytes,
		now: options.now ?? Date.now,
		sleep: options.sleep ?? wait,
		staleLockMs,
	}
}

export function minimumReviewPublicationJournalBytes(
	maxRecordBytes = DEFAULT_REVIEW_PUBLICATION_MAX_RECORD_BYTES
) {
	requirePositiveInteger(maxRecordBytes, 'maxRecordBytes')
	return maximumSaveJournalLineBytes(maxRecordBytes) * 2
}

function maximumSaveJournalLineBytes(maxRecordBytes: number) {
	const template = `${JSON.stringify({
		keyHash: '0'.repeat(64),
		keyVerifier: '0'.repeat(128),
		operation: 'save',
		record: null,
		version: JOURNAL_VERSION,
		writtenAtMs: Number.MAX_SAFE_INTEGER,
	})}\n`
	return Buffer.byteLength(template, 'utf8') - Buffer.byteLength('null', 'utf8') + maxRecordBytes
}

function resolveChildPath(baseDirectory: string, fileName: string) {
	if (!/^[0-9a-f]{64}\.(?:jsonl|lock)$/.test(fileName)) {
		throw storeError('INVALID_PATH', 'The publication store file name is invalid.')
	}
	const child = resolve(baseDirectory, fileName)
	const childRelative = relative(baseDirectory, child)
	if (
		childRelative === '' ||
		childRelative === '..' ||
		childRelative.startsWith(`..${sep}`) ||
		isAbsolute(childRelative)
	) {
		throw storeError('INVALID_PATH', 'The publication store path escapes its base directory.')
	}
	return child
}

function serializeAndCloneRecord<TRecord>(record: TRecord, maxBytes: number): TRecord {
	if (record === null) {
		throw storeError('INVALID_RECORD', 'A saved publication record cannot be null.')
	}
	validateJsonValue(record)
	let serialized: string
	try {
		serialized = JSON.stringify(record)
	} catch (error) {
		throw storeError('INVALID_RECORD', 'The publication record is not JSON-safe.', error)
	}
	if (Buffer.byteLength(serialized, 'utf8') > maxBytes) {
		throw storeError('INVALID_RECORD', 'The publication record exceeds the size limit.')
	}
	return JSON.parse(serialized) as TRecord
}

function validateJsonValue(value: unknown, ancestors = new Set<object>(), depth = 0): void {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return
	if (typeof value === 'number') {
		if (!Number.isFinite(value)) {
			throw storeError('INVALID_RECORD', 'The publication record contains a non-finite number.')
		}
		return
	}
	if (typeof value !== 'object') {
		throw storeError('INVALID_RECORD', 'The publication record is not JSON-safe.')
	}
	if (depth >= 100 || ancestors.has(value)) {
		throw storeError('INVALID_RECORD', 'The publication record is cyclic or too deeply nested.')
	}
	if (!Array.isArray(value) && !isPlainObject(value)) {
		throw storeError('INVALID_RECORD', 'The publication record contains a non-JSON object.')
	}
	if (Object.getOwnPropertySymbols(value).length > 0) {
		throw storeError('INVALID_RECORD', 'The publication record contains symbol properties.')
	}

	ancestors.add(value)
	try {
		for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
			if (!descriptor.enumerable) continue
			if (!('value' in descriptor)) {
				throw storeError('INVALID_RECORD', 'The publication record contains an accessor.')
			}
			validateJsonValue(descriptor.value, ancestors, depth + 1)
		}
	} finally {
		ancestors.delete(value)
	}
}

function cloneJson<T>(value: T): T {
	return value === null || value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T)
}

function lastCompleteLine(bytes: Buffer) {
	const finalNewline = bytes.lastIndexOf(0x0a)
	if (finalNewline < 0) return null
	let end = finalNewline
	while (end > 0 && (bytes[end - 1] === 0x0a || bytes[end - 1] === 0x0d)) end--
	if (end === 0) return null
	const precedingNewline = bytes.lastIndexOf(0x0a, end - 1)
	const start = precedingNewline < 0 ? 0 : precedingNewline + 1
	return bytes.subarray(start, end)
}

function discardFirstPartialLine(bytes: Buffer) {
	const firstNewline = bytes.indexOf(0x0a)
	return firstNewline < 0 ? Buffer.alloc(0) : bytes.subarray(firstNewline + 1)
}

async function requiresLineBoundary(handle: Awaited<ReturnType<typeof open>>, size: number) {
	if (size === 0) return false
	const byte = Buffer.allocUnsafe(1)
	const result = await handle.read(byte, 0, 1, size - 1)
	return result.bytesRead === 1 && byte[0] !== 0x0a
}

async function rejectSymbolicLink(path: string) {
	try {
		const info = await lstat(path)
		if (info.isSymbolicLink()) {
			throw storeError('INVALID_PATH', 'Symbolic publication store entries are not allowed.')
		}
		return true
	} catch (error) {
		if (hasErrorCode(error, 'ENOENT')) return false
		throw error
	}
}

async function countPublicationJournals(baseDirectory: string) {
	try {
		const entries = await readdir(baseDirectory, { withFileTypes: true })
		return entries.filter((entry) => /^[0-9a-f]{64}\.jsonl$/.test(entry.name)).length
	} catch (error) {
		throw wrapIoError(error, 'Could not inspect publication store capacity.')
	}
}

async function syncDirectory(path: string) {
	let handle
	try {
		handle = await open(path, 'r')
		await handle.sync()
	} catch (error) {
		if (process.platform !== 'win32') throw error
	} finally {
		await handle?.close().catch(() => undefined)
	}
}

async function readLockStats(path: string) {
	try {
		const info = await lstat(path)
		validatePosixEntry(info, 'lock')
		return info
	} catch (error) {
		if (hasErrorCode(error, 'ENOENT')) return null
		throw wrapIoError(error, 'Could not inspect the publication store lock.')
	}
}

function validatePosixEntry(
	info: Awaited<ReturnType<typeof stat>>,
	kind: 'directory' | 'journal' | 'lock'
) {
	if (process.platform === 'win32') return
	const currentUid = process.getuid?.()
	const disallowedMode = kind === 'journal' ? 0o066 : 0o022
	if (
		currentUid === undefined ||
		Number(info.uid) !== currentUid ||
		(Number(info.mode) & disallowedMode) !== 0
	) {
		throw storeError(
			'INVALID_PATH',
			`The publication store ${kind} has unsafe ownership or permissions.`
		)
	}
}

function toLockIdentity(info: Awaited<ReturnType<typeof stat>>): LockIdentity {
	return {
		birthtimeMs: String(info.birthtimeMs),
		dev: String(info.dev),
		ino: String(info.ino),
	}
}

function sameLockIdentity(left: LockIdentity, right: LockIdentity) {
	return left.birthtimeMs === right.birthtimeMs && left.dev === right.dev && left.ino === right.ino
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
	const prototype = Object.getPrototypeOf(value)
	return prototype === Object.prototype || prototype === null
}

function requireTimestamp(value: number) {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw storeError('IO_ERROR', 'The publication store clock returned an invalid timestamp.')
	}
	return value
}

function requirePositiveFinite(value: number, name: string) {
	if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be positive`)
}

function requirePositiveInteger(value: number, name: string) {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new RangeError(`${name} must be a positive integer`)
	}
}

function hasErrorCode(error: unknown, code: string) {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		(error as { code?: unknown }).code === code
	)
}

function storeError(code: ReviewPublicationStoreErrorCode, message: string, cause?: unknown) {
	return new ReviewPublicationStoreError(code, message, cause === undefined ? undefined : { cause })
}

function wrapIoError(error: unknown, message: string) {
	return error instanceof ReviewPublicationStoreError
		? error
		: storeError('IO_ERROR', message, error)
}

function markStateUnavailable(error: unknown) {
	if (error instanceof ReviewPublicationStoreError && error.code !== 'IO_ERROR') return error
	return storeError(
		'STORE_STATE_UNAVAILABLE',
		'The publication store could not determine whether this key has prior history.',
		error
	)
}

function asError(error: unknown) {
	return error instanceof Error
		? error
		: storeError('IO_ERROR', 'The publication store failed.', error)
}

function lockLost(cause?: unknown) {
	return storeError(
		'LOCK_LOST',
		'The publication store lock was lost before the critical section completed.',
		cause
	)
}

function wait(milliseconds: number) {
	return new Promise<void>((resolveWait) => setTimeout(resolveWait, milliseconds))
}
