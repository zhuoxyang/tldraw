import { useCallback, useEffect, useRef, useState } from 'react'
import {
	ReviewApiClientError,
	type ReviewApiClient,
	type ReviewChangeStreamStatus,
} from './reviewApiClient'
import {
	loadReviewBrowser,
	refreshReadyReviewBrowser,
	ReviewBrowserInvalidResponseError,
	ReviewBrowserNotFoundError,
	rootReviewSelection,
	type ReviewBrowserLoadResult,
	type ReviewSelectionRequest,
} from './reviewBrowser'
import { buildReviewSelectionRoute, parseReviewRoute } from './reviewRoute'

type HistoryMode = 'none' | 'push' | 'replace'

export interface ReviewBrowserDisplayError {
	kind: 'general' | 'not-found' | 'permission' | 'upstream'
	message: string
	requestId?: string
	retryable: boolean
	title: string
}

export type ReviewBrowserViewState =
	| { status: 'loading' }
	| ReviewBrowserLoadResult
	| { error: ReviewBrowserDisplayError; status: 'error' }

export function useReviewBrowser(api: ReviewApiClient) {
	const [state, setState] = useState<ReviewBrowserViewState>({ status: 'loading' })
	const [navigating, setNavigating] = useState(false)
	const [refreshError, setRefreshError] = useState<ReviewBrowserDisplayError | null>(null)
	const [refreshing, setRefreshing] = useState(false)
	const [changeStreamStatus, setChangeStreamStatus] =
		useState<ReviewChangeStreamStatus>('connecting')
	const [externalChangeRevision, setExternalChangeRevision] = useState(0)
	const abortControllerRef = useRef<AbortController | null>(null)
	const externalReloadControllerRef = useRef<AbortController | null>(null)
	const hasLoadedStateRef = useRef(false)
	const loadingRef = useRef(false)
	const navigatingRef = useRef(false)
	const refreshingRef = useRef(false)
	const lastLoadRef = useRef<{
		historyMode: HistoryMode
		request: ReviewSelectionRequest
	} | null>(null)

	const load = useCallback(
		async (request: ReviewSelectionRequest, historyMode: HistoryMode, showLoading = true) => {
			externalReloadControllerRef.current?.abort()
			abortControllerRef.current?.abort()
			const controller = new AbortController()
			abortControllerRef.current = controller
			loadingRef.current = true
			refreshingRef.current = false
			setRefreshing(false)
			setRefreshError(null)

			const preserveLoadedState = showLoading && hasLoadedStateRef.current
			navigatingRef.current = preserveLoadedState
			if (preserveLoadedState) setNavigating(true)
			else if (showLoading) setState({ status: 'loading' })

			lastLoadRef.current = {
				historyMode: historyMode === 'push' ? 'replace' : historyMode,
				request,
			}

			try {
				if (historyMode === 'push') {
					window.history.pushState({}, '', buildReviewSelectionRoute(request))
				}
				const result = await loadReviewBrowser(api, request, controller.signal)
				if (controller.signal.aborted) return

				if (historyMode !== 'none') {
					window.history.replaceState({}, '', buildLoadedReviewPath(result))
				}

				hasLoadedStateRef.current = true
				setState(result)
			} catch (error) {
				if (controller.signal.aborted || isAbortError(error)) return
				hasLoadedStateRef.current = false
				setState({ error: toReviewBrowserDisplayError(error), status: 'error' })
			} finally {
				if (abortControllerRef.current === controller) {
					loadingRef.current = false
					navigatingRef.current = false
					setNavigating(false)
				}
			}
		},
		[api]
	)

	useEffect(() => {
		const loadCurrentPath = () => {
			const resolved = resolveReviewPath(window.location.pathname)
			if (!resolved) {
				abortControllerRef.current?.abort()
				navigatingRef.current = false
				refreshingRef.current = false
				lastLoadRef.current = null
				setNavigating(false)
				setRefreshing(false)
				setState({
					error: toReviewBrowserDisplayError(new ReviewBrowserNotFoundError()),
					status: 'error',
				})
				return
			}
			void load(resolved.request, resolved.historyMode)
		}

		loadCurrentPath()
		window.addEventListener('popstate', loadCurrentPath)
		return () => {
			abortControllerRef.current?.abort()
			externalReloadControllerRef.current?.abort()
			window.removeEventListener('popstate', loadCurrentPath)
		}
	}, [load])

	useEffect(() => {
		let active = true
		let reloadTimer: ReturnType<typeof setTimeout> | undefined

		const scheduleReload = () => {
			if (!active) return
			if (reloadTimer !== undefined) clearTimeout(reloadTimer)
			reloadTimer = setTimeout(() => void reloadCurrentRoute(), 250)
		}

		const reloadCurrentRoute = async () => {
			reloadTimer = undefined
			if (!active) return
			if (loadingRef.current || navigatingRef.current || refreshingRef.current) {
				scheduleReload()
				return
			}

			const resolved = resolveReviewPath(window.location.pathname)
			if (!resolved) return
			const pathname = window.location.pathname
			const controller = new AbortController()
			externalReloadControllerRef.current?.abort()
			externalReloadControllerRef.current = controller

			try {
				const result = await loadReviewBrowser(api, resolved.request, controller.signal)
				if (controller.signal.aborted || !active || pathname !== window.location.pathname) {
					return
				}
				hasLoadedStateRef.current = true
				setRefreshError(null)
				setState(result)
				setExternalChangeRevision((revision) => revision + 1)
			} catch (error) {
				if (controller.signal.aborted || !active || isAbortError(error)) return
				const displayError = toReviewBrowserDisplayError(error)
				if (displayError.kind === 'not-found' || displayError.kind === 'permission') {
					hasLoadedStateRef.current = false
					setRefreshError(null)
					setState({ error: displayError, status: 'error' })
				} else {
					setRefreshError(displayError)
				}
			} finally {
				if (externalReloadControllerRef.current === controller) {
					externalReloadControllerRef.current = null
				}
			}
		}

		const unsubscribe = api.watchChanges({
			onChange: scheduleReload,
			onStatusChange(status) {
				if (active) setChangeStreamStatus(status)
			},
		})
		return () => {
			active = false
			if (reloadTimer !== undefined) clearTimeout(reloadTimer)
			externalReloadControllerRef.current?.abort()
			externalReloadControllerRef.current = null
			unsubscribe()
		}
	}, [api])

	const selectProject = useCallback(
		(projectId: number) => {
			if (
				navigatingRef.current ||
				refreshingRef.current ||
				('project' in state && state.project?.id === projectId)
			) {
				return
			}
			void load({ playlistId: null, projectId, versionId: null }, 'push')
		},
		[load, state]
	)

	const selectPlaylist = useCallback(
		(playlistId: number) => {
			if (
				navigatingRef.current ||
				refreshingRef.current ||
				!('project' in state) ||
				!state.project ||
				state.playlist?.id === playlistId
			) {
				return
			}
			void load({ playlistId, projectId: state.project.id, versionId: null }, 'push')
		},
		[load, state]
	)

	const selectVersion = useCallback(
		(versionId: number) => {
			if (
				navigatingRef.current ||
				refreshingRef.current ||
				state.status !== 'ready' ||
				versionId === state.version.id
			) {
				return
			}
			void load(
				{
					playlistId: state.playlist.id,
					projectId: state.project.id,
					versionId,
				},
				'push'
			)
		},
		[load, state]
	)

	const refresh = useCallback(() => {
		if (state.status !== 'ready' || refreshingRef.current || navigatingRef.current) return
		externalReloadControllerRef.current?.abort()
		abortControllerRef.current?.abort()
		const controller = new AbortController()
		abortControllerRef.current = controller
		refreshingRef.current = true
		setRefreshing(true)
		setRefreshError(null)

		void refreshReadyReviewBrowser(api, state, controller.signal)
			.then((result) => {
				if (!controller.signal.aborted) setState(result)
			})
			.catch((error: unknown) => {
				if (!controller.signal.aborted && !isAbortError(error)) {
					const displayError = toReviewBrowserDisplayError(error)
					if (displayError.kind === 'not-found' || displayError.kind === 'permission') {
						hasLoadedStateRef.current = false
						setRefreshError(null)
						setState({ error: displayError, status: 'error' })
					} else {
						setRefreshError(displayError)
					}
				}
			})
			.finally(() => {
				if (abortControllerRef.current === controller) {
					refreshingRef.current = false
					setRefreshing(false)
				}
			})
	}, [api, state])

	const retry = useCallback(() => {
		const lastLoad = lastLoadRef.current
		if (lastLoad) void load(lastLoad.request, lastLoad.historyMode, true)
	}, [load])

	return {
		changeStreamStatus,
		externalChangeRevision,
		navigating,
		refresh,
		refreshError,
		refreshing,
		retry,
		selectPlaylist,
		selectProject,
		selectVersion,
		state,
	}
}

export function resolveReviewPath(pathname: string): {
	historyMode: HistoryMode
	request: ReviewSelectionRequest
} | null {
	if (pathname === '/') return { historyMode: 'replace', request: rootReviewSelection }

	const route = parseReviewRoute(pathname)
	if (!route) return null
	return {
		historyMode: route.projectId === null || route.versionId === null ? 'replace' : 'none',
		request: route,
	}
}

function buildLoadedReviewPath(result: ReviewBrowserLoadResult) {
	if (result.status === 'ready') {
		return buildReviewSelectionRoute({
			playlistId: result.playlist.id,
			projectId: result.project.id,
			versionId: result.version.id,
		})
	}
	if (result.scope === 'projects') return '/'
	if (result.scope === 'playlists') {
		return buildReviewSelectionRoute({
			playlistId: null,
			projectId: result.project!.id,
			versionId: null,
		})
	}
	return buildReviewSelectionRoute({
		playlistId: result.playlist!.id,
		projectId: result.project!.id,
		versionId: null,
	})
}

export function toReviewBrowserDisplayError(error: unknown): ReviewBrowserDisplayError {
	if (error instanceof ReviewBrowserNotFoundError) {
		return {
			kind: 'not-found',
			message: 'The requested project, playlist, or version is no longer available.',
			retryable: false,
			title: 'Review not found',
		}
	}

	if (error instanceof ReviewBrowserInvalidResponseError) {
		return {
			kind: 'general',
			message: 'The review gateway returned inconsistent ShotGrid relationships.',
			retryable: false,
			title: 'Unable to load review',
		}
	}

	if (error instanceof ReviewApiClientError) {
		const requestId = error.requestId || undefined
		if (error.code === 'NOT_FOUND') {
			return {
				kind: 'not-found',
				message: 'The requested project, playlist, or version is no longer available.',
				requestId,
				retryable: false,
				title: 'Review not found',
			}
		}
		if (
			error.code === 'AUTHENTICATION_REQUIRED' ||
			error.code === 'PERMISSION_DENIED' ||
			error.code === 'SHOTGRID_PERMISSION_DENIED'
		) {
			return {
				kind: 'permission',
				message:
					error.code === 'AUTHENTICATION_REQUIRED'
						? 'Sign in through the review gateway before opening this workspace.'
						: 'Your ShotGrid account cannot access this review item.',
				requestId,
				retryable: false,
				title:
					error.code === 'AUTHENTICATION_REQUIRED'
						? 'Authentication required'
						: 'Permission denied',
			}
		}
		if (error.retryable) {
			return {
				kind: 'upstream',
				message: 'ShotGrid is temporarily unavailable. Try the request again.',
				requestId,
				retryable: true,
				title: 'ShotGrid is unavailable',
			}
		}
		return {
			kind: 'general',
			message: 'The review gateway rejected this request or returned an invalid response.',
			requestId,
			retryable: false,
			title: 'Unable to load review',
		}
	}

	return {
		kind: 'general',
		message: 'The review workspace could not be loaded. Check the gateway and try again.',
		retryable: true,
		title: 'Unable to load review',
	}
}

function isAbortError(error: unknown) {
	return error instanceof Error && error.name === 'AbortError'
}
