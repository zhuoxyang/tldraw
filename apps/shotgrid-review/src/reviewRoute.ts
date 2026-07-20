export interface ReviewRoute {
	playlistId: string
	versionId: string
}

const REVIEW_ROUTE = /^\/review\/([^/]+)\/([^/]+)\/?$/

export function parseReviewRoute(pathname: string): ReviewRoute | null {
	const match = pathname.match(REVIEW_ROUTE)
	if (!match) return null

	return {
		playlistId: decodeURIComponent(match[1]),
		versionId: decodeURIComponent(match[2]),
	}
}
