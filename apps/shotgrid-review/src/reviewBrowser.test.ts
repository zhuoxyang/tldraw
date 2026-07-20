import type {
	ReviewPlaylist,
	ReviewProject,
	ReviewVersion,
} from '@tldraw/shotgrid-review-contracts'
import { describe, expect, it, vi } from 'vitest'
import type { ReviewApiClient } from './reviewApiClient'
import {
	loadReviewBrowser,
	refreshReadyReviewBrowser,
	ReviewBrowserInvalidResponseError,
	ReviewBrowserNotFoundError,
	rootReviewSelection,
} from './reviewBrowser'

const projects: ReviewProject[] = [
	{ id: 101, name: 'Northstar', statusCode: 'act', thumbnailUrl: null },
	{ id: 102, name: 'Sundial', statusCode: 'act', thumbnailUrl: null },
]

const playlists: ReviewPlaylist[] = [
	{
		description: 'Lighting review',
		id: 201,
		name: 'Lighting dailies',
		projectId: 101,
		updatedAt: '2026-07-20T00:00:00Z',
		versionCount: 1,
	},
]

const version: ReviewVersion = {
	createdAt: '2026-07-20T00:00:00Z',
	createdBy: null,
	description: 'Lighting polish',
	entity: { id: 501, name: 'shot_010', type: 'Shot' },
	id: 301,
	media: null,
	name: 'shot_010_lgt_v014',
	playlistId: 201,
	projectId: 101,
	statusCode: 'rev',
	submittedBy: null,
	task: { id: 601, name: 'Lighting' },
}

function makeApi(overrides: Partial<ReviewApiClient> = {}): ReviewApiClient {
	return {
		getDecisionContext: vi.fn(),
		getCurrentReviewer: vi.fn(async () => ({
			avatarUrl: null,
			id: 7,
			kind: 'human' as const,
			login: 'reviewer',
			name: 'Reviewer',
		})),
		getHealth: vi.fn(async () => ({ mode: 'mock' as const, status: 'ok' as const })),
		getNoteOptions: vi.fn(),
		getVersion: vi.fn(async () => ({ ...version, media: { ...imageMedia } })),
		listPlaylists: vi.fn(async (projectId) =>
			projectId === 101 ? playlists.map((playlist) => ({ ...playlist })) : []
		),
		listProjects: vi.fn(async () => projects.map((project) => ({ ...project }))),
		listVersions: vi.fn(async (playlistId) => (playlistId === 201 ? [{ ...version }] : [])),
		publishReview: vi.fn(),
		updateDecision: vi.fn(),
		...overrides,
	}
}

const imageMedia = {
	contentType: 'image/svg+xml',
	height: 1080,
	kind: 'image' as const,
	thumbnailUrl: null,
	url: '/mock-media/northstar-lighting.svg',
	width: 1920,
}

describe('loadReviewBrowser', () => {
	it('selects the first available hierarchy and refreshes the selected version', async () => {
		const api = makeApi()
		const result = await loadReviewBrowser(api, rootReviewSelection)

		expect(result).toMatchObject({
			playlist: { id: 201 },
			project: { id: 101 },
			status: 'ready',
			version: { id: 301, media: imageMedia },
		})
		expect(api.getVersion).toHaveBeenCalledWith(201, 301, undefined)
	})

	it('resolves a legacy route from the refreshed Version project relationship', async () => {
		const api = makeApi({
			listPlaylists: vi.fn(async () => [{ ...playlists[0], id: 202, projectId: 102 }]),
			listVersions: vi.fn(async () => [{ ...version, id: 302, playlistId: 202, projectId: 102 }]),
			getVersion: vi.fn(async () => ({
				...version,
				id: 302,
				playlistId: 202,
				projectId: 102,
			})),
		})

		const result = await loadReviewBrowser(api, {
			playlistId: 202,
			projectId: null,
			versionId: 302,
		})

		expect(result).toMatchObject({
			playlist: { id: 202 },
			project: { id: 102 },
			status: 'ready',
			version: { id: 302 },
		})
		expect(api.listPlaylists).toHaveBeenCalledOnce()
		expect(api.listPlaylists).toHaveBeenCalledWith(102, undefined)
		expect(api.getVersion).toHaveBeenCalledOnce()
	})

	it.each([
		{
			expectedScope: 'projects',
			overrides: { listProjects: vi.fn(async () => []) },
		},
		{
			expectedScope: 'playlists',
			overrides: { listPlaylists: vi.fn(async () => []) },
		},
		{
			expectedScope: 'versions',
			overrides: { listVersions: vi.fn(async () => []) },
		},
	])('returns an explicit $expectedScope empty state', async ({ expectedScope, overrides }) => {
		const result = await loadReviewBrowser(makeApi(overrides), rootReviewSelection)
		expect(result).toMatchObject({ scope: expectedScope, status: 'empty' })
	})

	it('rejects an explicit deep link that is no longer available', async () => {
		await expect(
			loadReviewBrowser(makeApi(), { playlistId: 201, projectId: 101, versionId: 999 })
		).rejects.toBeInstanceOf(ReviewBrowserNotFoundError)
	})

	it('rejects inconsistent parent relationships from the API', async () => {
		const api = makeApi({
			listVersions: vi.fn(async () => [{ ...version, projectId: 102 }]),
		})

		await expect(loadReviewBrowser(api, rootReviewSelection)).rejects.toBeInstanceOf(
			ReviewBrowserInvalidResponseError
		)
	})

	it('rejects a refreshed version whose id differs from the selected list item', async () => {
		const api = makeApi({
			getVersion: vi.fn(async () => ({ ...version, id: 302 })),
		})

		await expect(loadReviewBrowser(api, rootReviewSelection)).rejects.toBeInstanceOf(
			ReviewBrowserInvalidResponseError
		)
	})

	it('passes one abort signal through the complete request chain', async () => {
		const api = makeApi()
		const controller = new AbortController()
		await loadReviewBrowser(api, rootReviewSelection, controller.signal)

		expect(api.getHealth).toHaveBeenCalledWith(controller.signal)
		expect(api.getCurrentReviewer).toHaveBeenCalledWith(controller.signal)
		expect(api.listProjects).toHaveBeenCalledWith(controller.signal)
		expect(api.listPlaylists).toHaveBeenCalledWith(101, controller.signal)
		expect(api.listVersions).toHaveBeenCalledWith(201, controller.signal)
		expect(api.getVersion).toHaveBeenCalledWith(201, 301, controller.signal)
	})
})

describe('refreshReadyReviewBrowser', () => {
	it('refreshes only the active Version and preserves its hierarchy', async () => {
		const api = makeApi()
		const loaded = await loadReviewBrowser(api, rootReviewSelection)
		if (loaded.status !== 'ready') throw new Error('Expected a ready review browser')
		vi.mocked(api.getVersion).mockClear()

		const refreshed = await refreshReadyReviewBrowser(api, loaded)

		expect(refreshed.version).toMatchObject({ id: 301, media: imageMedia })
		expect(api.getVersion).toHaveBeenCalledOnce()
		expect(api.listProjects).toHaveBeenCalledOnce()
		expect(api.listPlaylists).toHaveBeenCalledOnce()
		expect(api.listVersions).toHaveBeenCalledOnce()
	})

	it('rejects a refresh response for a different Version id', async () => {
		const api = makeApi({
			getVersion: vi.fn(async () => ({ ...version, id: 302 })),
		})
		const ready = {
			health: { mode: 'mock' as const, status: 'ok' as const },
			playlist: playlists[0],
			playlists,
			project: projects[0],
			projects,
			reviewer: await api.getCurrentReviewer(),
			status: 'ready' as const,
			version,
			versions: [version],
		}

		await expect(refreshReadyReviewBrowser(api, ready)).rejects.toBeInstanceOf(
			ReviewBrowserInvalidResponseError
		)
	})
})
