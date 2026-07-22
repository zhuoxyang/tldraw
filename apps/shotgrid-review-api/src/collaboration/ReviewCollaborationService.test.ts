import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReviewUser, ReviewVersion } from '@tldraw/shotgrid-review-contracts'
import {
	getTlsyncProtocolVersion,
	RecordOpType,
	TLSyncErrorCloseEventCode,
	TLSyncErrorCloseEventReason,
	ValueOpType,
	type WebSocketMinimal,
} from '@tldraw/sync-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	createReviewReservedSourceIds,
	ReviewCollaborationService,
	reviewSyncSchema,
	validateReviewClientMessage,
	type ReviewCollaborationGateway,
} from './ReviewCollaborationService'

const SECRET = 'review-collaboration-test-secret-32-bytes-minimum'
const humanReviewer: ReviewUser = {
	avatarUrl: null,
	id: 41,
	kind: 'human',
	login: 'alice',
	name: 'Alice Review',
}
const serviceReviewer: ReviewUser = {
	avatarUrl: null,
	id: null,
	kind: 'service',
	login: 'review-script',
	name: 'Review service',
}

const services: ReviewCollaborationService[] = []
const storeDirectories: string[] = []

afterEach(() => {
	for (const service of services.splice(0)) service.close()
	for (const directory of storeDirectories.splice(0)) {
		rmSync(directory, { force: true, recursive: true })
	}
})

describe('ReviewCollaborationService', () => {
	it('creates a stable opaque room identity that is scoped to the deployment and media', async () => {
		const service = createService()
		const first = await service.createSession(201, 301)
		const second = await service.createSession(201, 301)

		expect(first.roomId).toBe(second.roomId)
		expect(first.roomId).toMatch(/^r1_[A-Za-z0-9_-]{43}$/)
		expect(first.roomId).not.toContain('201')
		expect(first.roomId).not.toContain('301')
		expect(first.socketUrl).toMatch(
			new RegExp(
				`^/api/review/sync/${first.roomId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\?ticket=[A-Za-z0-9_-]{43}$`
			)
		)
		expect(first.socketUrl).not.toContain(humanReviewer.login!)

		const anotherDeployment = createService({ deploymentScope: 'production-secondary' })
		expect((await anotherDeployment.createSession(201, 301)).roomId).not.toBe(first.roomId)

		const videoService = createService({
			gateway: makeGateway({
				version: versionFixture(201, 301, {
					attachmentId: 901,
					contentType: 'video/mp4',
					durationSeconds: 10,
					fileName: 'review.mp4',
					firstFrame: 1,
					frameCount: 240,
					frameRate: 24,
					frameRateMode: 'constant',
					height: 1080,
					kind: 'video',
					lastFrame: 240,
					thumbnailUrl: null,
					url: '/review/playlists/201/versions/301/media/video/901',
					width: 1920,
				}),
			}),
		})
		expect((await videoService.createSession(201, 301)).roomId).not.toBe(first.roomId)
	})

	it('expires tickets, rejects replay and wrong-room use, and does not burn a wrong-room ticket', async () => {
		let now = Date.parse('2026-07-21T00:00:00.000Z')
		const service = createService({ now: () => now })
		const first = await service.createSession(201, 301)
		const firstTicket = readTicket(first.socketUrl)
		const wrongRoom = `r1_${'A'.repeat(43)}`

		expect(() => service.consumeSocketTicket(wrongRoom, firstTicket)).toThrow(
			expect.objectContaining({ code: 'UNAUTHORIZED' })
		)
		const authorization = service.consumeSocketTicket(first.roomId, firstTicket)
		expect(authorization).toMatchObject({ playlistId: 201, versionId: 301 })
		expect(() => service.consumeSocketTicket(first.roomId, firstTicket)).toThrow(
			expect.objectContaining({ code: 'UNAUTHORIZED' })
		)

		const expiring = await service.createSession(201, 301)
		now += 60_000
		expect(() =>
			service.consumeSocketTicket(expiring.roomId, readTicket(expiring.socketUrl))
		).toThrow(expect.objectContaining({ code: 'UNAUTHORIZED' }))

		const consumedBeforeExpiry = await service.createSession(201, 301)
		const consumedAuthorization = service.consumeSocketTicket(
			consumedBeforeExpiry.roomId,
			readTicket(consumedBeforeExpiry.socketUrl)
		)
		now += 60_000
		expect(() =>
			service.connectSocket(consumedAuthorization, {
				sessionId: 'expired-authorization',
				socket: new TestSocket(),
				storeId: 'expired-store',
			})
		).toThrow(expect.objectContaining({ code: 'UNAUTHORIZED' }))
	})

	it('binds each ticket to the opaque proxy principal without burning a stolen attempt', async () => {
		const service = createService()
		const session = await service.createSession(201, 301, 'p1_subject-A')
		const ticket = readTicket(session.socketUrl)

		expect(() => service.consumeSocketTicket(session.roomId, ticket, 'p1_subject-B')).toThrow(
			expect.objectContaining({ code: 'UNAUTHORIZED' })
		)
		expect(service.consumeSocketTicket(session.roomId, ticket, 'p1_subject-A')).toMatchObject({
			principalId: 'p1_subject-A',
		})
	})

	it('verifies the Version-to-Playlist relationship before reading the reviewer', async () => {
		const getCurrentReviewer = vi.fn(async () => humanReviewer)
		const service = createService({
			gateway: {
				getCurrentReviewer,
				getVersion: vi.fn(async () => versionFixture(999, 301)),
			},
		})

		await expect(service.createSession(201, 301)).rejects.toEqual(
			expect.objectContaining({ code: 'NOT_FOUND' })
		)
		expect(getCurrentReviewer).not.toHaveBeenCalled()
	})

	it('reauthorizes the exact reviewer, relationship, and media before socket upgrade', async () => {
		let currentVersion = versionFixture(201, 301)
		const service = createService({
			gateway: {
				getCurrentReviewer: vi.fn(async () => humanReviewer),
				getVersion: vi.fn(async () => currentVersion),
			},
		})
		const session = await service.createSession(201, 301, 'p1_subject-A')
		const authorization = service.consumeSocketTicket(
			session.roomId,
			readTicket(session.socketUrl),
			'p1_subject-A'
		)

		await expect(service.reauthorizeSocket(authorization)).resolves.toBeUndefined()
		currentVersion = { ...currentVersion, projectId: 202 }
		await expect(service.reauthorizeSocket(authorization)).rejects.toMatchObject({
			code: 'UNAUTHORIZED',
		})
	})

	it('grants human reviewers editor access and service identities viewer access', async () => {
		const editorService = createService()
		const editorSession = await editorService.createSession(201, 301)
		expect(editorSession.permission).toBe('editor')
		const editorSocket = new TestSocket()
		editorService.connectSocket(
			editorService.consumeSocketTicket(editorSession.roomId, readTicket(editorSession.socketUrl)),
			{ sessionId: 'editor-session', socket: editorSocket, storeId: 'editor-store' }
		)
		connect(editorSocket)
		expect(editorSocket.sentMessages.at(-1)).toMatchObject({ isReadonly: false, type: 'connect' })

		const viewerService = createService({
			gateway: makeGateway({ reviewer: serviceReviewer }),
		})
		const viewerSession = await viewerService.createSession(201, 301)
		expect(viewerSession.permission).toBe('viewer')
		const viewerSocket = new TestSocket()
		viewerService.connectSocket(
			viewerService.consumeSocketTicket(viewerSession.roomId, readTicket(viewerSession.socketUrl)),
			{ sessionId: 'viewer-session', socket: viewerSocket, storeId: 'viewer-store' }
		)
		connect(viewerSocket)
		expect(viewerSocket.sentMessages.at(-1)).toMatchObject({ isReadonly: true, type: 'connect' })
		viewerSocket.receive({
			clientClock: 1,
			diff: {
				'page:page': [RecordOpType.Patch, { name: [ValueOpType.Put, 'Forbidden edit'] }],
			},
			type: 'push',
		})
		expect(viewerSocket.sentMessages.at(-1)).toMatchObject({
			data: [{ action: 'discard', type: 'push_result' }],
			type: 'data',
		})
	})

	it('closes a socket fatally before applying a spoofed presence identity', async () => {
		const service = createService()
		const session = await service.createSession(201, 301)
		const socket = new TestSocket()
		service.connectSocket(
			service.consumeSocketTicket(session.roomId, readTicket(session.socketUrl)),
			{ sessionId: 'spoof-test', socket, storeId: 'spoof-test-store' }
		)
		connect(socket)
		socket.receive({
			clientClock: 1,
			presence: [
				RecordOpType.Put,
				{ color: '#000000', userId: 'user:attacker', userName: 'Attacker' },
			],
			type: 'push',
		})

		expect(socket.closedWith.at(-1)?.reason).toBe(TLSyncErrorCloseEventReason.FORBIDDEN)
	})

	it('persists document updates across a complete service and SQLite reopen', async () => {
		const storeDir = createStoreDirectory()
		const firstService = createService({ storeDir })
		const firstSession = await firstService.createSession(201, 301)
		const firstSocket = new TestSocket()
		firstService.connectSocket(
			firstService.consumeSocketTicket(firstSession.roomId, readTicket(firstSession.socketUrl)),
			{ sessionId: 'first-session', socket: firstSocket, storeId: 'first-store' }
		)
		connect(firstSocket)
		firstSocket.receive({
			clientClock: 1,
			diff: {
				'page:page': [RecordOpType.Patch, { name: [ValueOpType.Put, 'Persisted page'] }],
			},
			type: 'push',
		})
		firstService.close()

		const reopenedService = createService({ storeDir })
		const reopenedSession = await reopenedService.createSession(201, 301)
		expect(reopenedSession.roomId).toBe(firstSession.roomId)
		const reopenedSocket = new TestSocket()
		reopenedService.connectSocket(
			reopenedService.consumeSocketTicket(
				reopenedSession.roomId,
				readTicket(reopenedSession.socketUrl)
			),
			{ sessionId: 'reopened-session', socket: reopenedSocket, storeId: 'reopened-store' }
		)
		connect(reopenedSocket)

		expect(JSON.stringify(reopenedSocket.sentMessages.at(-1))).toContain('Persisted page')
	})

	it('enforces per-room and active-room capacity', async () => {
		const sessionService = createService({ maxSessionsPerRoom: 1 })
		const first = await sessionService.createSession(201, 301)
		const firstSocket = new TestSocket()
		sessionService.connectSocket(
			sessionService.consumeSocketTicket(first.roomId, readTicket(first.socketUrl)),
			{ sessionId: 'one', socket: firstSocket, storeId: 'store-one' }
		)

		const duplicate = await sessionService.createSession(201, 301)
		const duplicateSocket = new TestSocket()
		expect(() =>
			sessionService.connectSocket(
				sessionService.consumeSocketTicket(duplicate.roomId, readTicket(duplicate.socketUrl)),
				{ sessionId: 'one', socket: duplicateSocket, storeId: 'store-one' }
			)
		).not.toThrow()
		expect(firstSocket.closedWith).toHaveLength(1)
		expect(firstSocket.closedWith[0]).toEqual({
			code: TLSyncErrorCloseEventCode,
			reason: TLSyncErrorCloseEventReason.RATE_LIMITED,
		})

		connect(duplicateSocket)
		duplicateSocket.disconnect()
		const connectedDuplicate = await sessionService.createSession(201, 301)
		const connectedDuplicateSocket = new TestSocket()
		expect(() =>
			sessionService.connectSocket(
				sessionService.consumeSocketTicket(
					connectedDuplicate.roomId,
					readTicket(connectedDuplicate.socketUrl)
				),
				{ sessionId: 'one', socket: connectedDuplicateSocket, storeId: 'store-one' }
			)
		).not.toThrow()
		expect(duplicateSocket.closedWith).toHaveLength(2)
		expect(duplicateSocket.closedWith.at(-1)).toEqual({
			code: TLSyncErrorCloseEventCode,
			reason: TLSyncErrorCloseEventReason.RATE_LIMITED,
		})
		connect(connectedDuplicateSocket)

		const second = await sessionService.createSession(201, 301)
		expect(() =>
			sessionService.connectSocket(
				sessionService.consumeSocketTicket(second.roomId, readTicket(second.socketUrl)),
				{
					sessionId: 'one',
					socket: new TestSocket(),
					storeId: 'a-different-store-in-the-same-tab',
				}
			)
		).toThrow(expect.objectContaining({ code: 'ROOM_FULL' }))
		sessionService.close()
		expect(connectedDuplicateSocket.closedWith).toHaveLength(1)

		const roomService = createService({
			gateway: makeGateway({
				getVersion: async (playlistId, versionId) => versionFixture(playlistId, versionId),
			}),
			maxRooms: 1,
			maxSessionsPerRoom: 2,
		})
		const roomOne = await roomService.createSession(201, 301)
		roomService.connectSocket(
			roomService.consumeSocketTicket(roomOne.roomId, readTicket(roomOne.socketUrl)),
			{ sessionId: 'room-one', socket: new TestSocket(), storeId: 'room-one-store' }
		)
		const roomTwo = await roomService.createSession(201, 302)
		expect(() =>
			roomService.connectSocket(
				roomService.consumeSocketTicket(roomTwo.roomId, readTicket(roomTwo.socketUrl)),
				{ sessionId: 'room-two', socket: new TestSocket(), storeId: 'room-two-store' }
			)
		).toThrow(expect.objectContaining({ code: 'ROOM_FULL' }))
		expect(roomService.getActiveRoomCount()).toBe(1)
	})

	it('rejects malformed review-video props in the strict sync schema', () => {
		const validShape = {
			id: 'shape:custom-video',
			index: 'a1',
			isLocked: true,
			meta: {},
			opacity: 1,
			parentId: 'page:page',
			props: { attachmentId: 901, h: 1080, name: 'review.mp4', versionId: 301, w: 1920 },
			rotation: 0,
			type: 'review-video',
			typeName: 'shape',
			x: 0,
			y: 0,
		}

		expect(() => reviewSyncSchema.types.shape.validate(validShape)).not.toThrow()
		for (const invalidProps of [
			{ ...validShape.props, attachmentId: 0 },
			{ ...validShape.props, h: Number.POSITIVE_INFINITY },
			{ ...validShape.props, versionId: Number.MAX_SAFE_INTEGER + 1 },
			{ ...validShape.props, w: 1.5 },
			{ ...validShape.props, name: 'x'.repeat(256) },
		]) {
			expect(() =>
				reviewSyncSchema.types.shape.validate({ ...validShape, props: invalidProps })
			).toThrow()
		}
	})
})

describe('validateReviewClientMessage', () => {
	const presence = { color: '#FF6B6B', userId: 'user:shotgrid-human-41', userName: 'Alice' }
	const reservedIds = createReviewReservedSourceIds(301)

	it('accepts the bound presence identity and rejects identity spoofing', () => {
		expect(
			validateReviewClientMessage(
				{
					clientClock: 1,
					presence: [
						RecordOpType.Put,
						{ color: presence.color, userId: presence.userId, userName: presence.userName },
					],
					type: 'push',
				},
				presence,
				reservedIds
			)
		).toBeNull()
		expect(
			validateReviewClientMessage(
				{
					clientClock: 2,
					presence: [
						RecordOpType.Put,
						{ color: presence.color, userId: 'user:someone-else', userName: 'Mallory' },
					],
					type: 'push',
				},
				presence,
				reservedIds
			)
		).toBe(TLSyncErrorCloseEventReason.FORBIDDEN)
		expect(
			validateReviewClientMessage(
				{
					clientClock: 3,
					presence: [RecordOpType.Patch, { userName: [ValueOpType.Put, 'Mallory'] }],
					type: 'push',
				},
				presence,
				reservedIds
			)
		).toBe(TLSyncErrorCloseEventReason.FORBIDDEN)
	})

	it('rejects all reserved source record changes before the room applies them', () => {
		for (const id of Object.values(reservedIds)) {
			expect(
				validateReviewClientMessage(
					{ clientClock: 1, diff: { [id]: [RecordOpType.Remove] }, type: 'push' },
					presence,
					reservedIds
				)
			).toBe(TLSyncErrorCloseEventReason.FORBIDDEN)
		}
	})

	it('classifies malformed presence and document operations as invalid records', () => {
		expect(
			validateReviewClientMessage(
				{ clientClock: 1, presence: [RecordOpType.Put, { userId: presence.userId }], type: 'push' },
				presence,
				reservedIds
			)
		).toBe(TLSyncErrorCloseEventReason.INVALID_RECORD)
		expect(
			validateReviewClientMessage(
				{
					clientClock: 2,
					diff: {
						'shape:different-key': [RecordOpType.Put, { id: 'shape:record-id', typeName: 'shape' }],
					},
					type: 'push',
				},
				presence,
				reservedIds
			)
		).toBe(TLSyncErrorCloseEventReason.INVALID_RECORD)
	})

	it('persists only the authenticated public user attribution', () => {
		const userRecord = {
			color: presence.color,
			id: presence.userId,
			imageUrl: '',
			meta: {},
			name: presence.userName,
			typeName: 'user',
		}
		expect(
			validateReviewClientMessage(
				{
					clientClock: 1,
					diff: { [presence.userId]: [RecordOpType.Put, userRecord] },
					type: 'push',
				},
				presence,
				reservedIds
			)
		).toBeNull()
		expect(
			validateReviewClientMessage(
				{
					clientClock: 2,
					diff: {
						[presence.userId]: [
							RecordOpType.Patch,
							{
								color: [ValueOpType.Put, presence.color],
								imageUrl: [ValueOpType.Put, ''],
								name: [ValueOpType.Put, presence.userName],
							},
						],
					},
					type: 'push',
				},
				presence,
				reservedIds
			)
		).toBeNull()

		for (const diff of [
			{
				[presence.userId]: [
					RecordOpType.Put,
					{
						...userRecord,
						imageUrl: 'https://shotgrid.example/avatar?signature=secret',
					},
				],
			},
			{
				'user:shotgrid-human-999': [
					RecordOpType.Put,
					{ ...userRecord, id: 'user:shotgrid-human-999' },
				],
			},
			{
				[presence.userId]: [
					RecordOpType.Patch,
					{ imageUrl: [ValueOpType.Put, 'https://shotgrid.example/signed-avatar'] },
				],
			},
			{ [presence.userId]: [RecordOpType.Remove] },
		]) {
			expect(
				validateReviewClientMessage({ clientClock: 3, diff, type: 'push' }, presence, reservedIds)
			).toBe(TLSyncErrorCloseEventReason.FORBIDDEN)
		}
	})

	it('rejects every attempt to persist the local-only review-video source type', () => {
		const videoRecord = {
			id: 'shape:malicious-video',
			props: { attachmentId: 901, h: 1080, name: 'review.mp4', versionId: 301, w: 1920 },
			type: 'review-video',
			typeName: 'shape',
		}
		expect(
			validateReviewClientMessage(
				{
					clientClock: 1,
					diff: { [videoRecord.id]: [RecordOpType.Put, videoRecord] },
					type: 'push',
				},
				presence,
				reservedIds
			)
		).toBe(TLSyncErrorCloseEventReason.FORBIDDEN)
		expect(
			validateReviewClientMessage(
				{
					clientClock: 2,
					diff: {
						'shape:ordinary': [RecordOpType.Patch, { type: [ValueOpType.Put, 'review-video'] }],
					},
					type: 'push',
				},
				presence,
				reservedIds
			)
		).toBe(TLSyncErrorCloseEventReason.FORBIDDEN)
	})
})

interface ServiceOverrides {
	deploymentScope?: string
	gateway?: ReviewCollaborationGateway
	maxRooms?: number
	maxSessionsPerRoom?: number
	now?(): number
	storeDir?: string
}

function createService(overrides: ServiceOverrides = {}) {
	const service = new ReviewCollaborationService({
		deploymentScope: overrides.deploymentScope ?? 'production-primary',
		gateway: overrides.gateway ?? makeGateway(),
		maxRooms: overrides.maxRooms,
		maxSessionsPerRoom: overrides.maxSessionsPerRoom,
		now: overrides.now,
		secret: SECRET,
		storeDir: overrides.storeDir ?? createStoreDirectory(),
	})
	services.push(service)
	return service
}

function createStoreDirectory() {
	const directory = mkdtempSync(join(tmpdir(), 'shotgrid-review-collaboration-'))
	storeDirectories.push(directory)
	return directory
}

function makeGateway(
	overrides: {
		getVersion?: ReviewCollaborationGateway['getVersion']
		reviewer?: ReviewUser
		version?: ReviewVersion
	} = {}
): ReviewCollaborationGateway {
	return {
		getCurrentReviewer: vi.fn(async () => overrides.reviewer ?? humanReviewer),
		getVersion:
			overrides.getVersion ??
			vi.fn(
				async (playlistId, versionId) => overrides.version ?? versionFixture(playlistId, versionId)
			),
	}
}

function versionFixture(
	playlistId: number,
	versionId: number,
	media: ReviewVersion['media'] = {
		contentType: 'image/png',
		height: 1080,
		kind: 'image',
		thumbnailUrl: null,
		url: `/review/playlists/${playlistId}/versions/${versionId}/media/image`,
		width: 1920,
	}
): ReviewVersion {
	return {
		createdAt: '2026-07-21T00:00:00.000Z',
		createdBy: humanReviewer,
		description: null,
		entity: null,
		id: versionId,
		media,
		name: `Version ${versionId}`,
		playlistId,
		projectId: 101,
		statusCode: 'rev',
		submittedBy: humanReviewer,
		task: null,
	}
}

function readTicket(socketUrl: string) {
	return new URL(socketUrl, 'https://review.example').searchParams.get('ticket')!
}

class TestSocket implements WebSocketMinimal {
	readonly closedWith: Array<{ code?: number; reason?: string }> = []
	readonly sentMessages: unknown[] = []
	readyState = 1
	private readonly listeners = new Map<string, Set<(event: unknown) => void>>()

	addEventListener(type: 'message' | 'close' | 'error', listener: (event: unknown) => void) {
		let listeners = this.listeners.get(type)
		if (!listeners) {
			listeners = new Set()
			this.listeners.set(type, listeners)
		}
		listeners.add(listener)
	}

	removeEventListener(type: 'message' | 'close' | 'error', listener: (event: unknown) => void) {
		this.listeners.get(type)?.delete(listener)
	}

	send(data: string) {
		this.sentMessages.push(JSON.parse(data))
	}

	close(code?: number, reason?: string) {
		this.closedWith.push({ code, reason })
		this.readyState = 3
	}

	disconnect() {
		this.readyState = 3
		for (const listener of this.listeners.get('close') ?? []) {
			listener({})
		}
	}

	receive(message: unknown) {
		for (const listener of this.listeners.get('message') ?? []) {
			listener({ data: JSON.stringify(message) })
		}
	}
}

function connect(socket: TestSocket) {
	socket.receive({
		connectRequestId: 'connect-request',
		lastServerClock: 0,
		protocolVersion: getTlsyncProtocolVersion(),
		schema: reviewSyncSchema.serialize(),
		type: 'connect',
	})
}
