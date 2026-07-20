// @vitest-environment jsdom

import type {
	ReviewHealth,
	ReviewPlaylist,
	ReviewProject,
	ReviewUser,
	ReviewVersion,
} from '@tldraw/shotgrid-review-contracts'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReviewApiClient } from './reviewApiClient'
import { useReviewBrowser } from './useReviewBrowser'

const health: ReviewHealth = { mode: 'mock', status: 'ok' }
const reviewer: ReviewUser = {
	avatarUrl: null,
	id: 7,
	kind: 'human',
	login: 'reviewer',
	name: 'Reviewer',
}
const project: ReviewProject = {
	id: 101,
	name: 'Northstar',
	statusCode: 'act',
	thumbnailUrl: null,
}
const playlist: ReviewPlaylist = {
	description: null,
	id: 201,
	name: 'Dailies',
	projectId: 101,
	updatedAt: '2026-07-20T00:00:00Z',
	versionCount: 1,
}
const version: ReviewVersion = {
	createdAt: '2026-07-20T00:00:00Z',
	createdBy: null,
	description: null,
	entity: null,
	id: 301,
	media: null,
	name: 'shot_010_v001',
	playlistId: 201,
	projectId: 101,
	statusCode: 'rev',
	submittedBy: null,
	task: null,
}

function createApi(overrides: Partial<ReviewApiClient> = {}): ReviewApiClient {
	return {
		createCollaborationSession: vi.fn(),
		getDecisionContext: vi.fn(),
		getCurrentReviewer: vi.fn(async () => reviewer),
		getHealth: vi.fn(async () => health),
		getNoteOptions: vi.fn(),
		getVersion: vi.fn(async () => version),
		listPlaylists: vi.fn(async () => [playlist]),
		listProjects: vi.fn(async () => [project]),
		listVersions: vi.fn(async () => [version]),
		publishReview: vi.fn(),
		updateDecision: vi.fn(),
		...overrides,
	}
}

let cleanup: (() => void) | undefined

afterEach(() => {
	cleanup?.()
	cleanup = undefined
	vi.restoreAllMocks()
})

describe('useReviewBrowser history', () => {
	it('does not push another history entry when the active version is selected', async () => {
		window.history.replaceState({}, '', '/review/101/201/301')
		const pushState = vi.spyOn(window.history, 'pushState')
		const container = document.createElement('div')
		const root = createRoot(container)
		const api = createApi()
		let browser: ReturnType<typeof useReviewBrowser> | undefined

		function Harness() {
			browser = useReviewBrowser(api)
			return null
		}

		await act(async () => {
			root.render(<Harness />)
		})
		cleanup = () => act(() => root.unmount())
		expect(browser?.state.status).toBe('ready')

		await act(async () => {
			browser?.selectVersion(301)
		})

		expect(pushState).not.toHaveBeenCalled()
	})

	it('keeps an empty project selection and its URL in sync', async () => {
		window.history.replaceState({}, '', '/review/101/201/301')
		const emptyProject = { ...project, id: 102, name: 'Sundial' }
		const api = createApi({
			listPlaylists: vi.fn(async (projectId) => (projectId === 101 ? [playlist] : [])),
			listProjects: vi.fn(async () => [project, emptyProject]),
		})
		const container = document.createElement('div')
		const root = createRoot(container)
		let browser: ReturnType<typeof useReviewBrowser> | undefined

		function Harness() {
			browser = useReviewBrowser(api)
			return null
		}

		await act(async () => {
			root.render(<Harness />)
		})
		cleanup = () => act(() => root.unmount())

		await act(async () => {
			browser?.selectProject(102)
		})

		expect(browser?.state).toMatchObject({
			project: { id: 102 },
			scope: 'playlists',
			status: 'empty',
		})
		expect(window.location.pathname).toBe('/review/projects/102')
	})

	it('coalesces rapid navigation while the first selection is in flight', async () => {
		window.history.replaceState({}, '', '/review/101/201/301')
		const secondProject = { ...project, id: 102, name: 'Sundial' }
		const thirdProject = { ...project, id: 103, name: 'Aurora' }
		const listPlaylists = vi.fn(async (projectId: number) => (projectId === 101 ? [playlist] : []))
		const api = createApi({
			listPlaylists,
			listProjects: vi.fn(async () => [project, secondProject, thirdProject]),
		})
		const container = document.createElement('div')
		const root = createRoot(container)
		let browser: ReturnType<typeof useReviewBrowser> | undefined

		function Harness() {
			browser = useReviewBrowser(api)
			return null
		}

		await act(async () => {
			root.render(<Harness />)
		})
		cleanup = () => act(() => root.unmount())
		listPlaylists.mockClear()

		await act(async () => {
			browser?.selectProject(102)
			browser?.selectProject(103)
		})

		expect(listPlaylists).toHaveBeenCalledOnce()
		expect(listPlaylists).toHaveBeenCalledWith(102, expect.any(AbortSignal))
		expect(window.location.pathname).toBe('/review/projects/102')
	})
})
