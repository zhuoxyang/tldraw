// @vitest-environment jsdom

import type { ReviewDecisionContext, ReviewDecisionResult } from '@tldraw/shotgrid-review-contracts'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReviewApiClientError, type ReviewApiClient } from './reviewApiClient'
import { ReviewDecisionPanel, reviewDecisionAccessForReviewerKind } from './ReviewDecisionPanel'

;(
	globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const reviewer = {
	avatarUrl: null,
	id: 7,
	kind: 'human' as const,
	login: 'reviewer',
	name: 'Review lead',
}
const context: ReviewDecisionContext = {
	currentStatusCode: 'rev',
	decisions: [
		{ key: 'approve', label: 'Approved for final', statusCode: 'apr' },
		{ key: 'changes', label: 'Needs changes', statusCode: 'chg' },
	],
	history: [
		{
			decidedAt: '2026-07-20T23:00:00Z',
			decisionKey: null,
			id: 601,
			previousStatusCode: null,
			resultingStatusCode: 'rev',
			reviewer: null,
		},
		{
			decidedAt: '2026-07-21T00:00:00Z',
			decisionKey: 'changes',
			id: 602,
			previousStatusCode: 'apr',
			resultingStatusCode: 'chg',
			reviewer,
		},
	],
	historyTruncated: false,
	playlistId: 201,
	versionId: 301,
}
const decisionResult: ReviewDecisionResult = {
	changed: true,
	decisionKey: 'approve',
	playlistId: 201,
	previousStatusCode: 'rev',
	reviewer,
	statusCode: 'apr',
	updatedAt: '2026-07-21T01:00:00Z',
	versionId: 301,
}
const approvedContext: ReviewDecisionContext = {
	...context,
	currentStatusCode: 'apr',
	history: [
		{
			decidedAt: decisionResult.updatedAt!,
			decisionKey: 'approve',
			id: 603,
			previousStatusCode: 'rev',
			resultingStatusCode: 'apr',
			reviewer,
		},
		...context.history,
	],
}

let root: Root | undefined
let renderedContainer: HTMLElement | undefined

afterEach(() => {
	if (root) act(() => root?.unmount())
	renderedContainer?.remove()
	root = undefined
	renderedContainer = undefined
})

describe('ReviewDecisionPanel', () => {
	it('does not initialize or display decision context for a service actor', async () => {
		const api = reviewApi()
		const container = await renderPanel(api, {
			access: reviewDecisionAccessForReviewerKind('service'),
		})

		expect(container.textContent).toBe('')
		expect(api.getDecisionContext).not.toHaveBeenCalled()
		expect(api.updateDecision).not.toHaveBeenCalled()
	})

	it('shows configured labels, current status, and truthful decision history', async () => {
		const api = reviewApi({
			getDecisionContext: vi.fn(async () => context),
		})
		const container = await renderPanel(api)

		expect(button(container, 'Decision: Unmapped (rev)')).toBeTruthy()
		click(button(container, 'Decision: Unmapped (rev)'))

		expect(container.textContent).toContain('Approved for final')
		expect(container.textContent).toContain('Needs changes')
		expect(container.textContent).toContain('No status → rev')
		expect(container.textContent).toContain('apr → chg')
		expect(container.textContent).toContain('Unknown/system')
		expect(container.textContent).toContain('Review lead')
	})

	it('reloads decision context for an external change without collapsing the panel', async () => {
		const api = reviewApi({
			getDecisionContext: vi.fn(async () => context),
		})
		const container = await renderPanel(api)
		openPanel(container)
		expect(container.textContent).toContain('Decision history')

		await rerenderPanel(api, { externalChangeRevision: 1 })

		expect(api.getDecisionContext).toHaveBeenCalledTimes(2)
		expect(container.textContent).toContain('Decision history')
	})

	it('labels a truncated activity response as recent rather than a complete audit', async () => {
		const api = reviewApi({
			getDecisionContext: vi.fn(async () => ({
				...context,
				history: [],
				historyTruncated: true,
			})),
		})
		const container = await renderPanel(api)
		openPanel(container)

		expect(container.textContent).toContain('Recent decision history')
		expect(container.textContent).toContain('not a complete audit log')
		expect(container.textContent).toContain(
			'No status changes appear in the recent activity returned by ShotGrid'
		)
		expect(container.textContent).toContain('Older decision records may exist')
		expect(container.textContent).not.toContain('No decision changes have been recorded yet')
	})

	it('sends expected status and waits for authoritative context before showing success', async () => {
		const update = deferred<ReviewDecisionResult>()
		const confirmation = deferred<ReviewDecisionContext>()
		const api = reviewApi({
			getDecisionContext: vi
				.fn()
				.mockResolvedValueOnce(context)
				.mockImplementationOnce(() => confirmation.promise),
			updateDecision: vi.fn(() => update.promise),
		})
		const onStatusRefresh = vi.fn()
		const container = await renderPanel(api, { onStatusRefresh })
		openPanel(container)

		click(button(container, 'Approved for final'))
		expect(api.updateDecision).toHaveBeenCalledWith(201, 301, {
			decisionKey: 'approve',
			expectedStatusCode: 'rev',
		})
		expect(container.textContent).toContain('Recording Approved for final')
		expect(container.textContent).not.toContain('was recorded in ShotGrid')

		await resolveDeferred(update, decisionResult)
		expect(api.getDecisionContext).toHaveBeenCalledTimes(2)
		expect(container.textContent).not.toContain('was recorded in ShotGrid')

		await resolveDeferred(confirmation, approvedContext)
		expect(container.textContent).toContain('Approved for final was recorded in ShotGrid')
		expect(container.textContent).toContain('rev → apr')
		expect(onStatusRefresh).toHaveBeenCalledOnce()
	})

	it('refreshes after a conflict and never retries the mutation automatically', async () => {
		const changedContext: ReviewDecisionContext = {
			...context,
			currentStatusCode: 'chg',
		}
		const api = reviewApi({
			getDecisionContext: vi
				.fn()
				.mockResolvedValueOnce(context)
				.mockResolvedValueOnce(changedContext),
			updateDecision: vi.fn(async () => {
				throw new ReviewApiClientError({
					code: 'DECISION_CONFLICT',
					message: 'The status changed.',
					requestId: 'decision-conflict',
					retryable: false,
					status: 409,
				})
			}),
		})
		const onStatusRefresh = vi.fn()
		const container = await renderPanel(api, { onStatusRefresh })
		openPanel(container)

		click(button(container, 'Approved for final'))
		await settle()

		expect(api.updateDecision).toHaveBeenCalledOnce()
		expect(api.getDecisionContext).toHaveBeenCalledTimes(2)
		expect(container.textContent).toContain('gateway observed a different ShotGrid status')
		expect(container.textContent).toContain('current status and history were refreshed')
		expect(container.textContent).toContain('Request decision-conflict')
		expect(onStatusRefresh).toHaveBeenCalledOnce()
	})

	it('does not mislabel an upstream ShotGrid 409 as an expected-status conflict', async () => {
		const api = reviewApi({
			getDecisionContext: vi.fn(async () => context),
			updateDecision: vi.fn(async () => {
				throw new ReviewApiClientError({
					code: 'SHOTGRID_REQUEST_FAILED',
					message: 'ShotGrid rejected the update.',
					retryable: false,
					status: 409,
				})
			}),
		})
		const container = await renderPanel(api)
		openPanel(container)

		click(button(container, 'Approved for final'))
		await settle()

		expect(container.textContent).toContain('decision was rejected')
		expect(container.textContent).not.toContain('gateway observed a different ShotGrid status')
		expect(api.updateDecision).toHaveBeenCalledOnce()
	})

	it('treats a rejected fetch as indeterminate and blocks another decision until refresh works', async () => {
		const api = reviewApi({
			getDecisionContext: vi
				.fn()
				.mockResolvedValueOnce(context)
				.mockRejectedValueOnce(new TypeError('offline'))
				.mockResolvedValueOnce(context),
			updateDecision: vi.fn(async () => {
				throw new ReviewApiClientError({
					code: 'NETWORK_ERROR',
					message: 'The review API could not be reached.',
					retryable: true,
					status: 0,
				})
			}),
		})
		const onStatusRefresh = vi.fn()
		const container = await renderPanel(api, { onStatusRefresh })
		openPanel(container)

		click(button(container, 'Approved for final'))
		await settle()

		expect(container.textContent).toContain('decision outcome is uncertain')
		expect(container.textContent).toContain('Current status could not be refreshed')
		expect(button(container, 'Approved for final').disabled).toBe(true)
		expect(button(container, 'Refresh status and history').disabled).toBe(false)

		click(button(container, 'Refresh status and history'))
		await settle()
		expect(button(container, 'Approved for final').disabled).toBe(false)
		expect(api.updateDecision).toHaveBeenCalledOnce()
		expect(onStatusRefresh).toHaveBeenCalledOnce()
	})

	it('treats a malformed successful PUT response as uncertain and never replays it', async () => {
		const api = reviewApi({
			getDecisionContext: vi
				.fn()
				.mockResolvedValueOnce(context)
				.mockRejectedValueOnce(new TypeError('context refresh failed')),
			updateDecision: vi.fn(async () => {
				throw new ReviewApiClientError({
					code: 'INVALID_RESPONSE',
					message: 'The review API returned an invalid response.',
					requestId: 'invalid-decision-response',
					retryable: false,
					status: 200,
				})
			}),
		})
		const container = await renderPanel(api)
		openPanel(container)

		click(button(container, 'Approved for final'))
		await settle()

		expect(api.updateDecision).toHaveBeenCalledOnce()
		expect(api.getDecisionContext).toHaveBeenCalledTimes(2)
		expect(container.textContent).toContain('decision outcome is uncertain')
		expect(container.textContent).toContain('Request invalid-decision-response')
		expect(button(container, 'Approved for final').disabled).toBe(true)
		expect(button(container, 'Refresh status and history').disabled).toBe(false)
	})

	it('keeps a confirmed decision non-repeatable when its context refresh fails', async () => {
		const api = reviewApi({
			getDecisionContext: vi
				.fn()
				.mockResolvedValueOnce(context)
				.mockRejectedValueOnce(
					new ReviewApiClientError({
						code: 'SHOTGRID_TIMEOUT',
						message: 'ShotGrid timed out.',
						requestId: 'refresh-timeout',
						retryable: true,
						status: 504,
					})
				),
			updateDecision: vi.fn(async () => decisionResult),
		})
		const onStatusRefresh = vi.fn()
		const container = await renderPanel(api, { onStatusRefresh })
		openPanel(container)

		click(button(container, 'Approved for final'))
		await settle()

		expect(container.textContent).toContain('was confirmed by the gateway')
		expect(container.textContent).toContain('Do not submit another decision')
		expect(container.textContent).toContain('Request refresh-timeout')
		expect(button(container, 'Approved for final').disabled).toBe(true)
		expect(api.updateDecision).toHaveBeenCalledOnce()
		expect(onStatusRefresh).toHaveBeenCalledOnce()
	})

	it('aborts stale context reads and ignores a sent mutation after switching Version', async () => {
		const update = deferred<ReviewDecisionResult>()
		const secondContext: ReviewDecisionContext = {
			...context,
			currentStatusCode: 'new',
			decisions: [
				{ key: 'new-status', label: 'New version status', statusCode: 'new' },
				{ key: 'hold', label: 'Hold new version', statusCode: 'hld' },
			],
			history: [],
			versionId: 302,
		}
		const api = reviewApi({
			getDecisionContext: vi.fn(async (_playlistId, versionId) =>
				versionId === 301 ? context : secondContext
			),
			updateDecision: vi.fn(() => update.promise),
		})
		const container = await renderPanel(api)
		openPanel(container)
		click(button(container, 'Approved for final'))

		await rerenderPanel(api, { versionId: 302 })
		expect(container.textContent).toContain('Decision: New version status')

		await resolveDeferred(update, decisionResult)
		expect(api.updateDecision).toHaveBeenCalledWith(201, 301, {
			decisionKey: 'approve',
			expectedStatusCode: 'rev',
		})
		expect(api.getDecisionContext).toHaveBeenCalledTimes(2)
		expect(container.textContent).toContain('Decision: New version status')
		expect(container.textContent).not.toContain('was recorded in ShotGrid')
	})

	it('aborts and ignores an older context read after switching Playlist and Version', async () => {
		const firstRead = deferred<ReviewDecisionContext>()
		let firstSignal: AbortSignal | undefined
		const secondContext: ReviewDecisionContext = {
			...context,
			currentStatusCode: 'new',
			decisions: [{ key: 'new-status', label: 'New version status', statusCode: 'new' }],
			history: [],
			playlistId: 202,
			versionId: 302,
		}
		const api = reviewApi({
			getDecisionContext: vi
				.fn()
				.mockImplementationOnce((_playlistId: number, _versionId: number, signal?: AbortSignal) => {
					firstSignal = signal
					return firstRead.promise
				})
				.mockResolvedValueOnce(secondContext),
		})
		const container = await renderPanel(api)

		await rerenderPanel(api, { playlistId: 202, versionId: 302 })
		expect(firstSignal?.aborted).toBe(true)
		expect(container.textContent).toContain('Decision: New version status')

		await resolveDeferred(firstRead, context)
		expect(container.textContent).toContain('Decision: New version status')
		expect(container.textContent).not.toContain('Decision: Unmapped (rev)')
	})
})

function reviewApi(overrides: Partial<ReviewApiClient> = {}) {
	return {
		getDecisionContext: vi.fn(async () => context),
		updateDecision: vi.fn(async () => decisionResult),
		...overrides,
	} as unknown as ReviewApiClient
}

const defaultProps = {
	access: reviewDecisionAccessForReviewerKind('human'),
	disabled: false,
	externalChangeRevision: 0,
	onStatusRefresh: () => undefined,
	playlistId: 201,
	versionId: 301,
}

async function renderPanel(api: ReviewApiClient, overrides: Partial<typeof defaultProps> = {}) {
	const container = document.createElement('div')
	document.body.appendChild(container)
	renderedContainer = container
	root = createRoot(container)
	await act(async () => {
		root?.render(<ReviewDecisionPanel api={api} {...defaultProps} {...overrides} />)
		await Promise.resolve()
	})
	await settle()
	return container
}

async function rerenderPanel(api: ReviewApiClient, overrides: Partial<typeof defaultProps>) {
	await act(async () => {
		root?.render(<ReviewDecisionPanel api={api} {...defaultProps} {...overrides} />)
		await Promise.resolve()
	})
	await settle()
}

function openPanel(container: HTMLElement) {
	click(buttonStartingWith(container, 'Decision:'))
}

function button(container: HTMLElement, label: string) {
	const match = [...container.querySelectorAll('button')].find(
		(candidate) =>
			candidate.textContent?.trim() === label ||
			candidate.querySelector('span')?.textContent?.trim() === label
	)
	if (!match) throw new Error(`Button not found: ${label}`)
	return match
}

function buttonStartingWith(container: HTMLElement, label: string) {
	const match = [...container.querySelectorAll('button')].find((candidate) =>
		candidate.textContent?.trim().startsWith(label)
	)
	if (!match) throw new Error(`Button not found: ${label}`)
	return match
}

function click(target: HTMLButtonElement) {
	act(() => target.click())
}

async function settle() {
	await act(async () => {
		await Promise.resolve()
		await Promise.resolve()
	})
}

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise
	})
	return { promise, resolve }
}

async function resolveDeferred<T>(pending: ReturnType<typeof deferred<T>>, value: T) {
	await act(async () => {
		pending.resolve(value)
		await pending.promise
	})
	await settle()
}
