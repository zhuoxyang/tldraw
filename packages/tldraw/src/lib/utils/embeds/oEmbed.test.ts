import { afterEach, describe, expect, it, vi } from 'vitest'
import { oEmbedAspectRatio } from './oEmbed'

const ENDPOINT = 'https://vimeo.com/api/oembed.json'

describe('oEmbedAspectRatio', () => {
	afterEach(() => vi.restoreAllMocks())

	function mockFetch(body: unknown, ok = true) {
		return vi.spyOn(globalThis, 'fetch').mockResolvedValue({
			ok,
			json: async () => body,
		} as Response)
	}

	it('returns width / height as the aspect ratio', async () => {
		mockFetch({ width: 360, height: 240 })
		expect(await oEmbedAspectRatio(ENDPOINT)('https://vimeo.com/817841251')).toBe(1.5)
	})

	it('encodes the content url into the request', async () => {
		const spy = mockFetch({ width: 16, height: 9 })
		await oEmbedAspectRatio(ENDPOINT)('https://vimeo.com/1?a=b')
		expect(spy.mock.calls[0][0]).toContain('url=https%3A%2F%2Fvimeo.com%2F1%3Fa%3Db')
	})

	it('returns undefined on a non-ok response', async () => {
		mockFetch({}, false)
		expect(await oEmbedAspectRatio(ENDPOINT)('https://vimeo.com/1')).toBeUndefined()
	})

	it('returns undefined when dimensions are missing or zero', async () => {
		mockFetch({ width: 360 })
		expect(await oEmbedAspectRatio(ENDPOINT)('https://vimeo.com/1')).toBeUndefined()
		mockFetch({ width: 360, height: 0 })
		expect(await oEmbedAspectRatio(ENDPOINT)('https://vimeo.com/1')).toBeUndefined()
	})

	it('returns undefined if fetch rejects', async () => {
		vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network'))
		expect(await oEmbedAspectRatio(ENDPOINT)('https://vimeo.com/1')).toBeUndefined()
	})
})
