import { describe, expect, it, vi } from 'vitest'
import { classifyReviewRoute, JsonReviewLogger, ReviewMetrics } from './ReviewObservability'

describe('classifyReviewRoute', () => {
	it.each([
		['/internal/metrics', 'metrics'],
		['/api/health', 'health'],
		['/api/webhooks/shotgrid', 'webhook'],
		['/api/review/projects', 'projects'],
		['/api/review/projects/101/playlists', 'project_playlists'],
		['/api/review/playlists/201/versions', 'playlist_versions'],
		['/api/review/playlists/201/versions/301', 'version'],
		['/api/review/playlists/201/versions/301/collaboration-session', 'collaboration_session'],
		['/api/review/playlists/201/versions/301/media/image', 'media_image'],
		['/api/review/playlists/201/versions/301/media/video/901', 'media_video'],
		['/api/review/playlists/201/versions/301/note-options', 'note_options'],
		['/api/review/playlists/201/versions/301/decision-context', 'decision_context'],
		['/api/review/playlists/201/versions/301/decision', 'decision'],
		[
			'/api/review/playlists/201/versions/301/publications/018f3f72-1d6b-4c51-8f4b-a12c9d2e3478',
			'publication',
		],
		['/api/review/unknown/secret-entity-id', 'unknown'],
	] as const)('maps %s to the bounded %s label', (pathname, expected) => {
		expect(classifyReviewRoute(pathname)).toBe(expected)
	})
})

describe('ReviewMetrics', () => {
	it('records bounded request labels without paths or entity identifiers', () => {
		const times = [1_000, 1_010, 1_035, 1_050]
		const metrics = new ReviewMetrics(() => times.shift() ?? 1_050)
		const finish = metrics.beginRequest('get', () =>
			classifyReviewRoute('/api/review/playlists/sensitive-201/versions/sensitive-301')
		)
		finish(200)
		finish(500)

		const output = metrics.render()
		expect(output).toContain(
			'shotgrid_review_api_http_requests_total{method="GET",route="version",status="200"} 1'
		)
		expect(output).toContain(
			'shotgrid_review_api_http_request_duration_seconds_total{method="GET",route="version",status="200"} 0.025'
		)
		expect(output).toContain('shotgrid_review_api_http_requests_in_flight 0')
		expect(output).not.toContain('sensitive-201')
		expect(output).not.toContain('sensitive-301')
	})

	it('reports store capacity under fixed labels without exposing filesystem paths', () => {
		const missing = `${process.cwd()}/secret-deployment-path-that-does-not-exist`
		const metrics = new ReviewMetrics()
		const output = metrics.render({
			storeDirectories: { audit: process.cwd(), publications: missing },
		})

		expect(output).toMatch(
			/shotgrid_review_api_store_filesystem_available_bytes\{store="audit"\} \d+/
		)
		expect(output).toContain('shotgrid_review_api_store_filesystem_stat_error{store="audit"} 0')
		expect(output).toContain(
			'shotgrid_review_api_store_filesystem_stat_error{store="publications"} 1'
		)
		expect(output).not.toContain(process.cwd())
		expect(output).not.toContain('secret-deployment-path')
	})
})

describe('JsonReviewLogger', () => {
	it('writes one-line JSON with a fixed safe request schema', () => {
		const stdout = vi.fn()
		const logger = new JsonReviewLogger({ stderr: vi.fn(), stdout }, () =>
			Date.parse('2026-07-22T00:00:00.000Z')
		)
		logger.info('request_completed', {
			durationMs: 12,
			method: 'GET',
			requestId: 'request-1',
			route: 'version',
			status: 200,
			secret: 'must-not-be-logged',
		} as Parameters<JsonReviewLogger['info']>[1] & { secret: string })

		expect(stdout).toHaveBeenCalledOnce()
		const line = stdout.mock.calls[0][0] as string
		expect(line.endsWith('\n')).toBe(true)
		expect(JSON.parse(line)).toEqual({
			durationMs: 12,
			event: 'request_completed',
			level: 'info',
			method: 'GET',
			requestId: 'request-1',
			route: 'version',
			status: 200,
			timestamp: '2026-07-22T00:00:00.000Z',
		})
		expect(line).not.toContain('must-not-be-logged')
	})
})
