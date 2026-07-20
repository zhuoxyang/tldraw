import type {
	ReviewDecisionContext,
	ReviewDecisionOption,
	ReviewDecisionResult,
	ReviewUser,
} from '@tldraw/shotgrid-review-contracts'
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { ReviewApiClientError, type ReviewApiClient } from './reviewApiClient'

const SAFE_PRE_MUTATION_DECISION_ERRORS = new Set([
	'AUTHENTICATION_REQUIRED',
	'CONFIGURATION_ERROR',
	'INVALID_REQUEST',
	'NOT_FOUND',
	'PERMISSION_DENIED',
	'SHOTGRID_AUTH_FAILED',
	'SHOTGRID_PERMISSION_DENIED',
	'SHOTGRID_REQUEST_FAILED',
])

export type ReviewDecisionAccess = { status: 'enabled' } | { status: 'disabled' }

export function reviewDecisionAccessForReviewerKind(
	kind: ReviewUser['kind']
): ReviewDecisionAccess {
	return kind === 'human' ? { status: 'enabled' } : { status: 'disabled' }
}

type DecisionViewState =
	| { status: 'loading' }
	| { context: ReviewDecisionContext; notice?: string; status: 'ready' }
	| { context: ReviewDecisionContext; label: string; status: 'working' }
	| {
			context?: ReviewDecisionContext
			message: string
			mutationBlocked?: boolean
			requestId?: string
			status: 'error'
	  }

interface DecisionOperationContext {
	active: boolean
	generation: number
	playlistId: number
	versionId: number
}

export function ReviewDecisionPanel({
	access,
	api,
	disabled,
	onStatusRefresh,
	playlistId,
	versionId,
}: {
	access: ReviewDecisionAccess
	api: ReviewApiClient
	disabled: boolean
	onStatusRefresh(): void
	playlistId: number
	versionId: number
}) {
	const panelId = useId()
	const [expanded, setExpanded] = useState(false)
	const [loadAttempt, setLoadAttempt] = useState(0)
	const [state, setState] = useState<DecisionViewState>({ status: 'loading' })
	const operationContextRef = useRef<DecisionOperationContext | null>(null)
	const loadControllerRef = useRef<AbortController | null>(null)
	const mutationControllerRef = useRef<AbortController | null>(null)
	const mutationInFlightRef = useRef(false)
	const manualRefreshRequestedRef = useRef(false)
	const onStatusRefreshRef = useRef(onStatusRefresh)
	onStatusRefreshRef.current = onStatusRefresh

	useLayoutEffect(() => {
		if (operationContextRef.current) operationContextRef.current.active = false
		loadControllerRef.current?.abort()
		mutationControllerRef.current?.abort()
		const context: DecisionOperationContext = {
			active: access.status === 'enabled',
			generation: (operationContextRef.current?.generation ?? 0) + 1,
			playlistId,
			versionId,
		}
		operationContextRef.current = context
		mutationInFlightRef.current = false
		manualRefreshRequestedRef.current = false
		setExpanded(false)
		setState({ status: 'loading' })
		return () => {
			context.active = false
			loadControllerRef.current?.abort()
			mutationControllerRef.current?.abort()
		}
	}, [access.status, playlistId, versionId])

	useEffect(() => {
		if (access.status === 'disabled') return
		const context = operationContextRef.current
		if (!context || !context.active) return
		const shouldRefreshBrowser = manualRefreshRequestedRef.current
		manualRefreshRequestedRef.current = false
		const controller = new AbortController()
		loadControllerRef.current?.abort()
		loadControllerRef.current = controller
		setState({ status: 'loading' })
		void api
			.getDecisionContext(playlistId, versionId, controller.signal)
			.then((decisionContext) => {
				if (!isCurrentOperationContext(operationContextRef.current, context, controller)) return
				setState({ context: decisionContext, status: 'ready' })
				if (shouldRefreshBrowser) onStatusRefreshRef.current()
			})
			.catch((error) => {
				if (!isCurrentOperationContext(operationContextRef.current, context, controller)) return
				const details = decisionErrorDetails(error)
				setState({
					message: `Decision context could not be loaded. ${details.message}`,
					requestId: details.requestId,
					status: 'error',
				})
			})
			.finally(() => {
				if (loadControllerRef.current === controller) loadControllerRef.current = null
			})
		return () => controller.abort()
	}, [access.status, api, loadAttempt, playlistId, versionId])

	if (access.status === 'disabled') return null

	const decisionContext = 'context' in state ? state.context : undefined
	const currentStatus = decisionContext
		? formatDecisionStatus(decisionContext)
		: state.status === 'error'
			? 'Unavailable'
			: 'Loading'
	const operationDisabled = disabled || state.status === 'loading' || state.status === 'working'
	const decisionControlsDisabled =
		operationDisabled || (state.status === 'error' && state.mutationBlocked === true)

	const recordDecision = async (decision: ReviewDecisionOption) => {
		const context = operationContextRef.current
		if (
			!context ||
			!context.active ||
			!decisionContext ||
			disabled ||
			mutationInFlightRef.current ||
			decision.statusCode === decisionContext.currentStatusCode
		) {
			return
		}

		mutationInFlightRef.current = true
		loadControllerRef.current?.abort()
		setState({ context: decisionContext, label: `Recording ${decision.label}`, status: 'working' })

		const request = {
			decisionKey: decision.key,
			expectedStatusCode: decisionContext.currentStatusCode,
		}
		let result: ReviewDecisionResult
		try {
			// Do not abort a mutation once sent. Navigation only makes its eventual result stale.
			result = await api.updateDecision(context.playlistId, context.versionId, request)
			if (!isCurrentDecisionContext(operationContextRef.current, context)) return
			assertDecisionResultMatches(result, decision, decisionContext)
			onStatusRefresh()
		} catch (error) {
			if (!isCurrentDecisionContext(operationContextRef.current, context)) return
			const details = decisionErrorDetails(error)
			const controller = new AbortController()
			mutationControllerRef.current = controller
			let refreshed: ReviewDecisionContext | undefined
			try {
				refreshed = await api.getDecisionContext(
					context.playlistId,
					context.versionId,
					controller.signal
				)
			} catch {
				// The original mutation error remains the actionable failure. The user can refresh explicitly.
			}
			if (!isCurrentOperationContext(operationContextRef.current, context, controller)) return
			setState({
				context: refreshed ?? decisionContext,
				message: decisionMutationErrorMessage(error, refreshed !== undefined),
				mutationBlocked: refreshed === undefined,
				requestId: details.requestId,
				status: 'error',
			})
			if (refreshed) onStatusRefresh()
			if (mutationControllerRef.current === controller) mutationControllerRef.current = null
			mutationInFlightRef.current = false
			return
		}

		if (!isCurrentDecisionContext(operationContextRef.current, context)) return
		const controller = new AbortController()
		mutationControllerRef.current = controller
		try {
			const refreshed = await api.getDecisionContext(
				context.playlistId,
				context.versionId,
				controller.signal
			)
			if (!isCurrentOperationContext(operationContextRef.current, context, controller)) return
			if (refreshed.currentStatusCode !== result.statusCode) {
				setState({
					context: refreshed,
					message: `${decision.label} was confirmed by the gateway, but ShotGrid now reports ${formatStatusCode(refreshed.currentStatusCode)}. Another status change may have followed it. Review the latest history before taking another action.`,
					status: 'error',
				})
			} else {
				setState({
					context: refreshed,
					notice: result.changed
						? `${decision.label} was recorded in ShotGrid.`
						: `ShotGrid was already ${decision.label}; no new decision activity was created.`,
					status: 'ready',
				})
			}
		} catch (error) {
			if (!isCurrentOperationContext(operationContextRef.current, context, controller)) return
			const details = decisionErrorDetails(error)
			setState({
				context: decisionContext,
				message: `${decision.label} was confirmed by the gateway, but current status and history could not be refreshed. Do not submit another decision until Refresh status and history succeeds.`,
				mutationBlocked: true,
				requestId: details.requestId,
				status: 'error',
			})
		} finally {
			if (isCurrentOperationContext(operationContextRef.current, context, controller)) {
				mutationInFlightRef.current = false
			}
			if (mutationControllerRef.current === controller) mutationControllerRef.current = null
		}
	}

	return (
		<div className="review-decision">
			<button
				aria-controls={panelId}
				aria-expanded={expanded}
				disabled={disabled}
				onClick={() => setExpanded((value) => !value)}
				type="button"
			>
				Decision: {currentStatus}
			</button>
			{expanded ? (
				<section
					aria-busy={state.status === 'loading' || state.status === 'working' || undefined}
					aria-label="ShotGrid review decision"
					className="review-decision__panel"
					id={panelId}
				>
					<header>
						<div>
							<strong>Review decision</strong>
							<span>
								Current ShotGrid status: {currentStatus}
								{decisionContext?.currentStatusCode ? (
									<>
										{' '}
										· <code>{decisionContext.currentStatusCode}</code>
									</>
								) : null}
							</span>
						</div>
						<button
							aria-label="Close decision panel"
							onClick={() => setExpanded(false)}
							type="button"
						>
							Close
						</button>
					</header>

					{state.status === 'loading' ? <p aria-live="polite">Loading decision context…</p> : null}
					{state.status === 'working' ? <p aria-live="polite">{state.label}…</p> : null}
					{state.status === 'error' ? (
						<div className="review-decision__notice review-decision__notice--error" role="alert">
							<span>{state.message}</span>
							{state.requestId ? <code>Request {state.requestId}</code> : null}
						</div>
					) : null}
					{state.status === 'ready' && state.notice ? (
						<div className="review-decision__notice" role="status">
							{state.notice}
						</div>
					) : null}

					{decisionContext ? (
						<>
							<fieldset className="review-decision__options" disabled={decisionControlsDisabled}>
								<legend>Record decision</legend>
								{decisionContext.decisions.length === 0 ? (
									<span>No decisions are configured for this deployment.</span>
								) : null}
								<div>
									{decisionContext.decisions.map((decision) => (
										<button
											aria-pressed={decision.statusCode === decisionContext.currentStatusCode}
											disabled={
												decisionControlsDisabled ||
												decision.statusCode === decisionContext.currentStatusCode
											}
											key={decision.key}
											onClick={() => void recordDecision(decision)}
											type="button"
										>
											<span>{decision.label}</span>
											<code>{decision.statusCode}</code>
										</button>
									))}
								</div>
							</fieldset>
							<DecisionHistory context={decisionContext} headingId={`${panelId}-history`} />
						</>
					) : null}

					<button
						className="review-decision__refresh"
						disabled={operationDisabled}
						onClick={() => {
							manualRefreshRequestedRef.current = true
							setLoadAttempt((value) => value + 1)
						}}
						type="button"
					>
						Refresh status and history
					</button>
				</section>
			) : null}
		</div>
	)
}

function DecisionHistory({
	context,
	headingId,
}: {
	context: ReviewDecisionContext
	headingId: string
}) {
	return (
		<section aria-labelledby={headingId} className="review-decision__history">
			<h3 id={headingId}>
				{context.historyTruncated ? 'Recent decision history' : 'Decision history'}
			</h3>
			{context.historyTruncated ? (
				<p>ShotGrid returned only the most recent activity. This is not a complete audit log.</p>
			) : null}
			{context.history.length === 0 ? (
				<p>
					{context.historyTruncated
						? 'No status changes appear in the recent activity returned by ShotGrid. Older decision records may exist.'
						: 'No decision changes have been recorded yet.'}
				</p>
			) : (
				<ol>
					{context.history.map((entry) => {
						const label =
							context.decisions.find((decision) => decision.key === entry.decisionKey)?.label ??
							entry.decisionKey ??
							'Status changed'
						return (
							<li key={entry.id}>
								<div>
									<strong>{label}</strong>
									<time dateTime={entry.decidedAt}>{formatDecisionDate(entry.decidedAt)}</time>
								</div>
								<span>
									{formatStatusCode(entry.previousStatusCode)} →{' '}
									{formatStatusCode(entry.resultingStatusCode)}
								</span>
								<small>{entry.reviewer?.name ?? 'Unknown/system'}</small>
							</li>
						)
					})}
				</ol>
			)}
		</section>
	)
}

function assertDecisionResultMatches(
	result: ReviewDecisionResult,
	decision: ReviewDecisionOption,
	context: ReviewDecisionContext
) {
	if (
		result.decisionKey !== decision.key ||
		result.previousStatusCode !== context.currentStatusCode ||
		result.statusCode !== decision.statusCode
	) {
		throw new Error('The ShotGrid decision response does not match the requested transition.')
	}
}

function isCurrentOperationContext(
	current: DecisionOperationContext | null,
	expected: DecisionOperationContext,
	controller: AbortController
) {
	return (
		!controller.signal.aborted &&
		current === expected &&
		expected.active &&
		current.playlistId === expected.playlistId &&
		current.versionId === expected.versionId
	)
}

function isCurrentDecisionContext(
	current: DecisionOperationContext | null,
	expected: DecisionOperationContext
) {
	return current === expected && expected.active
}

function decisionMutationErrorMessage(error: unknown, refreshed: boolean) {
	const suffix = refreshed
		? 'The current status and history were refreshed. Review them before trying again.'
		: 'Current status could not be refreshed. Refresh status and history before trying again.'
	if (error instanceof ReviewApiClientError) {
		if (error.code === 'DECISION_CONFLICT') {
			return `The gateway observed a different ShotGrid status before this decision. ${suffix}`
		}
		if (SAFE_PRE_MUTATION_DECISION_ERRORS.has(error.code)) {
			return `The decision was rejected. ${error.message} ${suffix}`
		}
		return `The decision outcome is uncertain. ${suffix}`
	}
	return `The decision outcome is uncertain. ${suffix}`
}

function decisionErrorDetails(error: unknown) {
	return error instanceof ReviewApiClientError
		? { message: error.message, requestId: error.requestId }
		: { message: 'The review API returned an unexpected error.', requestId: undefined }
}

function formatDecisionStatus(context: ReviewDecisionContext) {
	if (context.currentStatusCode === null) return 'No status'
	const option = context.decisions.find(
		(decision) => decision.statusCode === context.currentStatusCode
	)
	return option?.label ?? `Unmapped (${context.currentStatusCode})`
}

function formatStatusCode(statusCode: string | null) {
	return statusCode ?? 'No status'
}

function formatDecisionDate(value: string) {
	const date = new Date(value)
	return Number.isNaN(date.getTime())
		? 'Unknown time'
		: new Intl.DateTimeFormat(undefined, {
				dateStyle: 'medium',
				timeStyle: 'short',
			}).format(date)
}
