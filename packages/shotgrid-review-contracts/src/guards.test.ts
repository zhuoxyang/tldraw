import { describe, expect, test } from 'vitest'
import {
	isReviewApiDataEnvelope,
	isReviewApiErrorEnvelope,
	isReviewArrayOf,
	isReviewHealth,
	isReviewPlaylist,
	isReviewProject,
	isSafeReviewUrl,
	isReviewUser,
	isReviewVersion,
	type ReviewVersion,
	type ReviewVideoMedia,
} from './index'

const videoMedia: ReviewVideoMedia = {
	contentType: 'video/mp4',
	durationSeconds: 5,
	firstFrame: null,
	frameCount: 120,
	frameRate: 24,
	height: null,
	kind: 'video',
	lastFrame: null,
	thumbnailUrl: '/mock-media/shot-comp.svg',
	url: 'https://media.example.test/review.mp4',
	width: null,
}

const version: ReviewVersion = {
	createdAt: '2026-07-20T08:00:00.000Z',
	createdBy: {
		avatarUrl: null,
		id: 10,
		kind: 'service',
		login: null,
		name: 'Publish Bot',
	},
	description: 'Lighting polish',
	entity: { id: 501, name: 'shot_010', type: 'Shot' },
	id: 301,
	media: videoMedia,
	name: 'shot_010_lgt_v014',
	playlistId: 201,
	projectId: 101,
	statusCode: 'rev',
	submittedBy: null,
	task: { id: 601, name: 'Lighting' },
}

describe('review contract runtime guards', () => {
	test('accepts complete health, navigation, identity, and version contracts', () => {
		expect(isReviewHealth({ mode: 'mock', status: 'ok' })).toBe(true)
		expect(
			isReviewUser({ avatarUrl: null, id: 7, kind: 'human', login: 'reviewer', name: 'Reviewer' })
		).toBe(true)
		expect(
			isReviewProject({ id: 101, name: 'Northstar', statusCode: 'act', thumbnailUrl: null })
		).toBe(true)
		expect(
			isReviewPlaylist({
				description: null,
				id: 201,
				name: 'Dailies',
				projectId: 101,
				updatedAt: '2026-07-20T00:00:00Z',
				versionCount: 1,
			})
		).toBe(true)
		expect(isReviewVersion(version)).toBe(true)
	})

	test('validates nested data envelopes and rejects malformed version context', () => {
		expect(
			isReviewApiDataEnvelope({ data: [version] }, (value) =>
				isReviewArrayOf(value, isReviewVersion)
			)
		).toBe(true)
		expect(isReviewVersion({ ...version, task: { id: '601', name: 'Lighting' } })).toBe(false)
		expect(
			isReviewVersion({
				...version,
				media: { ...videoMedia, frameCount: '120' },
			})
		).toBe(false)
		expect(isReviewVersion({ ...version, entity: undefined })).toBe(false)
		expect(isReviewVersion({ ...version, unexpected: true })).toBe(false)
		expect(isReviewVersion({ ...version, task: { id: 601, name: ' ' } })).toBe(false)
	})

	test('accepts only HTTPS or same-origin media URLs', () => {
		expect(isSafeReviewUrl('https://media.example.test/review.mp4')).toBe(true)
		expect(isSafeReviewUrl('/mock-media/review.svg')).toBe(true)
		for (const unsafe of [
			'http://media.example.test/review.mp4',
			'javascript:alert(1)',
			'data:text/html,unsafe',
			'//evil.example/review.mp4',
			'/mock-media\\review.svg',
		]) {
			expect(isSafeReviewUrl(unsafe)).toBe(false)
			expect(isReviewVersion({ ...version, media: { ...videoMedia, url: unsafe } })).toBe(false)
		}
	})

	test('accepts only the stable public error envelope', () => {
		expect(
			isReviewApiErrorEnvelope({
				error: {
					code: 'SHOTGRID_TIMEOUT',
					message: 'ShotGrid did not respond in time.',
					requestId: 'request-123',
					retryable: true,
					upstreamStatus: 504,
				},
			})
		).toBe(true)
		expect(
			isReviewApiErrorEnvelope({
				error: { code: 'RAW_UPSTREAM_ERROR', message: 'unsafe', retryable: 'yes' },
			})
		).toBe(false)
		expect(
			isReviewApiErrorEnvelope({
				error: {
					code: 'NOT_FOUND',
					debug: 'do not expose',
					message: 'Not found',
					retryable: false,
				},
			})
		).toBe(false)
	})
})
