import { createHash, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { promisify } from 'node:util'
import { inflate } from 'node:zlib'
import { TLSyncErrorCloseEventCode, TLSyncErrorCloseEventReason } from '@tldraw/sync-core'
import { WebSocketServer } from 'ws'
import {
	InMemoryReviewAuditStore,
	type ReviewAuditOutcome,
	type ReviewAuditStore,
} from '../audit/ReviewAuditStore'
import {
	ReviewCollaborationError,
	REVIEW_SYNC_MAX_MESSAGE_SIZE_BYTES,
	type ReviewCollaborationService,
} from '../collaboration/ReviewCollaborationService'
import type {
	ReviewApiErrorCode,
	ReviewDecisionOption,
	ReviewDecisionRequest,
	ReviewDecisionResult,
	ReviewHealth,
	ReviewPublicationRequest,
	ReviewPublicationResult,
} from '../contracts'
import { isReviewDecisionRequest } from '../contracts'
import { ReviewGatewayError } from '../errors'
import type {
	ReviewGateway,
	ReviewImageProxyPayload,
	ReviewVideoByteRange,
	ReviewVideoProxyPayload,
} from '../gateway/ReviewGateway'
import { ShotGridEventSyncHttp } from '../webhooks/ShotGridEventSyncHttp'
import type { ShotGridEventSyncService } from '../webhooks/ShotGridEventSyncService'
import { ReviewDecisionCoordinator } from './ReviewDecisionCoordinator'
import { ReviewPublicationCoordinator } from './ReviewPublicationCoordinator'
import type { ReviewPublicationStore } from './ReviewPublicationStore'

const DECISION_BODY_LIMIT = 4 * 1024
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
const PUBLICATION_BODY_LIMIT = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 64 * 1024
const MAX_PNG_DIMENSION = 8_192
const MAX_PNG_PIXELS = 16_777_216
const MAX_PNG_INFLATED_BYTES = MAX_PNG_PIXELS * 4 + MAX_PNG_DIMENSION
const MAX_RECIPIENTS = 50
const PNG_CRC_TABLE = createPngCrcTable()
const HEADERS_TIMEOUT_MS = 10_000
const REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_VIDEO_DOWNSTREAM_IDLE_TIMEOUT_MS = 10_000
const DEFAULT_MAX_CONCURRENT_PUBLICATIONS = 1
const DEFAULT_MAX_SOCKET_LIFETIME_MS = 5 * 60_000
const MOCK_PRINCIPAL_ID = 'p1_mock-local-reviewer'
const MUTATION_METHODS = ['POST', 'PUT'] as const
const inflateAsync = promisify(inflate)

type GatewayMode = 'mock' | 'shotgrid'

interface SafeLogger {
	error(message: string, context: { code: string; requestId: string; status: number }): void
}

export interface ReviewApiServerOptions {
	allowedOrigin: string
	auditStore?: ReviewAuditStore
	collaboration?: ReviewCollaborationService
	decisions?: readonly ReviewDecisionOption[]
	eventSync?: ShotGridEventSyncService
	fixedActorSubject?: string
	gateway: ReviewGateway
	logger?: SafeLogger
	maxConcurrentPublications?: number
	maxSocketLifetimeMs?: number
	mode: GatewayMode
	publicationDeploymentScope?: string
	publicationStore?: ReviewPublicationStore
	requestId?(): string
	serviceActorName?: string
	sudoAsLogin?: string
	trustedProxyToken?: string
	videoDownstreamIdleTimeoutMs?: number
}

interface RouteMatch {
	allowedMethods: string[]
	handle(
		method: string,
		request: IncomingMessage,
		response: ServerResponse,
		context: ReviewRequestContext
	): Promise<void>
	requiresHumanReviewer: boolean
}

interface ReviewRequestContext {
	principalId: string
	requestId: string
}

export function createReviewApiServer(options: ReviewApiServerOptions): Server {
	if (options.mode === 'shotgrid' && !options.auditStore) {
		throw new ReviewGatewayError({
			code: 'CONFIGURATION_ERROR',
			retryable: false,
			status: 500,
		})
	}
	if (options.mode === 'shotgrid' && !options.publicationStore) {
		throw new ReviewGatewayError({
			code: 'CONFIGURATION_ERROR',
			retryable: false,
			status: 500,
		})
	}
	if (
		options.mode === 'shotgrid' &&
		(!options.fixedActorSubject ||
			options.fixedActorSubject.trim() !== options.fixedActorSubject ||
			options.fixedActorSubject.length > 512 ||
			/\p{Cc}/u.test(options.fixedActorSubject))
	) {
		throw new ReviewGatewayError({
			code: 'CONFIGURATION_ERROR',
			retryable: false,
			status: 500,
		})
	}
	if (
		options.mode === 'shotgrid' &&
		!isCanonicalShotGridOrigin(options.publicationDeploymentScope)
	) {
		throw new ReviewGatewayError({
			code: 'CONFIGURATION_ERROR',
			retryable: false,
			status: 500,
		})
	}
	if (
		options.mode === 'shotgrid' &&
		options.sudoAsLogin === undefined &&
		(!options.serviceActorName ||
			options.serviceActorName.trim() !== options.serviceActorName ||
			options.serviceActorName.length > 255 ||
			/\p{Cc}/u.test(options.serviceActorName))
	) {
		throw new ReviewGatewayError({
			code: 'CONFIGURATION_ERROR',
			retryable: false,
			status: 500,
		})
	}
	if (
		options.mode === 'shotgrid' &&
		options.sudoAsLogin !== undefined &&
		(options.sudoAsLogin.trim() === '' ||
			options.sudoAsLogin.trim() !== options.sudoAsLogin ||
			options.sudoAsLogin.length > 255 ||
			/\p{Cc}/u.test(options.sudoAsLogin))
	) {
		throw new ReviewGatewayError({
			code: 'CONFIGURATION_ERROR',
			retryable: false,
			status: 500,
		})
	}
	const createRequestId = options.requestId ?? randomUUID
	const logger = options.logger ?? console
	const maxConcurrentPublications =
		options.maxConcurrentPublications ?? DEFAULT_MAX_CONCURRENT_PUBLICATIONS
	if (!Number.isSafeInteger(maxConcurrentPublications) || maxConcurrentPublications <= 0) {
		throw new ReviewGatewayError({
			code: 'CONFIGURATION_ERROR',
			retryable: false,
			status: 500,
		})
	}
	const videoDownstreamIdleTimeoutMs =
		options.videoDownstreamIdleTimeoutMs ?? DEFAULT_VIDEO_DOWNSTREAM_IDLE_TIMEOUT_MS
	if (
		!Number.isSafeInteger(videoDownstreamIdleTimeoutMs) ||
		videoDownstreamIdleTimeoutMs <= 0 ||
		videoDownstreamIdleTimeoutMs > 120_000
	) {
		throw new ReviewGatewayError({
			code: 'CONFIGURATION_ERROR',
			retryable: false,
			status: 500,
		})
	}
	const maxSocketLifetimeMs = options.maxSocketLifetimeMs ?? DEFAULT_MAX_SOCKET_LIFETIME_MS
	if (
		!Number.isSafeInteger(maxSocketLifetimeMs) ||
		maxSocketLifetimeMs <= 0 ||
		maxSocketLifetimeMs > 24 * 60 * 60_000
	) {
		throw new ReviewGatewayError({
			code: 'CONFIGURATION_ERROR',
			retryable: false,
			status: 500,
		})
	}
	const publications = new ReviewPublicationCoordinator(options.gateway, options.publicationStore)
	const auditStore = options.auditStore ?? new InMemoryReviewAuditStore()
	const decisions = new ReviewDecisionCoordinator(
		options.gateway,
		options.decisions ??
			(options.mode === 'mock'
				? [
						{ key: 'approve', label: 'Approve', statusCode: 'apr' },
						{ key: 'needs-changes', label: 'Needs changes', statusCode: 'chg' },
						{ key: 'pending-clarification', label: 'Pending clarification', statusCode: 'rev' },
					]
				: [])
	)
	const publicationLimiter = new InFlightLimiter(maxConcurrentPublications)
	const eventSyncHttp = options.eventSync ? new ShotGridEventSyncHttp(options.eventSync) : undefined
	const publicationActorScope =
		options.mode === 'mock'
			? 'mock:local.reviewer'
			: options.sudoAsLogin !== undefined
				? `shotgrid:${options.publicationDeploymentScope}:human:${options.sudoAsLogin}`
				: `shotgrid:${options.publicationDeploymentScope}:script:${options.serviceActorName}`

	const server = createServer(async (request, response) => {
		const requestId = createRequestId()
		setStandardHeaders(response, requestId)

		try {
			if (!applyCors(request, response, options.allowedOrigin, requestId)) return

			const url = parseRequestUrl(request.url)
			const route = matchRoute(
				url.pathname,
				options.gateway,
				options.mode,
				auditStore,
				decisions,
				publications,
				options.collaboration,
				publicationLimiter,
				publicationActorScope,
				videoDownstreamIdleTimeoutMs,
				eventSyncHttp,
				options.eventSync,
				response
			)
			if (!route) {
				sendError(response, 404, 'NOT_FOUND', false, requestId)
				return
			}

			if (request.method === 'OPTIONS') {
				handlePreflight(request, response, requestId, route.allowedMethods)
				return
			}

			let context: ReviewRequestContext = { principalId: MOCK_PRINCIPAL_ID, requestId }
			if (options.mode === 'shotgrid' && url.pathname.startsWith('/api/review/')) {
				const authenticated = authenticateTrustedProxy(request, response, requestId, options)
				if (!authenticated) return
				context = authenticated
			}

			const method = request.method ?? 'GET'
			if (!route.allowedMethods.includes(method)) {
				response.setHeader('Allow', route.allowedMethods.join(', '))
				sendError(response, 405, 'INVALID_REQUEST', false, requestId)
				return
			}
			if (
				options.mode === 'shotgrid' &&
				options.sudoAsLogin === undefined &&
				route.requiresHumanReviewer
			) {
				sendError(response, 403, 'PERMISSION_DENIED', false, requestId)
				return
			}

			await route.handle(method, request, response, context)
		} catch (error) {
			const normalized = normalizeError(error)
			logger.error('Review API request failed', {
				code: normalized.code,
				requestId,
				status: normalized.status,
			})
			if (response.headersSent) {
				response.destroy()
				return
			}
			if (normalized.status === 416 && normalized.rangeResourceLength !== undefined) {
				response.setHeader('Content-Range', `bytes */${normalized.rangeResourceLength}`)
			}
			sendJson(response, normalized.status, normalized.toApiErrorEnvelope(requestId))
		}
	})
	server.headersTimeout = HEADERS_TIMEOUT_MS
	server.keepAliveTimeout = 5_000
	server.maxHeadersCount = 100
	server.maxRequestsPerSocket = 100
	server.requestTimeout = REQUEST_TIMEOUT_MS
	if (options.collaboration) {
		attachReviewCollaborationWebSocket(
			server,
			options.collaboration,
			options.allowedOrigin,
			logger,
			createRequestId,
			options,
			maxSocketLifetimeMs
		)
	}
	if (options.eventSync) attachEventSyncShutdown(server, options.eventSync, logger)
	return server
}

function attachEventSyncShutdown(
	server: Server,
	eventSync: ShotGridEventSyncService,
	logger: SafeLogger
) {
	let closeStarted = false
	const closeHttpServer = server.close.bind(server)
	server.close = ((callback?: (error?: Error) => void) => {
		if (closeStarted) {
			if (callback) server.once('close', () => callback())
			return server
		}
		closeStarted = true
		void eventSync.close().then(
			() => closeHttpServer(callback),
			(error: unknown) => {
				logger.error('Review event sync could not shut down cleanly', {
					code: 'INTERNAL_ERROR',
					requestId: 'shutdown',
					status: 500,
				})
				const shutdownError =
					error instanceof Error ? error : new Error('Event sync shutdown failed')
				closeHttpServer(() => callback?.(shutdownError))
			}
		)
		return server
	}) as Server['close']
	server.once('close', () => {
		void eventSync.close()
	})
}

function attachReviewCollaborationWebSocket(
	server: Server,
	collaboration: ReviewCollaborationService,
	allowedOrigin: string,
	logger: SafeLogger,
	createRequestId: () => string,
	options: ReviewApiServerOptions,
	maxSocketLifetimeMs: number
) {
	let collaborationClosed = false
	const closeCollaboration = () => {
		if (collaborationClosed) return
		collaborationClosed = true
		collaboration.close()
	}
	const closeHttpServer = server.close.bind(server)
	server.close = ((callback?: (error?: Error) => void) => {
		// Node waits for upgraded sockets before emitting `close`. End sync rooms first so
		// callers can use the standard Server.close() API without deadlocking shutdown.
		closeCollaboration()
		return closeHttpServer(callback)
	}) as Server['close']
	const webSocketServer = new WebSocketServer({
		clientTracking: false,
		maxPayload: REVIEW_SYNC_MAX_MESSAGE_SIZE_BYTES,
		noServer: true,
		perMessageDeflate: false,
	})

	server.on('upgrade', (request, socket, head) => {
		const requestId = createRequestId()
		try {
			if (request.method !== 'GET' || readSingleHeader(request, 'origin') !== allowedOrigin) {
				rejectWebSocketUpgrade(socket, 403)
				return
			}
			if (request.headers['sec-websocket-protocol'] !== undefined) {
				rejectWebSocketUpgrade(socket, 400)
				return
			}
			const principalId =
				options.mode === 'shotgrid'
					? readTrustedProxyPrincipal(request, options)
					: MOCK_PRINCIPAL_ID
			if (!principalId) {
				rejectWebSocketUpgrade(socket, 401)
				return
			}

			const url = parseRequestUrl(request.url)
			const roomMatch = /^\/api\/review\/sync\/(r1_[A-Za-z0-9_-]{43})$/.exec(url.pathname)
			if (!roomMatch || !hasOnlySyncSearchParameters(url.searchParams)) {
				rejectWebSocketUpgrade(socket, 404)
				return
			}

			const ticket = readSingleSearchParameter(url.searchParams, 'ticket')
			const sessionId = readSingleSearchParameter(url.searchParams, 'sessionId')
			const storeId = readSingleSearchParameter(url.searchParams, 'storeId')
			if (!ticket || !sessionId || !storeId) {
				rejectWebSocketUpgrade(socket, 400)
				return
			}

			const authorization = collaboration.consumeSocketTicket(roomMatch[1], ticket, principalId)
			void collaboration.reauthorizeSocket(authorization).then(
				() => {
					if (socket.destroyed) return
					webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
						try {
							collaboration.connectSocket(authorization, { sessionId, socket: webSocket, storeId })
							const authorizationLease = setTimeout(() => {
								webSocket.close(
									TLSyncErrorCloseEventCode,
									TLSyncErrorCloseEventReason.NOT_AUTHENTICATED
								)
							}, maxSocketLifetimeMs)
							authorizationLease.unref?.()
							webSocket.once('close', () => clearTimeout(authorizationLease))
						} catch (error) {
							const reason = collaborationSocketCloseReason(error)
							webSocket.close(TLSyncErrorCloseEventCode, reason)
							if (!(error instanceof ReviewCollaborationError)) {
								logger.error('Review collaboration connection failed', {
									code: 'INTERNAL_ERROR',
									requestId,
									status: 500,
								})
							}
						}
					})
				},
				(error: unknown) => {
					const status = collaborationUpgradeStatus(error)
					rejectWebSocketUpgrade(socket, status)
					if (!(error instanceof ReviewCollaborationError)) {
						logger.error('Review collaboration reauthorization failed', {
							code: 'INTERNAL_ERROR',
							requestId,
							status,
						})
					}
				}
			)
		} catch (error) {
			const status = collaborationUpgradeStatus(error)
			rejectWebSocketUpgrade(socket, status)
			if (!(error instanceof ReviewCollaborationError)) {
				logger.error('Review collaboration upgrade failed', {
					code: 'INTERNAL_ERROR',
					requestId,
					status,
				})
			}
		}
	})

	server.once('close', () => {
		closeCollaboration()
		webSocketServer.close()
	})
}

function hasOnlySyncSearchParameters(search: URLSearchParams) {
	const keys = [...search.keys()]
	return (
		keys.length === 3 &&
		new Set(keys).size === 3 &&
		keys.every((key) => key === 'sessionId' || key === 'storeId' || key === 'ticket')
	)
}

function readSingleSearchParameter(search: URLSearchParams, name: string) {
	const values = search.getAll(name)
	return values.length === 1 ? values[0] : undefined
}

function collaborationUpgradeStatus(error: unknown) {
	if (!(error instanceof ReviewCollaborationError)) return 500
	switch (error.code) {
		case 'INVALID_REQUEST':
			return 400
		case 'UNAUTHORIZED':
			return 401
		case 'NOT_FOUND':
			return 404
		case 'ROOM_FULL':
			return 503
		case 'CONFIGURATION_ERROR':
			return 500
	}
}

function collaborationSocketCloseReason(error: unknown) {
	if (!(error instanceof ReviewCollaborationError)) {
		return TLSyncErrorCloseEventReason.UNKNOWN_ERROR
	}
	if (error.code === 'ROOM_FULL') return TLSyncErrorCloseEventReason.ROOM_FULL
	if (error.code === 'UNAUTHORIZED') return TLSyncErrorCloseEventReason.NOT_AUTHENTICATED
	return TLSyncErrorCloseEventReason.FORBIDDEN
}

function rejectWebSocketUpgrade(socket: Duplex, status: number) {
	if (socket.destroyed) return
	const reason =
		status === 400
			? 'Bad Request'
			: status === 401
				? 'Unauthorized'
				: status === 403
					? 'Forbidden'
					: status === 404
						? 'Not Found'
						: status === 503
							? 'Service Unavailable'
							: 'Internal Server Error'
	socket.end(
		`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\nX-Content-Type-Options: nosniff\r\n\r\n`
	)
}

function isCanonicalShotGridOrigin(value: unknown): value is string {
	if (typeof value !== 'string') return false
	try {
		const url = new URL(value)
		return (
			url.protocol === 'https:' &&
			url.username === '' &&
			url.password === '' &&
			url.origin === value &&
			(url.pathname === '' || url.pathname === '/') &&
			url.search === '' &&
			url.hash === ''
		)
	} catch {
		return false
	}
}

function authenticateTrustedProxy(
	request: IncomingMessage,
	response: ServerResponse,
	requestId: string,
	options: ReviewApiServerOptions
) {
	const principalId = readTrustedProxyPrincipal(request, options)
	if (!principalId) {
		sendError(response, 401, 'AUTHENTICATION_REQUIRED', false, requestId)
		return undefined
	}

	return { principalId, requestId }
}

function readTrustedProxyPrincipal(
	request: IncomingMessage,
	options: ReviewApiServerOptions
): string | undefined {
	const providedToken = readSingleHeader(request, 'x-review-proxy-token') ?? ''
	const expectedToken = options.trustedProxyToken ?? ''
	const tokenMatches = expectedToken.length >= 32 && constantTimeEqual(providedToken, expectedToken)
	const authenticatedSubject = readSingleHeader(request, 'x-review-authenticated-subject')
	const expectedSubject = options.fixedActorSubject
	if (!tokenMatches || !expectedSubject || authenticatedSubject !== expectedSubject)
		return undefined
	return `p1_${createHash('sha256')
		.update('shotgrid-review-principal-v1\0', 'utf8')
		.update(authenticatedSubject, 'utf8')
		.digest('base64url')}`
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
	auditStore: ReviewAuditStore,
	decisions: ReviewDecisionCoordinator,
	publications: ReviewPublicationCoordinator,
	collaboration: ReviewCollaborationService | undefined,
	publicationLimiter: InFlightLimiter,
	publicationActorScope: string,
	videoDownstreamIdleTimeoutMs: number,
	eventSyncHttp: ShotGridEventSyncHttp | undefined,
	eventSync: ShotGridEventSyncService | undefined,
	response: ServerResponse
): RouteMatch | undefined {
	if (pathname === '/api/webhooks/shotgrid' && eventSyncHttp) {
		return mutationRoute('POST', async (request) => {
			await eventSyncHttp.handleWebhook(request, response)
		})
	}

	if (pathname === '/api/health') {
		return getRoute(async () => {
			if (eventSync && !eventSync.isReady()) {
				throw new ReviewGatewayError({
					code: 'COLLABORATION_UNAVAILABLE',
					retryable: true,
					status: 503,
				})
			}
			const health: ReviewHealth = { mode, status: 'ok' }
			sendJson(response, 200, health)
		})
	}

	if (pathname === '/api/review/event-sync-status' && eventSyncHttp) {
		return getRoute(async () => {
			eventSyncHttp.handleStatus(response)
		})
	}

	if (pathname === '/api/review/changes' && eventSyncHttp) {
		return getRoute(async (request) => {
			eventSyncHttp.handleChangeStream(request, response)
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

	const collaborationSession = matchTwoIdPath(
		pathname,
		/^\/api\/review\/playlists\/([^/]+)\/versions\/([^/]+)\/collaboration-session$/
	)
	if (collaborationSession.matched && collaboration) {
		return mutationRoute('POST', async (request, context) => {
			requireEmptyRequestBody(request)
			const playlistId = requirePositiveId(collaborationSession.firstId, 'playlistId')
			const versionId = requirePositiveId(collaborationSession.secondId, 'versionId')
			sendJson(response, 201, {
				data: await collaboration.createSession(playlistId, versionId, context.principalId),
			})
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

	const playlistVersionVideo = matchThreeIdPath(
		pathname,
		/^\/api\/review\/playlists\/([^/]+)\/versions\/([^/]+)\/media\/video\/([^/]+)$/
	)
	if (playlistVersionVideo.matched) {
		return getRoute(async (request) => {
			const playlistId = requirePositiveId(playlistVersionVideo.firstId, 'playlistId')
			const versionId = requirePositiveId(playlistVersionVideo.secondId, 'versionId')
			const attachmentId = requirePositiveId(playlistVersionVideo.thirdId, 'attachmentId')
			const range = parseReviewVideoRange(request.headers.range)
			const controller = new AbortController()
			const abort = () => controller.abort()
			const abortOnPrematureClose = () => {
				if (!response.writableEnded) abort()
			}
			let video: ReviewVideoProxyPayload | undefined
			request.once('aborted', abort)
			response.once('close', abortOnPrematureClose)
			try {
				video = await gateway.getVersionVideo(
					playlistId,
					versionId,
					attachmentId,
					range,
					controller.signal
				)
				if (!controller.signal.aborted && !response.destroyed) {
					await sendVideo(response, video, videoDownstreamIdleTimeoutMs)
				}
			} catch (error) {
				if (controller.signal.aborted && (request.destroyed || response.destroyed)) return
				throw error
			} finally {
				request.off('aborted', abort)
				response.off('close', abortOnPrematureClose)
				await video?.dispose()
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

	const noteOptions = matchTwoIdPath(
		pathname,
		/^\/api\/review\/playlists\/([^/]+)\/versions\/([^/]+)\/note-options$/
	)
	if (noteOptions.matched) {
		return getRoute(async () => {
			const playlistId = requirePositiveId(noteOptions.firstId, 'playlistId')
			const versionId = requirePositiveId(noteOptions.secondId, 'versionId')
			sendJson(response, 200, { data: await gateway.getNoteOptions(playlistId, versionId) })
		}, true)
	}

	const decisionContext = matchTwoIdPath(
		pathname,
		/^\/api\/review\/playlists\/([^/]+)\/versions\/([^/]+)\/decision-context$/
	)
	if (decisionContext.matched) {
		return getRoute(async () => {
			const playlistId = requirePositiveId(decisionContext.firstId, 'playlistId')
			const versionId = requirePositiveId(decisionContext.secondId, 'versionId')
			sendJson(response, 200, { data: await decisions.getContext(playlistId, versionId) })
		}, true)
	}

	const decision = matchTwoIdPath(
		pathname,
		/^\/api\/review\/playlists\/([^/]+)\/versions\/([^/]+)\/decision$/
	)
	if (decision.matched) {
		return mutationRoute(
			'PUT',
			async (request, context) => {
				const playlistId = requirePositiveId(decision.firstId, 'playlistId')
				const versionId = requirePositiveId(decision.secondId, 'versionId')
				const body = await readJson(request, DECISION_BODY_LIMIT)
				const decisionRequest = parseDecisionRequest(body)
				const auditAttemptId = await beginMutationAudit({
					action: 'decision',
					auditStore,
					context,
					gateway,
					playlistId,
					versionId,
				})
				let result: ReviewDecisionResult
				try {
					result = await decisions.decide(playlistId, versionId, decisionRequest)
				} catch (error) {
					await auditStore.finish(auditAttemptId, auditFailureOutcome(error))
					throw error
				}
				await auditStore.finish(auditAttemptId, {
					decisionStatus: result.statusCode,
					errorCode: null,
					resultAttachmentId: null,
					resultNoteId: null,
					status: 'succeeded',
				})
				sendJson(response, 200, { data: result })
			},
			true
		)
	}

	const publication = matchPublicationPath(pathname)
	if (publication.matched) {
		return mutationRoute(
			'PUT',
			async (request, context) => {
				const playlistId = requirePositiveId(publication.playlistId, 'playlistId')
				const versionId = requirePositiveId(publication.versionId, 'versionId')
				const publicationId = requirePublicationId(publication.publicationId)
				const release = publicationLimiter.tryAcquire()
				if (!release) throw publicationConcurrencyExceeded()
				try {
					const body = await readJson(request, PUBLICATION_BODY_LIMIT)
					const publicationRequest = await parsePublicationRequest(body)
					const auditAttemptId = await beginMutationAudit({
						action: 'publication',
						auditStore,
						context,
						gateway,
						playlistId,
						versionId,
					})
					let result: ReviewPublicationResult
					try {
						result = await publications.publish(
							publicationActorScope,
							publicationId,
							playlistId,
							versionId,
							publicationRequest
						)
					} catch (error) {
						await auditStore.finish(auditAttemptId, auditFailureOutcome(error))
						throw error
					}
					await auditStore.finish(auditAttemptId, {
						decisionStatus: null,
						errorCode: null,
						resultAttachmentId: result.attachment.id,
						resultNoteId: result.note.id,
						status: 'succeeded',
					})
					sendJson(response, 200, { data: result })
				} finally {
					release()
				}
			},
			true
		)
	}

	return undefined

	function getRoute(
		handle: (request: IncomingMessage, context: ReviewRequestContext) => Promise<void>,
		requiresHumanReviewer = false
	): RouteMatch {
		return {
			allowedMethods: ['GET'],
			handle: async (_method, request, _response, context) => handle(request, context),
			requiresHumanReviewer,
		}
	}

	function mutationRoute(
		method: (typeof MUTATION_METHODS)[number],
		handle: (request: IncomingMessage, context: ReviewRequestContext) => Promise<void>,
		requiresHumanReviewer = false
	): RouteMatch {
		return {
			allowedMethods: [method],
			handle: async (_method, request, _response, context) => handle(request, context),
			requiresHumanReviewer,
		}
	}
}

async function beginMutationAudit(options: {
	action: 'decision' | 'publication'
	auditStore: ReviewAuditStore
	context: ReviewRequestContext
	gateway: ReviewGateway
	playlistId: number
	versionId: number
}) {
	const [version, actor] = await Promise.all([
		options.gateway.getVersion(options.playlistId, options.versionId),
		options.gateway.getCurrentReviewer(),
	])
	if (
		version.id !== options.versionId ||
		version.playlistId !== options.playlistId ||
		!Number.isSafeInteger(version.projectId) ||
		version.projectId <= 0
	) {
		throw new ReviewGatewayError({
			code: 'NOT_FOUND',
			retryable: false,
			status: 404,
		})
	}
	if (actor.kind === 'human' && (actor.id === null || !Number.isSafeInteger(actor.id))) {
		throw new ReviewGatewayError({
			code: 'PERMISSION_DENIED',
			retryable: false,
			status: 403,
		})
	}
	return await options.auditStore.begin({
		action: options.action,
		effectiveActor: { id: actor.id, kind: actor.kind },
		playlistId: options.playlistId,
		principalId: options.context.principalId,
		projectId: version.projectId,
		requestId: options.context.requestId,
		versionId: options.versionId,
	})
}

function auditFailureOutcome(error: unknown): ReviewAuditOutcome {
	const normalized = normalizeError(error)
	const indeterminate =
		normalized.code === 'DECISION_INDETERMINATE' ||
		normalized.code === 'PUBLICATION_INCOMPLETE' ||
		normalized.code === 'PUBLICATION_INDETERMINATE'
	return {
		decisionStatus: null,
		errorCode: normalized.code,
		resultAttachmentId:
			normalized.publication && 'attachmentId' in normalized.publication
				? (normalized.publication.attachmentId ?? null)
				: null,
		resultNoteId:
			normalized.publication && 'noteId' in normalized.publication
				? normalized.publication.noteId
				: null,
		status: indeterminate ? 'indeterminate' : 'failed',
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

function requireEmptyRequestBody(request: IncomingMessage) {
	const contentLength = readSingleHeader(request, 'content-length')
	if (
		request.headers['transfer-encoding'] !== undefined ||
		(contentLength !== undefined && contentLength !== '0')
	) {
		throw invalidRequest('The collaboration session request must not contain a body.')
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

function matchThreeIdPath(pathname: string, pattern: RegExp) {
	const match = pattern.exec(pathname)
	return match
		? { firstId: match[1], matched: true as const, secondId: match[2], thirdId: match[3] }
		: { matched: false as const }
}

function parseReviewVideoRange(value: string | undefined): ReviewVideoByteRange | null {
	if (value === undefined) return null
	const match = /^bytes=((?:0|[1-9]\d*)?)-((?:0|[1-9]\d*)?)$/.exec(value)
	if (!match || (match[1] === '' && match[2] === '')) throw invalidReviewVideoRange()
	if (match[1] === '') {
		const length = Number(match[2])
		if (!Number.isSafeInteger(length) || length <= 0) throw invalidReviewVideoRange()
		return { kind: 'suffix', length }
	}
	const start = Number(match[1])
	if (!Number.isSafeInteger(start)) throw invalidReviewVideoRange()
	if (match[2] === '') return { kind: 'open', start }
	const end = Number(match[2])
	if (!Number.isSafeInteger(end) || end < start) throw invalidReviewVideoRange()
	return { end, kind: 'closed', start }
}

function matchPublicationPath(pathname: string) {
	const match =
		/^\/api\/review\/playlists\/([^/]+)\/versions\/([^/]+)\/publications\/([^/]+)$/.exec(pathname)
	return match
		? {
				matched: true as const,
				playlistId: match[1],
				publicationId: match[3],
				versionId: match[2],
			}
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

async function parsePublicationRequest(value: unknown): Promise<ReviewPublicationRequest> {
	const body = requireRecord(value)
	requireOnlyKeys(body, ['attachment', 'content', 'recipientIds', 'subject'])
	const attachment = requireRecord(body.attachment)
	requireOnlyKeys(attachment, ['contentBase64', 'contentType', 'fileName', 'sha256'])
	const fileName = requireString(attachment.fileName, 'attachment.fileName', 1, 255)
	if (
		fileName === '.' ||
		fileName === '..' ||
		fileName !== fileName.replaceAll('\\', '/').split('/').at(-1) ||
		/[\p{Bidi_Control}\p{Cc}]/u.test(fileName) ||
		!fileName.toLowerCase().endsWith('.png')
	) {
		throw invalidRequest('attachment.fileName must be a PNG basename')
	}

	if (attachment.contentType !== 'image/png') {
		throw invalidRequest('attachment.contentType must be image/png')
	}

	const contentBase64 = requireRawString(
		attachment.contentBase64,
		'attachment.contentBase64',
		1,
		Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4
	)
	const decodedLength = decodedBase64Length(contentBase64)
	if (decodedLength !== null && decodedLength > MAX_ATTACHMENT_BYTES) {
		throw new ReviewGatewayError({
			code: 'INVALID_REQUEST',
			message: 'Attachment is too large',
			retryable: false,
			status: 413,
		})
	}
	if (!isCanonicalBase64(contentBase64)) {
		throw invalidRequest('attachment.contentBase64 must be valid base64')
	}
	const content = Buffer.from(contentBase64, 'base64')
	if (content.byteLength > MAX_ATTACHMENT_BYTES) {
		throw new ReviewGatewayError({
			code: 'INVALID_REQUEST',
			message: 'Attachment is too large',
			retryable: false,
			status: 413,
		})
	}
	await validatePngAttachment(content)
	const sha256 = requireRawString(attachment.sha256, 'attachment.sha256', 64, 64)
	if (!/^[0-9a-f]{64}$/.test(sha256)) {
		throw invalidRequest('attachment.sha256 must be a lowercase SHA-256 digest')
	}
	const digest = createHash('sha256').update(content).digest('hex')
	if (!constantTimeEqual(sha256, digest)) throw invalidRequest('attachment.sha256 does not match')

	if (!Array.isArray(body.recipientIds) || body.recipientIds.length > MAX_RECIPIENTS) {
		throw invalidRequest(`recipientIds must contain at most ${MAX_RECIPIENTS} items`)
	}
	const recipientIds = body.recipientIds.map((id) => requireBodyId(id, 'recipientIds item'))
	if (new Set(recipientIds).size !== recipientIds.length) {
		throw invalidRequest('recipientIds must not contain duplicates')
	}
	return {
		attachment: { contentBase64, contentType: 'image/png', fileName, sha256 },
		content: requireString(body.content, 'content', 1, 10_000),
		recipientIds: recipientIds.sort((a, b) => a - b),
		subject: requireString(body.subject, 'subject', 1, 255),
	}
}

async function validatePngAttachment(content: Buffer) {
	const signature = Buffer.from('89504e470d0a1a0a', 'hex')
	if (content.byteLength < 8 || !content.subarray(0, 8).equals(signature)) {
		throw invalidRequest('PNG attachment has an invalid header')
	}

	let offset = 8
	let width = 0
	let height = 0
	let bitDepth = 0
	let colorType = 0
	let sawEnd = false
	let sawHeader = false
	let sawImageData = false
	let sawImageDataChunk = false
	let finishedImageData = false
	let sawPalette = false
	const compressedImageData = Buffer.allocUnsafe(content.byteLength)
	let compressedImageDataLength = 0
	while (offset + 12 <= content.byteLength) {
		const dataLength = content.readUInt32BE(offset)
		const chunkEnd = offset + 12 + dataLength
		if (chunkEnd > content.byteLength) throw invalidRequest('PNG attachment is truncated')
		const chunkTypeBytes = content.subarray(offset + 4, offset + 8)
		const chunkType = content.toString('latin1', offset + 4, offset + 8)
		if (
			![...chunkTypeBytes].every(isPngChunkTypeByte) ||
			!isAsciiUppercase(chunkTypeBytes[2]) ||
			!hasValidPngChunkCrc(content, offset, dataLength)
		) {
			throw invalidRequest('PNG attachment contains an invalid chunk')
		}
		if (/[A-Z]/.test(chunkType[0]) && !['IDAT', 'IEND', 'IHDR', 'PLTE'].includes(chunkType)) {
			throw invalidRequest('PNG attachment contains an unknown critical chunk')
		}
		if (!sawHeader) {
			if (chunkType !== 'IHDR' || dataLength !== 13) {
				throw invalidRequest('PNG attachment has an invalid header')
			}
			sawHeader = true
			width = content.readUInt32BE(offset + 8)
			height = content.readUInt32BE(offset + 12)
			bitDepth = content[offset + 16]
			colorType = content[offset + 17]
			validatePngHeaderParameters(content, offset + 8)
		}
		if (chunkType === 'IHDR' && offset !== 8) {
			throw invalidRequest('PNG attachment contains more than one header')
		}
		if (chunkType === 'acTL' || chunkType === 'fcTL' || chunkType === 'fdAT') {
			throw invalidRequest('Animated PNG attachments are not allowed')
		}
		if (chunkType === 'PLTE') {
			if (
				sawPalette ||
				sawImageDataChunk ||
				colorType === 0 ||
				colorType === 4 ||
				dataLength === 0 ||
				dataLength % 3 !== 0 ||
				dataLength > 768 ||
				(colorType === 3 && dataLength / 3 > 2 ** bitDepth)
			) {
				throw invalidRequest('PNG attachment contains an invalid palette')
			}
			sawPalette = true
		}
		if (chunkType === 'IDAT') {
			if (finishedImageData || (colorType === 3 && !sawPalette)) {
				throw invalidRequest('PNG attachment has invalid image data ordering')
			}
			sawImageDataChunk = true
			if (dataLength > 0) {
				sawImageData = true
				content.copy(
					compressedImageData,
					compressedImageDataLength,
					offset + 8,
					offset + 8 + dataLength
				)
				compressedImageDataLength += dataLength
			}
		} else if (sawImageDataChunk) {
			finishedImageData = true
		}
		if (chunkType === 'IEND') {
			if (dataLength !== 0 || !sawImageData || chunkEnd !== content.byteLength) {
				throw invalidRequest('PNG attachment has an invalid ending')
			}
			sawEnd = true
			offset = chunkEnd
			break
		}
		offset = chunkEnd
	}
	if (!sawHeader || !sawImageData || !sawEnd || offset !== content.byteLength) {
		throw invalidRequest('PNG attachment is incomplete')
	}
	if (
		width === 0 ||
		height === 0 ||
		width > MAX_PNG_DIMENSION ||
		height > MAX_PNG_DIMENSION ||
		width * height > MAX_PNG_PIXELS
	) {
		throw invalidRequest('PNG attachment dimensions are invalid')
	}
	await validatePngScanlines(
		compressedImageData.subarray(0, compressedImageDataLength),
		width,
		height,
		colorType
	)
}

function isPngChunkTypeByte(value: number) {
	return isAsciiUppercase(value) || (value >= 0x61 && value <= 0x7a)
}

function isAsciiUppercase(value: number) {
	return value >= 0x41 && value <= 0x5a
}

function validatePngHeaderParameters(content: Buffer, dataOffset: number) {
	const bitDepth = content[dataOffset + 8]
	const colorType = content[dataOffset + 9]
	if (
		bitDepth !== 8 ||
		(colorType !== 2 && colorType !== 6) ||
		content[dataOffset + 10] !== 0 ||
		content[dataOffset + 11] !== 0 ||
		content[dataOffset + 12] !== 0
	) {
		throw invalidRequest('PNG attachment uses unsupported header parameters')
	}
}

async function validatePngScanlines(
	compressedImageData: Buffer,
	width: number,
	height: number,
	colorType: number
) {
	const bytesPerPixel = colorType === 6 ? 4 : 3
	const rowLength = width * bytesPerPixel + 1
	const expectedLength = rowLength * height
	if (expectedLength > MAX_PNG_INFLATED_BYTES) {
		throw invalidRequest('PNG attachment dimensions are invalid')
	}

	let inflated: Buffer
	let consumedBytes: number
	try {
		const result = (await inflateAsync(compressedImageData, {
			info: true,
			maxOutputLength: expectedLength,
		})) as unknown as { buffer: Buffer; engine: { bytesWritten: number } }
		inflated = result.buffer
		consumedBytes = result.engine.bytesWritten
	} catch {
		throw invalidRequest('PNG attachment contains invalid image data')
	}

	if (inflated.byteLength !== expectedLength || consumedBytes !== compressedImageData.byteLength) {
		throw invalidRequest('PNG attachment contains invalid image data')
	}
	for (let rowOffset = 0; rowOffset < inflated.byteLength; rowOffset += rowLength) {
		if (inflated[rowOffset] > 4) {
			throw invalidRequest('PNG attachment contains an invalid scanline filter')
		}
	}
}

class InFlightLimiter {
	private inFlight = 0

	constructor(private readonly limit: number) {}

	tryAcquire() {
		if (this.inFlight >= this.limit) return null
		this.inFlight += 1
		let released = false
		return () => {
			if (released) return
			released = true
			this.inFlight -= 1
		}
	}
}

function publicationConcurrencyExceeded() {
	return new ReviewGatewayError({
		code: 'SHOTGRID_RATE_LIMITED',
		message: 'Too many review publications are in progress.',
		retryable: true,
		status: 429,
	})
}

function hasValidPngChunkCrc(content: Buffer, offset: number, dataLength: number) {
	let crc = 0xffffffff
	const end = offset + 8 + dataLength
	for (let index = offset + 4; index < end; index++) {
		crc = PNG_CRC_TABLE[(crc ^ content[index]) & 0xff] ^ (crc >>> 8)
	}
	return (crc ^ 0xffffffff) >>> 0 === content.readUInt32BE(end)
}

function createPngCrcTable() {
	const table = new Uint32Array(256)
	for (let index = 0; index < table.length; index++) {
		let value = index
		for (let bit = 0; bit < 8; bit++) {
			value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
		}
		table[index] = value >>> 0
	}
	return table
}

function parseDecisionRequest(value: unknown): ReviewDecisionRequest {
	if (!isReviewDecisionRequest(value)) throw invalidRequest('Decision request is invalid')
	return value
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

function requireRawString(
	value: unknown,
	field: string,
	minimumLength: number,
	maximumLength: number
) {
	if (typeof value !== 'string') throw invalidRequest(`${field} must be a string`)
	if (value.length < minimumLength || value.length > maximumLength) {
		throw invalidRequest(`${field} has an invalid length`)
	}
	return value
}

function requireOnlyKeys(record: Record<string, unknown>, allowedKeys: readonly string[]) {
	if (Object.keys(record).some((key) => !allowedKeys.includes(key))) {
		throw invalidRequest('Request body contains an unsupported field')
	}
}

function requirePublicationId(value: string) {
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
		throw invalidRequest('publicationId must be a canonical UUID')
	}
	return value
}

function isCanonicalBase64(value: string) {
	if (value.length % 4 !== 0) return false
	const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
	if (padding > 0 && value.length < 4) return false
	for (let index = 0; index < value.length - padding; index++) {
		if (!isBase64Character(value.charCodeAt(index))) return false
	}
	for (let index = value.length - padding; index < value.length; index++) {
		if (value[index] !== '=') return false
	}
	return Buffer.from(value, 'base64').toString('base64') === value
}

function decodedBase64Length(value: string) {
	if (value.length === 0 || value.length % 4 !== 0) return null
	const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
	return (value.length / 4) * 3 - padding
}

function isBase64Character(code: number) {
	return (
		(code >= 0x41 && code <= 0x5a) ||
		(code >= 0x61 && code <= 0x7a) ||
		(code >= 0x30 && code <= 0x39) ||
		code === 0x2b ||
		code === 0x2f
	)
}

function invalidRequest(message: string) {
	return new ReviewGatewayError({
		code: 'INVALID_REQUEST',
		message,
		retryable: false,
		status: 400,
	})
}

function invalidReviewVideoRange() {
	return new ReviewGatewayError({
		code: 'INVALID_REQUEST',
		message: 'Range must contain one valid bytes range.',
		retryable: false,
		status: 416,
	})
}

function normalizeError(error: unknown) {
	if (error instanceof ReviewGatewayError) return error
	if (error instanceof ReviewCollaborationError) {
		switch (error.code) {
			case 'INVALID_REQUEST':
				return new ReviewGatewayError({
					cause: error,
					code: 'INVALID_REQUEST',
					retryable: false,
					status: 400,
				})
			case 'UNAUTHORIZED':
				return new ReviewGatewayError({
					cause: error,
					code: 'AUTHENTICATION_REQUIRED',
					retryable: false,
					status: 401,
				})
			case 'NOT_FOUND':
				return new ReviewGatewayError({
					cause: error,
					code: 'NOT_FOUND',
					retryable: false,
					status: 404,
				})
			case 'ROOM_FULL':
				return new ReviewGatewayError({
					cause: error,
					code: 'COLLABORATION_UNAVAILABLE',
					retryable: true,
					status: 503,
				})
			case 'CONFIGURATION_ERROR':
				return new ReviewGatewayError({
					cause: error,
					code: 'CONFIGURATION_ERROR',
					retryable: false,
					status: 500,
				})
		}
	}
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

async function sendVideo(
	response: ServerResponse,
	video: ReviewVideoProxyPayload,
	downstreamIdleTimeoutMs: number
) {
	if (response.writableEnded || response.destroyed) return
	response.statusCode = video.status
	response.setHeader('Accept-Ranges', 'bytes')
	response.setHeader('Content-Length', String(video.contentLength))
	response.setHeader('Content-Type', video.contentType)
	if (video.contentRange !== null) response.setHeader('Content-Range', video.contentRange)
	response.flushHeaders()

	const reader = video.body.getReader()
	let bytesWritten = 0
	try {
		for (;;) {
			const { done, value } = await reader.read()
			if (done) break
			if (isVideoResponseClosed(response)) throw new Error('Video response closed')
			bytesWritten += value.byteLength
			if (bytesWritten > video.contentLength) throw invalidUpstreamVideoStream()
			const chunk = Buffer.from(value.buffer, value.byteOffset, value.byteLength)
			if (!response.write(chunk)) await waitForDrain(response, downstreamIdleTimeoutMs)
		}
		if (bytesWritten !== video.contentLength) throw invalidUpstreamVideoStream()
		response.end()
	} finally {
		reader.releaseLock()
	}
}

function waitForDrain(response: ServerResponse, timeoutMs: number) {
	return new Promise<void>((resolve, reject) => {
		if (isVideoResponseClosed(response)) {
			reject(new Error('Video response closed before draining'))
			return
		}
		const cleanup = () => {
			clearTimeout(timeout)
			response.off('close', onClose)
			response.off('drain', onDrain)
			response.off('error', onError)
		}
		const onClose = () => {
			cleanup()
			reject(new Error('Video response closed before draining'))
		}
		const onDrain = () => {
			cleanup()
			resolve()
		}
		const onError = (error: Error) => {
			cleanup()
			reject(error)
		}
		const timeout = setTimeout(() => {
			cleanup()
			reject(new Error('Video response timed out while waiting for the client'))
		}, timeoutMs)
		response.once('close', onClose)
		response.once('drain', onDrain)
		response.once('error', onError)
	})
}

function isVideoResponseClosed(response: ServerResponse) {
	return response.destroyed || response.writableEnded || response.socket?.destroyed === true
}

function invalidUpstreamVideoStream() {
	return new ReviewGatewayError({
		code: 'SHOTGRID_INVALID_RESPONSE',
		retryable: false,
		status: 502,
	})
}
