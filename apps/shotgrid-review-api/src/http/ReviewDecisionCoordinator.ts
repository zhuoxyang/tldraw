import {
	isReviewDecisionContext,
	isReviewDecisionOption,
	isReviewDecisionResult,
} from '../contracts'
import type {
	ReviewDecisionContext,
	ReviewDecisionOption,
	ReviewDecisionRequest,
	ReviewDecisionResult,
} from '../contracts'
import { ReviewGatewayError } from '../errors'
import type { ReviewGateway } from '../gateway/ReviewGateway'

export class ReviewDecisionCoordinator {
	private readonly decisions: ReviewDecisionOption[]
	private readonly mutationLocks = new Map<number, Promise<void>>()

	constructor(
		private readonly gateway: ReviewGateway,
		decisions: readonly ReviewDecisionOption[]
	) {
		if (
			decisions.length > 32 ||
			!decisions.every(isReviewDecisionOption) ||
			new Set(decisions.map(({ key }) => key)).size !== decisions.length ||
			new Set(decisions.map(({ statusCode }) => statusCode)).size !== decisions.length
		) {
			throw new ReviewGatewayError({
				code: 'CONFIGURATION_ERROR',
				retryable: false,
				status: 500,
			})
		}
		this.decisions = decisions.map((decision) => ({ ...decision }))
	}

	async getContext(playlistId: number, versionId: number): Promise<ReviewDecisionContext> {
		this.requireConfiguredDecisions()
		const context = await this.gateway.getDecisionContext(playlistId, versionId, this.decisions)
		if (
			!isReviewDecisionContext(context) ||
			context.playlistId !== playlistId ||
			context.versionId !== versionId ||
			!sameDecisionOptions(context.decisions, this.decisions)
		) {
			throw new ReviewGatewayError({
				code: 'SHOTGRID_INVALID_RESPONSE',
				retryable: false,
				status: 502,
			})
		}
		return context
	}

	async decide(
		playlistId: number,
		versionId: number,
		request: ReviewDecisionRequest
	): Promise<ReviewDecisionResult> {
		this.requireConfiguredDecisions()
		const decision = this.decisions.find(({ key }) => key === request.decisionKey)
		if (!decision) {
			throw new ReviewGatewayError({
				code: 'INVALID_REQUEST',
				retryable: false,
				status: 400,
			})
		}

		return await this.withVersionMutationLock(versionId, async () => {
			const result = await this.gateway.updateVersionDecision({
				decision,
				decisions: this.decisions,
				expectedStatusCode: request.expectedStatusCode,
				playlistId,
				versionId,
			})
			if (
				!isReviewDecisionResult(result) ||
				result.playlistId !== playlistId ||
				result.versionId !== versionId ||
				result.decisionKey !== decision.key ||
				result.previousStatusCode !== request.expectedStatusCode ||
				result.statusCode !== decision.statusCode
			) {
				throw new ReviewGatewayError({
					code: 'DECISION_INDETERMINATE',
					retryable: false,
					status: 502,
				})
			}
			return result
		})
	}

	private requireConfiguredDecisions() {
		if (this.decisions.length > 0) return
		throw new ReviewGatewayError({
			code: 'CONFIGURATION_ERROR',
			retryable: false,
			status: 500,
		})
	}

	private async withVersionMutationLock<T>(versionId: number, operation: () => Promise<T>) {
		const predecessor = this.mutationLocks.get(versionId) ?? Promise.resolve()
		let release!: () => void
		const lock = new Promise<void>((resolve) => {
			release = resolve
		})
		this.mutationLocks.set(versionId, lock)

		await predecessor.catch(() => undefined)
		try {
			return await operation()
		} finally {
			release()
			if (this.mutationLocks.get(versionId) === lock) this.mutationLocks.delete(versionId)
		}
	}
}

function sameDecisionOptions(
	actual: readonly ReviewDecisionOption[],
	expected: readonly ReviewDecisionOption[]
) {
	return (
		actual.length === expected.length &&
		actual.every(
			(decision, index) =>
				decision.key === expected[index].key &&
				decision.label === expected[index].label &&
				decision.statusCode === expected[index].statusCode
		)
	)
}
