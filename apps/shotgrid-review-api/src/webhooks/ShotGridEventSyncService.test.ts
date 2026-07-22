import { createHmac } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReviewGatewayError } from '../errors'
import {
	ShotGridEventSyncService,
	type ShotGridEventSyncServiceOptions,
	type ShotGridWebhookRequest,
} from './ShotGridEventSyncService'

const SECRET = 'shotgrid-webhook-test-secret-with-at-least-32-characters'
const SITE_URL = 'https://review-test.shotgrid.autodesk.com'
const WEBHOOK_ID = '00000000-0000-4000-8000-000000000001'
const SECOND_WEBHOOK_ID = '00000000-0000-4000-8000-000000000002'
const ALLOWED_PROJECT_ID = 122
const OBSERVED_AT = '2026-07-22T02:00:00.000Z'

const services = new Set<ShotGridEventSyncService>()
const storeDirectories = new Set<string>()

afterEach(async () => {
	for (const service of services) await service.close()
	services.clear()
	for (const directory of storeDirectories) {
		rmSync(directory, { force: true, recursive: true })
	}
	storeDirectories.clear()
	vi.useRealTimers()
})

describe('ShotGridEventSyncService', () => {
	it('verifies the HMAC over the exact raw body before accepting an event', async () => {
		const processed = vi.fn()
		const service = createService({ processInvalidation: processed })
		const original = singleEventBody(eventFixture({ eventLogEntryId: 101 }))
		const semanticallyEquivalent = Buffer.from(
			JSON.stringify(JSON.parse(original.toString('utf8')), null, 2),
			'utf8'
		)

		expect(() =>
			service.ingest(
				webhookRequest(semanticallyEquivalent, 1, {
					signatureBody: original,
				})
			)
		).toThrow(
			expect.objectContaining({
				code: 'AUTHENTICATION_REQUIRED',
				status: 401,
			})
		)
		expect(service.getStatus().counters.signatureFailures).toBe(1)

		const receipt = service.ingest(webhookRequest(original, 2))
		expect(receipt).toMatchObject({
			acceptedEvents: 1,
			duplicateDelivery: false,
			ignoredEvents: 0,
		})

		await vi.waitFor(() => expect(processed).toHaveBeenCalledOnce())
		expect(processed.mock.calls[0][0]).toMatchObject({
			attributeName: 'sg_status_list',
			entity: { id: 301, type: 'Version' },
			eventLogEntryId: 101,
			projectId: ALLOWED_PROJECT_ID,
			sourceEventId: '101.476.0',
		})
	})

	it('accepts official single and batch shapes while filtering projects, entities, and fields', async () => {
		const service = createService()
		const singleReceipt = service.ingest(
			webhookRequest(singleEventBody(eventFixture({ eventLogEntryId: 201 })), 10)
		)
		expect(singleReceipt).toMatchObject({ acceptedEvents: 1, ignoredEvents: 0 })

		const batch = batchEventBody([
			eventFixture({
				attributeName: null,
				entityId: 401,
				entityType: 'Playlist',
				eventLogEntryId: 202,
				operation: 'create',
			}),
			eventFixture({ eventLogEntryId: 203, projectId: 999 }),
			eventFixture({ attributeName: 'tags', eventLogEntryId: 204 }),
			eventFixture({
				attributeName: 'sg_status_list',
				entityId: 501,
				entityType: 'Task',
				eventLogEntryId: 205,
			}),
		])
		const batchReceipt = service.ingest(webhookRequest(batch, 11))

		expect(batchReceipt).toMatchObject({
			acceptedEvents: 1,
			conflictingEvents: 0,
			duplicateEvents: 0,
			ignoredEvents: 3,
		})

		await vi.waitFor(() => expect(service.getChangesSince(0)).toHaveLength(2))
		expect(service.getChangesSince(0)).toEqual([
			expect.objectContaining({
				attributeName: 'sg_status_list',
				entity: { id: 301, type: 'Version' },
				eventLogEntryId: 201,
				operation: 'update',
				sequence: 1,
			}),
			expect.objectContaining({
				attributeName: null,
				entity: { id: 401, type: 'Playlist' },
				eventLogEntryId: 202,
				operation: 'create',
				sequence: 2,
			}),
		])
	})

	it('accepts every configured entity webhook id and rejects an unknown id', async () => {
		const service = createService({ webhookIds: [WEBHOOK_ID, SECOND_WEBHOOK_ID] })
		const firstBody = singleEventBody(eventFixture({ eventLogEntryId: 210 }))
		const secondBody = singleEventBody(eventFixture({ eventLogEntryId: 211 }))

		expect(service.ingest(webhookRequest(firstBody, 12))).toMatchObject({ acceptedEvents: 1 })
		expect(
			service.ingest({
				...webhookRequest(secondBody, 13),
				webhookId: SECOND_WEBHOOK_ID,
			})
		).toMatchObject({ acceptedEvents: 1 })
		expectGatewayError(
			() =>
				service.ingest({
					...webhookRequest(singleEventBody(eventFixture({ eventLogEntryId: 212 })), 14),
					webhookId: '00000000-0000-4000-8000-000000000003',
				}),
			{ code: 'PERMISSION_DENIED', status: 403 }
		)

		await vi.waitFor(() => expect(service.getChangesSince(0)).toHaveLength(2))
	})

	it('preserves the durable store when the webhook id allowlist is rotated', async () => {
		const storeDir = createStoreDirectory()
		const first = createService({ storeDir, webhookIds: [WEBHOOK_ID] })
		first.ingest(webhookRequest(singleEventBody(eventFixture({ eventLogEntryId: 215 })), 15))
		await vi.waitFor(() => expect(first.getChangesSince(0)).toHaveLength(1))
		await first.close()

		const second = createService({ storeDir, webhookIds: [SECOND_WEBHOOK_ID] })
		const nextBody = singleEventBody(eventFixture({ eventLogEntryId: 216 }))
		expect(
			second.ingest({
				...webhookRequest(nextBody, 16),
				webhookId: SECOND_WEBHOOK_ID,
			})
		).toMatchObject({ acceptedEvents: 1 })
		await vi.waitFor(() => expect(second.getChangesSince(0)).toHaveLength(2))
	})

	it('deduplicates deliveries and EventLogEntries and quarantines semantic conflicts', async () => {
		const service = createService()
		const original = singleEventBody(eventFixture({ eventLogEntryId: 301 }))

		expect(service.ingest(webhookRequest(original, 20))).toMatchObject({
			acceptedEvents: 1,
			duplicateDelivery: false,
		})
		expect(service.ingest(webhookRequest(original, 20))).toMatchObject({
			acceptedEvents: 0,
			duplicateDelivery: true,
			duplicateEvents: 1,
		})
		expect(service.ingest(webhookRequest(original, 21))).toMatchObject({
			acceptedEvents: 0,
			duplicateDelivery: false,
			duplicateEvents: 1,
		})

		const conflictingEvent = singleEventBody(
			eventFixture({ attributeName: 'description', eventLogEntryId: 301 })
		)
		expect(service.ingest(webhookRequest(conflictingEvent, 22))).toMatchObject({
			acceptedEvents: 0,
			conflictingEvents: 1,
			duplicateEvents: 0,
		})

		const reusedDelivery = singleEventBody(eventFixture({ eventLogEntryId: 302 }))
		expectGatewayError(() => service.ingest(webhookRequest(reusedDelivery, 20)), {
			code: 'INVALID_REQUEST',
			status: 409,
		})

		await vi.waitFor(() => expect(service.getChangesSince(0)).toHaveLength(1))
		expect(service.getChangesSince(0)[0]).toMatchObject({
			eventLogEntryId: 301,
			sequence: 1,
		})
		expect(service.getStatus().counters).toMatchObject({
			acceptedEvents: 1,
			conflictingEvents: 1,
			duplicateDeliveries: 1,
			duplicateEvents: 1,
			receivedDeliveries: 3,
		})
	})

	it('turns out-of-order upstream ids into a monotonic local sequence only', async () => {
		const service = createService()

		service.ingest(webhookRequest(singleEventBody(eventFixture({ eventLogEntryId: 900 })), 30))
		service.ingest(webhookRequest(singleEventBody(eventFixture({ eventLogEntryId: 100 })), 31))

		await vi.waitFor(() => expect(service.getChangesSince(0)).toHaveLength(2))
		const changes = service.getChangesSince(0)
		expect(changes.map(({ eventLogEntryId }) => eventLogEntryId)).toEqual([100, 900])
		expect(changes.map(({ sequence }) => sequence)).toEqual([1, 2])
		expect(changes.every(({ sequence, eventLogEntryId }) => sequence !== eventLogEntryId)).toBe(
			true
		)
	})

	it('durably ingests another delivery while an invalidation processor is blocked', async () => {
		const entered = deferred<void>()
		const release = deferred<void>()
		const processed: number[] = []
		const service = createService({
			processInvalidation: async (event, signal) => {
				processed.push(event.eventLogEntryId)
				if (event.eventLogEntryId !== 401) return
				entered.resolve()
				await abortable(release.promise, signal)
			},
		})

		service.ingest(webhookRequest(singleEventBody(eventFixture({ eventLogEntryId: 401 })), 40))
		await entered.promise

		const secondReceipt = service.ingest(
			webhookRequest(singleEventBody(eventFixture({ eventLogEntryId: 402 })), 41)
		)
		expect(secondReceipt.acceptedEvents).toBe(1)
		expect(service.getStatus().queue).toMatchObject({ depth: 2 })
		expect(service.getStatus().queue.bytes).toBeGreaterThan(0)
		expect(processed).toEqual([401])

		release.resolve()
		await vi.waitFor(() => expect(service.getChangesSince(0)).toHaveLength(2))
		expect(processed).toEqual([401, 402])
	})

	it('rolls back a full-queue rejection so later deliveries can proceed', async () => {
		const entered = deferred<void>()
		const release = deferred<void>()
		const service = createService({
			maxQueueEvents: 1,
			processInvalidation: async (event, signal) => {
				if (event.eventLogEntryId !== 450) return
				entered.resolve()
				await abortable(release.promise, signal)
			},
		})
		service.ingest(webhookRequest(singleEventBody(eventFixture({ eventLogEntryId: 450 })), 45))
		await entered.promise

		expectGatewayError(
			() =>
				service.ingest(webhookRequest(singleEventBody(eventFixture({ eventLogEntryId: 451 })), 46)),
			{ code: 'COLLABORATION_UNAVAILABLE', status: 503 }
		)

		release.resolve()
		await vi.waitFor(() => expect(service.getChangesSince(0)).toHaveLength(1))
		expect(
			service.ingest(webhookRequest(singleEventBody(eventFixture({ eventLogEntryId: 451 })), 46))
		).toMatchObject({ acceptedEvents: 1 })
		await vi.waitFor(() => expect(service.getChangesSince(0)).toHaveLength(2))
	})

	it('retries transient processing failures and dead-letters the terminal failure', async () => {
		const attempts = new Map<number, number>()
		const service = createService({
			maxProcessingAttempts: 3,
			processInvalidation: (event) => {
				const attempt = (attempts.get(event.eventLogEntryId) ?? 0) + 1
				attempts.set(event.eventLogEntryId, attempt)
				if (event.eventLogEntryId === 501 && attempt >= 3) return
				throw new Error('processor unavailable')
			},
			retryBaseDelayMs: 1,
		})

		service.ingest(webhookRequest(singleEventBody(eventFixture({ eventLogEntryId: 501 })), 50))
		service.ingest(webhookRequest(singleEventBody(eventFixture({ eventLogEntryId: 502 })), 51))

		await vi.waitFor(() => {
			expect(service.getStatus()).toMatchObject({
				counters: { failedEvents: 1, processedEvents: 1 },
				queue: { depth: 0 },
				state: 'degraded',
			})
		})
		expect(attempts).toEqual(
			new Map([
				[501, 3],
				[502, 3],
			])
		)
		expect(service.getChangesSince(0)).toEqual([
			expect.objectContaining({ eventLogEntryId: 501, sequence: 1 }),
		])
	})

	it('releases an interrupted lease and resumes pending work after restart', async () => {
		const storeDir = createStoreDirectory()
		const entered = deferred<void>()
		const first = createService({
			processInvalidation: async (_event, signal) => {
				entered.resolve()
				await waitForAbort(signal)
			},
			storeDir,
		})

		first.ingest(webhookRequest(singleEventBody(eventFixture({ eventLogEntryId: 601 })), 60))
		await entered.promise
		expect(first.getStatus().queue.depth).toBe(1)
		await first.close()
		expect(first.getStatus().state).toBe('stopped')

		const recovered = vi.fn()
		const second = createService({ processInvalidation: recovered, storeDir })
		await vi.waitFor(() => expect(second.getChangesSince(0)).toHaveLength(1))

		expect(recovered).toHaveBeenCalledOnce()
		expect(second.getChangesSince(0)[0]).toMatchObject({
			eventLogEntryId: 601,
			sequence: 1,
		})
		expect(second.getStatus()).toMatchObject({
			counters: { acceptedEvents: 1, processedEvents: 1, receivedDeliveries: 1 },
			queue: { depth: 0 },
			state: 'healthy',
		})
	})

	it('reports queue, counters, client count, timestamps, readiness, and stopped state', async () => {
		const service = createService()
		expect(service.isReady()).toBe(true)
		expect(service.getStatus()).toMatchObject({
			connectedClients: 0,
			counters: {
				acceptedEvents: 0,
				failedEvents: 0,
				processedEvents: 0,
				receivedDeliveries: 0,
			},
			latestSequence: 0,
			lastProcessedAt: null,
			lastReceivedAt: null,
			queue: { bytes: 0, depth: 0, oldestAgeMs: 0 },
			state: 'healthy',
		})

		const unsubscribe = service.subscribe(() => undefined)
		expect(service.getStatus().connectedClients).toBe(1)

		const body = batchEventBody([
			eventFixture({ eventLogEntryId: 701 }),
			eventFixture({ eventLogEntryId: 702, projectId: 999 }),
		])
		service.ingest(webhookRequest(body, 70))
		expect(() =>
			service.ingest({
				...webhookRequest(body, 71),
				signature: 'sha1=0000000000000000000000000000000000000000',
			})
		).toThrow(expect.objectContaining({ code: 'AUTHENTICATION_REQUIRED' }))

		await vi.waitFor(() => expect(service.getStatus().counters.processedEvents).toBe(1))
		const status = service.getStatus()
		expect(status).toMatchObject({
			connectedClients: 1,
			counters: {
				acceptedEvents: 1,
				ignoredEvents: 1,
				processedEvents: 1,
				receivedDeliveries: 1,
				signatureFailures: 1,
			},
			latestSequence: 1,
			queue: { bytes: 0, depth: 0, oldestAgeMs: 0 },
			state: 'healthy',
		})
		expect(Number.isFinite(Date.parse(status.lastReceivedAt!))).toBe(true)
		expect(Number.isFinite(Date.parse(status.lastProcessedAt!))).toBe(true)

		unsubscribe()
		expect(service.getStatus().connectedClients).toBe(0)
		await service.close()
		expect(service.isReady()).toBe(false)
		expect(service.getStatus()).toMatchObject({ connectedClients: 0, state: 'stopped' })
	})
})

function createService(
	overrides: Partial<ShotGridEventSyncServiceOptions> = {}
): ShotGridEventSyncService {
	const storeDir = overrides.storeDir ?? createStoreDirectory()
	const service = new ShotGridEventSyncService({
		allowedProjectIds: [ALLOWED_PROJECT_ID],
		secret: SECRET,
		siteUrl: SITE_URL,
		storeDir,
		webhookId: WEBHOOK_ID,
		...overrides,
	})
	services.add(service)
	return service
}

function createStoreDirectory() {
	const directory = mkdtempSync(join(tmpdir(), 'shotgrid-event-sync-'))
	storeDirectories.add(directory)
	return directory
}

interface EventFixtureOptions {
	attributeName?: null | string
	entityId?: number
	entityType?: string
	eventLogEntryId: number
	operation?: 'create' | 'delete' | 'revive' | 'update'
	projectId?: number
	sourceEventId?: string
}

function eventFixture({
	attributeName = 'sg_status_list',
	entityId = 301,
	entityType = 'Version',
	eventLogEntryId,
	operation = 'update',
	projectId = ALLOWED_PROJECT_ID,
	sourceEventId = `${eventLogEntryId}.476.0`,
}: EventFixtureOptions) {
	return {
		attribute_name: operation === 'update' ? attributeName : null,
		entity: { id: entityId, type: entityType },
		event_log_entry_id: eventLogEntryId,
		event_type: `Shotgun_${entityType}_Change`,
		id: sourceEventId,
		meta: {
			attribute_name: operation === 'update' ? attributeName : null,
			entity_id: entityId,
			entity_type: entityType,
			type: operation === 'update' ? 'attribute_change' : 'entity_change',
		},
		operation,
		project: { id: projectId, type: 'Project' },
	}
}

function singleEventBody(event: ReturnType<typeof eventFixture>) {
	return Buffer.from(JSON.stringify({ data: event, timestamp: OBSERVED_AT }), 'utf8')
}

function batchEventBody(events: Array<ReturnType<typeof eventFixture>>) {
	return Buffer.from(
		JSON.stringify({ data: { deliveries: events }, timestamp: OBSERVED_AT }),
		'utf8'
	)
}

function webhookRequest(
	body: Buffer,
	deliveryNumber: number,
	options: { signatureBody?: Buffer } = {}
): ShotGridWebhookRequest {
	return {
		body,
		deliveryId: uuid(deliveryNumber),
		signature: sign(options.signatureBody ?? body),
		siteUrl: SITE_URL,
		webhookId: WEBHOOK_ID,
	}
}

function uuid(value: number) {
	return `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
}

function sign(body: Buffer) {
	return `sha1=${createHmac('sha1', SECRET).update(body).digest('hex')}`
}

function expectGatewayError(
	operation: () => unknown,
	expected: Pick<ReviewGatewayError, 'code' | 'status'>
) {
	try {
		operation()
		throw new Error('Expected ReviewGatewayError')
	} catch (error) {
		expect(error).toBeInstanceOf(ReviewGatewayError)
		expect(error).toMatchObject(expected)
	}
}

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void
	let reject!: (reason?: unknown) => void
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise
		reject = rejectPromise
	})
	return { promise, reject, resolve }
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal) {
	return new Promise<T>((resolve, reject) => {
		if (signal.aborted) {
			reject(new Error('aborted'))
			return
		}
		const onAbort = () => reject(new Error('aborted'))
		signal.addEventListener('abort', onAbort, { once: true })
		void promise.then(
			(value) => {
				signal.removeEventListener('abort', onAbort)
				resolve(value)
			},
			(error) => {
				signal.removeEventListener('abort', onAbort)
				reject(error)
			}
		)
	})
}

function waitForAbort(signal: AbortSignal) {
	return new Promise<never>((_resolve, reject) => {
		if (signal.aborted) {
			reject(new Error('aborted'))
			return
		}
		signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
	})
}
