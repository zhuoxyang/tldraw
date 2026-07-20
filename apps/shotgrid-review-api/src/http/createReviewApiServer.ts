import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type {
	CreateReviewNoteRequest,
	ReviewApiErrorCode,
	ReviewHealth,
	UpdateReviewStatusRequest,
	UploadReviewAttachmentRequest,
} from '../contracts'
import { ReviewGatewayError } from '../errors'
import type { ReviewGateway, ReviewImageProxyPayload } from '../gateway/ReviewGateway'

const JSON_BODY_LIMIT = 1024 * 1024
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
const ATTACHMENT_BODY_LIMIT = Math.ceil((MAX_ATTACHMENT_BYTES * 4) / 3) + 4096
const HEADERS_TIMEOUT_MS = 10_000
const REQUEST_TIMEOUT_MS = 30_000
const MUTATION_METHODS = ['PATCH', 'POST'] as const

type GatewayMode = 'mock' | 'shotgrid'

interface SafeLogger {
	error(message: string, context: { code: string; requestId: string; status: number }): void
}

export interface ReviewApiServerOptions {
	allowedOrigin: string
	gateway: ReviewGateway
	logger?: SafeLogger
	mode: GatewayMode
	requestId?(): string
	sudoAsLogin?: string
	trustedProxyToken?: string
}

interface RouteMatch {
	allowedMethods: string[]
	handle(method: string, request: IncomingMessage, response: ServerResponse): Promise<void>
}

export function createReviewApiServer(options: ReviewApiServerOptions): Server {
	const createRequestId = options.requestId ?? randomUUID
	const logger = options.logger ?? console

	const server = createServer(async (request, response) => {
		const requestId = createRequestId()
		setStandardHeaders(response, requestId)

		try {
			if (!applyCors(request, response, options.allowedOrigin, requestId)) return

			const url = parseRequestUrl(request.url)
			const route = matchRoute(url.pathname, options.gateway, options.mode, response)
			if (!route) {
				sendError(response, 404, 'NOT_FOUND', false, requestId)
				return
			}

			if (request.method === 'OPTIONS') {
				handlePreflight(request, response, requestId, route.allowedMethods)
				return
			}

			if (
				options.mode === 'shotgrid' &&
				url.pathname.startsWith('/api/review/') &&
				!authenticateTrustedProxy(request, response, requestId, options)
			) {
				return
			}

			const method = request.method ?? 'GET'
			if (!route.allowedMethods.includes(method)) {
				response.setHeader('Allow', route.allowedMethods.join(', '))
				sendError(response, 405, 'INVALID_REQUEST', false, requestId)
				return
			}

			await route.handle(method, request, response)
		} catch (error) {
			const normalized = normalizeError(error)
			logger.error('Review API request failed', {
				code: normalized.code,
				requestId,
				status: normalized.status,
			})
			sendJson(response, normalized.status, normalized.toApiErrorEnvelope(requestId))
		}
	})
	server.headersTimeout = HEADERS_TIMEOUT_MS
	server.keepAliveTimeout = 5_000
	server.maxHeadersCount = 100
	server.maxRequestsPerSocket = 100
	server.requestTimeout = REQUEST_TIMEOUT_MS
	return server
}

function authenticateTrustedProxy(
	request: IncomingMessage,
	response: ServerResponse,
	requestId: string,
	options: ReviewApiServerOptions
) {
	const providedToken = readSingleHeader(request, 'x-review-proxy-token') ?? ''
	const expectedToken = options.trustedProxyToken ?? ''
	const tokenMatches = expectedToken.length >= 32 && constantTimeEqual(providedToken, expectedToken)
	const authenticatedLogin = readSingleHeader(request, 'x-review-authenticated-login')
	const loginMatches =
		options.sudoAsLogin === undefined || authenticatedLogin === options.sudoAsLogin

	if (!tokenMatches || !loginMatches) {
		sendError(response, 401, 'AUTHENTICATION_REQUIRED', false, requestId)
		return false
	}

	return true
}

function readSingleHeader(request: IncomingMessage, headerName: string) {
	const value = request.headers[headerName]
	return typeof value === 'string' ? value : undefined
}

function constantTimeEqual(provided: string, expected: string) {
	const providedDigest = createHash('sha256').update(provided, 'utf8').digest()
	const expectedDigest = createHash('sha256').update(expected, 'utf8').digest()
	return timingSafeEqual(providedDigest, expectedDigest)
}

function matchRoute(
	pathname: string,
	gateway: ReviewGateway,
	mode: GatewayMode,
	response: ServerResponse
): RouteMatch | undefined {
	if (pathname === '/api/health') {
		return getRoute(async () => {
			const health: ReviewHealth = { mode, status: 'ok' }
			sendJson(response, 200, health)
		})
	}

	if (pathname === '/api/review/me') {
		return getRoute(async () => {
			sendJson(response, 200, { data: await gateway.getCurrentReviewer() })
		})
	}

	if (pathname === '/api/review/projects') {
		return getRoute(async () => {
			sendJson(response, 200, { data: await gateway.listProjects() })
		})
	}

	const projectPlaylists = matchIdPath(pathname, /^\/api\/review\/projects\/([^/]+)\/playlists$/)
	if (projectPlaylists.matched) {
		return getRoute(async () => {
			const projectId = requirePositiveId(projectPlaylists.id, 'projectId')
			sendJson(response, 200, { data: await gateway.listPlaylists(projectId) })
		})
	}

	const playlistVersions = matchIdPath(pathname, /^\/api\/review\/playlists\/([^/]+)\/versions$/)
	if (playlistVersions.matched) {
		return getRoute(async () => {
			const playlistId = requirePositiveId(playlistVersions.id, 'playlistId')
			sendJson(response, 200, { data: await gateway.listVersions(playlistId) })
		})
	}

	const playlistVersionImage = matchTwoIdPath(
		pathname,
		/^\/api\/review\/playlists\/([^/]+)\/versions\/([^/]+)\/media\/image$/
	)
	if (playlistVersionImage.matched) {
		return getRoute(async (request) => {
			const playlistId = requirePositiveId(playlistVersionImage.firstId, 'playlistId')
			const versionId = requirePositiveId(playlistVersionImage.secondId, 'versionId')
			const controller = new AbortController()
			const abort = () => controller.abort()
			const abortOnPrematureClose = () => {
				if (!response.writableEnded) abort()
			}
			request.once('aborted', abort)
			response.once('close', abortOnPrematureClose)
			try {
				const image = await gateway.getVersionImage(playlistId, versionId, controller.signal)
				if (!controller.signal.aborted && !response.destroyed) sendImage(response, image)
			} catch (error) {
				if (controller.signal.aborted && (request.destroyed || response.destroyed)) return
				throw error
			} finally {
				request.off('aborted', abort)
				response.off('close', abortOnPrematureClose)
			}
		})
	}

	const playlistVersion = matchTwoIdPath(
		pathname,
		/^\/api\/review\/playlists\/([^/]+)\/versions\/([^/]+)$/
	)
	if (playlistVersion.matched) {
		return getRoute(async () => {
			const playlistId = requirePositiveId(playlistVersion.firstId, 'playlistId')
			const versionId = requirePositiveId(playlistVersion.secondId, 'versionId')
			sendJson(response, 200, { data: await gateway.getVersion(playlistId, versionId) })
		})
	}

	if (pathname === '/api/review/notes') {
		return mutationRoute('POST', async (request) => {
			const body = await readJson(request, JSON_BODY_LIMIT)
			const note = await gateway.createNote(parseNoteRequest(body))
			sendJson(response, 201, { data: note })
		})
	}

	if (pathname === '/api/review/attachments') {
		return mutationRoute('POST', async (request) => {
			const body = await readJson(request, ATTACHMENT_BODY_LIMIT)
			const attachment = await gateway.uploadAttachment(parseAttachmentRequest(body))
			sendJson(response, 201, { data: attachment })
		})
	}

	const statusUpdate = matchIdPath(pathname, /^\/api\/review\/versions\/([^/]+)\/status$/)
	if (statusUpdate.matched) {
		return mutationRoute('PATCH', async (request) => {
			const versionId = requirePositiveId(statusUpdate.id, 'versionId')
			const body = await readJson(request, JSON_BODY_LIMIT)
			const status = await gateway.updateVersionStatus(parseStatusRequest(versionId, body))
			sendJson(response, 200, { data: status })
		})
	}

	return undefined

	function getRoute(handle: (request: IncomingMessage) => Promise<void>): RouteMatch {
		return {
			allowedMethods: ['GET'],
			handle: async (_method, request) => handle(request),
		}
	}

	function mutationRoute(
		method: (typeof MUTATION_METHODS)[number],
		handle: (request: IncomingMessage) => Promise<void>
	): RouteMatch {
		return {
			allowedMethods: [method],
			handle: async (_method, request) => handle(request),
		}
	}
}

function applyCors(
	request: IncomingMessage,
	response: ServerResponse,
	allowedOrigin: string,
	requestId: string
) {
	const origin = request.headers.origin
	if (!origin) return true

	response.setHeader('Vary', 'Origin')
	if (origin === 'null' || origin !== allowedOrigin) {
		sendError(response, 403, 'PERMISSION_DENIED', false, requestId)
		return false
	}

	response.setHeader('Access-Control-Allow-Origin', origin)
	return true
}

function handlePreflight(
	request: IncomingMessage,
	response: ServerResponse,
	requestId: string,
	allowedMethods: string[]
) {
	const requestedMethod = request.headers['access-control-request-method']
	if (!requestedMethod || !allowedMethods.includes(requestedMethod)) {
		sendError(response, 403, 'PERMISSION_DENIED', false, requestId)
		return
	}

	const requestedHeaders = String(request.headers['access-control-request-headers'] ?? '')
		.split(',')
		.map((header) => header.trim().toLowerCase())
		.filter(Boolean)
	if (requestedHeaders.some((header) => header !== 'content-type')) {
		sendError(response, 403, 'PERMISSION_DENIED', false, requestId)
		return
	}

	response.statusCode = 204
	response.setHeader('Access-Control-Allow-Headers', 'Content-Type')
	response.setHeader('Access-Control-Allow-Methods', allowedMethods.join(', '))
	response.setHeader('Access-Control-Max-Age', '600')
	response.end()
}

function parseRequestUrl(rawUrl: string | undefined) {
	try {
		return new URL(rawUrl ?? '/', 'http://review-api.local')
	} catch {
		throw invalidRequest('Request URL is invalid')
	}
}

function matchIdPath(pathname: string, pattern: RegExp) {
	const match = pattern.exec(pathname)
	return match ? { id: match[1], matched: true as const } : { matched: false as const }
}

function matchTwoIdPath(pathname: string, pattern: RegExp) {
	const match = pattern.exec(pathname)
	return match
		? { firstId: match[1], matched: true as const, secondId: match[2] }
		: { matched: false as const }
}

function requirePositiveId(value: string, field: string) {
	if (!/^[1-9]\d*$/.test(value)) throw invalidRequest(`${field} must be a positive integer`)
	const id = Number(value)
	if (!Number.isSafeInteger(id)) throw invalidRequest(`${field} must be a positive integer`)
	return id
}

async function readJson(request: IncomingMessage, limit: number): Promise<unknown> {
	const contentType = request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase()
	if (contentType !== 'application/json') {
		throw new ReviewGatewayError({
			code: 'INVALID_REQUEST',
			message: 'Content-Type must be application/json',
			retryable: false,
			status: 415,
		})
	}

	const chunks: Buffer[] = []
	let size = 0
	for await (const chunk of request) {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
		size += buffer.byteLength
		if (size > limit) {
			throw new ReviewGatewayError({
				code: 'INVALID_REQUEST',
				message: 'Request body is too large',
				retryable: false,
				status: 413,
			})
		}
		chunks.push(buffer)
	}

	if (size === 0) throw invalidRequest('Request body is required')
	try {
		return JSON.parse(Buffer.concat(chunks).toString('utf8'))
	} catch {
		throw invalidRequest('Request body must be valid JSON')
	}
}

function parseNoteRequest(value: unknown): CreateReviewNoteRequest {
	const body = requireRecord(value)
	return {
		content: requireString(body.content, 'content', 1, 10_000),
		frame: body.frame === null ? null : (optionalNonNegativeInteger(body.frame, 'frame') ?? null),
		projectId: requireBodyId(body.projectId, 'projectId'),
		subject: requireString(body.subject, 'subject', 1, 255),
		versionId: requireBodyId(body.versionId, 'versionId'),
	}
}

function parseAttachmentRequest(value: unknown): UploadReviewAttachmentRequest {
	const body = requireRecord(value)
	const fileName = requireString(body.fileName, 'fileName', 1, 255)
	if (
		fileName === '.' ||
		fileName === '..' ||
		fileName !== fileName.replaceAll('\\', '/').split('/').at(-1) ||
		/[\p{Bidi_Control}\p{Cc}]/u.test(fileName)
	) {
		throw invalidRequest('fileName must not contain a path')
	}

	const contentType = requireString(body.contentType, 'contentType', 1, 100).toLowerCase()
	if (
		!['application/json', 'application/vnd.tldraw+json', 'image/jpeg', 'image/png'].includes(
			contentType
		)
	) {
		throw invalidRequest('contentType is not allowed')
	}

	const contentBase64 = requireString(body.contentBase64, 'contentBase64', 1, ATTACHMENT_BODY_LIMIT)
	if (!isCanonicalBase64(contentBase64)) throw invalidRequest('contentBase64 must be valid base64')
	const content = Buffer.from(contentBase64, 'base64')
	if (content.byteLength > MAX_ATTACHMENT_BYTES) {
		throw new ReviewGatewayError({
			code: 'INVALID_REQUEST',
			message: 'Attachment is too large',
			retryable: false,
			status: 413,
		})
	}
	validateAttachmentContent(fileName, contentType, content)

	return {
		contentBase64,
		contentType,
		fileName,
		noteId: requireBodyId(body.noteId, 'noteId'),
	}
}

function validateAttachmentContent(fileName: string, contentType: string, content: Buffer) {
	const extension = fileName.slice(fileName.lastIndexOf('.')).toLowerCase()
	if (contentType === 'image/png') {
		if (
			extension !== '.png' ||
			!content.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
		) {
			throw invalidRequest('PNG attachment content does not match its file type')
		}
		return
	}

	if (contentType === 'image/jpeg') {
		if (
			!['.jpeg', '.jpg'].includes(extension) ||
			!content.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))
		) {
			throw invalidRequest('JPEG attachment content does not match its file type')
		}
		return
	}

	const requiredExtension = contentType === 'application/vnd.tldraw+json' ? '.tldr' : '.json'
	if (extension !== requiredExtension) {
		throw invalidRequest('JSON attachment extension does not match its content type')
	}
	try {
		const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(content))
		if (
			contentType === 'application/vnd.tldraw+json' &&
			(!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
		) {
			throw new Error('Expected a tldraw object')
		}
	} catch {
		throw invalidRequest('JSON attachment content is invalid')
	}
}

function parseStatusRequest(versionId: number, value: unknown): UpdateReviewStatusRequest {
	const body = requireRecord(value)
	const statusCode = requireString(body.statusCode, 'statusCode', 1, 32)
	if (!/^[a-z0-9_]+$/i.test(statusCode)) throw invalidRequest('statusCode is invalid')

	return {
		statusCode,
		versionId,
	}
}

function requireRecord(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw invalidRequest('Request body must be an object')
	}
	return value as Record<string, unknown>
}

function requireBodyId(value: unknown, field: string) {
	if (!Number.isSafeInteger(value) || Number(value) <= 0) {
		throw invalidRequest(`${field} must be a positive integer`)
	}
	return Number(value)
}

function optionalNonNegativeInteger(value: unknown, field: string) {
	if (typeof value === 'undefined') return undefined
	if (!Number.isSafeInteger(value) || Number(value) < 0) {
		throw invalidRequest(`${field} must be a non-negative integer`)
	}
	return Number(value)
}

function requireString(
	value: unknown,
	field: string,
	minimumLength: number,
	maximumLength: number
) {
	if (typeof value !== 'string') throw invalidRequest(`${field} must be a string`)
	const trimmed = value.trim()
	if (trimmed.length < minimumLength || trimmed.length > maximumLength) {
		throw invalidRequest(`${field} has an invalid length`)
	}
	return trimmed
}

function isCanonicalBase64(value: string) {
	if (
		value.length % 4 !== 0 ||
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
	) {
		return false
	}
	return Buffer.from(value, 'base64').toString('base64') === value
}

function invalidRequest(message: string) {
	return new ReviewGatewayError({
		code: 'INVALID_REQUEST',
		message,
		retryable: false,
		status: 400,
	})
}

function normalizeError(error: unknown) {
	if (error instanceof ReviewGatewayError) return error
	return new ReviewGatewayError({
		code: 'INTERNAL_ERROR',
		message: 'The review service encountered an unexpected error',
		retryable: false,
		status: 500,
	})
}

function setStandardHeaders(response: ServerResponse, requestId: string) {
	response.setHeader('Cache-Control', 'no-store')
	response.setHeader('Referrer-Policy', 'no-referrer')
	response.setHeader('X-Content-Type-Options', 'nosniff')
	response.setHeader('X-Request-Id', requestId)
}

function sendError(
	response: ServerResponse,
	status: number,
	code: ReviewApiErrorCode,
	retryable: boolean,
	requestId: string
) {
	const error = new ReviewGatewayError({ code, retryable, status })
	sendJson(response, status, error.toApiErrorEnvelope(requestId))
}

function sendJson(response: ServerResponse, status: number, body: unknown) {
	if (response.writableEnded) return
	response.statusCode = status
	response.setHeader('Content-Type', 'application/json; charset=utf-8')
	response.end(JSON.stringify(body))
}

function sendImage(response: ServerResponse, image: ReviewImageProxyPayload) {
	if (response.writableEnded || response.destroyed) return
	const body = Buffer.from(image.body.buffer, image.body.byteOffset, image.body.byteLength)
	response.statusCode = 200
	response.setHeader('Content-Length', String(body.byteLength))
	response.setHeader('Content-Type', image.contentType)
	response.end(body)
}
