// @vitest-environment jsdom

import type {
	ReviewCollaborationSession,
	ReviewImageMedia,
	ReviewUser,
} from '@tldraw/shotgrid-review-contracts'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const collaborationMocks = vi.hoisted(() => ({
	options: undefined as undefined | Record<string, unknown>,
	state: { status: 'loading' } as Record<string, unknown>,
}))

vi.mock('@tldraw/sync', async (importOriginal) => {
	const original = await importOriginal<typeof import('@tldraw/sync')>()
	return {
		...original,
		useSync: (options: Record<string, unknown>) => {
			collaborationMocks.options = options
			return collaborationMocks.state
		},
	}
})

import { getReviewImageIds } from './reviewAnnotationEditor'
import type { ReviewApiClient } from './reviewApiClient'
import { reviewVideoShapeUtils } from './reviewVideoShape'

;(
	globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true
import {
	ReviewCollaborationCanvas,
	createReviewCollaborationAssetStore,
	resolveReviewCollaborationSocketUrl,
} from './ReviewCollaborationCanvas'

const reviewer: ReviewUser = {
	avatarUrl: 'https://shotgrid.example.test/avatar.jpg?signature=secret-avatar-token',
	id: 7,
	kind: 'human',
	login: 'reviewer@example.test',
	name: 'Reviewer',
}
const media: ReviewImageMedia = {
	contentType: 'image/png',
	height: 1080,
	kind: 'image',
	thumbnailUrl: '/api/review/media.png',
	url: '/api/review/media.png',
	width: 1920,
}
const session: ReviewCollaborationSession = {
	permission: 'editor',
	roomId: `r1_${'a'.repeat(43)}`,
	socketUrl: `/api/review/sync/r1_${'a'.repeat(43)}?ticket=${'b'.repeat(43)}`,
	ticketExpiresAt: '2026-07-21T00:01:00.000Z',
}

afterEach(() => {
	collaborationMocks.options = undefined
	collaborationMocks.state = { status: 'loading' }
	document.body.replaceChildren()
})

describe('ReviewCollaborationCanvas', () => {
	it('requests a fresh scoped ticket for every socket connection attempt', async () => {
		const api = {
			createCollaborationSession: vi.fn(async () => session),
		} as unknown as ReviewApiClient
		const container = document.createElement('div')
		const root = createRoot(container)

		await act(async () => {
			root.render(
				<ReviewCollaborationCanvas
					api={api}
					apiBaseUrl="/api"
					media={media}
					playlistId={201}
					reviewer={reviewer}
					versionId={301}
				>
					{() => <span>ready</span>}
				</ReviewCollaborationCanvas>
			)
		})

		const uri = collaborationMocks.options?.uri as () => Promise<string>
		const users = collaborationMocks.options?.users as {
			currentUser: { get(): { imageUrl: string } }
		}
		expect(collaborationMocks.options?.shapeUtils).toEqual(
			expect.arrayContaining([...reviewVideoShapeUtils])
		)
		expect(users.currentUser.get().imageUrl).toBe('')
		expect(JSON.stringify(users.currentUser.get())).not.toContain('secret-avatar-token')
		await expect(uri()).resolves.toBe(
			`ws://localhost:3000/api/review/sync/${session.roomId}?ticket=${'b'.repeat(43)}`
		)
		await expect(uri()).resolves.toContain(session.roomId)
		expect(api.createCollaborationSession).toHaveBeenCalledTimes(2)
		expect(api.createCollaborationSession).toHaveBeenNthCalledWith(1, 201, 301)

		await act(async () => root.unmount())
	})

	it('surfaces a failed ticket request while the connection manager retries', async () => {
		const api = {
			createCollaborationSession: vi
				.fn<ReviewApiClient['createCollaborationSession']>()
				.mockRejectedValueOnce(new Error('gateway unavailable'))
				.mockResolvedValue(session),
		} as unknown as ReviewApiClient
		const container = document.createElement('div')
		const root = createRoot(container)

		await act(async () => {
			root.render(
				<ReviewCollaborationCanvas
					api={api}
					apiBaseUrl="/api"
					media={media}
					playlistId={201}
					reviewer={reviewer}
					versionId={301}
				>
					{() => <span>ready</span>}
				</ReviewCollaborationCanvas>
			)
		})

		const uri = collaborationMocks.options?.uri as () => Promise<string>
		await act(async () => {
			await expect(uri()).rejects.toThrow('gateway unavailable')
		})
		expect(container.textContent).toContain('Could not authorize collaboration')

		await act(async () => {
			await expect(uri()).resolves.toContain(session.roomId)
		})
		expect(container.textContent).toContain('Joining review room')

		await act(async () => root.unmount())
	})

	it('rejects a reconnect that resolves to another room and resets on a new Version scope', async () => {
		const nextSession: ReviewCollaborationSession = {
			...session,
			roomId: `r1_${'c'.repeat(43)}`,
			socketUrl: `/api/review/sync/r1_${'c'.repeat(43)}?ticket=${'d'.repeat(43)}`,
		}
		const api = {
			createCollaborationSession: vi
				.fn<ReviewApiClient['createCollaborationSession']>()
				.mockResolvedValueOnce(session)
				.mockResolvedValueOnce(nextSession)
				.mockResolvedValueOnce(nextSession),
		} as unknown as ReviewApiClient
		const container = document.createElement('div')
		const root = createRoot(container)
		const renderVersion = (versionId: number) =>
			root.render(
				<ReviewCollaborationCanvas
					api={api}
					apiBaseUrl="/api"
					media={media}
					playlistId={201}
					reviewer={reviewer}
					versionId={versionId}
				>
					{() => <span>ready</span>}
				</ReviewCollaborationCanvas>
			)

		await act(async () => renderVersion(301))
		const firstUri = collaborationMocks.options?.uri as () => Promise<string>
		await act(async () => {
			await expect(firstUri()).resolves.toContain(session.roomId)
		})
		await act(async () => {
			await expect(firstUri()).rejects.toThrow(/room identity changed/i)
		})
		expect(container.textContent).toContain('Review media changed')

		await act(async () => renderVersion(302))
		const nextUri = collaborationMocks.options?.uri as () => Promise<string>
		await act(async () => {
			await expect(nextUri()).resolves.toContain(nextSession.roomId)
		})
		expect(api.createCollaborationSession).toHaveBeenLastCalledWith(201, 302)

		await act(async () => root.unmount())
	})
})

describe('review collaboration socket URLs', () => {
	it('uses the configured API origin and upgrades HTTP protocols', () => {
		expect(
			resolveReviewCollaborationSocketUrl(
				session.socketUrl,
				'https://review-api.example.test/api',
				'https://review-app.example.test/'
			)
		).toBe(`wss://review-api.example.test${session.socketUrl}`)
	})

	it.each([
		['https://user:password@example.test/api', session.socketUrl],
		['https://example.test/api', 'https://attacker.example/sync'],
		['https://example.test/api', '/api/other'],
	])('rejects an unsafe API or socket URL', (apiBaseUrl, socketUrl) => {
		expect(() =>
			resolveReviewCollaborationSocketUrl(socketUrl, apiBaseUrl, 'https://app.example.test/')
		).toThrow(/cannot be used|invalid collaboration/i)
	})
})

describe('review collaboration assets', () => {
	it('allows only the canonical local review image asset', async () => {
		const assets = createReviewCollaborationAssetStore(media, 301)
		const sourceId = getReviewImageIds(301).assetId
		const source = {
			id: sourceId,
			meta: {},
			props: {
				h: 1080,
				isAnimated: false,
				mimeType: 'image/png',
				name: 'source',
				src: media.url,
				w: 1920,
			},
			type: 'image',
			typeName: 'asset',
		} as const

		await expect(assets.upload(source, new File(['image'], 'source.png'))).resolves.toEqual({
			src: media.url,
		})
		expect(assets.resolve!(source, {} as never)).toBe(media.url)
		await expect(
			assets.upload({ ...source, id: getReviewImageIds(302).assetId }, new File([], 'other.png'))
		).rejects.toThrow(/do not accept uploaded assets/i)
	})
})
