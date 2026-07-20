import { mkdtemp, rm } from 'node:fs/promises'
import { request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReviewCollaborationSession } from '@tldraw/shotgrid-review-contracts'
import { afterEach, describe, expect, test, vi } from 'vitest'
import WebSocket from 'ws'
import { ReviewCollaborationService } from '../collaboration/ReviewCollaborationService'
import { MockReviewGateway } from '../gateway/MockReviewGateway'
import { createReviewApiServer } from './createReviewApiServer'

const ALLOWED_ORIGIN = 'http://127.0.0.1:5430'
const COLLABORATION_SECRET = 'collaboration-http-test-secret-32-characters'
const TEMP_DIRECTORY_PREFIX = join(tmpdir(), 'tldraw-review-collaboration-http-')

const resources: {
	servers: Server[]
	services: ReviewCollaborationService[]
	sockets: Set<WebSocket>
	temporaryDirectories: string[]
} = {
	servers: [],
	services: [],
	sockets: new Set(),
	temporaryDirectories: [],
}

afterEach(async () => {
	for (const socket of resources.sockets) {
		if (socket.readyState !== WebSocket.CLOSED) socket.terminate()
	}
	resources.sockets.clear()

	await Promise.all(resources.servers.splice(0).map(closeServer))
	for (const service of resources.services.splice(0)) service.close()
	await Promise.all(
		resources.temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { force: true, recursive: true }))
	)
})

describe('review collaboration HTTP and WebSocket transport', () => {
	test('creates a session only for a Version in the requested Playlist and requires an empty body', async () => {
		const { baseUrl, gateway } = await startHarness()
		const getVersion = vi.spyOn(gateway, 'getVersion')

		const created = await fetch(
			`${baseUrl}/api/review/playlists/201/versions/301/collaboration-session`,
			{ method: 'POST' }
		)
		expect(created.status).toBe(201)
		expect(created.headers.get('cache-control')).toBe('no-store')
		expect(created.headers.get('content-type')).toBe('application/json; charset=utf-8')
		const session = (await created.json()) as { data: ReviewCollaborationSession }
		expect(session.data).toEqual({
			permission: 'editor',
			roomId: expect.stringMatching(/^r1_[A-Za-z0-9_-]{43}$/),
			socketUrl: expect.stringMatching(
				/^\/api\/review\/sync\/r1_[A-Za-z0-9_-]{43}\?ticket=[A-Za-z0-9_-]{43}$/
			),
			ticketExpiresAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
		})
		expect(getVersion).toHaveBeenCalledWith(201, 301)

		const nonEmpty = await fetch(
			`${baseUrl}/api/review/playlists/201/versions/301/collaboration-session`,
			{
				body: '{}',
				headers: { 'Content-Type': 'application/json' },
				method: 'POST',
			}
		)
		expect(nonEmpty.status).toBe(400)
		expect(await nonEmpty.json()).toMatchObject({ error: { code: 'INVALID_REQUEST' } })
		expect(getVersion).toHaveBeenCalledTimes(1)

		const chunked = await postChunkedBody(
			`${baseUrl}/api/review/playlists/201/versions/301/collaboration-session`
		)
		expect(chunked.status).toBe(400)
		expect(chunked.body).toMatchObject({ error: { code: 'INVALID_REQUEST' } })
		expect(getVersion).toHaveBeenCalledTimes(1)

		const mismatched = await fetch(
			`${baseUrl}/api/review/playlists/202/versions/301/collaboration-session`,
			{ method: 'POST' }
		)
		expect(mismatched.status).toBe(404)
		expect(await mismatched.json()).toMatchObject({ error: { code: 'NOT_FOUND' } })
		expect(getVersion).toHaveBeenLastCalledWith(202, 301)
	})

	test('upgrades an authorized same-origin WebSocket connection', async () => {
		const { baseUrl, service } = await startHarness()
		const session = await createSession(baseUrl)
		const socket = await openWebSocket(createSocketUrl(baseUrl, session))

		expect(socket.readyState).toBe(WebSocket.OPEN)
		expect(service.getActiveRoomCount()).toBe(1)

		await closeWebSocket(socket)
	})

	test('rejects the wrong Origin, extra or repeated query parameters, and a replayed ticket', async () => {
		const { baseUrl } = await startHarness()

		const wrongOriginSession = await createSession(baseUrl)
		expect(
			await readRejectedUpgradeStatus(
				createSocketUrl(baseUrl, wrongOriginSession),
				'http://untrusted.example.test'
			)
		).toBe(403)

		const extraQuerySession = await createSession(baseUrl)
		const extraQueryUrl = createSocketUrl(baseUrl, extraQuerySession)
		extraQueryUrl.searchParams.set('unexpected', 'value')
		expect(await readRejectedUpgradeStatus(extraQueryUrl)).toBe(404)

		const repeatedQuerySession = await createSession(baseUrl)
		const repeatedQueryUrl = createSocketUrl(baseUrl, repeatedQuerySession)
		repeatedQueryUrl.searchParams.append('ticket', repeatedQueryUrl.searchParams.get('ticket')!)
		expect(await readRejectedUpgradeStatus(repeatedQueryUrl)).toBe(404)

		const replayedSession = await createSession(baseUrl)
		const replayedUrl = createSocketUrl(baseUrl, replayedSession)
		const socket = await openWebSocket(replayedUrl)
		await closeWebSocket(socket)
		expect(await readRejectedUpgradeStatus(replayedUrl)).toBe(401)
	})

	test('closing the HTTP server closes the collaboration service and active sockets', async () => {
		const { baseUrl, server, service } = await startHarness()
		const closeService = vi.spyOn(service, 'close')
		const socket = await openWebSocket(createSocketUrl(baseUrl, await createSession(baseUrl)))
		expect(service.getActiveRoomCount()).toBe(1)

		const shutdown = Promise.all([closeServer(server), waitForWebSocketClose(socket)])
		await expect(withTimeout(shutdown, 1_000, 'server shutdown')).resolves.toBeUndefined()
		resources.servers.splice(resources.servers.indexOf(server), 1)

		expect(closeService).toHaveBeenCalledOnce()
		expect(service.getActiveRoomCount()).toBe(0)
		await expect(service.createSession(201, 301)).rejects.toMatchObject({
			code: 'CONFIGURATION_ERROR',
		})
	})
})

async function startHarness() {
	const storeDir = await mkdtemp(TEMP_DIRECTORY_PREFIX)
	resources.temporaryDirectories.push(storeDir)
	const gateway = new MockReviewGateway()
	const service = new ReviewCollaborationService({
		deploymentScope: 'test:review-collaboration-http',
		gateway,
		secret: COLLABORATION_SECRET,
		storeDir,
	})
	resources.services.push(service)
	const server = createReviewApiServer({
		allowedOrigin: ALLOWED_ORIGIN,
		collaboration: service,
		gateway,
		logger: { error: vi.fn() },
		mode: 'mock',
		requestId: () => 'collaboration-http-test-request-id',
	})
	resources.servers.push(server)
	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
	const { port } = server.address() as AddressInfo
	return { baseUrl: `http://127.0.0.1:${port}`, gateway, server, service }
}

async function createSession(baseUrl: string) {
	const response = await fetch(
		`${baseUrl}/api/review/playlists/201/versions/301/collaboration-session`,
		{ method: 'POST' }
	)
	expect(response.status).toBe(201)
	return ((await response.json()) as { data: ReviewCollaborationSession }).data
}

function createSocketUrl(baseUrl: string, session: ReviewCollaborationSession) {
	const url = new URL(session.socketUrl, baseUrl)
	url.protocol = 'ws:'
	url.searchParams.set('sessionId', 'test-browser-session')
	url.searchParams.set('storeId', 'test-browser-store')
	return url
}

async function openWebSocket(url: URL) {
	const socket = new WebSocket(url, { origin: ALLOWED_ORIGIN })
	resources.sockets.add(socket)
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(
			() => reject(new Error('Timed out opening the test WebSocket')),
			5_000
		)
		socket.once('open', () => {
			clearTimeout(timeout)
			resolve()
		})
		socket.once('error', (error) => {
			clearTimeout(timeout)
			reject(error)
		})
	})
	return socket
}

async function readRejectedUpgradeStatus(url: URL, origin = ALLOWED_ORIGIN) {
	const socket = new WebSocket(url, { origin })
	resources.sockets.add(socket)
	return await new Promise<number>((resolve, reject) => {
		const timeout = setTimeout(
			() => reject(new Error('Timed out waiting for the WebSocket upgrade rejection')),
			5_000
		)
		socket.once('unexpected-response', (_request, response) => {
			clearTimeout(timeout)
			response.resume()
			resolve(response.statusCode ?? 0)
		})
		socket.once('open', () => {
			clearTimeout(timeout)
			reject(new Error('The WebSocket upgrade unexpectedly succeeded'))
		})
		socket.once('error', () => {
			// `unexpected-response` is the assertion channel for rejected handshakes.
		})
	})
}

async function closeWebSocket(socket: WebSocket) {
	if (socket.readyState === WebSocket.CLOSED) return
	const closed = waitForWebSocketClose(socket)
	socket.close()
	await closed
	resources.sockets.delete(socket)
}

async function waitForWebSocketClose(socket: WebSocket) {
	if (socket.readyState === WebSocket.CLOSED) return
	await new Promise<void>((resolve, reject) => {
		const timeout = setTimeout(
			() => reject(new Error('Timed out closing the test WebSocket')),
			5_000
		)
		socket.once('close', () => {
			clearTimeout(timeout)
			resolve()
		})
	})
}

async function closeServer(server: Server) {
	if (!server.listening) return
	await new Promise<void>((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()))
	})
}

async function withTimeout(promise: Promise<unknown>, timeoutMs: number, label: string) {
	let timeout: ReturnType<typeof setTimeout> | undefined
	try {
		return await Promise.race([
			promise.then(() => undefined),
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs)
			}),
		])
	} finally {
		if (timeout) clearTimeout(timeout)
	}
}

async function postChunkedBody(url: string) {
	return await new Promise<{ body: unknown; status: number }>((resolve, reject) => {
		const clientRequest = request(
			url,
			{ headers: { 'Transfer-Encoding': 'chunked' }, method: 'POST' },
			(response) => {
				const chunks: Buffer[] = []
				response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
				response.once('end', () => {
					try {
						resolve({
							body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
							status: response.statusCode ?? 0,
						})
					} catch (error) {
						reject(error)
					}
				})
			}
		)
		clientRequest.once('error', reject)
		clientRequest.write('{}')
		clientRequest.end()
	})
}
