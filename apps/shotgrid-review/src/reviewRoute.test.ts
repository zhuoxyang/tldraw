import { describe, expect, it } from 'vitest'
import {
	buildReviewRoute,
	buildReviewSelectionRoute,
	parseReviewRoute,
	resolveReviewRoute,
} from './reviewRoute'

describe('parseReviewRoute', () => {
	it('parses the canonical project, playlist, and version deep link', () => {
		expect(parseReviewRoute('/review/101/201/301')).toEqual({
			playlistId: 201,
			projectId: 101,
			versionId: 301,
		})
	})

	it('parses the legacy playlist and version deep link', () => {
		expect(parseReviewRoute('/review/201/301')).toEqual({
			playlistId: 201,
			projectId: null,
			versionId: 301,
		})
	})

	it('parses explicit project and Playlist selection links', () => {
		expect(parseReviewRoute('/review/projects/101')).toEqual({
			playlistId: null,
			projectId: 101,
			versionId: null,
		})
		expect(parseReviewRoute('/review/projects/101/playlists/201')).toEqual({
			playlistId: 201,
			projectId: 101,
			versionId: null,
		})
	})

	it.each([
		'/projects',
		'/review/101',
		'/review/101/201/301/extra',
		'/review/101/201/301/',
		'/review//201/301',
		'/review/0/201/301',
		'/review/-1/201/301',
		'/review/1.5/201/301',
		'/review/01/201/301',
		'/review/%31/201/301',
		`/review/${Number.MAX_SAFE_INTEGER + 1}/201/301`,
	])('rejects an invalid or non-canonical route: %s', (pathname) => {
		expect(parseReviewRoute(pathname)).toBeNull()
	})
})

describe('buildReviewRoute', () => {
	it('builds a canonical review deep link', () => {
		expect(buildReviewRoute({ playlistId: 201, projectId: 101, versionId: 301 })).toBe(
			'/review/101/201/301'
		)
	})

	it.each([
		{ playlistId: 201, projectId: 0, versionId: 301 },
		{ playlistId: -1, projectId: 101, versionId: 301 },
		{ playlistId: 201, projectId: 101, versionId: Number.MAX_SAFE_INTEGER + 1 },
	])('rejects an invalid route id: %o', (route) => {
		expect(() => buildReviewRoute(route)).toThrow(RangeError)
	})
})

describe('buildReviewSelectionRoute', () => {
	it('builds root, project, Playlist, and Version selection links', () => {
		expect(buildReviewSelectionRoute({ playlistId: null, projectId: null, versionId: null })).toBe(
			'/'
		)
		expect(buildReviewSelectionRoute({ playlistId: null, projectId: 101, versionId: null })).toBe(
			'/review/projects/101'
		)
		expect(buildReviewSelectionRoute({ playlistId: 201, projectId: 101, versionId: null })).toBe(
			'/review/projects/101/playlists/201'
		)
		expect(buildReviewSelectionRoute({ playlistId: 201, projectId: 101, versionId: 301 })).toBe(
			'/review/101/201/301'
		)
	})

	it('rejects incomplete parent relationships', () => {
		expect(() =>
			buildReviewSelectionRoute({ playlistId: 201, projectId: null, versionId: 301 })
		).toThrow(RangeError)
		expect(() =>
			buildReviewSelectionRoute({ playlistId: null, projectId: 101, versionId: 301 })
		).toThrow(RangeError)
	})
})

describe('resolveReviewRoute', () => {
	const options = {
		defaultVersionId: 301,
		playlistId: 201,
		projectId: 101,
		versionIds: [301, 302],
	}

	it('resolves the application root to the default canonical selection', () => {
		expect(resolveReviewRoute('/', options)).toEqual({
			playlistId: 201,
			projectId: 101,
			versionId: 301,
		})
	})

	it('accepts a matching legacy route during migration', () => {
		expect(resolveReviewRoute('/review/201/302', options)).toEqual({
			playlistId: 201,
			projectId: null,
			versionId: 302,
		})
	})

	it.each(['/review/999/201/301', '/review/101/999/301', '/review/101/201/999'])(
		'rejects a route outside the selected review context: %s',
		(pathname) => {
			expect(resolveReviewRoute(pathname, options)).toBeNull()
		}
	)
})
