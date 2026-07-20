import { createHmac, randomBytes as nodeRandomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import {
	createReviewCollaborationPresence,
	type ReviewCollaborationPermission,
	type ReviewCollaborationPresence,
	type ReviewCollaborationSession,
	type ReviewUser,
	type ReviewVersion,
} from '@tldraw/shotgrid-review-contracts'
import {
	NodeSqliteWrapper,
	RecordOpType,
	SQLiteSyncStorage,
	TLSocketRoom,
	TLSyncErrorCloseEventReason,
	ValueOpType,
	DEFAULT_INITIAL_SNAPSHOT,
	type TLSocketClientSentEvent,
	type WebSocketMinimal,
} from '@tldraw/sync-core'
import { createTLSchema, defaultShapeSchemas, type TLRecord } from '@tldraw/tlschema'
import { T } from '@tldraw/validate'

const ROOM_ID_PATTERN = /^r1_[A-Za-z0-9_-]{43}$/
const TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/
const DEFAULT_MAX_ROOMS = 100
const DEFAULT_MAX_SESSIONS_PER_ROOM = 16
const DEFAULT_TICKET_TTL_SECONDS = 60
const MAX_DEPLOYMENT_SCOPE_LENGTH = 256
const MAX_SESSION_IDENTIFIER_LENGTH = 256
const MAX_REVIEW_VIDEO_NAME_LENGTH = 255
export const REVIEW_SYNC_MAX_MESSAGE_SIZE_BYTES = 1024 * 1024
export const REVIEW_SYNC_MAX_MESSAGE_CHUNKS = 1024

const positiveSafeInteger = T.number.check('positive safe integer', (value) => {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new RangeError('Expected a positive safe integer')
	}
})

const boundedReviewVideoName = T.string.check('bounded review video name', (value) => {
	if (value.length > MAX_REVIEW_VIDEO_NAME_LENGTH) {
		throw new RangeError(
			`Expected a review video name no longer than ${MAX_REVIEW_VIDEO_NAME_LENGTH} characters`
		)
	}
})

/** The sync schema is strict: unknown shape types and malformed review-video records are rejected. */
export const reviewSyncSchema = createTLSchema({
	shapes: {
		...defaultShapeSchemas,
		'review-video': {
			props: {
				attachmentId: positiveSafeInteger,
				h: positiveSafeInteger,
				name: boundedReviewVideoName,
				versionId: positiveSafeInteger,
				w: positiveSafeInteger,
			},
		},
	},
})

export type ReviewCollaborationErrorCode =
	| 'CONFIGURATION_ERROR'
	| 'INVALID_REQUEST'
	| 'NOT_FOUND'
	| 'ROOM_FULL'
	| 'UNAUTHORIZED'

export class ReviewCollaborationError extends Error {
	constructor(
		public readonly code: ReviewCollaborationErrorCode,
		message: string,
		options?: ErrorOptions
	) {
		super(message, options)
		this.name = 'ReviewCollaborationError'
	}
}

export interface ReviewReservedSourceIds {
	imageAssetId: string
	imageShapeId: string
	videoShapeId: string
}

export interface ReviewSocketAuthorization {
	media: { attachmentId: number; kind: 'video' } | { kind: 'image' } | { kind: 'none' }
	permission: ReviewCollaborationPermission
	playlistId: number
	presence: ReviewCollaborationPresence
	projectId: number
	reservedSourceIds: ReviewReservedSourceIds
	roomId: string
	versionId: number
}

export interface ReviewSocketConnection {
	sessionId: string
	socket: WebSocketMinimal
	storeId: string
}

export interface ReviewCollaborationGateway {
	getCurrentReviewer(): Promise<ReviewUser>
	getVersion(playlistId: number, versionId: number): Promise<ReviewVersion>
}

export interface ReviewCollaborationServiceOptions {
	deploymentScope: string
	gateway: ReviewCollaborationGateway
	maxRooms?: number
	maxSessionsPerRoom?: number
	now?(): number
	randomBytes?(size: number): Uint8Array
	secret: string
	storeDir: string
	ticketTtlSeconds?: number
}

interface PendingTicket extends ReviewSocketAuthorization {
	expiresAt: number
}

export interface ReviewSocketSessionMeta {
	permission: ReviewCollaborationPermission
	playlistId: number
	presence: ReviewCollaborationPresence
	projectId: number
	storeId: string
	versionId: number
}

interface ActiveRoom {
	closed: boolean
	database: DatabaseSync
	room: TLSocketRoom<TLRecord, ReviewSocketSessionMeta>
	roomId: string
}

/**
 * Owns authenticated, persistent tldraw sync rooms for ShotGrid review Versions.
 * Tickets are intentionally opaque and single-use; only their keyed digests are retained.
 */
export class ReviewCollaborationService {
	private readonly activeRooms = new Map<string, ActiveRoom>()
	private readonly deploymentScope: string
	private readonly gateway: ReviewCollaborationGateway
	private readonly issuedAuthorizations = new Map<ReviewSocketAuthorization, number>()
	private readonly maxTicketRecords: number
	private readonly maxRooms: number
	private readonly maxSessionsPerRoom: number
	private readonly now: () => number
	private readonly pendingTickets = new Map<string, PendingTicket>()
	private readonly randomBytes: (size: number) => Uint8Array
	private readonly secret: string
	private readonly storeDir: string
	private readonly ticketTtlMs: number
	private readonly usedTicketDigests = new Map<string, number>()
	private closed = false

	constructor(options: ReviewCollaborationServiceOptions) {
		if (!isAbsolute(options.storeDir)) {
			throw configurationError('The collaboration store directory must be absolute.')
		}
		if (typeof options.secret !== 'string' || options.secret.length < 32) {
			throw configurationError('The collaboration secret must contain at least 32 characters.')
		}
		if (!isBoundedPlainString(options.deploymentScope, MAX_DEPLOYMENT_SCOPE_LENGTH)) {
			throw configurationError('The collaboration deployment scope is invalid.')
		}

		this.maxRooms = readPositiveLimit(options.maxRooms, DEFAULT_MAX_ROOMS, 'maxRooms')
		this.maxSessionsPerRoom = readPositiveLimit(
			options.maxSessionsPerRoom,
			DEFAULT_MAX_SESSIONS_PER_ROOM,
			'maxSessionsPerRoom'
		)
		const ticketTtlSeconds = readPositiveLimit(
			options.ticketTtlSeconds,
			DEFAULT_TICKET_TTL_SECONDS,
			'ticketTtlSeconds'
		)

		this.deploymentScope = options.deploymentScope
		this.gateway = options.gateway
		const configuredCapacity = this.maxRooms * this.maxSessionsPerRoom
		if (!Number.isSafeInteger(configuredCapacity)) {
			throw configurationError('The collaboration capacity is too large.')
		}
		const ticketCapacity = Math.max(64, configuredCapacity * 4)
		if (!Number.isSafeInteger(ticketCapacity)) {
			throw configurationError('The collaboration ticket capacity is too large.')
		}
		this.maxTicketRecords = ticketCapacity
		this.now = options.now ?? Date.now
		this.randomBytes = options.randomBytes ?? nodeRandomBytes
		this.secret = options.secret
		this.storeDir = options.storeDir
		this.ticketTtlMs = ticketTtlSeconds * 1_000

		this.readNow()

		mkdirSync(this.storeDir, { recursive: true })
	}

	async createSession(playlistId: number, versionId: number): Promise<ReviewCollaborationSession> {
		this.assertOpen()
		assertPositiveEntityId(playlistId, 'playlistId')
		assertPositiveEntityId(versionId, 'versionId')

		const version = await this.gateway.getVersion(playlistId, versionId)
		if (
			version.id !== versionId ||
			version.playlistId !== playlistId ||
			!Number.isSafeInteger(version.projectId) ||
			version.projectId <= 0
		) {
			throw new ReviewCollaborationError(
				'NOT_FOUND',
				'The requested Version does not belong to the requested Playlist.'
			)
		}

		const reviewer = await this.gateway.getCurrentReviewer()
		const presence = createReviewCollaborationPresence(reviewer)
		const permission: ReviewCollaborationPermission =
			reviewer.kind === 'human' ? 'editor' : 'viewer'
		const roomId = this.createRoomId(version)
		const now = this.readNow()
		this.pruneExpiredAuthorizationState(now)
		if (this.pendingTickets.size + this.usedTicketDigests.size >= this.maxTicketRecords) {
			throw new ReviewCollaborationError(
				'ROOM_FULL',
				'The collaboration ticket capacity has been reached.'
			)
		}

		const expiresAt = now + this.ticketTtlMs
		const authorization: ReviewSocketAuthorization = {
			media: getMediaIdentity(version),
			permission,
			playlistId,
			presence,
			projectId: version.projectId,
			reservedSourceIds: createReviewReservedSourceIds(versionId),
			roomId,
			versionId,
		}
		const ticket = this.issueTicket({ ...authorization, expiresAt })

		return {
			permission,
			roomId,
			socketUrl: `/api/review/sync/${roomId}?ticket=${ticket}`,
			ticketExpiresAt: new Date(expiresAt).toISOString(),
		}
	}

	consumeSocketTicket(roomId: string, ticket: string): ReviewSocketAuthorization {
		this.assertOpen()
		if (!ROOM_ID_PATTERN.test(roomId) || !TICKET_PATTERN.test(ticket)) {
			throw unauthorizedTicket()
		}

		const now = this.readNow()
		this.pruneExpiredAuthorizationState(now)
		const digest = this.digestTicket(ticket)
		const pending = this.pendingTickets.get(digest)
		if (!pending || pending.roomId !== roomId || pending.expiresAt <= now) {
			throw unauthorizedTicket()
		}

		this.pendingTickets.delete(digest)
		this.usedTicketDigests.set(digest, pending.expiresAt)
		const authorization = Object.freeze({
			media: Object.freeze({ ...pending.media }),
			permission: pending.permission,
			playlistId: pending.playlistId,
			presence: Object.freeze({ ...pending.presence }),
			projectId: pending.projectId,
			reservedSourceIds: Object.freeze({ ...pending.reservedSourceIds }),
			roomId: pending.roomId,
			versionId: pending.versionId,
		}) satisfies ReviewSocketAuthorization
		this.issuedAuthorizations.set(authorization, pending.expiresAt)
		return authorization
	}

	connectSocket(
		authorization: ReviewSocketAuthorization,
		{ sessionId, socket, storeId }: ReviewSocketConnection
	): void {
		this.assertOpen()
		const authorizationExpiresAt = this.issuedAuthorizations.get(authorization)
		this.issuedAuthorizations.delete(authorization)
		if (authorizationExpiresAt === undefined || authorizationExpiresAt <= this.readNow()) {
			throw unauthorizedTicket()
		}
		if (
			!ROOM_ID_PATTERN.test(authorization.roomId) ||
			!isBoundedPlainString(sessionId, MAX_SESSION_IDENTIFIER_LENGTH) ||
			!isBoundedPlainString(storeId, MAX_SESSION_IDENTIFIER_LENGTH)
		) {
			throw new ReviewCollaborationError(
				'INVALID_REQUEST',
				'The collaboration connection identifiers are invalid.'
			)
		}

		const activeRoom = this.getOrOpenRoom(authorization.roomId)
		const effectiveSessionId = this.createEffectiveSessionId(
			authorization.presence.userId,
			sessionId,
			storeId
		)
		const existingSession = activeRoom.room
			.getSessions()
			.find((session) => session.sessionId === effectiveSessionId)
		if (!existingSession && activeRoom.room.getNumActiveSessions() >= this.maxSessionsPerRoom) {
			throw new ReviewCollaborationError('ROOM_FULL', 'The collaboration room is full.')
		}

		activeRoom.room.handleSocketConnect({
			isReadonly: authorization.permission === 'viewer',
			meta: {
				permission: authorization.permission,
				playlistId: authorization.playlistId,
				presence: { ...authorization.presence },
				projectId: authorization.projectId,
				storeId,
				versionId: authorization.versionId,
			},
			sessionId: effectiveSessionId,
			socket,
		})
	}

	getActiveRoomCount() {
		return this.activeRooms.size
	}

	close(): void {
		if (this.closed) return
		this.closed = true
		this.pendingTickets.clear()
		this.usedTicketDigests.clear()
		this.issuedAuthorizations.clear()
		for (const activeRoom of [...this.activeRooms.values()]) {
			this.closeActiveRoom(activeRoom)
		}
	}

	private assertOpen() {
		if (this.closed) {
			throw new ReviewCollaborationError(
				'CONFIGURATION_ERROR',
				'The collaboration service is closed.'
			)
		}
	}

	private createRoomId(version: ReviewVersion) {
		const canonicalIdentity = JSON.stringify([
			'review-room-v1',
			this.deploymentScope,
			version.projectId,
			version.playlistId,
			version.id,
			getMediaCanonicalIdentity(version),
		])
		const digest = createHmac('sha256', this.secret)
			.update(canonicalIdentity, 'utf8')
			.digest('base64url')
		return `r1_${digest}`
	}

	private issueTicket(ticketData: PendingTicket) {
		for (let attempt = 0; attempt < 4; attempt++) {
			const bytes = this.randomBytes(32)
			if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 32) {
				throw configurationError('The collaboration random source must return 32 bytes.')
			}
			const ticket = Buffer.from(bytes).toString('base64url')
			const digest = this.digestTicket(ticket)
			if (!this.pendingTickets.has(digest) && !this.usedTicketDigests.has(digest)) {
				this.pendingTickets.set(digest, ticketData)
				return ticket
			}
		}
		throw new ReviewCollaborationError(
			'CONFIGURATION_ERROR',
			'The collaboration random source generated repeated tickets.'
		)
	}

	private digestTicket(ticket: string) {
		return createHmac('sha256', this.secret)
			.update('review-ticket-v1\0')
			.update(ticket)
			.digest('hex')
	}

	private pruneExpiredAuthorizationState(now: number) {
		for (const [digest, ticket] of this.pendingTickets) {
			if (ticket.expiresAt <= now) this.pendingTickets.delete(digest)
		}
		for (const [digest, expiresAt] of this.usedTicketDigests) {
			if (expiresAt <= now) this.usedTicketDigests.delete(digest)
		}
		for (const [authorization, expiresAt] of this.issuedAuthorizations) {
			if (expiresAt <= now) this.issuedAuthorizations.delete(authorization)
		}
	}

	private readNow() {
		const now = this.now()
		const expiresAt = now + this.ticketTtlMs
		if (
			!Number.isSafeInteger(now) ||
			now < 0 ||
			!Number.isSafeInteger(expiresAt) ||
			!Number.isFinite(new Date(expiresAt).getTime())
		) {
			throw configurationError('The collaboration clock returned an invalid timestamp.')
		}
		return now
	}

	private createEffectiveSessionId(userId: string, sessionId: string, storeId: string) {
		return `s1_${createHmac('sha256', this.secret)
			.update('review-session-v1\0')
			.update(userId)
			.update('\0')
			.update(sessionId)
			.update('\0')
			.update(storeId)
			.digest('base64url')}`
	}

	private getOrOpenRoom(roomId: string) {
		const existing = this.activeRooms.get(roomId)
		if (existing) return existing
		if (this.activeRooms.size >= this.maxRooms) {
			throw new ReviewCollaborationError(
				'ROOM_FULL',
				'The collaboration room capacity has been reached.'
			)
		}

		if (!ROOM_ID_PATTERN.test(roomId)) {
			throw new ReviewCollaborationError('INVALID_REQUEST', 'The collaboration room id is invalid.')
		}
		const database = new DatabaseSync(join(this.storeDir, `${roomId}.sqlite`))
		let room: TLSocketRoom<TLRecord, ReviewSocketSessionMeta> | undefined
		try {
			database.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;')
			const sql = new NodeSqliteWrapper(database)
			const isInitialized = SQLiteSyncStorage.hasBeenInitialized(sql)
			const storage = new SQLiteSyncStorage<TLRecord>({
				snapshot: isInitialized
					? undefined
					: { ...DEFAULT_INITIAL_SNAPSHOT, schema: reviewSyncSchema.serialize() },
				sql,
			})
			room = new TLSocketRoom<TLRecord, ReviewSocketSessionMeta>({
				maxMessageChunks: REVIEW_SYNC_MAX_MESSAGE_CHUNKS,
				maxMessageSizeBytes: REVIEW_SYNC_MAX_MESSAGE_SIZE_BYTES,
				onAfterReceiveMessage: ({ message, meta, sessionId }) => {
					const fatalReason = validateReviewClientMessage(
						message,
						meta.presence,
						createReviewReservedSourceIds(meta.versionId)
					)
					if (fatalReason) room?.closeSession(sessionId, fatalReason)
				},
				onSessionRemoved: (removedFromRoom, { numSessionsRemaining }) => {
					if (numSessionsRemaining !== 0) return
					queueMicrotask(() => {
						if (
							this.activeRooms.get(roomId) === activeRoom &&
							removedFromRoom.getNumActiveSessions() === 0
						) {
							this.closeActiveRoom(activeRoom)
						}
					})
				},
				schema: reviewSyncSchema,
				storage,
			})
			const activeRoom = { closed: false, database, room, roomId }
			this.activeRooms.set(roomId, activeRoom)
			return activeRoom
		} catch (error) {
			room?.close()
			database.close()
			throw error
		}
	}

	private closeActiveRoom(activeRoom: ActiveRoom) {
		if (activeRoom.closed) return
		activeRoom.closed = true
		if (this.activeRooms.get(activeRoom.roomId) === activeRoom) {
			this.activeRooms.delete(activeRoom.roomId)
		}
		activeRoom.room.close()
		activeRoom.database.close()
	}
}

export function createReviewReservedSourceIds(versionId: number): ReviewReservedSourceIds {
	assertPositiveEntityId(versionId, 'versionId')
	return {
		imageAssetId: `asset:shotgrid-review-source-${versionId}`,
		imageShapeId: `shape:shotgrid-review-source-${versionId}`,
		videoShapeId: `shape:shotgrid-review-video-${versionId}`,
	}
}

/** Returns the fatal sync close reason for an untrusted client message, or null when allowed. */
export function validateReviewClientMessage(
	value: unknown,
	expectedPresence: ReviewCollaborationPresence,
	reservedSourceIds: ReviewReservedSourceIds
): (typeof TLSyncErrorCloseEventReason)[keyof typeof TLSyncErrorCloseEventReason] | null {
	if (!isPlainRecord(value) || value.type !== 'push') return null
	const message = value as unknown as TLSocketClientSentEvent<TLRecord> & Record<string, unknown>

	if ('presence' in message && message.presence !== undefined) {
		const presenceReason = validatePresenceOperation(message.presence, expectedPresence)
		if (presenceReason) return presenceReason
	}

	if ('diff' in message && message.diff !== undefined) {
		if (!isPlainRecord(message.diff)) return TLSyncErrorCloseEventReason.INVALID_RECORD
		const reservedIds = new Set(Object.values(reservedSourceIds))
		for (const [recordId, operation] of Object.entries(message.diff)) {
			if (reservedIds.has(recordId)) return TLSyncErrorCloseEventReason.FORBIDDEN
			if (!Array.isArray(operation) || typeof operation[0] !== 'string') {
				return TLSyncErrorCloseEventReason.INVALID_RECORD
			}
			if (operation[0] === RecordOpType.Put) {
				if (
					operation.length !== 2 ||
					!isPlainRecord(operation[1]) ||
					operation[1].id !== recordId
				) {
					return TLSyncErrorCloseEventReason.INVALID_RECORD
				}
				if (typeof operation[1].id === 'string' && reservedIds.has(operation[1].id)) {
					return TLSyncErrorCloseEventReason.FORBIDDEN
				}
				if (operation[1].typeName === 'shape' && operation[1].type === 'review-video') {
					return TLSyncErrorCloseEventReason.FORBIDDEN
				}
				const userReason = validateReviewUserRecordOperation(recordId, operation, expectedPresence)
				if (userReason !== undefined) return userReason
			} else if (operation[0] === RecordOpType.Patch) {
				if (operation.length !== 2 || !isPlainRecord(operation[1])) {
					return TLSyncErrorCloseEventReason.INVALID_RECORD
				}
				if ('id' in operation[1]) {
					const idOperation = operation[1].id
					if (
						Array.isArray(idOperation) &&
						idOperation[0] === ValueOpType.Put &&
						typeof idOperation[1] === 'string' &&
						reservedIds.has(idOperation[1])
					) {
						return TLSyncErrorCloseEventReason.FORBIDDEN
					}
					return TLSyncErrorCloseEventReason.INVALID_RECORD
				}
				if ('typeName' in operation[1]) {
					const typeNameOperation = operation[1].typeName
					if (
						Array.isArray(typeNameOperation) &&
						typeNameOperation[0] === ValueOpType.Put &&
						typeNameOperation[1] === 'user'
					) {
						return TLSyncErrorCloseEventReason.FORBIDDEN
					}
					return TLSyncErrorCloseEventReason.INVALID_RECORD
				}
				const typeOperation = operation[1].type
				if (
					Array.isArray(typeOperation) &&
					typeOperation[0] === ValueOpType.Put &&
					typeOperation[1] === 'review-video'
				) {
					return TLSyncErrorCloseEventReason.FORBIDDEN
				}
				const userReason = validateReviewUserRecordOperation(recordId, operation, expectedPresence)
				if (userReason !== undefined) return userReason
			} else if (operation[0] !== RecordOpType.Remove || operation.length !== 1) {
				return TLSyncErrorCloseEventReason.INVALID_RECORD
			} else {
				const userReason = validateReviewUserRecordOperation(recordId, operation, expectedPresence)
				if (userReason !== undefined) return userReason
			}
		}
	}

	return null
}

type ReviewSyncFatalReason =
	(typeof TLSyncErrorCloseEventReason)[keyof typeof TLSyncErrorCloseEventReason]

/**
 * User records are document-scoped, so only the authenticated reviewer's public attribution may
 * be persisted. In particular, ShotGrid avatar URLs can contain signed credentials and must never
 * enter the shared document.
 */
function validateReviewUserRecordOperation(
	recordId: string,
	operation: unknown[],
	expected: ReviewCollaborationPresence
): ReviewSyncFatalReason | null | undefined {
	const record =
		operation[0] === RecordOpType.Put && isPlainRecord(operation[1]) ? operation[1] : null
	const targetsUserRecord = recordId.startsWith('user:') || record?.typeName === 'user'
	if (!targetsUserRecord) return undefined
	if (recordId !== expected.userId) return TLSyncErrorCloseEventReason.FORBIDDEN

	if (operation[0] === RecordOpType.Put) {
		if (
			record === null ||
			record.typeName !== 'user' ||
			record.id !== expected.userId ||
			record.name !== expected.userName ||
			record.color !== expected.color ||
			record.imageUrl !== '' ||
			!isEmptyPlainRecord(record.meta) ||
			!hasOnlyKeys(record, ['color', 'id', 'imageUrl', 'meta', 'name', 'typeName'])
		) {
			return TLSyncErrorCloseEventReason.FORBIDDEN
		}
		return null
	}

	if (operation[0] === RecordOpType.Patch) {
		const patch = operation[1]
		if (!isPlainRecord(patch) || Object.keys(patch).length === 0) {
			return TLSyncErrorCloseEventReason.INVALID_RECORD
		}
		if (!hasOnlyKeys(patch, ['color', 'imageUrl', 'meta', 'name'])) {
			return TLSyncErrorCloseEventReason.FORBIDDEN
		}
		for (const [field, fieldOperation] of Object.entries(patch)) {
			if (
				!Array.isArray(fieldOperation) ||
				fieldOperation.length !== 2 ||
				fieldOperation[0] !== ValueOpType.Put
			) {
				return TLSyncErrorCloseEventReason.FORBIDDEN
			}
			if (field === 'meta') {
				if (!isEmptyPlainRecord(fieldOperation[1])) {
					return TLSyncErrorCloseEventReason.FORBIDDEN
				}
			} else {
				const expectedValue =
					field === 'name' ? expected.userName : field === 'color' ? expected.color : ''
				if (fieldOperation[1] !== expectedValue) {
					return TLSyncErrorCloseEventReason.FORBIDDEN
				}
			}
		}
		return null
	}

	return TLSyncErrorCloseEventReason.FORBIDDEN
}

function validatePresenceOperation(
	presence: unknown,
	expected: ReviewCollaborationPresence
): (typeof TLSyncErrorCloseEventReason)[keyof typeof TLSyncErrorCloseEventReason] | null {
	if (!Array.isArray(presence) || presence.length !== 2) {
		return TLSyncErrorCloseEventReason.INVALID_RECORD
	}
	if (presence[0] === RecordOpType.Put) {
		if (!isPlainRecord(presence[1])) return TLSyncErrorCloseEventReason.INVALID_RECORD
		const record = presence[1]
		if (
			typeof record.userId !== 'string' ||
			typeof record.userName !== 'string' ||
			typeof record.color !== 'string'
		) {
			return TLSyncErrorCloseEventReason.INVALID_RECORD
		}
		return record.userId === expected.userId &&
			record.userName === expected.userName &&
			record.color === expected.color
			? null
			: TLSyncErrorCloseEventReason.FORBIDDEN
	}
	if (presence[0] === RecordOpType.Patch) {
		if (!isPlainRecord(presence[1])) return TLSyncErrorCloseEventReason.INVALID_RECORD
		return ['userId', 'userName', 'color'].some((field) => field in presence[1])
			? TLSyncErrorCloseEventReason.FORBIDDEN
			: null
	}
	return TLSyncErrorCloseEventReason.INVALID_RECORD
}

function getMediaIdentity(version: ReviewVersion): ReviewSocketAuthorization['media'] {
	if (version.media?.kind === 'video') {
		return { attachmentId: version.media.attachmentId, kind: 'video' }
	}
	return version.media?.kind === 'image' ? { kind: 'image' } : { kind: 'none' }
}

function getMediaCanonicalIdentity(version: ReviewVersion) {
	const media = getMediaIdentity(version)
	return media.kind === 'video' ? `video:${media.attachmentId}` : media.kind
}

function unauthorizedTicket() {
	return new ReviewCollaborationError(
		'UNAUTHORIZED',
		'The collaboration socket authorization is invalid.'
	)
}

function configurationError(message: string) {
	return new ReviewCollaborationError('CONFIGURATION_ERROR', message)
}

function readPositiveLimit(value: number | undefined, fallback: number, label: string) {
	const resolved = value ?? fallback
	if (!Number.isSafeInteger(resolved) || resolved <= 0) {
		throw configurationError(`${label} must be a positive safe integer.`)
	}
	return resolved
}

function assertPositiveEntityId(value: number, label: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new ReviewCollaborationError(
			'INVALID_REQUEST',
			`${label} must be a positive safe integer.`
		)
	}
}

function isBoundedPlainString(value: unknown, maxLength: number): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= maxLength &&
		value.trim() === value &&
		!/\p{Cc}/u.test(value)
	)
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
	const prototype = Object.getPrototypeOf(value)
	return prototype === Object.prototype || prototype === null
}

function isEmptyPlainRecord(value: unknown): value is Record<string, never> {
	return isPlainRecord(value) && Object.keys(value).length === 0
}

function hasOnlyKeys(record: Record<string, unknown>, allowedKeys: readonly string[]) {
	return Object.keys(record).every((key) => allowedKeys.includes(key))
}
