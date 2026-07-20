import type { ReviewVideoMedia } from '@tldraw/shotgrid-review-contracts'
import type { Editor, JsonObject, TLShape, TLShapeId } from 'tldraw'
import { describe, expect, it } from 'vitest'
import { REVIEW_ANNOTATION_TARGET_META_KEY } from './reviewAnnotationTarget'
import {
	createTargetForAnnotationSpan,
	canGroupReviewAnnotationShapes,
	getReviewAnnotationGroupTarget,
	getVisibleReviewAnnotationShapeIds,
	isReviewAnnotationBindingCompatible,
	isReviewAnnotationShapeParentCompatible,
	resolveReviewVideoMetadata,
} from './ReviewVideoCanvas'
import { createReviewVideoTiming } from './reviewVideoTiming'

const media: ReviewVideoMedia = {
	attachmentId: 901,
	contentType: 'video/mp4',
	durationSeconds: 1,
	fileName: 'shot_010.mp4',
	firstFrame: 1001,
	frameCount: 24,
	frameRate: 24,
	frameRateMode: 'constant',
	height: null,
	kind: 'video',
	lastFrame: 1024,
	thumbnailUrl: null,
	url: '/api/review/playlists/201/versions/301/media/video/901',
	width: null,
}

describe('resolveReviewVideoMetadata', () => {
	it('uses decoded dimensions and verified source-frame timing', () => {
		const result = resolveReviewVideoMetadata(media, {
			duration: 1,
			videoHeight: 1080,
			videoWidth: 1920,
		})

		expect(result).toMatchObject({
			durationSeconds: 1,
			height: 1080,
			timing: {
				firstFrame: 1001,
				frameNumbering: 'source',
				lastFrame: 1024,
				mode: 'frames',
			},
			width: 1920,
		})
	})

	it('uses relative frames when ShotGrid does not provide a source range', () => {
		const result = resolveReviewVideoMetadata(
			{ ...media, firstFrame: null, lastFrame: null },
			{ duration: 1, videoHeight: 720, videoWidth: 1280 }
		)

		expect(result.timing).toMatchObject({
			firstFrame: 0,
			frameNumbering: 'relative',
			lastFrame: 23,
			mode: 'frames',
		})
	})

	it('falls back to decoded time rather than inventing frames without FPS', () => {
		const result = resolveReviewVideoMetadata(
			{ ...media, frameRate: null },
			{ duration: 1, videoHeight: 720, videoWidth: 1280 }
		)

		expect(result.timing).toEqual({
			durationSeconds: 1,
			fallbackReason: 'missing-frame-rate',
			mode: 'time',
		})
	})

	it('rejects decoded dimensions that conflict with declared metadata', () => {
		expect(() =>
			resolveReviewVideoMetadata(
				{ ...media, height: 1080, width: 1920 },
				{ duration: 1, videoHeight: 720, videoWidth: 1280 }
			)
		).toThrow('do not match ShotGrid metadata')
	})

	it('rejects decoded media beyond the bounded review duration', () => {
		expect(() =>
			resolveReviewVideoMetadata(media, {
				duration: 24 * 60 * 60 + 0.001,
				videoHeight: 1080,
				videoWidth: 1920,
			})
		).toThrow('24-hour review limit')
	})
})

describe('video annotation spans', () => {
	it('creates an inclusive frame range and clamps it at the final frame', () => {
		const timing = createReviewVideoTiming({
			durationSeconds: 1,
			firstFrame: 1001,
			frameCount: 24,
			frameRate: 24,
			lastFrame: 1024,
		})

		expect(createTargetForAnnotationSpan(timing, 22.5 / 24, 4)).toEqual({
			endFrame: 1024,
			kind: 'frame',
			startFrame: 1023,
		})
	})

	it('creates a millisecond range in time-only mode', () => {
		const timing = createReviewVideoTiming({ durationSeconds: 5, frameRate: null })

		expect(createTargetForAnnotationSpan(timing, 1.25, 0.5)).toEqual({
			endTimeMs: 1750,
			kind: 'time',
			startTimeMs: 1250,
		})
	})

	it('rejects non-integer frame spans', () => {
		const timing = createReviewVideoTiming({
			durationSeconds: 1,
			frameCount: 24,
			frameRate: 24,
		})
		expect(createTargetForAnnotationSpan(timing, 0, 1.5)).toBeNull()
	})
})

describe('visible video annotations', () => {
	it('exports only leaf annotations visible in the inclusive current frame range', () => {
		const timing = createReviewVideoTiming({
			durationSeconds: 1,
			firstFrame: 1001,
			frameCount: 24,
			frameRate: 24,
			lastFrame: 1024,
		})
		const sourceId = 'shape:source' as TLShapeId
		const visibleId = 'shape:visible' as TLShapeId
		const shapes = [
			shape(sourceId, 'review-video', undefined),
			shape(visibleId, 'draw', { endFrame: 1005, kind: 'frame', startFrame: 1003 }),
			shape('shape:hidden' as TLShapeId, 'text', {
				endFrame: 1010,
				kind: 'frame',
				startFrame: 1006,
			}),
			shape('shape:invalid' as TLShapeId, 'geo', { endFrame: 1, kind: 'frame' }),
			shape('shape:group' as TLShapeId, 'group', undefined),
		]
		const editor = { getCurrentPageShapes: () => shapes } as unknown as Editor

		expect(getVisibleReviewAnnotationShapeIds(editor, timing, 3.5 / 24, sourceId)).toEqual([
			visibleId,
		])
	})

	it('allows grouped editing only when every leaf has the same frame/time target', () => {
		const timing = createReviewVideoTiming({
			durationSeconds: 1,
			firstFrame: 1001,
			frameCount: 24,
			frameRate: 24,
			lastFrame: 1024,
		})
		const groupId = 'shape:group' as TLShapeId
		const firstId = 'shape:first' as TLShapeId
		const secondId = 'shape:second' as TLShapeId
		const shapes = new Map<TLShapeId, TLShape>([
			[groupId, shape(groupId, 'group', undefined)],
			[firstId, shape(firstId, 'draw', { endFrame: 1002, kind: 'frame', startFrame: 1001 })],
			[secondId, shape(secondId, 'text', { endFrame: 1002, kind: 'frame', startFrame: 1001 })],
		])
		const editor = {
			getShape: (id: TLShapeId) => shapes.get(id),
			getSortedChildIdsForParent: () => [firstId, secondId],
		} as unknown as Editor

		expect(getReviewAnnotationGroupTarget(editor, groupId, timing)).toEqual({
			endFrame: 1002,
			kind: 'frame',
			startFrame: 1001,
		})
		shapes.set(
			secondId,
			shape(secondId, 'text', { endFrame: 1003, kind: 'frame', startFrame: 1003 })
		)
		expect(getReviewAnnotationGroupTarget(editor, groupId, timing)).toBeNull()
	})

	it('prevents normal grouping, reparenting, and arrow binding across temporal targets', () => {
		const timing = createReviewVideoTiming({
			durationSeconds: 1,
			firstFrame: 1001,
			frameCount: 24,
			frameRate: 24,
			lastFrame: 1024,
		})
		const pageId = 'page:page' as TLShapeId
		const groupId = 'shape:group' as TLShapeId
		const outerGroupId = 'shape:outer-group' as TLShapeId
		const innerGroupId = 'shape:inner-group' as TLShapeId
		const arrowId = 'shape:arrow' as TLShapeId
		const drawId = 'shape:draw' as TLShapeId
		const geoId = 'shape:geo' as TLShapeId
		const frame1001 = { endFrame: 1001, kind: 'frame', startFrame: 1001 }
		const frame1001To1003 = { endFrame: 1003, kind: 'frame', startFrame: 1001 }
		const group = shape(groupId, 'group', undefined, pageId)
		const outerGroup = shape(outerGroupId, 'group', undefined, pageId)
		const innerGroup = shape(innerGroupId, 'group', undefined, outerGroupId)
		const arrow = shape(arrowId, 'arrow', frame1001, pageId)
		const draw = shape(drawId, 'draw', frame1001, groupId)
		const geo = shape(geoId, 'geo', frame1001To1003, pageId)
		const outerSibling = shape('shape:outer-sibling' as TLShapeId, 'draw', frame1001, outerGroupId)
		const shapes = new Map<TLShapeId, TLShape>([
			[groupId, group],
			[outerGroupId, outerGroup],
			[innerGroupId, innerGroup],
			[arrowId, arrow],
			[drawId, draw],
			[geoId, geo],
			[outerSibling.id, outerSibling],
		])
		const editor = {
			getShape: (id: TLShapeId) => shapes.get(id),
			getSortedChildIdsForParent: (id: TLShapeId) =>
				[...shapes.values()].filter((item) => item.parentId === id).map((item) => item.id),
		} as unknown as Editor

		expect(canGroupReviewAnnotationShapes(editor, [arrow, draw], timing)).toBe(true)
		expect(canGroupReviewAnnotationShapes(editor, [arrow, geo], timing)).toBe(false)
		expect(
			isReviewAnnotationShapeParentCompatible(editor, { ...geo, parentId: groupId }, timing)
		).toBe(false)
		expect(
			isReviewAnnotationShapeParentCompatible(editor, { ...geo, parentId: innerGroupId }, timing)
		).toBe(false)
		expect(
			isReviewAnnotationBindingCompatible(
				editor,
				{ fromId: arrowId, toId: drawId, type: 'arrow' },
				timing
			)
		).toBe(true)
		expect(
			isReviewAnnotationBindingCompatible(
				editor,
				{ fromId: arrowId, toId: geoId, type: 'arrow' },
				timing
			)
		).toBe(false)
	})
})

function shape(
	id: TLShapeId,
	type: TLShape['type'],
	target: unknown,
	parentId = 'page:page' as TLShapeId
) {
	return {
		id,
		meta: target === undefined ? {} : { [REVIEW_ANNOTATION_TARGET_META_KEY]: target as JsonObject },
		parentId,
		type,
	} as TLShape
}
