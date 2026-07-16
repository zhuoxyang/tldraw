import { fetch } from '@tldraw/editor'

/**
 * Build an aspect-ratio resolver for a provider that exposes an [oEmbed](https://oembed.com/)
 * endpoint returning `width` and `height`. The returned function fetches the endpoint for a given
 * content URL and resolves to `width / height`, or `undefined` if the endpoint is unavailable or
 * doesn't report usable dimensions.
 *
 * @example
 * ```ts
 * getAspectRatio: oEmbedAspectRatio('https://vimeo.com/api/oembed.json')
 * ```
 *
 * @param endpoint - The provider's oEmbed endpoint, without query parameters.
 * @public
 */
export function oEmbedAspectRatio(endpoint: string) {
	return async (url: string): Promise<number | undefined> => {
		try {
			const res = await fetch(`${endpoint}?url=${encodeURIComponent(url)}&format=json`)
			if (!res.ok) return undefined
			const data = await res.json()
			if (
				typeof data?.width === 'number' &&
				typeof data?.height === 'number' &&
				data.width > 0 &&
				data.height > 0
			) {
				return data.width / data.height
			}
		} catch {
			// network error, invalid JSON, etc. — fall through to undefined
		}
		return undefined
	}
}
