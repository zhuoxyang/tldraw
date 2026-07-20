export interface ReviewRoute {
	projectId: number | null
	playlistId: number | null
	versionId: number | null
}

export interface CanonicalReviewRoute {
	projectId: number
	playlistId: number
	versionId: number
}

const CANONICAL_REVIEW_ROUTE = /^\/review\/([^/]+)\/([^/]+)\/([^/]+)$/
const LEGACY_REVIEW_ROUTE = /^\/review\/([^/]+)\/([^/]+)$/
const PROJECT_REVIEW_ROUTE = /^\/review\/projects\/([^/]+)$/
const PLAYLIST_REVIEW_ROUTE = /^\/review\/projects\/([^/]+)\/playlists\/([^/]+)$/
const POSITIVE_INTEGER = /^[1-9]\d*$/

export function parseReviewRoute(pathname: string): ReviewRoute | null {
	const canonical = CANONICAL_REVIEW_ROUTE.exec(pathname)
	if (canonical) {
		const projectId = parseRouteId(canonical[1])
		const playlistId = parseRouteId(canonical[2])
		const versionId = parseRouteId(canonical[3])
		if (projectId === null || playlistId === null || versionId === null) return null
		return { playlistId, projectId, versionId }
	}

	const playlist = PLAYLIST_REVIEW_ROUTE.exec(pathname)
	if (playlist) {
		const projectId = parseRouteId(playlist[1])
		const playlistId = parseRouteId(playlist[2])
		if (projectId === null || playlistId === null) return null
		return { playlistId, projectId, versionId: null }
	}

	const project = PROJECT_REVIEW_ROUTE.exec(pathname)
	if (project) {
		const projectId = parseRouteId(project[1])
		if (projectId === null) return null
		return { playlistId: null, projectId, versionId: null }
	}

	const legacy = LEGACY_REVIEW_ROUTE.exec(pathname)
	if (!legacy) return null
	const playlistId = parseRouteId(legacy[1])
	const versionId = parseRouteId(legacy[2])
	if (playlistId === null || versionId === null) return null
	return { playlistId, projectId: null, versionId }
}

export function buildReviewRoute(route: CanonicalReviewRoute) {
	const projectId = requireRouteId(route.projectId, 'projectId')
	const playlistId = requireRouteId(route.playlistId, 'playlistId')
	const versionId = requireRouteId(route.versionId, 'versionId')
	return `/review/${projectId}/${playlistId}/${versionId}`
}

export function buildReviewSelectionRoute(route: ReviewRoute) {
	if (route.projectId === null) {
		if (route.playlistId === null && route.versionId === null) return '/'
		throw new RangeError('A canonical selection requires a projectId')
	}

	const projectId = requireRouteId(route.projectId, 'projectId')
	if (route.playlistId === null) {
		if (route.versionId !== null) throw new RangeError('A Version selection requires a playlistId')
		return `/review/projects/${projectId}`
	}

	const playlistId = requireRouteId(route.playlistId, 'playlistId')
	if (route.versionId === null) return `/review/projects/${projectId}/playlists/${playlistId}`
	return buildReviewRoute({ playlistId, projectId, versionId: route.versionId })
}

export function resolveReviewRoute(
	pathname: string,
	options: {
		defaultVersionId: number
		playlistId: number
		projectId?: number
		versionIds: readonly number[]
	}
): ReviewRoute | null {
	if (pathname === '/') {
		return {
			playlistId: requireRouteId(options.playlistId, 'playlistId'),
			projectId:
				options.projectId === undefined ? null : requireRouteId(options.projectId, 'projectId'),
			versionId: requireRouteId(options.defaultVersionId, 'defaultVersionId'),
		}
	}

	const route = parseReviewRoute(pathname)
	if (
		!route ||
		route.playlistId === null ||
		route.versionId === null ||
		route.playlistId !== options.playlistId ||
		!options.versionIds.includes(route.versionId) ||
		(route.projectId !== null && route.projectId !== options.projectId)
	) {
		return null
	}

	return route
}

function parseRouteId(value: string) {
	if (!POSITIVE_INTEGER.test(value)) return null
	const id = Number(value)
	return Number.isSafeInteger(id) ? id : null
}

function requireRouteId(value: number, field: string) {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new RangeError(`${field} must be a positive safe integer`)
	}
	return value
}
