import type { TLEditorSnapshot } from 'tldraw'
import { describe, expect, it } from 'vitest'
import { REVIEW_ANNOTATION_TARGET_META_KEY } from './reviewAnnotationTarget'
import { getReviewVideoShapeId } from './reviewVideoShape'
import {
	assertReviewVideoSnapshotRecords,
	assertReviewVideoSnapshotSource,
	createReviewVideoSnapshot,
	createReviewVideoSnapshotSource,
	MAX_REVIEW_VIDEO_SNAPSHOT_RECORDS,
	parseReviewVideoSnapshot,
	parseReviewVideoSnapshotJson,
	REVIEW_VIDEO_SNAPSHOT_KIND,
	serializeReviewVideoSnapshot,
	type ReviewVideoSnapshot,
	type ReviewVideoSnapshotSource,
} from './reviewVideoSnapshot'

const review = { projectId: 101, scope: 'studio-sandbox:shotgrid', versionId: 301 }
const source: ReviewVideoSnapshotSource = {
	attachmentId: 401,
	contentType: 'video/mp4',
	durationMs: 5_000,
	firstFrame: 1001,
	frameCount: 120,
	frameRate: 24,
	frameRateMode: 'constant',
	height: 1080,
	lastFrame: 1120,
	width: 1920,
}

describe('review video snapshots', () => {
	it('round-trips a strict, URL-free editable snapshot envelope', () => {
		const snapshot = makeEditorSnapshot()
		const value = createReviewVideoSnapshot({
			review,
			savedAt: '2026-07-21T00:00:00.000Z',
			snapshot,
			source,
		})
		const json = serializeReviewVideoSnapshot(value)

		expect(parseReviewVideoSnapshotJson(json, review, source)).toEqual(value)
		expect(value).toMatchObject({
			kind: REVIEW_VIDEO_SNAPSHOT_KIND,
			schemaVersion: 1,
			source,
		})
		expect(json).not.toContain('https://')
	})

	it('canonicalizes the browser duration to integer milliseconds', () => {
		expect(
			createReviewVideoSnapshotSource({
				...source,
				durationSeconds: 5.000_6,
			})
		).toEqual({ ...source, durationMs: 5_001 })
		expect(() => createReviewVideoSnapshotSource({ ...source, durationSeconds: 0.000_1 })).toThrow(
			expect.objectContaining({ code: 'INVALID_SNAPSHOT' })
		)
	})

	it('rejects stale review context before loading document records', () => {
		const value = makeEnvelope()
		expect(() => parseReviewVideoSnapshot(value, { ...review, scope: 'other' }, source)).toThrow(
			expect.objectContaining({ code: 'SNAPSHOT_CONTEXT_MISMATCH' })
		)
		expect(() =>
			parseReviewVideoSnapshot(value, { ...review, versionId: review.versionId + 1 }, source)
		).toThrow(expect.objectContaining({ code: 'SNAPSHOT_CONTEXT_MISMATCH' }))
	})

	it('rejects unknown envelope fields, kinds, and schema versions', () => {
		const value = makeEnvelope()
		expect(() => parseReviewVideoSnapshot({ ...value, unexpected: true }, review)).toThrow(
			expect.objectContaining({ code: 'INVALID_SNAPSHOT' })
		)
		expect(() =>
			parseReviewVideoSnapshot({ ...value, kind: 'shotgrid-review-annotation' }, review)
		).toThrow(expect.objectContaining({ code: 'INVALID_SNAPSHOT' }))
		expect(() => parseReviewVideoSnapshot({ ...value, schemaVersion: 2 }, review)).toThrow(
			expect.objectContaining({ code: 'UNSUPPORTED_SNAPSHOT_VERSION' })
		)
	})

	it.each([
		['attachment', { attachmentId: 402 }],
		['width', { width: 1280 }],
		['height', { height: 720 }],
		['duration', { durationMs: 5_001 }],
		['frame count', { frameCount: 119 }],
		['frame rate', { frameRate: 23.976 }],
		['frame-rate mode', { frameRateMode: 'variable' as const }],
		['first frame', { firstFrame: 0 }],
		['last frame', { lastFrame: 1121 }],
	])('rejects changed %s source metadata', (_label, changed) => {
		const current = { ...source, ...changed }
		expect(() => assertReviewVideoSnapshotSource(source, current)).toThrow(
			expect.objectContaining({ code: 'SNAPSHOT_SOURCE_MISMATCH' })
		)
		expect(() => parseReviewVideoSnapshot(makeEnvelope(), review, current)).toThrow(
			expect.objectContaining({ code: 'SNAPSHOT_SOURCE_MISMATCH' })
		)
	})

	it('requires a single locked source shape with matching identity, dimensions, and metadata', () => {
		const unlocked = makeEditorSnapshot()
		getSourceShape(unlocked).isLocked = false
		expect(() => assertRecords(unlocked)).toThrow(/not protected/i)

		const wrongAttachment = makeEditorSnapshot()
		getSourceProps(wrongAttachment).attachmentId = source.attachmentId + 1
		expect(() => assertRecords(wrongAttachment)).toThrow(/source fingerprint/i)

		const externalUrl = makeEditorSnapshot()
		getSourceProps(externalUrl).url = 'https://evil.example/review.mp4'
		expect(() => assertRecords(externalUrl)).toThrow(/invalid/i)

		const wrongDimensions = makeEditorSnapshot()
		getSourceMeta(wrongDimensions).width = source.width - 1
		expect(() => assertRecords(wrongDimensions)).toThrow(/source metadata/i)
	})

	it('allows only review annotation shapes and never assets or extra video shapes', () => {
		const withAsset = makeEditorSnapshot()
		getStore(withAsset)['asset:movie'] = {
			id: 'asset:movie',
			props: { src: 'https://evil.example/review.mp4' },
			type: 'video',
			typeName: 'asset',
		}
		expect(() => assertRecords(withAsset)).toThrow(/cannot contain assets/i)

		const extraVideo = makeEditorSnapshot()
		getStore(extraVideo)['shape:movie'] = {
			id: 'shape:movie',
			parentId: 'page:page',
			type: 'video',
			typeName: 'shape',
		}
		expect(() => assertRecords(extraVideo)).toThrow(/unsupported video shape/i)
	})

	it('requires every non-group annotation to have a target inside current timing bounds', () => {
		const missing = makeEditorSnapshot()
		delete getShape(missing, 'shape:draw').meta
		expect(() => assertRecords(missing)).toThrow(/frame or time target/i)

		const frameOutOfBounds = makeEditorSnapshot()
		getShapeMeta(frameOutOfBounds, 'shape:draw')[REVIEW_ANNOTATION_TARGET_META_KEY] = {
			endFrame: 1121,
			kind: 'frame',
			startFrame: 1121,
		}
		expect(() => assertRecords(frameOutOfBounds)).toThrow(/timing boundaries/i)

		const timeOutOfBounds = makeEditorSnapshot()
		getShapeMeta(timeOutOfBounds, 'shape:text')[REVIEW_ANNOTATION_TARGET_META_KEY] = {
			endTimeMs: source.durationMs + 1,
			kind: 'time',
			startTimeMs: source.durationMs,
		}
		expect(() => assertRecords(timeOutOfBounds)).toThrow(/timing boundaries/i)
	})

	it('rejects frame targets when incomplete metadata selects the honest time-only fallback', () => {
		const timeOnlySource = { ...source, frameRate: null }
		expect(() =>
			assertReviewVideoSnapshotRecords(makeEditorSnapshot(), {
				review,
				source: timeOnlySource,
			})
		).toThrow(/timing boundaries/i)

		const timeTargetSnapshot = makeEditorSnapshot()
		for (const shapeId of ['shape:arrow', 'shape:draw', 'shape:geo', 'shape:text']) {
			getShapeMeta(timeTargetSnapshot, shapeId)[REVIEW_ANNOTATION_TARGET_META_KEY] = {
				endTimeMs: 2_000,
				kind: 'time',
				startTimeMs: 1_000,
			}
		}
		expect(() =>
			assertReviewVideoSnapshotRecords(timeTargetSnapshot, {
				review,
				source: timeOnlySource,
			})
		).not.toThrow()
	})

	it('preserves typed but unsupported timing metadata for an honest time-only fallback', () => {
		const unsupportedRateSource = { ...source, frameRate: 1_000 }
		const timeTargetSnapshot = makeEditorSnapshot()
		for (const shapeId of ['shape:arrow', 'shape:draw', 'shape:geo', 'shape:text']) {
			getShapeMeta(timeTargetSnapshot, shapeId)[REVIEW_ANNOTATION_TARGET_META_KEY] = {
				endTimeMs: 2_000,
				kind: 'time',
				startTimeMs: 1_000,
			}
		}
		expect(() =>
			assertReviewVideoSnapshotRecords(timeTargetSnapshot, {
				review,
				source: unsupportedRateSource,
			})
		).not.toThrow()
	})

	it('validates arrow bindings and annotation group ancestry', () => {
		const boundToSource = makeEditorSnapshot()
		getBinding(boundToSource).toId = getReviewVideoShapeId(review.versionId)
		expect(() => assertRecords(boundToSource)).toThrow(/binding references/i)

		const wrongFrom = makeEditorSnapshot()
		getBinding(wrongFrom).fromId = 'shape:geo'
		expect(() => assertRecords(wrongFrom)).toThrow(/binding references/i)

		const boundToSameTargetGroup = makeEditorSnapshot()
		getBinding(boundToSameTargetGroup).toId = 'shape:group'
		expect(() => assertRecords(boundToSameTargetGroup)).not.toThrow()

		const crossFrameBinding = makeEditorSnapshot()
		getShapeMeta(crossFrameBinding, 'shape:geo')[REVIEW_ANNOTATION_TARGET_META_KEY] = {
			endFrame: 1002,
			kind: 'frame',
			startFrame: 1002,
		}
		expect(() => assertRecords(crossFrameBinding)).toThrow(/binding crosses frame\/time targets/i)

		const crossGroupBinding = makeEditorSnapshot()
		getBinding(crossGroupBinding).toId = 'shape:group'
		getShapeMeta(crossGroupBinding, 'shape:draw')[REVIEW_ANNOTATION_TARGET_META_KEY] = {
			endFrame: 1002,
			kind: 'frame',
			startFrame: 1002,
		}
		expect(() => assertRecords(crossGroupBinding)).toThrow(/binding crosses frame\/time targets/i)

		const cyclicGroup = makeEditorSnapshot()
		getShape(cyclicGroup, 'shape:group').parentId = 'shape:group'
		expect(() => assertRecords(cyclicGroup)).toThrow(/parent hierarchy/i)

		const mixedTargets = makeEditorSnapshot()
		getShape(mixedTargets, 'shape:text').parentId = 'shape:group'
		expect(() => assertRecords(mixedTargets)).toThrow(/mixed frame\/time targets/i)
	})

	it('enforces the 5,000-record open limit', () => {
		const tooMany = makeEditorSnapshot()
		const store = getStore(tooMany)
		for (let index = 0; index <= MAX_REVIEW_VIDEO_SNAPSHOT_RECORDS; index++) {
			store[`user:${index}`] = {
				id: `user:${index}`,
				imageUrl: '',
				typeName: 'user',
			}
		}
		expect(() => assertRecords(tooMany)).toThrow(/too many records/i)
	})

	it('enforces the 16 MiB limit for JSON loading and serialization', () => {
		const oversized = makeEnvelope()
		getShape(oversized.snapshot, 'shape:text').props = { text: 'x'.repeat(16 * 1024 * 1024) }
		expect(() => serializeReviewVideoSnapshot(oversized)).toThrow(/16 MiB/i)
		expect(() => parseReviewVideoSnapshotJson(' '.repeat(16 * 1024 * 1024 + 1), review)).toThrow(
			/16 MiB/i
		)
	})

	it('rejects malformed or non-canonical source fingerprints', () => {
		const value = makeEnvelope()
		expect(() =>
			parseReviewVideoSnapshot({ ...value, source: { ...source, durationMs: 5_000.5 } }, review)
		).toThrow(expect.objectContaining({ code: 'INVALID_SNAPSHOT' }))
		expect(() =>
			parseReviewVideoSnapshot(
				{ ...value, source: { ...source, contentType: 'video/quicktime' } },
				review
			)
		).toThrow(expect.objectContaining({ code: 'INVALID_SNAPSHOT' }))
	})
})

function makeEnvelope(): ReviewVideoSnapshot {
	return {
		kind: REVIEW_VIDEO_SNAPSHOT_KIND,
		review,
		savedAt: '2026-07-21T00:00:00.000Z',
		schemaVersion: 1,
		snapshot: makeEditorSnapshot(),
		source,
	}
}

function makeEditorSnapshot(): TLEditorSnapshot {
	const sourceShapeId = getReviewVideoShapeId(review.versionId)
	const frameTarget = {
		endFrame: 1010,
		kind: 'frame',
		startFrame: 1001,
	}
	const store: Record<string, unknown> = {
		'document:document': { id: 'document:document', typeName: 'document' },
		'page:page': { id: 'page:page', typeName: 'page' },
		[sourceShapeId]: {
			id: sourceShapeId,
			isLocked: true,
			meta: {
				attachmentId: source.attachmentId,
				height: source.height,
				role: 'shotgrid-review-video-source',
				schemaVersion: 1,
				versionId: review.versionId,
				width: source.width,
			},
			opacity: 1,
			parentId: 'page:page',
			props: {
				attachmentId: source.attachmentId,
				h: source.height,
				name: 'Review movie.mp4',
				versionId: review.versionId,
				w: source.width,
			},
			rotation: 0,
			type: 'review-video',
			typeName: 'shape',
			x: 0,
			y: 0,
		},
		'shape:group': {
			id: 'shape:group',
			meta: {},
			parentId: 'page:page',
			type: 'group',
			typeName: 'shape',
		},
		'shape:draw': annotationShape('shape:draw', 'draw', 'shape:group', frameTarget),
		'shape:arrow': annotationShape('shape:arrow', 'arrow', 'page:page', frameTarget),
		'shape:geo': annotationShape('shape:geo', 'geo', 'page:page', frameTarget),
		'shape:text': annotationShape('shape:text', 'text', 'page:page', {
			endTimeMs: 2_000,
			kind: 'time',
			startTimeMs: 1_000,
		}),
		'binding:arrow-geo': {
			fromId: 'shape:arrow',
			id: 'binding:arrow-geo',
			meta: {},
			props: {},
			toId: 'shape:geo',
			type: 'arrow',
			typeName: 'binding',
		},
		'user:reviewer': {
			id: 'user:reviewer',
			imageUrl: '',
			name: 'Reviewer',
			typeName: 'user',
		},
	}
	return {
		document: { schema: {}, store: store as never },
		session: {},
	} as unknown as TLEditorSnapshot
}

function annotationShape(
	id: string,
	type: string,
	parentId: string,
	target: Record<string, unknown>
) {
	return {
		id,
		meta: { [REVIEW_ANNOTATION_TARGET_META_KEY]: target },
		parentId,
		props: {},
		type,
		typeName: 'shape',
	}
}

function assertRecords(snapshot: TLEditorSnapshot) {
	return assertReviewVideoSnapshotRecords(snapshot, { review, source })
}

function getStore(snapshot: TLEditorSnapshot) {
	return snapshot.document.store as unknown as Record<string, Record<string, unknown>>
}

function getShape(snapshot: TLEditorSnapshot, id: string) {
	return getStore(snapshot)[id]
}

function getShapeMeta(snapshot: TLEditorSnapshot, id: string) {
	return getShape(snapshot, id).meta as Record<string, unknown>
}

function getSourceShape(snapshot: TLEditorSnapshot) {
	return getShape(snapshot, getReviewVideoShapeId(review.versionId))
}

function getSourceProps(snapshot: TLEditorSnapshot) {
	return getSourceShape(snapshot).props as Record<string, unknown>
}

function getSourceMeta(snapshot: TLEditorSnapshot) {
	return getSourceShape(snapshot).meta as Record<string, unknown>
}

function getBinding(snapshot: TLEditorSnapshot) {
	return getStore(snapshot)['binding:arrow-geo']
}
