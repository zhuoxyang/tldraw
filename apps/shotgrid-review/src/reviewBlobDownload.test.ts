// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { downloadReviewBlob, releaseAllReviewBlobUrls } from './reviewBlobDownload'

const createObjectURL = vi.fn(() => 'blob:shotgrid-review')
const revokeObjectURL = vi.fn()

beforeEach(() => {
	vi.useFakeTimers()
	createObjectURL.mockClear()
	revokeObjectURL.mockClear()
	Object.defineProperty(URL, 'createObjectURL', {
		configurable: true,
		value: createObjectURL,
	})
	Object.defineProperty(URL, 'revokeObjectURL', {
		configurable: true,
		value: revokeObjectURL,
	})
})

afterEach(() => {
	releaseAllReviewBlobUrls()
	vi.restoreAllMocks()
	vi.useRealTimers()
	document.body.replaceChildren()
})

describe('review Blob downloads', () => {
	it('revokes the temporary object URL after the browser receives the download click', () => {
		const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})

		downloadReviewBlob(new Blob(['sensitive review']), 'review.json')

		expect(createObjectURL).toHaveBeenCalledOnce()
		expect(click).toHaveBeenCalledOnce()
		expect(document.querySelector('a')).toBeNull()
		expect(revokeObjectURL).not.toHaveBeenCalled()
		vi.runAllTimers()
		expect(revokeObjectURL).toHaveBeenCalledWith('blob:shotgrid-review')
	})

	it('still revokes the object URL if starting the download throws', () => {
		vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
			throw new Error('Download blocked')
		})

		expect(() => downloadReviewBlob(new Blob(['sensitive review']), 'review.json')).toThrow(
			'Download blocked'
		)
		vi.runAllTimers()
		expect(revokeObjectURL).toHaveBeenCalledWith('blob:shotgrid-review')
	})

	it('revokes pending object URLs immediately when the page is hidden', () => {
		vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
		downloadReviewBlob(new Blob(['sensitive review']), 'review.json')

		globalThis.dispatchEvent(new Event('pagehide'))

		expect(revokeObjectURL).toHaveBeenCalledWith('blob:shotgrid-review')
		vi.runAllTimers()
		expect(revokeObjectURL).toHaveBeenCalledOnce()
	})
})
