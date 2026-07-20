import { describe, expect, it } from 'vitest'
import {
	createFrameAnnotationTarget,
	createReviewAnnotationTarget,
	createTimeAnnotationTarget,
	isReviewAnnotationVisibleAtPlayhead,
	mediaTimeToMilliseconds,
	normalizeReviewAnnotationTarget,
	parseReviewAnnotationTarget,
	REVIEW_ANNOTATION_TARGET_META_KEY,
	ReviewAnnotationTargetError,
} from './reviewAnnotationTarget'
import {
	createReviewVideoTiming,
	type ReviewVideoFrameTiming,
	type ReviewVideoTiming,
} from './reviewVideoTiming'

describe('review annotation target creation', () => {
	it('uses one stable shape-meta persistence key', () => {
		expect(REVIEW_ANNOTATION_TARGET_META_KEY).toBe('reviewAnnotationTarget')
	})

	it('represents a single frame with equal inclusive bounds', () => {
		expect(createFrameAnnotationTarget(1001)).toEqual({
			endFrame: 1001,
			kind: 'frame',
			startFrame: 1001,
		})
	})

	it('represents inclusive frame ranges without reordering them', () => {
		expect(createFrameAnnotationTarget(1001, 1003)).toEqual({
			endFrame: 1003,
			kind: 'frame',
			startFrame: 1001,
		})
		expect(() => createFrameAnnotationTarget(1003, 1001)).toThrow(ReviewAnnotationTargetError)
	})

	it('canonicalizes time-only targets to integer milliseconds', () => {
		expect(createTimeAnnotationTarget(1.2345, 2.3456)).toEqual({
			endTimeMs: 2346,
			kind: 'time',
			startTimeMs: 1235,
		})
		expect(createTimeAnnotationTarget(1.25)).toEqual({
			endTimeMs: 1250,
			kind: 'time',
			startTimeMs: 1250,
		})
	})

	it('uses frames only for verified frame timing and time for every fallback', () => {
		expect(createReviewAnnotationTarget(frameTiming(), 1 / 24, 3 / 24)).toEqual({
			endFrame: 1004,
			kind: 'frame',
			startFrame: 1002,
		})
		expect(createReviewAnnotationTarget(timeTiming(), 0.25, 0.75)).toEqual({
			endTimeMs: 750,
			kind: 'time',
			startTimeMs: 250,
		})
	})
})

describe('parseReviewAnnotationTarget', () => {
	it.each([
		{ endFrame: 1003, kind: 'frame', startFrame: 1001 },
		{ endTimeMs: 500, kind: 'time', startTimeMs: 250 },
	])('returns a canonical copy of $kind targets', (target) => {
		expect(parseReviewAnnotationTarget(target)).toEqual(target)
		expect(parseReviewAnnotationTarget(target)).not.toBe(target)
	})

	it.each([
		null,
		[],
		{},
		{ endFrame: 1001, kind: 'frame' },
		{ endFrame: 1001, extra: true, kind: 'frame', startFrame: 1001 },
		{ endFrame: 1001.5, kind: 'frame', startFrame: 1001 },
		{ endFrame: 1001, kind: 'frame', startFrame: -1 },
		{ endFrame: 1001, kind: 'frame', startFrame: 1002 },
		{ endTimeMs: 100, kind: 'time', startTimeMs: 101 },
		{ endTimeMs: 100, kind: 'time', startTimeMs: Number.NaN },
		{ endTimeMs: 100, kind: 'unknown', startTimeMs: 100 },
	])('rejects malformed, extra, fractional, or inverted target %#', (target) => {
		expect(() => parseReviewAnnotationTarget(target)).toThrow(ReviewAnnotationTargetError)
	})
})

describe('normalizeReviewAnnotationTarget', () => {
	it('accepts targets within current verified media bounds', () => {
		expect(
			normalizeReviewAnnotationTarget(
				{ endFrame: 1100, kind: 'frame', startFrame: 1001 },
				frameTiming()
			)
		).toEqual({ endFrame: 1100, kind: 'frame', startFrame: 1001 })
		expect(
			normalizeReviewAnnotationTarget(
				{ endTimeMs: 1000, kind: 'time', startTimeMs: 0 },
				timeTiming()
			)
		).toEqual({ endTimeMs: 1000, kind: 'time', startTimeMs: 0 })
	})

	it('rejects frame bounds outside the verified source range', () => {
		expect(() =>
			normalizeReviewAnnotationTarget(
				{ endFrame: 1001, kind: 'frame', startFrame: 1000 },
				frameTiming()
			)
		).toThrow(expect.objectContaining({ code: 'TARGET_OUT_OF_BOUNDS' }))
	})

	it('never interprets frame targets against a time-only fallback', () => {
		expect(() =>
			normalizeReviewAnnotationTarget(
				{ endFrame: 1001, kind: 'frame', startFrame: 1001 },
				timeTiming()
			)
		).toThrow(expect.objectContaining({ code: 'TARGET_TIMING_MISMATCH' }))
	})

	it('rejects time bounds beyond a known browser duration', () => {
		expect(() =>
			normalizeReviewAnnotationTarget(
				{ endTimeMs: 1001, kind: 'time', startTimeMs: 1000 },
				timeTiming()
			)
		).toThrow(expect.objectContaining({ code: 'TARGET_OUT_OF_BOUNDS' }))
	})
})

describe('isReviewAnnotationVisibleAtPlayhead', () => {
	it('shows a frame range for all included frames and hides adjacent frames', () => {
		const timing = frameTiming()
		const target = createFrameAnnotationTarget(1002, 1003)

		expect(isReviewAnnotationVisibleAtPlayhead(target, timing, 1 / 24 - 0.000_001)).toBe(false)
		expect(isReviewAnnotationVisibleAtPlayhead(target, timing, 1 / 24)).toBe(true)
		expect(isReviewAnnotationVisibleAtPlayhead(target, timing, 3 / 24 - 0.000_001)).toBe(true)
		expect(isReviewAnnotationVisibleAtPlayhead(target, timing, 3 / 24)).toBe(false)
	})

	it('treats single-frame and final-frame bounds as inclusive', () => {
		const timing = frameTiming()

		expect(
			isReviewAnnotationVisibleAtPlayhead(createFrameAnnotationTarget(1002), timing, 1.5 / 24)
		).toBe(true)
		expect(
			isReviewAnnotationVisibleAtPlayhead(
				createFrameAnnotationTarget(1100),
				timing,
				timing.durationSeconds
			)
		).toBe(true)
	})

	it('uses closed millisecond ranges in time-only mode', () => {
		const timing = timeTiming()
		const target = createTimeAnnotationTarget(0.25, 0.5)

		expect(isReviewAnnotationVisibleAtPlayhead(target, timing, 0.249)).toBe(false)
		expect(isReviewAnnotationVisibleAtPlayhead(target, timing, 0.25)).toBe(true)
		expect(isReviewAnnotationVisibleAtPlayhead(target, timing, 0.5)).toBe(true)
		expect(isReviewAnnotationVisibleAtPlayhead(target, timing, 0.501)).toBe(false)
	})

	it('returns false for invalid or out-of-media playheads', () => {
		const timing = timeTiming()
		const target = createTimeAnnotationTarget(0)

		expect(isReviewAnnotationVisibleAtPlayhead(target, timing, -1)).toBe(false)
		expect(isReviewAnnotationVisibleAtPlayhead(target, timing, Number.NaN)).toBe(false)
		expect(isReviewAnnotationVisibleAtPlayhead(target, timing, 2)).toBe(false)
	})
})

describe('mediaTimeToMilliseconds', () => {
	it('rounds once to the persisted time-only precision', () => {
		expect(mediaTimeToMilliseconds(23.976_5)).toBe(23_977)
		expect(() => mediaTimeToMilliseconds(-0.001)).toThrow(ReviewAnnotationTargetError)
	})
})

function frameTiming(): ReviewVideoFrameTiming {
	const timing = createReviewVideoTiming({
		durationSeconds: 100 / 24,
		firstFrame: 1001,
		frameCount: 100,
		frameRate: 24,
		lastFrame: 1100,
	})
	if (timing.mode !== 'frames') throw new Error('Expected frame timing in test.')
	return timing
}

function timeTiming(): ReviewVideoTiming {
	return createReviewVideoTiming({ durationSeconds: 1 })
}
