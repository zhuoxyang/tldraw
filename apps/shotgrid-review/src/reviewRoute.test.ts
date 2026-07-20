import { describe, expect, it } from 'vitest'
import { parseReviewRoute, resolveReviewRoute } from './reviewRoute'

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

	it('returns null for malformed encoded identifiers', () => {
		expect(parseReviewRoute('/review/%/version-202')).toBeNull()
	})
})

describe('resolveReviewRoute', () => {
	const options = {
		defaultVersionId: 'version-201',
		playlistId: 'playlist-101',
		versionIds: ['version-201', 'version-202'],
	}

	it('resolves the application root to the default version', () => {
		expect(resolveReviewRoute('/', options)).toEqual({
			playlistId: 'playlist-101',
			versionId: 'version-201',
		})
	})

	it('rejects unknown versions instead of silently using the default', () => {
		expect(resolveReviewRoute('/review/playlist-101/version-missing', options)).toBeNull()
	})

	it('rejects unknown playlists', () => {
		expect(resolveReviewRoute('/review/playlist-missing/version-201', options)).toBeNull()
	})
})
