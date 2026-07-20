export interface ReviewRoute {
	playlistId: string
	versionId: string
}

const REVIEW_ROUTE = /^\/review\/([^/]+)\/([^/]+)\/?$/

export function parseReviewRoute(pathname: string): ReviewRoute | null {
	const match = pathname.match(REVIEW_ROUTE)
	if (!match) return null

	try {
		return {
			playlistId: decodeURIComponent(match[1]),
			versionId: decodeURIComponent(match[2]),
		}
	} catch {
		return null
	}
}

export function resolveReviewRoute(
	pathname: string,
	options: { defaultVersionId: string; playlistId: string; versionIds: readonly string[] }
): ReviewRoute | null {
	if (pathname === '/') {
		return { playlistId: options.playlistId, versionId: options.defaultVersionId }
	}

	const route = parseReviewRoute(pathname)
	if (
		!route ||
		route.playlistId !== options.playlistId ||
		!options.versionIds.includes(route.versionId)
	) {
		return null
	}

	return route
}
