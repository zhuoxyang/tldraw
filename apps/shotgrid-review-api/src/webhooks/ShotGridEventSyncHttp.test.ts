import { createHmac } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { request, type OutgoingHttpHeaders, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReviewChangeNotification } from '@tldraw/shotgrid-review-contracts'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { InMemoryReviewAuditStore } from '../audit/ReviewAuditStore'
import { MockReviewGateway } from '../gateway/MockReviewGateway'
import { createReviewApiServer } from '../http/createReviewApiServer'
import { InMemoryReviewPublicationStore } from '../http/ReviewPublicationStore'
import {
	ShotGridEventSyncService,
	type ShotGridEventSyncServiceOptions,
} from './ShotGridEventSyncService'

const ALLOWED_ORIGIN = 'http://127.0.0.1:5430'
const ALLOWED_PROJECT_ID = 101
const EVENT_SYNC_SECRET = 'event-sync-http-test-secret-with-32-characters'
const SITE_URL = 'https://studio.example.test'
const TEMP_DIRECTORY_PREFIX = join(tmpdir(), 'tldraw-shotgrid-event-sync-http-')
const TRUSTED_PROXY_TOKEN = 'event-sync-http-test-proxy-token-with-32-characters'
const METRICS_TOKEN = 'event-sync-http-test-metrics-token-with-32-characters'
const FIXED_ACTOR_SUBJECT = 'oidc:test:event-sync-reviewer'
const WEBHOOK_ID = '11111111-1111-4111-8111-111111111111'

interface Harness {
	baseUrl: string
	closed: boolean
	directory: string
	server: Server
	service: ShotGridEventSyncService
}

interface HttpResult {
	body: string
	status: number
}

const harnesses: Harness[] = []

afterEach(async () => {
	for (const harness of harnesses.splice(0).reverse()) {
		await closeHarness(harness)
		await rm(harness.directory, { force: true, recursive: true })
	}
})

describe('ShotGrid event sync HTTP transport', () => {
	test('accepts an exact raw-body HMAC without the trusted proxy and protects status', async () => {
		const harness = await startHarness()
		const body = makeWebhookBody([makeEvent(1)], true)

		const accepted = await postWebhook(harness, body, deliveryId(1))
		expect(accepted.status).toBe(202)
		expect(await accepted.text()).toBe('')
		expect(accepted.headers.get('content-length')).toBe('0')
		expect(harness.service.getStatus().counters).toMatchObject({
			acceptedEvents: 1,
			receivedDeliveries: 1,
		})

		const anonymousStatus = await fetch(`${harness.baseUrl}/api/review/event-sync-status`)
		expect(anonymousStatus.status).toBe(401)
		expect(await anonymousStatus.json()).toMatchObject({
			error: { code: 'AUTHENTICATION_REQUIRED' },
		})

		const wrongProxyStatus = await fetch(`${harness.baseUrl}/api/review/event-sync-status`, {
			headers: { 'X-Review-Proxy-Token': 'wrong-token' },
		})
		expect(wrongProxyStatus.status).toBe(401)

		const authorizedStatus = await fetch(`${harness.baseUrl}/api/review/event-sync-status`, {
			headers: trustedProxyHeaders(),
		})
		expect(authorizedStatus.status).toBe(200)
		expect(await authorizedStatus.json()).toMatchObject({
			data: {
				counters: { acceptedEvents: 1, receivedDeliveries: 1 },
				state: 'healthy',
			},
		})
	})

	test('rejects altered signatures and duplicate authentication headers without enqueueing', async () => {
		const harness = await startHarness()
		const prettyBody = makeWebhookBody([makeEvent(10)], true)
		const accepted = await postWebhook(harness, prettyBody, deliveryId(10))
		expect(accepted.status).toBe(202)

		const compactBody = Buffer.from(JSON.stringify(JSON.parse(prettyBody.toString('utf8'))))
		const rawBodyMismatch = await postWebhook(harness, compactBody, deliveryId(11), {
			signature: sign(prettyBody),
		})
		expect(rawBodyMismatch.status).toBe(401)

		const wrongSignature = await postWebhook(harness, compactBody, deliveryId(12), {
			signature: `sha1=${'0'.repeat(40)}`,
		})
		expect(wrongSignature.status).toBe(401)

		for (const [index, headerName] of [
			'x-sg-signature',
			'x-sg-webhook-id',
			'x-sg-delivery-id',
			'x-sg-webhook-site-url',
		].entries()) {
			const headers = webhookNodeHeaders(compactBody, deliveryId(20 + index))
			const value = headers[headerName]
			expect(typeof value).toBe('string')
			headers[headerName] = [String(value), String(value)]

			const duplicate = await postRaw(harness.baseUrl, compactBody, headers)
			expect(duplicate.status).toBe(401)
			expect(JSON.parse(duplicate.body)).toMatchObject({
				error: { code: 'AUTHENTICATION_REQUIRED' },
			})
		}

		expect(harness.service.getStatus().counters).toMatchObject({
			acceptedEvents: 1,
			receivedDeliveries: 1,
			signatureFailures: 2,
		})
	})

	test('rejects unsupported representations and a body larger than one MiB', async () => {
		const harness = await startHarness()
		const body = makeWebhookBody([makeEvent(30)])

		const wrongContentType = await postWebhook(harness, body, deliveryId(30), {
			contentType: 'text/plain',
		})
		expect(wrongContentType.status).toBe(415)

		const encoded = await postWebhook(harness, body, deliveryId(31), {
			contentEncoding: 'gzip',
		})
		expect(encoded.status).toBe(415)

		const oversizedBody = Buffer.alloc(1024 * 1024 + 1, 0x20)
		const oversized = await postWebhook(harness, oversizedBody, deliveryId(32))
		expect(oversized.status).toBe(413)

		expect(harness.service.getStatus().counters).toMatchObject({
			acceptedEvents: 0,
			receivedDeliveries: 0,
		})
	})

	test('accepts a bounded ShotGrid batch and publishes each invalidation once', async () => {
		const processInvalidation = vi.fn<
			NonNullable<ShotGridEventSyncServiceOptions['processInvalidation']>
		>(async () => {})
		const harness = await startHarness({ processInvalidation })
		const body = makeWebhookBody([
			makeEvent(40),
			makeEvent(41, {
				attribute_name: 'code',
				entity: { id: 201, type: 'Playlist' },
				event_type: 'Shotgun_Playlist_Change',
			}),
		])

		const accepted = await postWebhook(harness, body, deliveryId(40))
		expect(accepted.status).toBe(202)
		await waitFor(() => harness.service.getStatus().latestSequence === 2)

		expect(processInvalidation).toHaveBeenCalledTimes(2)
		expect(harness.service.getChangesSince(0)).toMatchObject([
			{ entity: { type: 'Version' }, sequence: 1 },
			{ entity: { type: 'Playlist' }, sequence: 2 },
		])
		expect(harness.service.getStatus().counters).toMatchObject({
			acceptedEvents: 2,
			processedEvents: 2,
			receivedDeliveries: 1,
		})
	})

	test('replays and resumes SSE changes, validates Last-Event-ID, and closes streams on shutdown', async () => {
		const harness = await startHarness()
		expect(
			(await postWebhook(harness, makeWebhookBody([makeEvent(50)]), deliveryId(50))).status
		).toBe(202)
		await waitFor(() => harness.service.getStatus().latestSequence === 1)

		const replayResponse = await fetch(`${harness.baseUrl}/api/review/changes`, {
			headers: trustedProxyHeaders(),
		})
		expect(replayResponse.status).toBe(200)
		expect(replayResponse.headers.get('content-type')).toBe('text/event-stream; charset=utf-8')
		const replay = new SseReader(requireBody(replayResponse))
		expect(await replay.next()).toEqual({ sequence: 1 })

		expect(
			(await postWebhook(harness, makeWebhookBody([makeEvent(51)]), deliveryId(51))).status
		).toBe(202)
		expect(await replay.next()).toEqual({ sequence: 2 })

		const resumedResponse = await fetch(`${harness.baseUrl}/api/review/changes`, {
			headers: { ...trustedProxyHeaders(), 'Last-Event-ID': '1' },
		})
		expect(resumedResponse.status).toBe(200)
		const resumed = new SseReader(requireBody(resumedResponse))
		expect(await resumed.next()).toEqual({ sequence: 2 })

		const invalidCursor = await fetch(`${harness.baseUrl}/api/review/changes`, {
			headers: { ...trustedProxyHeaders(), 'Last-Event-ID': '-1' },
		})
		expect(invalidCursor.status).toBe(400)
		expect(await invalidCursor.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } })

		const closing = closeHarness(harness)
		await withTimeout(Promise.all([replay.waitForEnd(), resumed.waitForEnd()]), 1_000)
		await closing
	})
})

async function startHarness(
	options: Pick<ShotGridEventSyncServiceOptions, 'processInvalidation'> = {}
): Promise<Harness> {
	const directory = await mkdtemp(TEMP_DIRECTORY_PREFIX)
	const service = new ShotGridEventSyncService({
		allowedProjectIds: [ALLOWED_PROJECT_ID],
		secret: EVENT_SYNC_SECRET,
		siteUrl: SITE_URL,
		storeDir: directory,
		webhookId: WEBHOOK_ID,
		...options,
	})
	const server = createReviewApiServer({
		allowedOrigin: ALLOWED_ORIGIN,
		auditStore: new InMemoryReviewAuditStore(),
		eventSync: service,
		gateway: new MockReviewGateway(),
		fixedActorSubject: FIXED_ACTOR_SUBJECT,
		logger: { error: vi.fn() },
		metricsToken: METRICS_TOKEN,
		mode: 'shotgrid',
		publicationDeploymentScope: SITE_URL,
		publicationStore: new InMemoryReviewPublicationStore(),
		requestId: () => 'event-sync-http-request-id',
		serviceActorName: 'review-gateway',
		trustedProxyToken: TRUSTED_PROXY_TOKEN,
	})
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const { port } = server.address() as AddressInfo
	const harness = {
		baseUrl: `http://127.0.0.1:${port}`,
		closed: false,
		directory,
		server,
		service,
	}
	harnesses.push(harness)
	return harness
}

async function closeHarness(harness: Harness) {
	if (harness.closed) return
	harness.closed = true
	await new Promise<void>((resolve, reject) => {
		harness.server.close((error) => (error ? reject(error) : resolve()))
	})
}

function makeEvent(
	index: number,
	overrides: Record<string, unknown> = {}
): Record<string, unknown> {
	return {
		attribute_name: 'image',
		entity: { id: 300 + index, type: 'Version' },
		event_log_entry_id: 50_000 + index,
		event_type: 'Shotgun_Version_Change',
		id: `11777.3065.${index}`,
		operation: 'update',
		project: { id: ALLOWED_PROJECT_ID, type: 'Project' },
		...overrides,
	}
}

function makeWebhookBody(events: Record<string, unknown>[], pretty = false) {
	const payload = {
		data: events.length === 1 ? events[0] : { deliveries: events },
		timestamp: '2026-07-22T02:00:00.000Z',
	}
	return Buffer.from(
		`${JSON.stringify(payload, null, pretty ? 2 : undefined)}${pretty ? '\n' : ''}`
	)
}

function deliveryId(index: number) {
	return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`
}

function sign(body: Buffer) {
	return `sha1=${createHmac('sha1', EVENT_SYNC_SECRET).update(body).digest('hex')}`
}

function trustedProxyHeaders() {
	return {
		'X-Review-Authenticated-Subject': FIXED_ACTOR_SUBJECT,
		'X-Review-Proxy-Token': TRUSTED_PROXY_TOKEN,
	}
}

async function postWebhook(
	harness: Harness,
	body: Buffer,
	delivery: string,
	options: {
		contentEncoding?: string
		contentType?: string
		signature?: string
	} = {}
) {
	return await fetch(`${harness.baseUrl}/api/webhooks/shotgrid`, {
		body: body.toString('utf8'),
		headers: {
			'Content-Type': options.contentType ?? 'application/json; charset=utf-8',
			...(options.contentEncoding === undefined
				? undefined
				: { 'Content-Encoding': options.contentEncoding }),
			'X-SG-Delivery-ID': delivery,
			'X-SG-Signature': options.signature ?? sign(body),
			'X-SG-Webhook-ID': WEBHOOK_ID,
			'X-SG-Webhook-Site-URL': SITE_URL,
		},
		method: 'POST',
	})
}

function webhookNodeHeaders(body: Buffer, delivery: string): OutgoingHttpHeaders {
	return {
		'content-length': body.byteLength,
		'content-type': 'application/json',
		'x-sg-delivery-id': delivery,
		'x-sg-signature': sign(body),
		'x-sg-webhook-id': WEBHOOK_ID,
		'x-sg-webhook-site-url': SITE_URL,
	}
}

async function postRaw(baseUrl: string, body: Buffer, headers: OutgoingHttpHeaders) {
	const url = new URL('/api/webhooks/shotgrid', baseUrl)
	return await new Promise<HttpResult>((resolve, reject) => {
		const outgoing = request(
			url,
			{
				headers,
				method: 'POST',
			},
			(response) => {
				const chunks: Buffer[] = []
				response.on('data', (chunk: Buffer) => chunks.push(chunk))
				response.on('end', () => {
					resolve({
						body: Buffer.concat(chunks).toString('utf8'),
						status: response.statusCode ?? 0,
					})
				})
			}
		)
		outgoing.on('error', reject)
		outgoing.end(body)
	})
}

class SseReader {
	private buffer = ''
	private readonly decoder = new TextDecoder()
	private readonly reader: ReadableStreamDefaultReader<Uint8Array>

	constructor(body: ReadableStream<Uint8Array>) {
		this.reader = body.getReader()
	}

	async next(): Promise<ReviewChangeNotification> {
		for (;;) {
			const boundary = this.buffer.indexOf('\n\n')
			if (boundary !== -1) {
				const frame = this.buffer.slice(0, boundary)
				this.buffer = this.buffer.slice(boundary + 2)
				if (frame.startsWith(':')) continue
				const data = frame
					.split('\n')
					.find((line) => line.startsWith('data: '))
					?.slice('data: '.length)
				if (data) return JSON.parse(data) as ReviewChangeNotification
				continue
			}

			const result = await this.reader.read()
			if (result.done) throw new Error('The SSE stream ended before an event arrived.')
			this.buffer += this.decoder.decode(result.value, { stream: true })
		}
	}

	async waitForEnd() {
		for (;;) {
			const result = await this.reader.read()
			if (result.done) return
		}
	}
}

function requireBody(response: Response) {
	if (!response.body) throw new Error('Expected a streaming response body.')
	return response.body
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000) {
	const deadline = Date.now() + timeoutMs
	while (!predicate()) {
		if (Date.now() >= deadline) throw new Error('Timed out waiting for event sync state.')
		await new Promise((resolve) => setTimeout(resolve, 5))
	}
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number) {
	let timer: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(
					() => reject(new Error('Timed out waiting for SSE shutdown.')),
					timeoutMs
				)
			}),
		])
	} finally {
		if (timer) clearTimeout(timer)
	}
}
