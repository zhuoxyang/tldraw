import { describe, expect, test, vi } from 'vitest'
import { MockReviewGateway } from '../gateway/MockReviewGateway'
import type { UpdateReviewDecisionGatewayRequest } from '../gateway/ReviewGateway'
import { ReviewDecisionCoordinator } from './ReviewDecisionCoordinator'

const DECISIONS = [
	{ key: 'approve', label: 'Approve', statusCode: 'apr' },
	{ key: 'needs-changes', label: 'Needs changes', statusCode: 'chg' },
] as const

describe('ReviewDecisionCoordinator', () => {
	test('rejects more than 32 deployment decision mappings', () => {
		const decisions = Array.from({ length: 33 }, (_, index) => ({
			key: `decision-${index}`,
			label: `Decision ${index}`,
			statusCode: `status_${index}`,
		}))
		expect(() => new ReviewDecisionCoordinator(new MockReviewGateway(), decisions)).toThrow(
			expect.objectContaining({ code: 'CONFIGURATION_ERROR', status: 500 })
		)
	})

	test('fails closed at decision routes when no deployment mapping is configured', async () => {
		const gateway = new MockReviewGateway()
		const getContext = vi.spyOn(gateway, 'getDecisionContext')
		const update = vi.spyOn(gateway, 'updateVersionDecision')
		const coordinator = new ReviewDecisionCoordinator(gateway, [])

		await expect(coordinator.getContext(201, 301)).rejects.toMatchObject({
			code: 'CONFIGURATION_ERROR',
			status: 500,
		})
		await expect(
			coordinator.decide(201, 301, {
				decisionKey: 'approve',
				expectedStatusCode: 'rev',
			})
		).rejects.toMatchObject({ code: 'CONFIGURATION_ERROR', status: 500 })
		expect(getContext).not.toHaveBeenCalled()
		expect(update).not.toHaveBeenCalled()
	})

	test('rejects an unknown decision key before calling the gateway', async () => {
		const gateway = new MockReviewGateway()
		const update = vi.spyOn(gateway, 'updateVersionDecision')
		const coordinator = new ReviewDecisionCoordinator(gateway, DECISIONS)

		await expect(
			coordinator.decide(201, 301, {
				decisionKey: 'not-configured',
				expectedStatusCode: 'rev',
			})
		).rejects.toMatchObject({ code: 'INVALID_REQUEST', status: 400 })
		expect(update).not.toHaveBeenCalled()
	})

	test('validates gateway context and mutation output before returning it', async () => {
		const gateway = new MockReviewGateway()
		vi.spyOn(gateway, 'getDecisionContext').mockResolvedValue({
			currentStatusCode: 'rev',
			decisions: [...DECISIONS].reverse(),
			history: [],
			historyTruncated: false,
			playlistId: 201,
			versionId: 301,
		})
		const coordinator = new ReviewDecisionCoordinator(gateway, DECISIONS)
		await expect(coordinator.getContext(201, 301)).rejects.toMatchObject({
			code: 'SHOTGRID_INVALID_RESPONSE',
			status: 502,
		})

		vi.spyOn(gateway, 'updateVersionDecision').mockResolvedValue({
			changed: true,
			decisionKey: 'approve',
			playlistId: 201,
			previousStatusCode: 'rev',
			reviewer: {
				avatarUrl: null,
				id: 7,
				kind: 'human',
				login: 'reviewer',
				name: 'Reviewer',
			},
			statusCode: 'chg',
			updatedAt: '2026-07-20T00:00:00.000Z',
			versionId: 301,
		})
		await expect(
			coordinator.decide(201, 301, {
				decisionKey: 'approve',
				expectedStatusCode: 'rev',
			})
		).rejects.toMatchObject({
			code: 'DECISION_INDETERMINATE',
			status: 502,
		})
	})

	test('serializes mutations by Version id while allowing a different Version in parallel', async () => {
		const gateway = new MockReviewGateway()
		let releaseFirst!: () => void
		const firstBlocked = new Promise<void>((resolve) => {
			releaseFirst = resolve
		})
		const entered: number[] = []
		vi.spyOn(gateway, 'updateVersionDecision').mockImplementation(async (request) => {
			entered.push(request.versionId)
			if (entered.length === 1) await firstBlocked
			return decisionResult(request)
		})
		const coordinator = new ReviewDecisionCoordinator(gateway, DECISIONS)

		const first = coordinator.decide(201, 301, {
			decisionKey: 'approve',
			expectedStatusCode: 'rev',
		})
		await vi.waitFor(() => expect(entered).toEqual([301]))
		const sameVersionFromAnotherPlaylist = coordinator.decide(999, 301, {
			decisionKey: 'needs-changes',
			expectedStatusCode: 'apr',
		})
		const otherVersion = coordinator.decide(201, 302, {
			decisionKey: 'approve',
			expectedStatusCode: 'chg',
		})
		await vi.waitFor(() => expect(entered).toEqual([301, 302]))

		releaseFirst()
		await Promise.all([first, sameVersionFromAnotherPlaylist, otherVersion])
		expect(entered).toEqual([301, 302, 301])
	})

	test('releases a Version mutation lock after a gateway failure', async () => {
		const gateway = new MockReviewGateway()
		const update = vi
			.spyOn(gateway, 'updateVersionDecision')
			.mockRejectedValueOnce(new Error('first failed'))
			.mockImplementation(async (request) => decisionResult(request))
		const coordinator = new ReviewDecisionCoordinator(gateway, DECISIONS)

		const first = coordinator.decide(201, 301, {
			decisionKey: 'approve',
			expectedStatusCode: 'rev',
		})
		const second = coordinator.decide(201, 301, {
			decisionKey: 'needs-changes',
			expectedStatusCode: 'apr',
		})

		await expect(first).rejects.toThrow('first failed')
		await expect(second).resolves.toMatchObject({
			decisionKey: 'needs-changes',
			statusCode: 'chg',
		})
		expect(update).toHaveBeenCalledTimes(2)
	})
})

function decisionResult(request: UpdateReviewDecisionGatewayRequest) {
	return {
		changed: true,
		decisionKey: request.decision.key,
		playlistId: request.playlistId,
		previousStatusCode: request.expectedStatusCode,
		reviewer: {
			avatarUrl: null,
			id: 7,
			kind: 'human' as const,
			login: 'reviewer',
			name: 'Reviewer',
		},
		statusCode: request.decision.statusCode,
		updatedAt: '2026-07-20T00:00:00.000Z',
		versionId: request.versionId,
	}
}
