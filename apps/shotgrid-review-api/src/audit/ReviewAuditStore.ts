import { randomUUID as nodeRandomUUID } from 'node:crypto'
import {
	chmodSync,
	closeSync,
	constants,
	fchmodSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	realpathSync,
	type Stats,
} from 'node:fs'
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { REVIEW_API_ERROR_CODES, isReviewApiErrorCode, type ReviewApiErrorCode } from '../contracts'

const AUDIT_SCHEMA_VERSION = 1
const AUDIT_APPLICATION_ID = 0x52564131
const AUDIT_SCHEMA_MARKER = 'shotgrid-review-audit-v1'
const AUDIT_DATABASE_NAME = 'review-audit.sqlite'
const DEFAULT_MAX_ENTRIES = 100_000
const MAX_MAX_ENTRIES = 10_000_000
const MAX_REQUEST_ID_LENGTH = 128
const MAX_PRINCIPAL_ID_LENGTH = 256
const ATTEMPT_ID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/
const DECISION_STATUS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const MAX_ATTEMPT_ID_GENERATION_TRIES = 4

export const REVIEW_AUDIT_ACTIONS = ['decision', 'publication'] as const
export type ReviewAuditAction = (typeof REVIEW_AUDIT_ACTIONS)[number]

export interface ReviewAuditEffectiveActor {
	id: number | null
	kind: 'human' | 'service'
}

export interface ReviewAuditIntent {
	action: ReviewAuditAction
	effectiveActor: ReviewAuditEffectiveActor
	playlistId: number
	principalId: string
	projectId: number
	requestId: string
	versionId: number
}

export type ReviewAuditOutcomeStatus = 'failed' | 'indeterminate' | 'succeeded'

/**
 * Every field is required so callers cannot smuggle an unbounded result object into the audit log.
 * Unknown runtime properties are rejected as well.
 */
export interface ReviewAuditOutcome {
	decisionStatus: string | null
	errorCode: ReviewApiErrorCode | null
	resultAttachmentId: number | null
	resultNoteId: number | null
	status: ReviewAuditOutcomeStatus
}

interface ReviewAuditEntryBase extends ReviewAuditIntent {
	attemptId: string
	sequence: number
	timestampMs: number
}

export interface ReviewAuditAttemptEntry extends ReviewAuditEntryBase {
	decisionStatus: null
	entryKind: 'attempt'
	errorCode: null
	outcome: null
	resultAttachmentId: null
	resultNoteId: null
}

export interface ReviewAuditOutcomeEntry extends ReviewAuditEntryBase {
	decisionStatus: string | null
	entryKind: 'outcome'
	errorCode: ReviewApiErrorCode | null
	outcome: ReviewAuditOutcomeStatus
	resultAttachmentId: number | null
	resultNoteId: number | null
}

export type ReviewAuditEntry = ReviewAuditAttemptEntry | ReviewAuditOutcomeEntry

export interface ReviewAuditStore {
	/** Persist intent before the caller performs the external mutation. */
	begin(intent: ReviewAuditIntent): Promise<string>
	/** Append the externally observed result to an existing attempt. */
	finish(attemptId: string, outcome: ReviewAuditOutcome): Promise<void>
}

export type ReviewAuditStoreErrorCode =
	| 'ATTEMPT_ALREADY_FINISHED'
	| 'ATTEMPT_NOT_FOUND'
	| 'INVALID_ATTEMPT_ID'
	| 'INVALID_INTENT'
	| 'INVALID_OPTIONS'
	| 'INVALID_OUTCOME'
	| 'INVALID_PATH'
	| 'STORE_CAPACITY_EXCEEDED'
	| 'STORE_CLOSED'
	| 'STORE_STATE_UNAVAILABLE'

export class ReviewAuditStoreError extends Error {
	constructor(
		readonly code: ReviewAuditStoreErrorCode,
		message: string
	) {
		super(message)
		this.name = 'ReviewAuditStoreError'
	}
}

interface ReviewAuditStoreDependencies {
	now?(): number
	randomUUID?(): string
}

export interface InMemoryReviewAuditStoreOptions extends ReviewAuditStoreDependencies {
	maxEntries?: number
}

interface MemoryAttempt {
	finished: boolean
	intent: ReviewAuditIntent
}

/** An append-only implementation intended for tests and explicit non-production use. */
export class InMemoryReviewAuditStore implements ReviewAuditStore {
	private readonly attempts = new Map<string, MemoryAttempt>()
	private readonly entries: ReviewAuditEntry[] = []
	private readonly maxEntries: number
	private readonly now: () => number
	private readonly randomUUID: () => string

	constructor(options: InMemoryReviewAuditStoreOptions = {}) {
		this.maxEntries = readMaxEntries(options.maxEntries)
		this.now = options.now ?? Date.now
		this.randomUUID = options.randomUUID ?? nodeRandomUUID
	}

	async begin(intent: ReviewAuditIntent) {
		const normalized = validateIntent(intent)
		const openAttempts = [...this.attempts.values()].filter(({ finished }) => !finished).length
		if (this.entries.length + openAttempts + 2 > this.maxEntries) throw capacityError()

		const attemptId = generateAttemptId(this.randomUUID, (candidate) =>
			this.attempts.has(candidate)
		)
		const timestampMs = readTimestamp(this.now)
		const sequence = this.entries.length + 1
		this.attempts.set(attemptId, { finished: false, intent: cloneIntent(normalized) })
		this.entries.push(createAttemptEntry(sequence, attemptId, timestampMs, normalized))
		return attemptId
	}

	async finish(attemptId: string, outcome: ReviewAuditOutcome) {
		validateAttemptId(attemptId)
		const normalized = validateOutcome(outcome)
		const attempt = this.attempts.get(attemptId)
		if (!attempt) throw attemptNotFound()
		if (attempt.finished) throw attemptAlreadyFinished()

		const timestampMs = readTimestamp(this.now)
		attempt.finished = true
		this.entries.push(
			createOutcomeEntry(
				this.entries.length + 1,
				attemptId,
				timestampMs,
				attempt.intent,
				normalized
			)
		)
	}

	getEntries(): ReviewAuditEntry[] {
		return this.entries.map(cloneEntry)
	}
}

export interface SqliteReviewAuditStoreOptions extends ReviewAuditStoreDependencies {
	maxEntries?: number
}

interface AttemptRow {
	action: ReviewAuditAction
	effective_actor_id: number | null
	effective_actor_kind: ReviewAuditEffectiveActor['kind']
	playlist_id: number
	principal_id: string
	project_id: number
	request_id: string
	version_id: number
}

/**
 * Durable append-only audit storage. SQLite runs in rollback-journal mode with FULL synchronous
 * commits so `begin` does not resolve until the intent transaction has been committed.
 */
export class SqliteReviewAuditStore implements ReviewAuditStore {
	private readonly database: DatabaseSync
	private readonly databasePath: string
	private readonly maxEntries: number
	private readonly now: () => number
	private readonly randomUUID: () => string
	private closed = false

	constructor(storeDirectory: string, options: SqliteReviewAuditStoreOptions = {}) {
		if (
			typeof storeDirectory !== 'string' ||
			storeDirectory.trim() !== storeDirectory ||
			!isAbsolute(storeDirectory) ||
			/^[\\/]{2}/.test(storeDirectory)
		) {
			throw auditError(
				'INVALID_PATH',
				'The review audit store directory must be an absolute local path.'
			)
		}
		this.maxEntries = readMaxEntries(options.maxEntries)
		this.now = options.now ?? Date.now
		this.randomUUID = options.randomUUID ?? nodeRandomUUID

		const safeDirectory = prepareSecureDirectory(storeDirectory)
		this.databasePath = join(safeDirectory, AUDIT_DATABASE_NAME)
		prepareSecureDatabaseFile(this.databasePath)

		let database: DatabaseSync | undefined
		try {
			database = new DatabaseSync(this.databasePath)
			this.database = database
			this.initializeDatabase()
			assertSecureStoreEntries(this.databasePath)
		} catch (error) {
			try {
				database?.close()
			} catch {
				// Preserve the initialization failure.
			}
			throw normalizeStoreFailure(error)
		}
	}

	async begin(intent: ReviewAuditIntent) {
		this.assertOpen()
		const normalized = validateIntent(intent)
		const timestampMs = readTimestamp(this.now)
		assertSecureStoreEntries(this.databasePath)

		let transactionOpen = false
		try {
			this.database.exec('BEGIN IMMEDIATE')
			transactionOpen = true
			const entryCount = readCount(
				this.database,
				'SELECT COUNT(*) AS value FROM review_audit_entries'
			)
			const openAttemptCount = readCount(
				this.database,
				`SELECT COUNT(*) AS value
				 FROM review_audit_entries AS attempt
				 WHERE attempt.entry_kind = 'attempt'
				   AND NOT EXISTS (
					SELECT 1 FROM review_audit_entries AS outcome
					WHERE outcome.attempt_id = attempt.attempt_id
					  AND outcome.entry_kind = 'outcome'
				   )`
			)
			if (entryCount + openAttemptCount + 2 > this.maxEntries) throw capacityError()

			const attemptId = generateAttemptId(this.randomUUID, (candidate) => {
				return (
					this.database
						.prepare('SELECT 1 AS value FROM review_audit_entries WHERE attempt_id = ? LIMIT 1')
						.get(candidate) !== undefined
				)
			})
			this.database
				.prepare(
					`INSERT INTO review_audit_entries (
						entry_kind, attempt_id, request_id, principal_id,
						effective_actor_kind, effective_actor_id, action,
						project_id, playlist_id, version_id, timestamp_ms,
						outcome, error_code, result_note_id, result_attachment_id, decision_status
					) VALUES ('attempt', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL)`
				)
				.run(
					attemptId,
					normalized.requestId,
					normalized.principalId,
					normalized.effectiveActor.kind,
					normalized.effectiveActor.id,
					normalized.action,
					normalized.projectId,
					normalized.playlistId,
					normalized.versionId,
					timestampMs
				)
			this.database.exec('COMMIT')
			transactionOpen = false
			assertSecureStoreEntries(this.databasePath)
			return attemptId
		} catch (error) {
			if (transactionOpen) rollback(this.database)
			throw normalizeStoreFailure(error)
		}
	}

	async finish(attemptId: string, outcome: ReviewAuditOutcome) {
		this.assertOpen()
		validateAttemptId(attemptId)
		const normalized = validateOutcome(outcome)
		const timestampMs = readTimestamp(this.now)
		assertSecureStoreEntries(this.databasePath)

		let transactionOpen = false
		try {
			this.database.exec('BEGIN IMMEDIATE')
			transactionOpen = true
			const attempt = this.database
				.prepare(
					`SELECT request_id, principal_id, effective_actor_kind, effective_actor_id,
						action, project_id, playlist_id, version_id
					 FROM review_audit_entries
					 WHERE attempt_id = ? AND entry_kind = 'attempt'`
				)
				.get(attemptId) as unknown as AttemptRow | undefined
			if (!attempt) throw attemptNotFound()
			if (
				this.database
					.prepare(
						"SELECT 1 AS value FROM review_audit_entries WHERE attempt_id = ? AND entry_kind = 'outcome'"
					)
					.get(attemptId) !== undefined
			) {
				throw attemptAlreadyFinished()
			}

			this.database
				.prepare(
					`INSERT INTO review_audit_entries (
						entry_kind, attempt_id, request_id, principal_id,
						effective_actor_kind, effective_actor_id, action,
						project_id, playlist_id, version_id, timestamp_ms,
						outcome, error_code, result_note_id, result_attachment_id, decision_status
					) VALUES ('outcome', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.run(
					attemptId,
					attempt.request_id,
					attempt.principal_id,
					attempt.effective_actor_kind,
					attempt.effective_actor_id,
					attempt.action,
					attempt.project_id,
					attempt.playlist_id,
					attempt.version_id,
					timestampMs,
					normalized.status,
					normalized.errorCode,
					normalized.resultNoteId,
					normalized.resultAttachmentId,
					normalized.decisionStatus
				)
			this.database.exec('COMMIT')
			transactionOpen = false
			assertSecureStoreEntries(this.databasePath)
		} catch (error) {
			if (transactionOpen) rollback(this.database)
			throw normalizeStoreFailure(error)
		}
	}

	close() {
		if (this.closed) return
		this.closed = true
		try {
			this.database.close()
		} catch (error) {
			throw normalizeStoreFailure(error)
		}
	}

	private assertOpen() {
		if (this.closed) {
			throw auditError('STORE_CLOSED', 'The review audit store is closed.')
		}
	}

	private initializeDatabase() {
		this.database.exec(`
			PRAGMA busy_timeout = 5000;
			PRAGMA foreign_keys = ON;
			PRAGMA journal_mode = DELETE;
			PRAGMA synchronous = FULL;
			PRAGMA trusted_schema = OFF;
		`)

		let transactionOpen = false
		try {
			this.database.exec('BEGIN EXCLUSIVE')
			transactionOpen = true
			const version = readPragmaNumber(this.database, 'user_version')
			if (version === 0) {
				const existingObjects = readCount(
					this.database,
					"SELECT COUNT(*) AS value FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'"
				)
				if (existingObjects !== 0) throw invalidSchema()
				this.createSchema()
			} else if (version !== AUDIT_SCHEMA_VERSION) {
				throw invalidSchema()
			}
			this.verifySchema()
			this.database.exec('COMMIT')
			transactionOpen = false
		} catch (error) {
			if (transactionOpen) rollback(this.database)
			throw error
		}
	}

	private createSchema() {
		const allowedErrorCodes = REVIEW_API_ERROR_CODES.map((code) => `'${code}'`).join(', ')
		this.database.exec(`
			PRAGMA application_id = ${AUDIT_APPLICATION_ID};
			CREATE TABLE review_audit_metadata (
				key TEXT PRIMARY KEY CHECK (key = 'schema'),
				value TEXT NOT NULL CHECK (value = '${AUDIT_SCHEMA_MARKER}')
			) STRICT;
			INSERT INTO review_audit_metadata (key, value)
			VALUES ('schema', '${AUDIT_SCHEMA_MARKER}');

			CREATE TABLE review_audit_entries (
				sequence INTEGER PRIMARY KEY AUTOINCREMENT,
				entry_kind TEXT NOT NULL CHECK (entry_kind IN ('attempt', 'outcome')),
				attempt_id TEXT NOT NULL CHECK (length(attempt_id) = 36),
				request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND ${MAX_REQUEST_ID_LENGTH}),
				principal_id TEXT NOT NULL CHECK (length(principal_id) BETWEEN 1 AND ${MAX_PRINCIPAL_ID_LENGTH}),
				effective_actor_kind TEXT NOT NULL CHECK (effective_actor_kind IN ('human', 'service')),
				effective_actor_id INTEGER CHECK (effective_actor_id IS NULL OR effective_actor_id > 0),
				action TEXT NOT NULL CHECK (action IN ('decision', 'publication')),
				project_id INTEGER NOT NULL CHECK (project_id > 0),
				playlist_id INTEGER NOT NULL CHECK (playlist_id > 0),
				version_id INTEGER NOT NULL CHECK (version_id > 0),
				timestamp_ms INTEGER NOT NULL CHECK (timestamp_ms >= 0),
				outcome TEXT CHECK (outcome IS NULL OR outcome IN ('failed', 'indeterminate', 'succeeded')),
				error_code TEXT CHECK (error_code IS NULL OR error_code IN (${allowedErrorCodes})),
				result_note_id INTEGER CHECK (result_note_id IS NULL OR result_note_id > 0),
				result_attachment_id INTEGER CHECK (result_attachment_id IS NULL OR result_attachment_id > 0),
				decision_status TEXT CHECK (
					decision_status IS NULL OR length(decision_status) BETWEEN 1 AND 64
				),
				UNIQUE (attempt_id, entry_kind),
				CHECK (
					(effective_actor_kind = 'human' AND effective_actor_id IS NOT NULL)
					OR effective_actor_kind = 'service'
				),
				CHECK (
					(entry_kind = 'attempt' AND outcome IS NULL AND error_code IS NULL
						AND result_note_id IS NULL AND result_attachment_id IS NULL
						AND decision_status IS NULL)
					OR
					(entry_kind = 'outcome' AND outcome IS NOT NULL
						AND ((outcome = 'succeeded' AND error_code IS NULL)
							OR (outcome != 'succeeded' AND error_code IS NOT NULL)))
				)
			) STRICT;

			CREATE TRIGGER review_audit_entries_no_update
			BEFORE UPDATE ON review_audit_entries
			BEGIN
				SELECT RAISE(ABORT, 'review audit entries are append-only');
			END;
			CREATE TRIGGER review_audit_entries_no_delete
			BEFORE DELETE ON review_audit_entries
			BEGIN
				SELECT RAISE(ABORT, 'review audit entries are append-only');
			END;
			CREATE TRIGGER review_audit_outcome_requires_attempt
			BEFORE INSERT ON review_audit_entries
			WHEN NEW.entry_kind = 'outcome' AND NOT EXISTS (
				SELECT 1 FROM review_audit_entries
				WHERE attempt_id = NEW.attempt_id AND entry_kind = 'attempt'
			)
			BEGIN
				SELECT RAISE(ABORT, 'review audit outcome has no attempt');
			END;
			CREATE TRIGGER review_audit_metadata_no_update
			BEFORE UPDATE ON review_audit_metadata
			BEGIN
				SELECT RAISE(ABORT, 'review audit metadata is immutable');
			END;
			CREATE TRIGGER review_audit_metadata_no_delete
			BEFORE DELETE ON review_audit_metadata
			BEGIN
				SELECT RAISE(ABORT, 'review audit metadata is immutable');
			END;
			PRAGMA user_version = ${AUDIT_SCHEMA_VERSION};
		`)
	}

	private verifySchema() {
		if (
			readPragmaNumber(this.database, 'application_id') !== AUDIT_APPLICATION_ID ||
			readPragmaNumber(this.database, 'user_version') !== AUDIT_SCHEMA_VERSION
		) {
			throw invalidSchema()
		}
		const marker = this.database
			.prepare("SELECT value FROM review_audit_metadata WHERE key = 'schema'")
			.get() as { value: string } | undefined
		if (marker?.value !== AUDIT_SCHEMA_MARKER) throw invalidSchema()

		const expectedColumns = [
			'sequence',
			'entry_kind',
			'attempt_id',
			'request_id',
			'principal_id',
			'effective_actor_kind',
			'effective_actor_id',
			'action',
			'project_id',
			'playlist_id',
			'version_id',
			'timestamp_ms',
			'outcome',
			'error_code',
			'result_note_id',
			'result_attachment_id',
			'decision_status',
		]
		const columns = this.database
			.prepare('PRAGMA table_info(review_audit_entries)')
			.all() as unknown as Array<{ name: string }>
		if (
			columns.length !== expectedColumns.length ||
			columns.some(({ name }, index) => name !== expectedColumns[index])
		) {
			throw invalidSchema()
		}

		const expectedObjects = [
			['review_audit_entries', 'table'],
			['review_audit_entries_no_delete', 'trigger'],
			['review_audit_entries_no_update', 'trigger'],
			['review_audit_metadata', 'table'],
			['review_audit_metadata_no_delete', 'trigger'],
			['review_audit_metadata_no_update', 'trigger'],
			['review_audit_outcome_requires_attempt', 'trigger'],
		] as const
		for (const [name, type] of expectedObjects) {
			const found = this.database
				.prepare('SELECT 1 AS value FROM sqlite_schema WHERE name = ? AND type = ?')
				.get(name, type)
			if (!found) throw invalidSchema()
		}
	}
}

function validateIntent(value: ReviewAuditIntent): ReviewAuditIntent {
	if (!isPlainDataObject(value) || !hasExactKeys(value, INTENT_KEYS)) throw invalidIntent()
	if (
		!isBoundedOpaqueId(value.requestId, MAX_REQUEST_ID_LENGTH) ||
		!isBoundedOpaqueId(value.principalId, MAX_PRINCIPAL_ID_LENGTH) ||
		!REVIEW_AUDIT_ACTIONS.includes(value.action as ReviewAuditAction) ||
		!isPositiveEntityId(value.projectId) ||
		!isPositiveEntityId(value.playlistId) ||
		!isPositiveEntityId(value.versionId) ||
		!isPlainDataObject(value.effectiveActor) ||
		!hasExactKeys(value.effectiveActor, EFFECTIVE_ACTOR_KEYS) ||
		(value.effectiveActor.kind !== 'human' && value.effectiveActor.kind !== 'service') ||
		(value.effectiveActor.id !== null && !isPositiveEntityId(value.effectiveActor.id)) ||
		(value.effectiveActor.kind === 'human' && value.effectiveActor.id === null)
	) {
		throw invalidIntent()
	}
	return cloneIntent(value)
}

function validateOutcome(value: ReviewAuditOutcome): ReviewAuditOutcome {
	if (!isPlainDataObject(value) || !hasExactKeys(value, OUTCOME_KEYS)) throw invalidOutcome()
	if (
		(value.status !== 'failed' &&
			value.status !== 'indeterminate' &&
			value.status !== 'succeeded') ||
		(value.errorCode !== null && !isReviewApiErrorCode(value.errorCode)) ||
		(value.status === 'succeeded' ? value.errorCode !== null : value.errorCode === null) ||
		(value.resultNoteId !== null && !isPositiveEntityId(value.resultNoteId)) ||
		(value.resultAttachmentId !== null && !isPositiveEntityId(value.resultAttachmentId)) ||
		(value.decisionStatus !== null && !DECISION_STATUS_PATTERN.test(value.decisionStatus))
	) {
		throw invalidOutcome()
	}
	return { ...value }
}

const INTENT_KEYS = [
	'action',
	'effectiveActor',
	'playlistId',
	'principalId',
	'projectId',
	'requestId',
	'versionId',
] as const
const EFFECTIVE_ACTOR_KEYS = ['id', 'kind'] as const
const OUTCOME_KEYS = [
	'decisionStatus',
	'errorCode',
	'resultAttachmentId',
	'resultNoteId',
	'status',
] as const

function cloneIntent(intent: ReviewAuditIntent): ReviewAuditIntent {
	return { ...intent, effectiveActor: { ...intent.effectiveActor } }
}

function createAttemptEntry(
	sequence: number,
	attemptId: string,
	timestampMs: number,
	intent: ReviewAuditIntent
): ReviewAuditAttemptEntry {
	return {
		...cloneIntent(intent),
		attemptId,
		decisionStatus: null,
		entryKind: 'attempt',
		errorCode: null,
		outcome: null,
		resultAttachmentId: null,
		resultNoteId: null,
		sequence,
		timestampMs,
	}
}

function createOutcomeEntry(
	sequence: number,
	attemptId: string,
	timestampMs: number,
	intent: ReviewAuditIntent,
	outcome: ReviewAuditOutcome
): ReviewAuditOutcomeEntry {
	return {
		...cloneIntent(intent),
		attemptId,
		decisionStatus: outcome.decisionStatus,
		entryKind: 'outcome',
		errorCode: outcome.errorCode,
		outcome: outcome.status,
		resultAttachmentId: outcome.resultAttachmentId,
		resultNoteId: outcome.resultNoteId,
		sequence,
		timestampMs,
	}
}

function cloneEntry(entry: ReviewAuditEntry): ReviewAuditEntry {
	return { ...entry, effectiveActor: { ...entry.effectiveActor } }
}

function generateAttemptId(randomUUID: () => string, exists: (candidate: string) => boolean) {
	for (let attempt = 0; attempt < MAX_ATTEMPT_ID_GENERATION_TRIES; attempt++) {
		const candidate = randomUUID()
		if (ATTEMPT_ID_PATTERN.test(candidate) && !exists(candidate)) return candidate.toLowerCase()
	}
	throw auditError(
		'STORE_STATE_UNAVAILABLE',
		'The review audit store could not allocate an attempt id.'
	)
}

function validateAttemptId(value: string) {
	if (typeof value !== 'string' || !ATTEMPT_ID_PATTERN.test(value)) {
		throw auditError('INVALID_ATTEMPT_ID', 'The review audit attempt id is invalid.')
	}
}

function readTimestamp(now: () => number) {
	const value = now()
	if (!Number.isSafeInteger(value) || value < 0 || !Number.isFinite(new Date(value).getTime())) {
		throw auditError('STORE_STATE_UNAVAILABLE', 'The review audit clock is invalid.')
	}
	return value
}

function readMaxEntries(value: number | undefined) {
	const resolved = value ?? DEFAULT_MAX_ENTRIES
	if (!Number.isSafeInteger(resolved) || resolved < 2 || resolved > MAX_MAX_ENTRIES) {
		throw auditError(
			'INVALID_OPTIONS',
			`The review audit capacity must be an integer from 2 to ${MAX_MAX_ENTRIES}.`
		)
	}
	return resolved
}

function isPositiveEntityId(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) > 0
}

function isBoundedOpaqueId(value: unknown, maximumLength: number): value is string {
	return typeof value === 'string' && value.length <= maximumLength && OPAQUE_ID_PATTERN.test(value)
}

function isPlainDataObject(value: unknown): value is object {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
	const prototype = Object.getPrototypeOf(value)
	if (prototype !== Object.prototype && prototype !== null) return false
	return Object.values(Object.getOwnPropertyDescriptors(value)).every(
		(descriptor) => 'value' in descriptor
	)
}

function hasExactKeys(value: object, expected: readonly string[]) {
	const keys = Object.keys(value).sort()
	const sortedExpected = [...expected].sort()
	return (
		keys.length === sortedExpected.length &&
		keys.every((key, index) => key === sortedExpected[index])
	)
}

function prepareSecureDirectory(configuredPath: string) {
	const absolutePath = resolve(configuredPath)
	const root = parse(absolutePath).root
	if (absolutePath === root) {
		throw auditError('INVALID_PATH', 'The review audit store directory is too broad.')
	}

	let current = root
	let finalCreated = false
	const parts = relative(root, absolutePath).split(sep).filter(Boolean)
	try {
		for (const [index, part] of parts.entries()) {
			current = join(current, part)
			let info = readStats(current)
			let created = false
			if (!info) {
				mkdirSync(current, { mode: 0o700 })
				created = true
				info = lstatSync(current)
			}
			if (info.isSymbolicLink() || !info.isDirectory()) {
				throw auditError('INVALID_PATH', 'The review audit store path is unsafe.')
			}
			if (index === parts.length - 1) finalCreated = created
		}
		const finalInfo = lstatSync(absolutePath)
		if (finalCreated && process.platform !== 'win32') chmodSync(absolutePath, 0o700)
		validatePosixEntry(lstatSync(absolutePath), 'directory')
		if (!finalInfo.isDirectory())
			throw auditError('INVALID_PATH', 'The review audit path is invalid.')
		return resolve(realpathSync(absolutePath))
	} catch (error) {
		throw normalizePathFailure(error)
	}
}

function prepareSecureDatabaseFile(databasePath: string) {
	try {
		assertSecureStoreEntries(databasePath, false)
		if (!readStats(databasePath)) {
			const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW
			const descriptor = openSync(
				databasePath,
				constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | noFollow,
				0o600
			)
			try {
				if (process.platform !== 'win32') fchmodSync(descriptor, 0o600)
				fsyncSync(descriptor)
			} finally {
				closeSync(descriptor)
			}
			syncDirectory(resolve(databasePath, '..'))
		}
		const info = lstatSync(databasePath)
		if (info.isSymbolicLink() || !info.isFile()) {
			throw auditError('INVALID_PATH', 'The review audit database path is unsafe.')
		}
		validatePosixEntry(info, 'file')
	} catch (error) {
		throw normalizePathFailure(error)
	}
}

function assertSecureStoreEntries(databasePath: string, requireDatabase = true) {
	for (const path of [
		databasePath,
		`${databasePath}-journal`,
		`${databasePath}-wal`,
		`${databasePath}-shm`,
	]) {
		const info = readStats(path)
		if (!info) {
			if (requireDatabase && path === databasePath) {
				throw auditError('INVALID_PATH', 'The review audit database is unavailable.')
			}
			continue
		}
		if (info.isSymbolicLink() || !info.isFile()) {
			throw auditError('INVALID_PATH', 'The review audit store contains an unsafe entry.')
		}
		validatePosixEntry(info, 'file')
	}
}

function validatePosixEntry(info: Stats, kind: 'directory' | 'file') {
	if (process.platform === 'win32') return
	const currentUid = process.getuid?.()
	const requiredMode = kind === 'directory' ? 0o700 : 0o600
	if (
		currentUid === undefined ||
		Number(info.uid) !== currentUid ||
		(Number(info.mode) & 0o777) !== requiredMode
	) {
		throw auditError(
			'INVALID_PATH',
			`The review audit ${kind} has unsafe ownership or permissions.`
		)
	}
}

function readStats(path: string) {
	try {
		return lstatSync(path)
	} catch (error) {
		if (hasErrorCode(error, 'ENOENT')) return null
		throw error
	}
}

function syncDirectory(path: string) {
	let descriptor: number | undefined
	try {
		descriptor = openSync(path, 'r')
		fsyncSync(descriptor)
	} catch (error) {
		if (process.platform !== 'win32') throw error
	} finally {
		if (descriptor !== undefined) closeSync(descriptor)
	}
}

function readCount(database: DatabaseSync, sql: string) {
	const row = database.prepare(sql).get() as { value: number }
	const value = Number(row.value)
	if (!Number.isSafeInteger(value) || value < 0) throw invalidSchema()
	return value
}

function readPragmaNumber(database: DatabaseSync, name: 'application_id' | 'user_version') {
	const row = database.prepare(`PRAGMA ${name}`).get() as Record<string, number>
	const value = Number(row[name])
	if (!Number.isSafeInteger(value) || value < 0) throw invalidSchema()
	return value
}

function rollback(database: DatabaseSync) {
	try {
		database.exec('ROLLBACK')
	} catch {
		// Preserve the operation failure. The connection is not reused by a successful caller path.
	}
}

function capacityError() {
	return auditError(
		'STORE_CAPACITY_EXCEEDED',
		'The review audit store does not have capacity for another complete attempt.'
	)
}

function invalidIntent() {
	return auditError('INVALID_INTENT', 'The review audit intent is invalid.')
}

function invalidOutcome() {
	return auditError('INVALID_OUTCOME', 'The review audit outcome is invalid.')
}

function invalidSchema() {
	return auditError('STORE_STATE_UNAVAILABLE', 'The review audit database schema is invalid.')
}

function attemptNotFound() {
	return auditError('ATTEMPT_NOT_FOUND', 'The review audit attempt does not exist.')
}

function attemptAlreadyFinished() {
	return auditError('ATTEMPT_ALREADY_FINISHED', 'The review audit attempt is already finished.')
}

function auditError(code: ReviewAuditStoreErrorCode, message: string) {
	return new ReviewAuditStoreError(code, message)
}

function normalizePathFailure(error: unknown) {
	if (error instanceof ReviewAuditStoreError) return error
	return auditError('INVALID_PATH', 'The review audit store path could not be secured.')
}

function normalizeStoreFailure(error: unknown) {
	if (error instanceof ReviewAuditStoreError) return error
	return auditError('STORE_STATE_UNAVAILABLE', 'The review audit store is unavailable.')
}

function hasErrorCode(error: unknown, code: string) {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		(error as { code?: unknown }).code === code
	)
}
