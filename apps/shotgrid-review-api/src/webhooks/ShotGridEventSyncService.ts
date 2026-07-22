import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { ReviewChangeEvent } from '@tldraw/shotgrid-review-contracts'
import { ReviewGatewayError } from '../errors'

const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024
const MAX_BATCH_EVENTS = 50
const MAX_SOURCE_EVENT_ID_LENGTH = 128
const DEFAULT_MAX_QUEUE_EVENTS = 10_000
const DEFAULT_MAX_QUEUE_BYTES = 16 * 1024 * 1024
const DEFAULT_MAX_PROCESSING_ATTEMPTS = 5
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000
const DEFAULT_LEASE_DURATION_MS = 30_000
const WORKER_YIELD_INTERVAL = 25
const MAX_REPLAY_EVENTS = 100
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SIGNATURE_PATTERN = /^sha1=([0-9a-fA-F]{40})$/

const SUBSCRIBED_UPDATE_FIELDS = new Map<ReviewChangeEvent['entity']['type'], ReadonlySet<string>>([
	['Project', new Set(['image', 'name', 'sg_status'])],
	['Playlist', new Set(['code', 'description', 'project', 'updated_at', 'versions'])],
	[
		'Version',
		new Set([
			'code',
			'description',
			'entity',
			'frame_count',
			'frame_rate',
			'image',
			'playlists',
			'project',
			'sg_first_frame',
			'sg_last_frame',
			'sg_status_list',
			'sg_task',
			'sg_uploaded_movie',
			'user',
		]),
	],
	[
		'Note',
		new Set([
			'addressings_to',
			'attachments',
			'content',
			'note_links',
			'project',
			'sg_status_list',
			'subject',
			'tasks',
		]),
	],
	['Attachment', new Set(['attachment_links', 'description', 'filename', 'project', 'this_file'])],
])

type ChangeEntityType = ReviewChangeEvent['entity']['type']
type ChangeOperation = ReviewChangeEvent['operation']

interface ParsedWebhookEvent extends Omit<ReviewChangeEvent, 'sequence'> {
	eventBytes: number
	semanticHash: string
}

interface InboxRow {
	attribute_name: null | string
	entity_id: number
	entity_type: ChangeEntityType
	event_log_entry_id: number
	lease_owner: null | string
	observed_at: string
	operation: ChangeOperation
	project_id: number
	retry_count: number
	source_event_id: string
}

export interface ShotGridWebhookRequest {
	body: Buffer
	deliveryId: string
	signature: string
	siteUrl: string
	webhookId: string
}

export interface ShotGridWebhookReceipt {
	acceptedEvents: number
	conflictingEvents: number
	deliveryId: string
	duplicateDelivery: boolean
	duplicateEvents: number
	ignoredEvents: number
}

export interface ShotGridEventSyncStatus {
	connectedClients: number
	counters: {
		acceptedEvents: number
		conflictingDeliveries: number
		conflictingEvents: number
		duplicateDeliveries: number
		duplicateEvents: number
		failedEvents: number
		ignoredEvents: number
		processedEvents: number
		receivedDeliveries: number
		retryAttempts: number
		signatureFailures: number
	}
	latestSequence: number
	lastProcessedAt: string | null
	lastReceivedAt: string | null
	queue: {
		bytes: number
		depth: number
		oldestAgeMs: number
	}
	state: 'healthy' | 'degraded' | 'stopped'
}

export interface ShotGridEventSyncServiceOptions {
	allowedProjectIds: readonly number[]
	leaseDurationMs?: number
	maxProcessingAttempts?: number
	maxQueueBytes?: number
	maxQueueEvents?: number
	now?(): number
	processInvalidation?(
		event: Omit<ReviewChangeEvent, 'sequence'>,
		signal: AbortSignal
	): Promise<void> | void
	retryBaseDelayMs?: number
	secret: string
	siteUrl: string
	storeDir: string
	/** A single id remains supported for focused tests and one-hook local development. */
	webhookId?: string
	/** Production uses one ShotGrid webhook per entity type and allows every configured id here. */
	webhookIds?: readonly string[]
}

type ChangeListener = (event: ReviewChangeEvent) => boolean | void

/**
 * Durable ShotGrid webhook inbox. Webhook payloads are invalidation hints only: event old/new
 * values are deliberately never stored or applied as current state.
 */
export class ShotGridEventSyncService {
	private readonly abortController = new AbortController()
	private readonly allowedProjectIds: ReadonlySet<number>
	private readonly database: DatabaseSync
	private readonly leaseDurationMs: number
	private readonly listeners = new Map<ChangeListener, (() => void) | undefined>()
	private readonly maxProcessingAttempts: number
	private readonly maxQueueBytes: number
	private readonly maxQueueEvents: number
	private readonly now: () => number
	private readonly processInvalidation: NonNullable<
		ShotGridEventSyncServiceOptions['processInvalidation']
	>
	private readonly retryBaseDelayMs: number
	private readonly secret: string
	private readonly siteUrl: string
	private readonly webhookIds: ReadonlySet<string>
	private readonly workerId = randomUUID()
	private closePromise: Promise<void> | undefined
	private closed = false
	private retryTimer: ReturnType<typeof setTimeout> | undefined
	private signatureFailures = 0
	private workerFaulted = false
	private workerPromise: Promise<void> | undefined
	private workerScheduled = false

	constructor(options: ShotGridEventSyncServiceOptions) {
		validateServiceOptions(options)
		this.allowedProjectIds = new Set(options.allowedProjectIds)
		this.leaseDurationMs = readPositiveLimit(
			options.leaseDurationMs,
			DEFAULT_LEASE_DURATION_MS,
			1_000,
			10 * 60_000,
			'leaseDurationMs'
		)
		this.maxProcessingAttempts = readPositiveLimit(
			options.maxProcessingAttempts,
			DEFAULT_MAX_PROCESSING_ATTEMPTS,
			1,
			100,
			'maxProcessingAttempts'
		)
		this.maxQueueBytes = readPositiveLimit(
			options.maxQueueBytes,
			DEFAULT_MAX_QUEUE_BYTES,
			MAX_WEBHOOK_BODY_BYTES,
			1024 * 1024 * 1024,
			'maxQueueBytes'
		)
		this.maxQueueEvents = readPositiveLimit(
			options.maxQueueEvents,
			DEFAULT_MAX_QUEUE_EVENTS,
			1,
			1_000_000,
			'maxQueueEvents'
		)
		this.now = options.now ?? Date.now
		this.processInvalidation = options.processInvalidation ?? (() => undefined)
		this.retryBaseDelayMs = readPositiveLimit(
			options.retryBaseDelayMs,
			DEFAULT_RETRY_BASE_DELAY_MS,
			1,
			60_000,
			'retryBaseDelayMs'
		)
		this.secret = options.secret
		this.siteUrl = options.siteUrl
		this.webhookIds = new Set(readWebhookIds(options))

		mkdirSync(options.storeDir, { recursive: true })
		this.database = new DatabaseSync(join(options.storeDir, 'shotgrid-event-sync.sqlite'))
		try {
			this.initializeDatabase()
			this.readNow()
		} catch (error) {
			this.database.close()
			throw error
		}
		this.scheduleWorker()
	}

	ingest(request: ShotGridWebhookRequest): ShotGridWebhookReceipt {
		this.assertOpen()
		if (!Buffer.isBuffer(request.body) || request.body.byteLength === 0) {
			throw invalidWebhookRequest('Webhook body is required.')
		}
		if (request.body.byteLength > MAX_WEBHOOK_BODY_BYTES) {
			throw webhookError('INVALID_REQUEST', 413, false, 'Webhook body is too large.')
		}

		if (!this.verifySignature(request.signature, request.body)) {
			this.signatureFailures++
			throw webhookError('AUTHENTICATION_REQUIRED', 401, false, 'Webhook signature is invalid.')
		}
		if (
			!UUID_PATTERN.test(request.webhookId) ||
			!this.webhookIds.has(request.webhookId.toLowerCase())
		) {
			throw webhookError('PERMISSION_DENIED', 403, false, 'Webhook identity is not allowed.')
		}
		if (canonicalHttpsOrigin(request.siteUrl) !== this.siteUrl) {
			throw webhookError('PERMISSION_DENIED', 403, false, 'Webhook site is not allowed.')
		}
		if (!UUID_PATTERN.test(request.deliveryId)) {
			throw invalidWebhookRequest('Webhook delivery id is invalid.')
		}

		const bodyHash = createHash('sha256').update(request.body).digest('hex')
		const parsed = parseWebhookPayload(request.body, this.allowedProjectIds)
		const now = this.readNow()
		const deliveryId = request.deliveryId.toLowerCase()
		let receipt!: ShotGridWebhookReceipt
		let transactionOpen = false

		try {
			this.database.exec('BEGIN IMMEDIATE')
			transactionOpen = true
			const existingDelivery = this.database
				.prepare('SELECT body_sha256 FROM deliveries WHERE delivery_id = ?')
				.get(deliveryId) as { body_sha256: string } | undefined
			if (existingDelivery) {
				if (existingDelivery.body_sha256 !== bodyHash) {
					incrementCounter(this.database, 'conflicting_deliveries', 1)
					this.database.exec('COMMIT')
					transactionOpen = false
					throw webhookError(
						'INVALID_REQUEST',
						409,
						false,
						'A delivery id was reused with different content.'
					)
				}
				incrementCounter(this.database, 'duplicate_deliveries', 1)
				this.database.exec('COMMIT')
				transactionOpen = false
				return {
					acceptedEvents: 0,
					conflictingEvents: 0,
					deliveryId,
					duplicateDelivery: true,
					duplicateEvents: parsed.events.length,
					ignoredEvents: parsed.ignoredEvents,
				}
			}

			const newEvents: ParsedWebhookEvent[] = []
			const eventsInDelivery = new Map<number, ParsedWebhookEvent>()
			let duplicateEvents = 0
			let conflictingEvents = 0
			for (const event of parsed.events) {
				const sameDeliveryEvent = eventsInDelivery.get(event.eventLogEntryId)
				if (sameDeliveryEvent) {
					if (sameDeliveryEvent.semanticHash === event.semanticHash) duplicateEvents++
					else {
						conflictingEvents++
						this.database
							.prepare(
								`INSERT INTO event_conflicts (
									event_log_entry_id, existing_hash, received_hash, received_at_ms
								) VALUES (?, ?, ?, ?)`
							)
							.run(event.eventLogEntryId, sameDeliveryEvent.semanticHash, event.semanticHash, now)
					}
					continue
				}
				eventsInDelivery.set(event.eventLogEntryId, event)
				const existing = this.database
					.prepare('SELECT semantic_hash FROM inbox_events WHERE event_log_entry_id = ?')
					.get(event.eventLogEntryId) as { semantic_hash: string } | undefined
				if (!existing) {
					newEvents.push(event)
				} else if (existing.semantic_hash === event.semanticHash) {
					duplicateEvents++
				} else {
					conflictingEvents++
					this.database
						.prepare(
							`INSERT INTO event_conflicts (
								event_log_entry_id, existing_hash, received_hash, received_at_ms
							) VALUES (?, ?, ?, ?)`
						)
						.run(event.eventLogEntryId, existing.semantic_hash, event.semanticHash, now)
				}
			}

			const queue = this.readQueueUsage()
			const addedBytes = newEvents.reduce((total, event) => total + event.eventBytes, 0)
			if (
				newEvents.length > 0 &&
				(queue.depth + newEvents.length > this.maxQueueEvents ||
					queue.bytes + addedBytes > this.maxQueueBytes)
			) {
				throw webhookError('COLLABORATION_UNAVAILABLE', 503, true, 'Webhook queue is full.')
			}

			this.database
				.prepare(
					`INSERT INTO deliveries (
						delivery_id, webhook_id, body_sha256, received_at_ms, event_count,
						accepted_count, ignored_count, duplicate_count, conflict_count
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.run(
					deliveryId,
					request.webhookId.toLowerCase(),
					bodyHash,
					now,
					parsed.events.length + parsed.ignoredEvents,
					newEvents.length,
					parsed.ignoredEvents,
					duplicateEvents,
					conflictingEvents
				)

			const insertEvent = this.database.prepare(
				`INSERT INTO inbox_events (
					event_log_entry_id, source_event_id, semantic_hash, delivery_id,
					project_id, entity_type, entity_id, operation, attribute_name,
					observed_at, received_at_ms, event_bytes, status, retry_count,
					next_attempt_at_ms
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?)`
			)
			for (const event of newEvents) {
				insertEvent.run(
					event.eventLogEntryId,
					event.sourceEventId,
					event.semanticHash,
					deliveryId,
					event.projectId,
					event.entity.type,
					event.entity.id,
					event.operation,
					event.attributeName,
					event.observedAt,
					now,
					event.eventBytes,
					now
				)
			}

			incrementCounter(this.database, 'received_deliveries', 1)
			incrementCounter(this.database, 'accepted_events', newEvents.length)
			incrementCounter(this.database, 'ignored_events', parsed.ignoredEvents)
			incrementCounter(this.database, 'duplicate_events', duplicateEvents)
			incrementCounter(this.database, 'conflicting_events', conflictingEvents)
			this.database.exec('COMMIT')
			transactionOpen = false
			receipt = {
				acceptedEvents: newEvents.length,
				conflictingEvents,
				deliveryId,
				duplicateDelivery: false,
				duplicateEvents,
				ignoredEvents: parsed.ignoredEvents,
			}
		} catch (error) {
			if (transactionOpen) this.database.exec('ROLLBACK')
			if (error instanceof ReviewGatewayError) throw error
			throw webhookError(
				'COLLABORATION_UNAVAILABLE',
				503,
				true,
				'The durable webhook queue is unavailable.'
			)
		}

		this.scheduleWorker()
		return receipt
	}

	getChangesSince(sequence: number, limit = MAX_REPLAY_EVENTS): ReviewChangeEvent[] {
		this.assertOpen()
		if (!Number.isSafeInteger(sequence) || sequence < 0) {
			throw invalidWebhookRequest('Change cursor must be a non-negative safe integer.')
		}
		if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_REPLAY_EVENTS) {
			throw invalidWebhookRequest('Change replay limit is invalid.')
		}
		const rows = this.database
			.prepare(
				`SELECT sequence, event_log_entry_id, source_event_id, project_id,
					entity_type, entity_id, operation, attribute_name, observed_at
				FROM changes WHERE sequence > ? ORDER BY sequence ASC LIMIT ?`
			)
			.all(sequence, limit + 1) as unknown as ChangeRow[]
		if (rows.length <= limit) return rows.map(mapChangeRow)

		// Any invalidation causes an authoritative browser refetch, so coalescing a very old replay
		// cursor to the latest record is safe and avoids an unbounded reconnect response.
		const latest = this.database
			.prepare(
				`SELECT sequence, event_log_entry_id, source_event_id, project_id,
					entity_type, entity_id, operation, attribute_name, observed_at
				FROM changes ORDER BY sequence DESC LIMIT 1`
			)
			.get() as unknown as ChangeRow | undefined
		return latest ? [mapChangeRow(latest)] : []
	}

	subscribe(listener: ChangeListener, onClose?: () => void) {
		this.assertOpen()
		this.listeners.set(listener, onClose)
		return () => {
			this.listeners.delete(listener)
		}
	}

	getStatus(): ShotGridEventSyncStatus {
		const queue = this.closed ? { bytes: 0, depth: 0 } : this.readQueueUsage()
		const oldest =
			this.closed || queue.depth === 0
				? undefined
				: (
						this.database
							.prepare(
								"SELECT MIN(received_at_ms) AS received_at_ms FROM inbox_events WHERE status IN ('pending', 'processing')"
							)
							.get() as { received_at_ms: null | number }
					).received_at_ms
		const counters = this.closed ? new Map<string, number>() : readCounters(this.database)
		const latestSequence = this.closed
			? 0
			: readAggregateNumber(this.database, 'SELECT MAX(sequence) AS value FROM changes')
		const lastProcessedMs = this.closed
			? null
			: readNullableAggregateNumber(
					this.database,
					"SELECT MAX(processed_at_ms) AS value FROM inbox_events WHERE status = 'processed'"
				)
		const lastReceivedMs = this.closed
			? null
			: readNullableAggregateNumber(
					this.database,
					'SELECT MAX(received_at_ms) AS value FROM deliveries'
				)
		const failedEvents = this.closed
			? 0
			: readAggregateNumber(
					this.database,
					"SELECT COUNT(*) AS value FROM inbox_events WHERE status = 'failed'"
				)
		const retryAttempts = this.closed
			? 0
			: readAggregateNumber(
					this.database,
					'SELECT COALESCE(SUM(retry_count), 0) AS value FROM inbox_events'
				)
		return {
			connectedClients: this.listeners.size,
			counters: {
				acceptedEvents: counters.get('accepted_events') ?? 0,
				conflictingDeliveries: counters.get('conflicting_deliveries') ?? 0,
				conflictingEvents: counters.get('conflicting_events') ?? 0,
				duplicateDeliveries: counters.get('duplicate_deliveries') ?? 0,
				duplicateEvents: counters.get('duplicate_events') ?? 0,
				failedEvents,
				ignoredEvents: counters.get('ignored_events') ?? 0,
				processedEvents: counters.get('processed_events') ?? 0,
				receivedDeliveries: counters.get('received_deliveries') ?? 0,
				retryAttempts,
				signatureFailures: this.signatureFailures,
			},
			latestSequence,
			lastProcessedAt: lastProcessedMs === null ? null : new Date(lastProcessedMs).toISOString(),
			lastReceivedAt: lastReceivedMs === null ? null : new Date(lastReceivedMs).toISOString(),
			queue: {
				...queue,
				oldestAgeMs:
					oldest === undefined || oldest === null ? 0 : Math.max(0, this.readNow() - oldest),
			},
			state: this.closed
				? 'stopped'
				: failedEvents > 0 || this.workerFaulted
					? 'degraded'
					: 'healthy',
		}
	}

	isReady() {
		if (this.closed || this.workerFaulted) return false
		try {
			const queue = this.readQueueUsage()
			return queue.depth < this.maxQueueEvents && queue.bytes < this.maxQueueBytes
		} catch {
			return false
		}
	}

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise
		this.closed = true
		this.abortController.abort()
		if (this.retryTimer) clearTimeout(this.retryTimer)
		this.retryTimer = undefined
		for (const closeListener of this.listeners.values()) closeListener?.()
		this.listeners.clear()
		const activeWorker = this.workerPromise
		this.closePromise = (async () => {
			if (activeWorker) await activeWorker
			this.database.close()
		})()
		return this.closePromise
	}

	private initializeDatabase() {
		this.database.exec(`
			PRAGMA journal_mode = WAL;
			PRAGMA synchronous = FULL;
			PRAGMA busy_timeout = 2000;
			PRAGMA foreign_keys = ON;
			CREATE TABLE IF NOT EXISTS metadata (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL
			) STRICT;
			CREATE TABLE IF NOT EXISTS counters (
				name TEXT PRIMARY KEY,
				value INTEGER NOT NULL CHECK (value >= 0)
			) STRICT;
			CREATE TABLE IF NOT EXISTS deliveries (
				delivery_id TEXT PRIMARY KEY,
				webhook_id TEXT NOT NULL,
				body_sha256 TEXT NOT NULL,
				received_at_ms INTEGER NOT NULL,
				event_count INTEGER NOT NULL,
				accepted_count INTEGER NOT NULL,
				ignored_count INTEGER NOT NULL,
				duplicate_count INTEGER NOT NULL,
				conflict_count INTEGER NOT NULL
			) STRICT;
			CREATE TABLE IF NOT EXISTS inbox_events (
				event_log_entry_id INTEGER PRIMARY KEY,
				source_event_id TEXT NOT NULL,
				semantic_hash TEXT NOT NULL,
				delivery_id TEXT NOT NULL REFERENCES deliveries(delivery_id),
				project_id INTEGER NOT NULL,
				entity_type TEXT NOT NULL,
				entity_id INTEGER NOT NULL,
				operation TEXT NOT NULL,
				attribute_name TEXT,
				observed_at TEXT NOT NULL,
				received_at_ms INTEGER NOT NULL,
				event_bytes INTEGER NOT NULL,
				status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'processed', 'failed')),
				retry_count INTEGER NOT NULL,
				next_attempt_at_ms INTEGER NOT NULL,
				lease_owner TEXT,
				lease_expires_at_ms INTEGER,
				processed_at_ms INTEGER,
				last_error_code TEXT
			) STRICT;
			CREATE INDEX IF NOT EXISTS inbox_events_work
				ON inbox_events(status, next_attempt_at_ms, event_log_entry_id);
			CREATE TABLE IF NOT EXISTS changes (
				sequence INTEGER PRIMARY KEY AUTOINCREMENT,
				event_log_entry_id INTEGER NOT NULL UNIQUE,
				source_event_id TEXT NOT NULL,
				project_id INTEGER NOT NULL,
				entity_type TEXT NOT NULL,
				entity_id INTEGER NOT NULL,
				operation TEXT NOT NULL,
				attribute_name TEXT,
				observed_at TEXT NOT NULL,
				processed_at_ms INTEGER NOT NULL
			) STRICT;
			CREATE TABLE IF NOT EXISTS event_conflicts (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				event_log_entry_id INTEGER NOT NULL,
				existing_hash TEXT NOT NULL,
				received_hash TEXT NOT NULL,
				received_at_ms INTEGER NOT NULL
			) STRICT;
		`)

		const deliveryColumns = this.database
			.prepare('PRAGMA table_info(deliveries)')
			.all() as unknown as Array<{
			name: string
		}>
		if (!deliveryColumns.some(({ name }) => name === 'webhook_id')) {
			this.database.exec('ALTER TABLE deliveries ADD COLUMN webhook_id TEXT')
		}

		const scope = `shotgrid-event-sync-v1\n${this.siteUrl}`
		const current = this.database
			.prepare("SELECT value FROM metadata WHERE key = 'deployment_scope'")
			.get() as { value: string } | undefined
		const legacyScopeForThisSite = current?.value.startsWith(`${this.siteUrl}\n`) === true
		if (current && current.value !== scope && !legacyScopeForThisSite) {
			throw configurationError('The event store belongs to a different ShotGrid webhook.')
		}
		if (legacyScopeForThisSite) {
			this.database
				.prepare("UPDATE metadata SET value = ? WHERE key = 'deployment_scope'")
				.run(scope)
		} else if (!current) {
			this.database
				.prepare("INSERT INTO metadata (key, value) VALUES ('deployment_scope', ?)")
				.run(scope)
		}
		// This store is intentionally owned by one Node process. Recover work claimed by the
		// previous process immediately instead of waiting for its now-orphaned lease.
		this.database
			.prepare(
				`UPDATE inbox_events SET status = 'pending', next_attempt_at_ms = 0,
					lease_owner = NULL, lease_expires_at_ms = NULL
				WHERE status = 'processing'`
			)
			.run()
	}

	private verifySignature(signature: string, body: Buffer) {
		const match = SIGNATURE_PATTERN.exec(signature)
		if (!match) return false
		const supplied = Buffer.from(match[1], 'hex')
		const expected = createHmac('sha1', this.secret).update(body).digest()
		return supplied.byteLength === expected.byteLength && timingSafeEqual(supplied, expected)
	}

	private readQueueUsage() {
		const row = this.database
			.prepare(
				`SELECT COUNT(*) AS depth, COALESCE(SUM(event_bytes), 0) AS bytes
				FROM inbox_events WHERE status IN ('pending', 'processing')`
			)
			.get() as { bytes: number; depth: number }
		return { bytes: Number(row.bytes), depth: Number(row.depth) }
	}

	private scheduleWorker() {
		if (this.closed || this.workerScheduled || this.workerPromise) return
		this.workerScheduled = true
		queueMicrotask(() => {
			this.workerScheduled = false
			if (this.closed || this.workerPromise) return
			const worker = this.drainQueue().catch(() => {
				this.workerFaulted = true
			})
			this.workerPromise = worker
			void worker
				.finally(() => {
					if (this.workerPromise === worker) this.workerPromise = undefined
					if (!this.closed) this.armRetryTimer()
				})
				.catch(() => {
					this.workerFaulted = true
				})
		})
	}

	private async drainQueue() {
		let processedSinceYield = 0
		for (;;) {
			if (this.closed) return
			if (processedSinceYield >= WORKER_YIELD_INTERVAL) {
				processedSinceYield = 0
				await yieldToEventLoop()
				if (this.closed) return
			}
			const event = this.claimNextEvent()
			if (!event) return
			try {
				const invalidation = mapInboxRow(event)
				await this.processInvalidation(invalidation, this.abortController.signal)
				if (this.closed && this.abortController.signal.aborted) {
					this.releaseClaim(event.event_log_entry_id)
					return
				}
				const change = this.completeEvent(event)
				this.publish(change)
			} catch {
				this.failAttempt(event.event_log_entry_id, event.retry_count)
			}
			processedSinceYield++
		}
	}

	private claimNextEvent(): InboxRow | undefined {
		const now = this.readNow()
		let transactionOpen = false
		try {
			this.database.exec('BEGIN IMMEDIATE')
			transactionOpen = true
			const event = this.database
				.prepare(
					`SELECT event_log_entry_id, source_event_id, project_id, entity_type,
						entity_id, operation, attribute_name, observed_at, retry_count, lease_owner
					FROM inbox_events
					WHERE (status = 'pending' AND next_attempt_at_ms <= ?)
						OR (status = 'processing' AND lease_expires_at_ms <= ?)
					ORDER BY event_log_entry_id ASC LIMIT 1`
				)
				.get(now, now) as unknown as InboxRow | undefined
			if (!event) {
				this.database.exec('COMMIT')
				transactionOpen = false
				return undefined
			}
			this.database
				.prepare(
					`UPDATE inbox_events SET status = 'processing', lease_owner = ?,
						lease_expires_at_ms = ? WHERE event_log_entry_id = ?`
				)
				.run(this.workerId, now + this.leaseDurationMs, event.event_log_entry_id)
			this.database.exec('COMMIT')
			transactionOpen = false
			return event
		} catch (error) {
			if (transactionOpen) this.database.exec('ROLLBACK')
			throw error
		}
	}

	private completeEvent(event: InboxRow): ReviewChangeEvent {
		const now = this.readNow()
		let transactionOpen = false
		try {
			this.database.exec('BEGIN IMMEDIATE')
			transactionOpen = true
			const result = this.database
				.prepare(
					`INSERT INTO changes (
						event_log_entry_id, source_event_id, project_id, entity_type,
						entity_id, operation, attribute_name, observed_at, processed_at_ms
					) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
				)
				.run(
					event.event_log_entry_id,
					event.source_event_id,
					event.project_id,
					event.entity_type,
					event.entity_id,
					event.operation,
					event.attribute_name,
					event.observed_at,
					now
				)
			const sequence = Number(result.lastInsertRowid)
			this.database
				.prepare(
					`UPDATE inbox_events SET status = 'processed', processed_at_ms = ?,
						lease_owner = NULL, lease_expires_at_ms = NULL, last_error_code = NULL
					WHERE event_log_entry_id = ? AND lease_owner = ?`
				)
				.run(now, event.event_log_entry_id, this.workerId)
			incrementCounter(this.database, 'processed_events', 1)
			this.database.exec('COMMIT')
			transactionOpen = false
			return {
				...mapInboxRow(event),
				sequence,
			}
		} catch (error) {
			if (transactionOpen) this.database.exec('ROLLBACK')
			throw error
		}
	}

	private failAttempt(eventLogEntryId: number, previousRetryCount: number) {
		if (this.closed || this.abortController.signal.aborted) {
			this.releaseClaim(eventLogEntryId)
			return
		}
		const retryCount = previousRetryCount + 1
		const now = this.readNow()
		if (retryCount >= this.maxProcessingAttempts) {
			this.database
				.prepare(
					`UPDATE inbox_events SET status = 'failed', retry_count = ?,
						lease_owner = NULL, lease_expires_at_ms = NULL, last_error_code = 'PROCESSING_FAILED'
					WHERE event_log_entry_id = ? AND lease_owner = ?`
				)
				.run(retryCount, eventLogEntryId, this.workerId)
			return
		}
		const delay = Math.min(60_000, this.retryBaseDelayMs * 2 ** (retryCount - 1))
		this.database
			.prepare(
				`UPDATE inbox_events SET status = 'pending', retry_count = ?, next_attempt_at_ms = ?,
					lease_owner = NULL, lease_expires_at_ms = NULL, last_error_code = 'PROCESSING_FAILED'
				WHERE event_log_entry_id = ? AND lease_owner = ?`
			)
			.run(retryCount, now + delay, eventLogEntryId, this.workerId)
	}

	private releaseClaim(eventLogEntryId: number) {
		this.database
			.prepare(
				`UPDATE inbox_events SET status = 'pending', next_attempt_at_ms = ?,
					lease_owner = NULL, lease_expires_at_ms = NULL
				WHERE event_log_entry_id = ? AND lease_owner = ?`
			)
			.run(this.readNow(), eventLogEntryId, this.workerId)
	}

	private armRetryTimer() {
		if (this.closed || this.retryTimer) return
		const row = this.database
			.prepare(
				"SELECT MIN(next_attempt_at_ms) AS next_at FROM inbox_events WHERE status = 'pending'"
			)
			.get() as { next_at: null | number }
		if (row.next_at === null) return
		const delay = Math.max(0, Math.min(2_147_483_647, row.next_at - this.readNow()))
		this.retryTimer = setTimeout(() => {
			this.retryTimer = undefined
			this.scheduleWorker()
		}, delay)
		this.retryTimer.unref?.()
	}

	private publish(change: ReviewChangeEvent) {
		for (const [listener, onClose] of this.listeners) {
			try {
				if (listener(change) === false) {
					this.listeners.delete(listener)
					onClose?.()
				}
			} catch {
				this.listeners.delete(listener)
				onClose?.()
			}
		}
	}

	private readNow() {
		const now = this.now()
		if (!Number.isSafeInteger(now) || now < 0) {
			throw configurationError('The event sync clock returned an invalid value.')
		}
		return now
	}

	private assertOpen() {
		if (this.closed) {
			throw webhookError('COLLABORATION_UNAVAILABLE', 503, true, 'Webhook queue is closed.')
		}
	}
}

interface ChangeRow {
	attribute_name: null | string
	entity_id: number
	entity_type: ChangeEntityType
	event_log_entry_id: number
	observed_at: string
	operation: ChangeOperation
	project_id: number
	sequence: number
	source_event_id: string
}

function mapInboxRow(row: InboxRow): Omit<ReviewChangeEvent, 'sequence'> {
	return {
		attributeName: row.attribute_name,
		entity: { id: Number(row.entity_id), type: row.entity_type },
		eventLogEntryId: Number(row.event_log_entry_id),
		observedAt: row.observed_at,
		operation: row.operation,
		projectId: Number(row.project_id),
		sourceEventId: row.source_event_id,
	}
}

function mapChangeRow(row: ChangeRow): ReviewChangeEvent {
	return {
		attributeName: row.attribute_name,
		entity: { id: Number(row.entity_id), type: row.entity_type },
		eventLogEntryId: Number(row.event_log_entry_id),
		observedAt: row.observed_at,
		operation: row.operation,
		projectId: Number(row.project_id),
		sequence: Number(row.sequence),
		sourceEventId: row.source_event_id,
	}
}

function parseWebhookPayload(body: Buffer, allowedProjectIds: ReadonlySet<number>) {
	let decoded: string
	try {
		decoded = new TextDecoder('utf-8', { fatal: true }).decode(body)
	} catch {
		throw invalidWebhookRequest('Webhook body must be valid UTF-8.')
	}
	let value: unknown
	try {
		value = JSON.parse(decoded)
	} catch {
		throw invalidWebhookRequest('Webhook body must be valid JSON.')
	}
	const envelope = requireRecord(value, 'Webhook payload')
	const observedAt = normalizeTimestamp(envelope.timestamp)
	const data = requireRecord(envelope.data, 'Webhook data')
	const deliveries = 'deliveries' in data ? data.deliveries : undefined
	let rawEvents: unknown[]
	if (deliveries !== undefined) {
		if (
			!Array.isArray(deliveries) ||
			deliveries.length === 0 ||
			deliveries.length > MAX_BATCH_EVENTS
		) {
			throw invalidWebhookRequest('Webhook batch must contain from 1 to 50 deliveries.')
		}
		rawEvents = deliveries
	} else {
		rawEvents = [data]
	}

	const events: ParsedWebhookEvent[] = []
	let ignoredEvents = 0
	for (const rawEvent of rawEvents) {
		const parsed = parseWebhookEvent(rawEvent, observedAt, allowedProjectIds)
		if (parsed) events.push(parsed)
		else ignoredEvents++
	}
	return { events, ignoredEvents }
}

function parseWebhookEvent(
	value: unknown,
	observedAt: string,
	allowedProjectIds: ReadonlySet<number>
): ParsedWebhookEvent | null {
	const event = requireRecord(value, 'Webhook event')
	if (event.event_type === 'Test_Connection' || event.operation === 'test_connection') return null

	const sourceEventId = requireBoundedString(
		event.id,
		'Webhook event id',
		MAX_SOURCE_EVENT_ID_LENGTH
	)
	const eventLogEntryId = requirePositiveSafeInteger(
		event.event_log_entry_id,
		'Webhook EventLogEntry id'
	)
	const entity = requireEntity(event.entity, 'Webhook entity')
	const operation = requireOperation(event.operation)
	if (event.event_type !== `Shotgun_${entity.type}_Change`) {
		throw invalidWebhookRequest('Webhook event type does not match its entity.')
	}
	const project = readProject(event.project, entity)
	const attributeName = readAttributeName(event.attribute_name, operation)

	if (!SUBSCRIBED_UPDATE_FIELDS.has(entity.type)) return null
	if (!allowedProjectIds.has(project.id)) return null
	if (
		operation === 'update' &&
		(attributeName === null || !SUBSCRIBED_UPDATE_FIELDS.get(entity.type)?.has(attributeName))
	) {
		return null
	}

	const semantic = {
		attributeName,
		entity,
		eventLogEntryId,
		operation,
		projectId: project.id,
		sourceEventId,
	}
	const serialized = JSON.stringify(semantic)
	return {
		...semantic,
		eventBytes: Buffer.byteLength(serialized, 'utf8'),
		observedAt,
		semanticHash: createHash('sha256').update(serialized).digest('hex'),
	}
}

function readProject(value: unknown, entity: { id: number; type: string }) {
	if (entity.type === 'Project' && (value === null || value === undefined)) {
		return { id: entity.id, type: 'Project' as const }
	}
	const project = requireRecord(value, 'Webhook project')
	if (project.type !== 'Project') throw invalidWebhookRequest('Webhook project type is invalid.')
	return {
		id: requirePositiveSafeInteger(project.id, 'Webhook project id'),
		type: 'Project' as const,
	}
}

function requireEntity(value: unknown, label: string) {
	const entity = requireRecord(value, label)
	if (typeof entity.type !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(entity.type)) {
		throw invalidWebhookRequest(`${label} type is invalid.`)
	}
	return {
		id: requirePositiveSafeInteger(entity.id, `${label} id`),
		type: entity.type as ChangeEntityType,
	}
}

function readAttributeName(value: unknown, operation: ChangeOperation) {
	if (operation !== 'update') {
		if (value !== undefined && value !== null && typeof value !== 'string') {
			throw invalidWebhookRequest('Webhook attribute name is invalid.')
		}
		return null
	}
	return requireBoundedString(value, 'Webhook attribute name', 128)
}

function requireOperation(value: unknown): ChangeOperation {
	if (value === 'create' || value === 'update' || value === 'delete' || value === 'revive') {
		return value
	}
	throw invalidWebhookRequest('Webhook operation is invalid.')
}

function normalizeTimestamp(value: unknown) {
	const text = requireBoundedString(value, 'Webhook timestamp', 64)
	const milliseconds = Date.parse(text)
	if (!Number.isFinite(milliseconds)) throw invalidWebhookRequest('Webhook timestamp is invalid.')
	return new Date(milliseconds).toISOString()
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw invalidWebhookRequest(`${label} must be an object.`)
	}
	return value as Record<string, unknown>
}

function requireBoundedString(value: unknown, label: string, maximumLength: number) {
	if (
		typeof value !== 'string' ||
		value.length === 0 ||
		value.length > maximumLength ||
		value.trim() !== value ||
		/[\p{Bidi_Control}\p{Cc}]/u.test(value)
	) {
		throw invalidWebhookRequest(`${label} is invalid.`)
	}
	return value
}

function requirePositiveSafeInteger(value: unknown, label: string) {
	if (!Number.isSafeInteger(value) || Number(value) <= 0) {
		throw invalidWebhookRequest(`${label} must be a positive safe integer.`)
	}
	return Number(value)
}

function validateServiceOptions(options: ShotGridEventSyncServiceOptions) {
	if (!isAbsolute(options.storeDir)) {
		throw configurationError('The event sync store directory must be absolute.')
	}
	if (
		typeof options.secret !== 'string' ||
		options.secret.length < 32 ||
		options.secret.length > 1024 ||
		/\p{Cc}/u.test(options.secret)
	) {
		throw configurationError('The webhook secret must contain from 32 to 1024 plain characters.')
	}
	readWebhookIds(options)
	if (canonicalHttpsOrigin(options.siteUrl) !== options.siteUrl) {
		throw configurationError('The ShotGrid webhook site URL must be a canonical HTTPS origin.')
	}
	if (
		!Array.isArray(options.allowedProjectIds) ||
		options.allowedProjectIds.length === 0 ||
		options.allowedProjectIds.length > 1_000 ||
		options.allowedProjectIds.some((id) => !Number.isSafeInteger(id) || id <= 0) ||
		new Set(options.allowedProjectIds).size !== options.allowedProjectIds.length
	) {
		throw configurationError('At least one unique ShotGrid project id is required.')
	}
}

function readWebhookIds(options: ShotGridEventSyncServiceOptions) {
	const configured =
		options.webhookIds ?? (options.webhookId === undefined ? [] : [options.webhookId])
	const ids = configured.map((id) => id.toLowerCase())
	if (
		ids.length === 0 ||
		ids.length > 32 ||
		ids.some((id) => !UUID_PATTERN.test(id)) ||
		new Set(ids).size !== ids.length
	) {
		throw configurationError('The ShotGrid webhook ids must be from 1 to 32 unique UUIDs.')
	}
	return ids
}

function canonicalHttpsOrigin(value: unknown) {
	if (typeof value !== 'string') return null
	try {
		const url = new URL(value)
		if (
			url.protocol !== 'https:' ||
			url.username !== '' ||
			url.password !== '' ||
			(url.pathname !== '' && url.pathname !== '/') ||
			url.search !== '' ||
			url.hash !== ''
		) {
			return null
		}
		return url.origin
	} catch {
		return null
	}
}

function readPositiveLimit(
	value: number | undefined,
	fallback: number,
	minimum: number,
	maximum: number,
	label: string
) {
	const resolved = value ?? fallback
	if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
		throw configurationError(`${label} is invalid.`)
	}
	return resolved
}

function incrementCounter(database: DatabaseSync, name: string, amount: number) {
	if (amount === 0) return
	database
		.prepare(
			`INSERT INTO counters (name, value) VALUES (?, ?)
			ON CONFLICT(name) DO UPDATE SET value = value + excluded.value`
		)
		.run(name, amount)
}

function readCounters(database: DatabaseSync) {
	return new Map(
		(
			database.prepare('SELECT name, value FROM counters').all() as unknown as Array<{
				name: string
				value: number
			}>
		).map(({ name, value }) => [name, Number(value)])
	)
}

function readAggregateNumber(database: DatabaseSync, sql: string) {
	return readNullableAggregateNumber(database, sql) ?? 0
}

function readNullableAggregateNumber(database: DatabaseSync, sql: string) {
	const row = database.prepare(sql).get() as { value: null | number }
	return row.value === null ? null : Number(row.value)
}

function yieldToEventLoop() {
	return new Promise<void>((resolve) => setImmediate(resolve))
}

function invalidWebhookRequest(message: string) {
	return webhookError('INVALID_REQUEST', 400, false, message)
}

function configurationError(message: string) {
	return webhookError('CONFIGURATION_ERROR', 500, false, message)
}

function webhookError(
	code: ConstructorParameters<typeof ReviewGatewayError>[0]['code'],
	status: number,
	retryable: boolean,
	message: string
) {
	return new ReviewGatewayError({ code, status, retryable, cause: new Error(message) })
}
