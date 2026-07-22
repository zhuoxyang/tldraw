const activeReviewBlobUrls = new Map<string, ReturnType<typeof setTimeout> | null>()
let pageHideListenerInstalled = false

/**
 * Starts a browser download without leaving its object URL alive beyond the current page task.
 * The pagehide fallback also covers a navigation that happens before the timer can run.
 */
export function downloadReviewBlob(blob: Blob, fileName: string) {
	const url = URL.createObjectURL(blob)
	trackReviewBlobUrl(url)
	const anchor = document.createElement('a')
	try {
		anchor.href = url
		anchor.download = fileName
		document.body.appendChild(anchor)
		anchor.click()
	} finally {
		anchor.remove()
		scheduleReviewBlobUrlRevocation(url)
	}
}

/** Releases all object URLs still owned by review downloads. */
export function releaseAllReviewBlobUrls() {
	for (const url of [...activeReviewBlobUrls.keys()]) releaseReviewBlobUrl(url)
}

function trackReviewBlobUrl(url: string) {
	activeReviewBlobUrls.set(url, null)
	if (pageHideListenerInstalled) return
	globalThis.addEventListener('pagehide', releaseAllReviewBlobUrls)
	pageHideListenerInstalled = true
}

function scheduleReviewBlobUrlRevocation(url: string) {
	if (!activeReviewBlobUrls.has(url)) return
	const timeout = setTimeout(() => releaseReviewBlobUrl(url), 0)
	activeReviewBlobUrls.set(url, timeout)
}

function releaseReviewBlobUrl(url: string) {
	const timeout = activeReviewBlobUrls.get(url)
	if (timeout === undefined) return
	if (timeout !== null) clearTimeout(timeout)
	activeReviewBlobUrls.delete(url)
	try {
		URL.revokeObjectURL(url)
	} finally {
		if (activeReviewBlobUrls.size === 0 && pageHideListenerInstalled) {
			globalThis.removeEventListener('pagehide', releaseAllReviewBlobUrls)
			pageHideListenerInstalled = false
		}
	}
}
