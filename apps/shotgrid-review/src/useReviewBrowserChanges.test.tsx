// @vitest-environment jsdom

import type {
	ReviewChangeEvent,
	ReviewHealth,
	ReviewPlaylist,
	ReviewProject,
	ReviewUser,
	ReviewVersion,
} from '@tldraw/shotgrid-review-contracts'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReviewApiClient, ReviewChangeObserver } from './reviewApiClient'
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
const changeEvent: ReviewChangeEvent = {
	attributeName: 'sg_status_list',
	entity: { id: 301, type: 'Version' },
	eventLogEntryId: 545175,
	observedAt: '2026-07-22T08:30:00.000Z',
	operation: 'update',
	projectId: 101,
	sequence: 42,
	sourceEventId: '11777.3065.0',
}

let root: Root | undefined

afterEach(() => {
	if (root) act(() => root?.unmount())
	root = undefined
	vi.useRealTimers()
	vi.restoreAllMocks()
})

describe('useReviewBrowser live changes', () => {
	it('debounces bursts and silently reloads the complete current route', async () => {
		vi.useFakeTimers()
		window.history.replaceState({}, '', '/review/101/201/301')
		let observer: ReviewChangeObserver | undefined
		let authoritativeVersion = version
		const unsubscribe = vi.fn()
		const api = createApi({
			getVersion: vi.fn(async () => authoritativeVersion),
			listVersions: vi.fn(async () => [authoritativeVersion]),
			watchChanges: vi.fn((nextObserver) => {
				observer = nextObserver
				nextObserver.onStatusChange('connecting')
				return unsubscribe
			}),
		})
		const container = document.createElement('div')
		root = createRoot(container)
		let browser: ReturnType<typeof useReviewBrowser> | undefined

		function Harness() {
			browser = useReviewBrowser(api)
			return null
		}

		await act(async () => {
			root?.render(<Harness />)
			await settlePromises()
		})
		expect(browser?.state.status).toBe('ready')
		expect(browser?.externalChangeRevision).toBe(0)
		expect(api.listProjects).toHaveBeenCalledTimes(1)

		act(() => observer?.onStatusChange('live'))
		expect(browser?.changeStreamStatus).toBe('live')
		authoritativeVersion = { ...version, statusCode: 'apr' }
		act(() => {
			observer?.onChange(changeEvent)
			observer?.onChange({ ...changeEvent, sequence: 43 })
			observer?.onChange({ ...changeEvent, sequence: 44 })
			vi.advanceTimersByTime(249)
		})
		expect(api.listProjects).toHaveBeenCalledTimes(1)
		expect(browser?.state.status).toBe('ready')

		await act(async () => {
			vi.advanceTimersByTime(1)
			await settlePromises()
		})

		expect(api.getHealth).toHaveBeenCalledTimes(2)
		expect(api.getCurrentReviewer).toHaveBeenCalledTimes(2)
		expect(api.listProjects).toHaveBeenCalledTimes(2)
		expect(api.listPlaylists).toHaveBeenCalledTimes(2)
		expect(api.listVersions).toHaveBeenCalledTimes(2)
		expect(api.getVersion).toHaveBeenCalledTimes(2)
		expect(browser?.state).toMatchObject({
			status: 'ready',
			version: { id: 301, statusCode: 'apr' },
		})
		expect(browser?.externalChangeRevision).toBe(1)
		expect(browser?.navigating).toBe(false)
		expect(browser?.refreshing).toBe(false)
	})

	it('closes the feed and cancels a pending burst on unmount', async () => {
		vi.useFakeTimers()
		window.history.replaceState({}, '', '/review/101/201/301')
		let observer: ReviewChangeObserver | undefined
		const unsubscribe = vi.fn()
		const api = createApi({
			watchChanges: vi.fn((nextObserver) => {
				observer = nextObserver
				return unsubscribe
			}),
		})
		root = createRoot(document.createElement('div'))

		function Harness() {
			useReviewBrowser(api)
			return null
		}

		await act(async () => {
			root?.render(<Harness />)
			await settlePromises()
		})
		act(() => observer?.onChange(changeEvent))
		act(() => root?.unmount())
		root = undefined
		await act(async () => {
			vi.advanceTimersByTime(250)
			await settlePromises()
		})

		expect(unsubscribe).toHaveBeenCalledOnce()
		expect(api.listProjects).toHaveBeenCalledTimes(1)
	})
})

function createApi(overrides: Partial<ReviewApiClient> = {}): ReviewApiClient {
	return {
		createCollaborationSession: vi.fn(),
		getCurrentReviewer: vi.fn(async () => reviewer),
		getDecisionContext: vi.fn(),
		getHealth: vi.fn(async () => health),
		getNoteOptions: vi.fn(),
		getVersion: vi.fn(async () => version),
		listPlaylists: vi.fn(async () => [playlist]),
		listProjects: vi.fn(async () => [project]),
		listVersions: vi.fn(async () => [version]),
		publishReview: vi.fn(),
		updateDecision: vi.fn(),
		watchChanges: vi.fn(() => () => {}),
		...overrides,
	}
}

async function settlePromises() {
	for (let index = 0; index < 10; index++) await Promise.resolve()
}
