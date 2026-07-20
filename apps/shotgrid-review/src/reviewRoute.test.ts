import { describe, expect, it } from 'vitest'
import { parseReviewRoute } from './reviewRoute'

describe('parseReviewRoute', () => {
	it('parses a review deep link', () => {
		expect(parseReviewRoute('/review/playlist-101/version-202')).toEqual({
			playlistId: 'playlist-101',
			versionId: 'version-202',
		})
	})

	it('decodes route identifiers', () => {
		expect(parseReviewRoute('/review/lighting%20dailies/shot%20010')).toEqual({
			playlistId: 'lighting dailies',
			versionId: 'shot 010',
		})
	})

	it('returns null for unrelated routes', () => {
		expect(parseReviewRoute('/projects')).toBeNull()
	})
})
