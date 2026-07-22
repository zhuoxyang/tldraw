import type { IncomingMessage, ServerResponse } from 'node:http'
import { ReviewGatewayError } from '../errors'
import type { ShotGridEventSyncService } from './ShotGridEventSyncService'

const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024
const MAX_WEBHOOK_HEADERS = 64
const MAX_WEBHOOK_HEADER_BYTES = 16 * 1024
const MAX_CONCURRENT_BODY_READS = 32
const BODY_READ_TIMEOUT_MS = 3_000
const HEARTBEAT_INTERVAL_MS = 15_000
const JSON_CONTENT_TYPE_PATTERN = /^application\/json(?:\s*;\s*charset=utf-8)?$/i

export class ShotGridEventSyncHttp {
	private activeBodyReads = 0

	constructor(private readonly service: ShotGridEventSyncService) {}

	async handleWebhook(request: IncomingMessage, response: ServerResponse) {
		validateHeaderBounds(request)
		const contentType = requireUniqueHeader(request, 'content-type', 'INVALID_REQUEST', 415)
		if (!JSON_CONTENT_TYPE_PATTERN.test(contentType)) {
			throw requestError('INVALID_REQUEST', 415, false, 'Webhook Content-Type is invalid.')
		}
		if (readHeaderValues(request, 'content-encoding').length !== 0) {
			throw requestError('INVALID_REQUEST', 415, false, 'Webhook compression is not supported.')
		}
		const signature = requireUniqueHeader(request, 'x-sg-signature', 'AUTHENTICATION_REQUIRED', 401)
		const webhookId = requireUniqueHeader(
			request,
			'x-sg-webhook-id',
			'AUTHENTICATION_REQUIRED',
			401
		)
		const deliveryId = requireUniqueHeader(
			request,
			'x-sg-delivery-id',
			'AUTHENTICATION_REQUIRED',
			401
		)
		const siteUrl = requireUniqueHeader(
			request,
			'x-sg-webhook-site-url',
			'AUTHENTICATION_REQUIRED',
			401
		)

		if (this.activeBodyReads >= MAX_CONCURRENT_BODY_READS) {
			throw requestError('COLLABORATION_UNAVAILABLE', 503, true, 'Webhook intake is busy.')
		}
		this.activeBodyReads++
		let body: Buffer
		try {
			body = await readRawBody(request, response)
		} finally {
			this.activeBodyReads--
		}

		this.service.ingest({ body, deliveryId, signature, siteUrl, webhookId })
		response.statusCode = 202
		response.setHeader('Content-Length', '0')
		response.end()
	}

	handleStatus(response: ServerResponse) {
		response.statusCode = 200
		response.setHeader('Content-Type', 'application/json; charset=utf-8')
		response.end(JSON.stringify({ data: this.service.getStatus() }))
	}

	handleChangeStream(request: IncomingMessage, response: ServerResponse) {
		const cursorHeader = readOptionalUniqueHeader(request, 'last-event-id')
		let cursor = 0
		if (cursorHeader !== undefined) {
			if (!/^(?:0|[1-9]\d*)$/.test(cursorHeader)) {
				throw requestError('INVALID_REQUEST', 400, false, 'Last-Event-ID is invalid.')
			}
			cursor = Number(cursorHeader)
			if (!Number.isSafeInteger(cursor)) {
				throw requestError('INVALID_REQUEST', 400, false, 'Last-Event-ID is invalid.')
			}
		}
		const latestSequence = this.service.getStatus().latestSequence
		if (cursor > latestSequence) cursor = 0

		response.statusCode = 200
		response.setHeader('Cache-Control', 'no-cache, no-store')
		response.setHeader('Connection', 'keep-alive')
		response.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
		response.setHeader('X-Accel-Buffering', 'no')
		response.flushHeaders()

		let closed = false
		const stream = {
			heartbeat: undefined as ReturnType<typeof setInterval> | undefined,
			unsubscribe: () => {},
		}
		const close = () => {
			if (closed) return
			closed = true
			if (stream.heartbeat) clearInterval(stream.heartbeat)
			stream.unsubscribe()
			if (!response.writableEnded) response.end()
		}
		const send = (event: ReturnType<ShotGridEventSyncService['getChangesSince']>[number]) => {
			if (closed || response.destroyed || response.writableEnded) return false
			const writable = response.write(`id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`)
			if (!writable) {
				close()
				return false
			}
			return true
		}

		request.once('aborted', close)
		response.once('close', close)
		stream.unsubscribe = this.service.subscribe(send, close)
		for (const event of this.service.getChangesSince(cursor)) {
			if (!send(event)) return
		}
		stream.heartbeat = setInterval(() => {
			if (closed || response.destroyed || response.writableEnded) {
				close()
				return
			}
			if (!response.write(': heartbeat\n\n')) close()
		}, HEARTBEAT_INTERVAL_MS)
		stream.heartbeat.unref?.()
	}
}

async function readRawBody(request: IncomingMessage, response: ServerResponse) {
	const contentLength = readOptionalUniqueHeader(request, 'content-length')
	if (contentLength !== undefined) {
		if (!/^(?:0|[1-9]\d*)$/.test(contentLength)) {
			throw requestError('INVALID_REQUEST', 400, false, 'Webhook Content-Length is invalid.')
		}
		const declaredLength = Number(contentLength)
		if (!Number.isSafeInteger(declaredLength)) {
			throw requestError('INVALID_REQUEST', 400, false, 'Webhook Content-Length is invalid.')
		}
		if (declaredLength > MAX_WEBHOOK_BODY_BYTES) {
			throw requestError('INVALID_REQUEST', 413, false, 'Webhook body is too large.')
		}
	}

	return await new Promise<Buffer>((resolve, reject) => {
		const chunks: Buffer[] = []
		let settled = false
		let size = 0
		const timer = setTimeout(() => {
			fail(requestError('INVALID_REQUEST', 408, true, 'Webhook body timed out.'), true)
		}, BODY_READ_TIMEOUT_MS)
		timer.unref?.()

		const cleanup = () => {
			clearTimeout(timer)
			request.off('aborted', onAborted)
			request.off('data', onData)
			request.off('end', onEnd)
			request.off('error', onError)
		}
		const fail = (error: ReviewGatewayError, closeConnection = false) => {
			if (settled) return
			settled = true
			cleanup()
			if (closeConnection) {
				request.pause()
				response.setHeader('Connection', 'close')
				response.once('finish', () => request.destroy())
			}
			reject(error)
		}
		const onAborted = () =>
			fail(requestError('INVALID_REQUEST', 400, false, 'Webhook body aborted.'))
		const onError = () => fail(requestError('INVALID_REQUEST', 400, false, 'Webhook body failed.'))
		const onData = (chunk: Buffer | string) => {
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
			size += buffer.byteLength
			if (size > MAX_WEBHOOK_BODY_BYTES) {
				fail(requestError('INVALID_REQUEST', 413, false, 'Webhook body is too large.'), true)
				return
			}
			chunks.push(buffer)
		}
		const onEnd = () => {
			if (settled) return
			settled = true
			cleanup()
			if (size === 0) {
				reject(requestError('INVALID_REQUEST', 400, false, 'Webhook body is required.'))
				return
			}
			resolve(Buffer.concat(chunks, size))
		}

		request.on('aborted', onAborted)
		request.on('data', onData)
		request.on('end', onEnd)
		request.on('error', onError)
	})
}

function validateHeaderBounds(request: IncomingMessage) {
	const headerCount = request.rawHeaders.length / 2
	const headerBytes = request.rawHeaders.reduce(
		(total, value) => total + Buffer.byteLength(value, 'latin1') + 2,
		0
	)
	if (headerCount > MAX_WEBHOOK_HEADERS || headerBytes > MAX_WEBHOOK_HEADER_BYTES) {
		throw requestError('INVALID_REQUEST', 431, false, 'Webhook headers are too large.')
	}
}

function readHeaderValues(request: IncomingMessage, name: string) {
	const values: string[] = []
	for (let index = 0; index < request.rawHeaders.length; index += 2) {
		if (request.rawHeaders[index].toLowerCase() === name) values.push(request.rawHeaders[index + 1])
	}
	return values
}

function requireUniqueHeader(
	request: IncomingMessage,
	name: string,
	code: ConstructorParameters<typeof ReviewGatewayError>[0]['code'],
	status: number
) {
	const values = readHeaderValues(request, name)
	if (values.length !== 1 || values[0].length === 0) {
		throw requestError(code, status, false, `Webhook ${name} header is invalid.`)
	}
	return values[0]
}

function readOptionalUniqueHeader(request: IncomingMessage, name: string) {
	const values = readHeaderValues(request, name)
	if (values.length > 1) {
		throw requestError('INVALID_REQUEST', 400, false, `${name} header must be unique.`)
	}
	return values[0]
}

function requestError(
	code: ConstructorParameters<typeof ReviewGatewayError>[0]['code'],
	status: number,
	retryable: boolean,
	message: string
) {
	return new ReviewGatewayError({ code, status, retryable, cause: new Error(message) })
}
