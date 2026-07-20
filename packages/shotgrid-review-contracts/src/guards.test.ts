import { describe, expect, test } from 'vitest'
import {
	createReviewCollaborationPresence,
	isReviewApiDataEnvelope,
	isReviewApiErrorEnvelope,
	isReviewArrayOf,
	isReviewCollaborationPresence,
	isReviewCollaborationSession,
	isReviewDecisionContext,
	isReviewDecisionRequest,
	isReviewDecisionResult,
	isReviewHealth,
	isReviewNoteOptions,
	isReviewPlaylist,
	isReviewProject,
	isReviewPublicationResult,
	isSafeReviewUrl,
	isReviewUser,
	isReviewVersion,
	type ReviewVersion,
	type ReviewVideoMedia,
} from './index'

const videoMedia: ReviewVideoMedia = {
	attachmentId: 901,
	contentType: 'video/mp4',
	durationSeconds: 5,
	fileName: 'shot-comp.mp4',
	firstFrame: null,
	frameCount: 120,
	frameRate: 24,
	frameRateMode: 'constant',
	height: null,
	kind: 'video',
	lastFrame: null,
	thumbnailUrl: '/review/playlists/201/versions/301/media/image',
	url: '/review/playlists/201/versions/301/media/video/901',
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
	test('accepts only bound collaboration session URLs and canonical expirations', () => {
		const roomId = `r1_${'A'.repeat(43)}`
		const session = {
			permission: 'editor',
			roomId,
			socketUrl: `/api/review/sync/${roomId}?ticket=${'b'.repeat(43)}`,
			ticketExpiresAt: '2026-07-21T00:01:00.000Z',
		}

		expect(isReviewCollaborationSession(session)).toBe(true)
		expect(isReviewCollaborationSession({ ...session, permission: 'viewer' })).toBe(true)
		for (const invalid of [
			{ ...session, permission: 'owner' },
			{ ...session, roomId: `r1_${'A'.repeat(42)}` },
			{
				...session,
				socketUrl: `/api/review/sync/r1_${'B'.repeat(43)}?ticket=${'b'.repeat(43)}`,
			},
			{ ...session, socketUrl: `https://review.example.test${session.socketUrl}` },
			{ ...session, socketUrl: `${session.socketUrl}&proxyToken=secret` },
			{ ...session, ticketExpiresAt: '2026-07-21T00:01:00Z' },
			{ ...session, unexpected: true },
		]) {
			expect(isReviewCollaborationSession(invalid)).toBe(false)
		}
	})

	test('maps reviewer identities to stable, non-sensitive collaboration presence', () => {
		const human = createReviewCollaborationPresence({
			avatarUrl: null,
			id: 7,
			kind: 'human',
			login: 'reviewer',
			name: 'Reviewer',
		})
		const serviceReviewer = {
			avatarUrl: null,
			id: null,
			kind: 'service' as const,
			login: null,
			name: 'Review Service',
		}
		const service = createReviewCollaborationPresence(serviceReviewer)

		expect(human).toEqual({
			color: '#DDA0DD',
			userId: 'user:shotgrid-human-7',
			userName: 'Reviewer',
		})
		expect(service).toEqual({
			color: '#4ECDC4',
			userId: 'user:shotgrid-service-d414e2f9',
			userName: 'Review Service',
		})
		expect(createReviewCollaborationPresence(serviceReviewer)).toEqual(service)
		expect(service.userId).not.toContain('Review')
		expect(isReviewCollaborationPresence(human)).toBe(true)
		expect(isReviewCollaborationPresence(service)).toBe(true)
		expect(isReviewCollaborationPresence({ ...service, color: '#000000' })).toBe(false)
		expect(isReviewCollaborationPresence({ ...service, userId: 'user:shotgrid-service-xyz' })).toBe(
			false
		)
		expect(isReviewCollaborationPresence({ ...human, userId: 'user:shotgrid-human-0' })).toBe(false)
		expect(isReviewCollaborationPresence({ ...human, extra: true })).toBe(false)
		for (const id of [null, 0, Number.MAX_SAFE_INTEGER + 1]) {
			expect(() =>
				createReviewCollaborationPresence({
					avatarUrl: null,
					id,
					kind: 'human',
					login: 'broken',
					name: 'Broken human',
				})
			).toThrow(/ShotGrid id/)
		}
	})

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
		for (const media of [
			{ ...videoMedia, attachmentId: 0 },
			{ ...videoMedia, contentType: 'video/quicktime' },
			{ ...videoMedia, fileName: '../review.mp4' },
			{ ...videoMedia, fileName: 'review.mov' },
			{ ...videoMedia, frameCount: 1.5 },
			{ ...videoMedia, frameRate: 0 },
			{ ...videoMedia, firstFrame: -1 },
		]) {
			expect(isReviewVersion({ ...version, media })).toBe(false)
		}
	})

	test('validates exact decision context, request, result, and audit relationships', () => {
		const reviewer = {
			avatarUrl: null,
			id: 7,
			kind: 'human' as const,
			login: 'reviewer',
			name: 'Reviewer',
		}
		const decisions = [
			{ key: 'approve', label: 'Approve', statusCode: 'apr' },
			{ key: 'needs-changes', label: 'Needs changes', statusCode: 'chg' },
		]
		const entry = {
			decidedAt: '2026-07-20T00:00:00.000Z',
			decisionKey: 'approve',
			id: 701,
			previousStatusCode: 'rev',
			resultingStatusCode: 'apr',
			reviewer,
		}
		const context = {
			currentStatusCode: 'apr',
			decisions,
			history: [entry, { ...entry, decisionKey: null, id: 702, resultingStatusCode: 'rev' }],
			historyTruncated: false,
			playlistId: 201,
			versionId: 301,
		}
		expect(isReviewDecisionContext(context)).toBe(true)
		expect(
			isReviewDecisionContext({
				...context,
				history: [{ ...entry, reviewer: null }],
			})
		).toBe(true)
		expect(
			isReviewDecisionContext({
				...context,
				history: [{ ...entry, changed: true }],
			})
		).toBe(false)
		expect(
			isReviewDecisionContext({
				...context,
				history: [entry, { ...entry }],
			})
		).toBe(false)
		expect(
			isReviewDecisionContext({
				...context,
				history: [{ ...entry, decisionKey: null }],
			})
		).toBe(false)
		expect(
			isReviewDecisionContext({
				...context,
				history: [{ ...entry, decisionKey: 'needs-changes' }],
			})
		).toBe(false)
		expect(isReviewDecisionContext({ ...context, historyTruncated: undefined })).toBe(false)

		expect(isReviewDecisionRequest({ decisionKey: 'approve', expectedStatusCode: null })).toBe(true)
		expect(
			isReviewDecisionRequest({
				decisionKey: 'approve',
				expectedStatusCode: null,
				statusCode: 'apr',
			})
		).toBe(false)

		const changedResult = {
			changed: true,
			decisionKey: 'approve',
			playlistId: 201,
			previousStatusCode: 'rev',
			reviewer,
			statusCode: 'apr',
			updatedAt: '2026-07-20T00:00:00.000Z',
			versionId: 301,
		}
		expect(isReviewDecisionResult(changedResult)).toBe(true)
		expect(
			isReviewDecisionResult({
				...changedResult,
				reviewer: { ...reviewer, kind: 'service' },
			})
		).toBe(false)
		expect(
			isReviewDecisionResult({
				...changedResult,
				changed: false,
				previousStatusCode: 'apr',
				reviewer: null,
				updatedAt: null,
			})
		).toBe(true)
		expect(isReviewDecisionResult({ ...changedResult, changed: false })).toBe(false)
	})

	test('accepts only HTTPS or same-origin media URLs', () => {
		expect(isSafeReviewUrl('https://media.example.test/review.mp4')).toBe(true)
		expect(isSafeReviewUrl('/mock-media/review.svg')).toBe(true)
		expect(
			isReviewVersion({
				...version,
				media: { ...videoMedia, url: 'https://media.example.test/review.mp4' },
			})
		).toBe(false)
		expect(
			isReviewVersion({
				...version,
				media: {
					...videoMedia,
					thumbnailUrl: '/review/playlists/201/versions/999/media/image',
				},
			})
		).toBe(false)
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
		const links = {
			entity: { id: 501, name: 'shot_010', type: 'Shot' },
			project: { id: 101, name: 'Project', type: 'Project' },
			task: { id: 601, name: 'Lighting' },
			version: { id: 301, name: 'shot_v001', type: 'Version' },
		}
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
				error: {
					code: 'PUBLICATION_INDETERMINATE',
					message: 'The Note is known.',
					publication: {
						links,
						noteId: 401,
						publicationId: '018f3f72-1d6b-4c51-8f4b-a12c9d2e3478',
						stage: 'note-created',
					},
					retryable: false,
				},
			})
		).toBe(true)
		expect(
			isReviewApiErrorEnvelope({
				error: {
					code: 'PUBLICATION_INDETERMINATE',
					message: 'Verify the Note in ShotGrid.',
					publication: {
						publicationId: '018f3f72-1d6b-4c51-8f4b-a12c9d2e3478',
						stage: 'note-creation',
					},
					retryable: false,
				},
			})
		).toBe(true)
		expect(
			isReviewApiErrorEnvelope({
				error: {
					code: 'PUBLICATION_INDETERMINATE',
					message: 'Verify the Attachment in ShotGrid.',
					publication: {
						attachmentId: 501,
						links,
						noteId: 401,
						publicationId: '018f3f72-1d6b-4c51-8f4b-a12c9d2e3478',
						stage: 'attachment-completion',
					},
					retryable: false,
				},
			})
		).toBe(true)
		expect(
			isReviewApiErrorEnvelope({
				error: { code: 'RAW_UPSTREAM_ERROR', message: 'unsafe', retryable: 'yes' },
			})
		).toBe(false)
		for (const invalidPublication of [
			{
				publicationId: 'not-a-uuid',
				stage: 'note-creation',
			},
			{
				links,
				publicationId: '018f3f72-1d6b-4c51-8f4b-a12c9d2e3478',
				stage: 'attachment-completion',
			},
			{
				content: 'must not be exposed',
				publicationId: '018f3f72-1d6b-4c51-8f4b-a12c9d2e3478',
				stage: 'note-creation',
			},
		]) {
			expect(
				isReviewApiErrorEnvelope({
					error: {
						code: 'PUBLICATION_INDETERMINATE',
						message: 'Uncertain',
						publication: invalidPublication,
						retryable: false,
					},
				})
			).toBe(false)
		}
		expect(
			isReviewApiErrorEnvelope({
				error: {
					code: 'NOT_FOUND',
					message: 'Not found',
					publication: {
						publicationId: '018f3f72-1d6b-4c51-8f4b-a12c9d2e3478',
						stage: 'note-creation',
					},
					retryable: false,
				},
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

	test('validates note options and complete publication results', () => {
		const recipient = {
			avatarUrl: null,
			id: 7,
			kind: 'human' as const,
			login: 'reviewer',
			name: 'Reviewer',
		}
		const links = {
			entity: { id: 501, name: 'shot_010', type: 'Shot' },
			project: { id: 101, name: 'Northstar', type: 'Project' },
			task: { id: 601, name: 'Lighting' },
			version: { id: 301, name: 'shot_v001', type: 'Version' },
		}
		const note = {
			content: 'Move the highlight left',
			createdAt: '2026-07-20T00:00:00.000Z',
			createdBy: recipient,
			frame: null,
			id: 401,
			projectId: 101,
			subject: 'Lighting note',
			versionId: 301,
		}
		const result = {
			attachment: {
				contentType: 'image/png',
				fileName: 'annotation.png',
				id: 501,
				noteId: 401,
				sizeBytes: 1024,
			},
			links,
			note,
			publicationId: '018f3f72-1d6b-4c51-8f4b-a12c9d2e3478',
			status: 'complete',
		}

		expect(isReviewNoteOptions({ links, recipients: [recipient] })).toBe(true)
		expect(isReviewPublicationResult(result)).toBe(true)
		expect(isReviewNoteOptions({ links, recipients: [{ ...recipient, kind: 'service' }] })).toBe(
			false
		)
		expect(
			isReviewPublicationResult({
				...result,
				attachment: { ...result.attachment, noteId: 999 },
			})
		).toBe(false)
		expect(isReviewPublicationResult({ ...result, publicationId: 'not-a-uuid' })).toBe(false)
		expect(
			isReviewPublicationResult({
				...result,
				publicationId: '018f3f72-1d6b-7c51-8f4b-a12c9d2e3478',
			})
		).toBe(false)
		for (const attachment of [
			{ ...result.attachment, contentType: 'image/jpeg' },
			{ ...result.attachment, fileName: '../annotation.png' },
			{ ...result.attachment, sizeBytes: 0 },
			{ ...result.attachment, sizeBytes: 10 * 1024 * 1024 + 1 },
		]) {
			expect(isReviewPublicationResult({ ...result, attachment })).toBe(false)
		}
		expect(
			isReviewPublicationResult({
				...result,
				note: { ...result.note, projectId: 999 },
			})
		).toBe(false)
		expect(
			isReviewPublicationResult({
				...result,
				note: { ...result.note, versionId: 999 },
			})
		).toBe(false)
		for (const boundedResult of [
			{ ...result, note: { ...result.note, content: 'x'.repeat(10_001) } },
			{ ...result, note: { ...result.note, subject: 'x'.repeat(256) } },
			{
				...result,
				note: {
					...result.note,
					createdBy: { ...result.note.createdBy, name: 'x'.repeat(256) },
				},
			},
			{
				...result,
				links: { ...result.links, entity: { ...result.links.entity!, type: 'Shot-Type!' } },
			},
			{
				...result,
				links: {
					...result.links,
					version: { ...result.links.version, name: 'x'.repeat(256) },
				},
			},
		]) {
			expect(isReviewPublicationResult(boundedResult)).toBe(false)
		}
		expect(
			isReviewNoteOptions({
				links: {
					...links,
					version: { ...links.version, name: 'x'.repeat(256) },
				},
				recipients: [recipient],
			})
		).toBe(true)
	})
})
