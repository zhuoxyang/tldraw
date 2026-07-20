import { describe, expect, it } from 'vitest'
import {
	MAX_REVIEW_VIDEO_DURATION_SECONDS,
	MAX_REVIEW_VIDEO_FRAME_COUNT,
	MAX_REVIEW_VIDEO_FRAME_NUMBER,
	MAX_REVIEW_VIDEO_FRAME_RATE,
	clampReviewVideoTime,
	createReviewVideoTiming,
	formatReviewVideoTime,
	formatReviewVideoTimecode,
	frameToMediaTime,
	mediaTimeToFrame,
	type ReviewVideoFrameTiming,
	type ReviewVideoTimingInput,
} from './reviewVideoTiming'

describe('createReviewVideoTiming', () => {
	it.each([
		[24, 240],
		[23.976, 240],
		[29.97, 300],
	])('creates a verified fixed-frame model for %s fps', (frameRate, frameCount) => {
		const timing = createReviewVideoTiming({
			durationSeconds: frameCount / frameRate,
			firstFrame: 1001,
			frameCount,
			frameRate,
			lastFrame: 1000 + frameCount,
		})

		expect(timing).toEqual({
			durationSeconds: frameCount / frameRate,
			firstFrame: 1001,
			frameCount,
			frameNumbering: 'source',
			frameRate,
			lastFrame: 1000 + frameCount,
			mode: 'frames',
			nominalFrameRate: Math.round(frameRate),
		})
	})

	it.each([
		['durationSeconds', undefined, 'missing-duration'],
		['frameRate', null, 'missing-frame-rate'],
		['frameCount', undefined, 'missing-frame-count'],
	] as const)('falls back instead of inventing frames when %s is missing', (key, value, reason) => {
		const input = validInput()
		input[key] = value

		expect(createReviewVideoTiming(input)).toMatchObject({
			fallbackReason: reason,
			mode: 'time',
		})
	})

	it.each([
		['durationSeconds', 0, 'invalid-duration'],
		['durationSeconds', -1, 'invalid-duration'],
		['durationSeconds', Number.POSITIVE_INFINITY, 'invalid-duration'],
		['durationSeconds', MAX_REVIEW_VIDEO_DURATION_SECONDS + 1, 'invalid-duration'],
		['frameRate', 0, 'invalid-frame-rate'],
		['frameRate', -24, 'invalid-frame-rate'],
		['frameRate', MAX_REVIEW_VIDEO_FRAME_RATE + 1, 'invalid-frame-rate'],
		['frameCount', 0, 'invalid-frame-count'],
		['frameCount', -1, 'invalid-frame-count'],
		['frameCount', 1.5, 'invalid-frame-count'],
		['frameCount', MAX_REVIEW_VIDEO_FRAME_COUNT + 1, 'invalid-frame-count'],
		['firstFrame', -1, 'invalid-frame-range'],
		['lastFrame', MAX_REVIEW_VIDEO_FRAME_NUMBER + 1, 'invalid-frame-range'],
	] as const)('uses time-only fallback for unsafe %s metadata', (key, value, reason) => {
		const input = validInput()
		input[key] = value

		expect(createReviewVideoTiming(input)).toMatchObject({
			fallbackReason: reason,
			mode: 'time',
		})
	})

	it('retains a valid browser duration in time-only mode', () => {
		expect(createReviewVideoTiming({ durationSeconds: 12.5 })).toEqual({
			durationSeconds: 12.5,
			fallbackReason: 'missing-frame-rate',
			mode: 'time',
		})
	})

	it('uses explicit relative numbering when ShotGrid has no source-frame range', () => {
		expect(
			createReviewVideoTiming({
				durationSeconds: 100 / 24,
				frameCount: 100,
				frameRate: 24,
			})
		).toEqual({
			durationSeconds: 100 / 24,
			firstFrame: 0,
			frameCount: 100,
			frameNumbering: 'relative',
			frameRate: 24,
			lastFrame: 99,
			mode: 'frames',
			nominalFrameRate: 24,
		})
	})

	it('derives the missing end of a partial source-frame range', () => {
		expect(
			createReviewVideoTiming({
				durationSeconds: 100 / 24,
				firstFrame: 1001,
				frameCount: 100,
				frameRate: 24,
			})
		).toMatchObject({ firstFrame: 1001, frameNumbering: 'source', lastFrame: 1100 })
		expect(
			createReviewVideoTiming({
				durationSeconds: 100 / 24,
				frameCount: 100,
				frameRate: 24,
				lastFrame: 1100,
			})
		).toMatchObject({ firstFrame: 1001, frameNumbering: 'source', lastFrame: 1100 })
	})

	it('falls back when a partial source-frame range cannot be derived safely', () => {
		expect(
			createReviewVideoTiming({
				durationSeconds: 100 / 24,
				frameCount: 100,
				frameRate: 24,
				lastFrame: 50,
			})
		).toMatchObject({ fallbackReason: 'invalid-frame-range', mode: 'time' })
	})

	it('rejects contradictory frame ranges and decoded durations', () => {
		expect(createReviewVideoTiming({ ...validInput(), lastFrame: 1099 })).toMatchObject({
			fallbackReason: 'inconsistent-frame-range',
			mode: 'time',
		})
		expect(createReviewVideoTiming({ ...validInput(), durationSeconds: 5 })).toEqual({
			durationSeconds: 5,
			fallbackReason: 'inconsistent-duration',
			mode: 'time',
		})
	})

	it('explicitly falls back for variable-frame-rate media even when nominal metadata agrees', () => {
		expect(createReviewVideoTiming({ ...validInput(), frameRateMode: 'variable' })).toEqual({
			durationSeconds: 100 / 24,
			fallbackReason: 'variable-frame-rate',
			mode: 'time',
		})
	})

	it('does not claim frame accuracy for media without a deployment CFR guarantee', () => {
		expect(createReviewVideoTiming({ ...validInput(), frameRateMode: 'unknown' })).toEqual({
			durationSeconds: 100 / 24,
			fallbackReason: 'unverified-frame-rate',
			mode: 'time',
		})
	})
})

describe('frame and time conversion', () => {
	it('uses source first-frame offsets and seeks to frame centers', () => {
		const timing = frameTiming()

		expect(frameToMediaTime(timing, 1001)).toBeCloseTo(0.5 / 24, 12)
		expect(frameToMediaTime(timing, 1002)).toBeCloseTo(1.5 / 24, 12)
		expect(mediaTimeToFrame(timing, 0)).toBe(1001)
		expect(mediaTimeToFrame(timing, 1 / 24 - Number.EPSILON)).toBe(1001)
		expect(mediaTimeToFrame(timing, 1 / 24)).toBe(1002)
		expect(mediaTimeToFrame(timing, frameToMediaTime(timing, 1075))).toBe(1075)
	})

	it('clamps the last frame center inside a slightly shorter authoritative duration', () => {
		const timing = requireFrameTiming(
			createReviewVideoTiming({
				durationSeconds: 2 / 24 - 0.5 / 24,
				firstFrame: 10,
				frameCount: 2,
				frameRate: 24,
				lastFrame: 11,
			})
		)

		const seekTime = frameToMediaTime(timing, 11)
		expect(seekTime).toBeLessThan(timing.durationSeconds)
		expect(mediaTimeToFrame(timing, seekTime)).toBe(11)
		expect(mediaTimeToFrame(timing, timing.durationSeconds)).toBe(11)
	})

	it.each([23.976, 29.97])('round-trips frame centers stably at %s fps', (frameRate) => {
		const timing = requireFrameTiming(
			createReviewVideoTiming({
				durationSeconds: 300 / frameRate,
				firstFrame: 1001,
				frameCount: 300,
				frameRate,
				lastFrame: 1300,
			})
		)

		for (const frame of [timing.firstFrame, 1073, 1199, timing.lastFrame]) {
			expect(mediaTimeToFrame(timing, frameToMediaTime(timing, frame))).toBe(frame)
		}
	})

	it('rejects frame and time values outside a verified model', () => {
		const timing = frameTiming()

		expect(() => frameToMediaTime(timing, 1000)).toThrow(RangeError)
		expect(() => frameToMediaTime(timing, 1101)).toThrow(RangeError)
		expect(() => mediaTimeToFrame(timing, -0.001)).toThrow(RangeError)
		expect(() => mediaTimeToFrame(timing, timing.durationSeconds + 0.001)).toThrow(RangeError)
	})

	it('provides an explicit clamping helper for browser seek input', () => {
		const timing = frameTiming()

		expect(clampReviewVideoTime(timing, -1)).toBe(0)
		expect(clampReviewVideoTime(timing, 999)).toBe(timing.durationSeconds)
		expect(() => clampReviewVideoTime(timing, Number.NaN)).toThrow(RangeError)
	})
})

describe('time display', () => {
	it('formats 24 fps source frames as relative NDF timecode', () => {
		const timing = frameTiming()

		expect(formatReviewVideoTimecode(timing, 1001)).toBe('00:00:00:00')
		expect(formatReviewVideoTimecode(timing, 1025)).toBe('00:00:01:00')
		expect(formatReviewVideoTimecode(timing, 1100)).toBe('00:00:04:03')
	})

	it.each([
		[23.976, 24, '00:00:01:00'],
		[29.97, 1_800, '00:01:00:00'],
	])('uses nominal NDF counting at %s fps', (frameRate, relativeFrame, expected) => {
		const timing = requireFrameTiming(
			createReviewVideoTiming({
				durationSeconds: (relativeFrame + 1) / frameRate,
				firstFrame: 1001,
				frameCount: relativeFrame + 1,
				frameRate,
				lastFrame: 1001 + relativeFrame,
			})
		)

		expect(formatReviewVideoTimecode(timing, 1001 + relativeFrame)).toBe(expected)
	})

	it('formats honest millisecond time with rounded carry', () => {
		expect(formatReviewVideoTime(0)).toBe('00:00:00.000')
		expect(formatReviewVideoTime(61.2345)).toBe('00:01:01.235')
		expect(formatReviewVideoTime(3_599.9996)).toBe('01:00:00.000')
		expect(() => formatReviewVideoTime(-1)).toThrow(RangeError)
	})
})

function validInput(): ReviewVideoTimingInput {
	return {
		durationSeconds: 100 / 24,
		firstFrame: 1001,
		frameCount: 100,
		frameRate: 24,
		lastFrame: 1100,
	}
}

function frameTiming() {
	return requireFrameTiming(createReviewVideoTiming(validInput()))
}

function requireFrameTiming(timing: ReturnType<typeof createReviewVideoTiming>) {
	if (timing.mode !== 'frames') throw new Error('Expected frame timing in test.')
	return timing satisfies ReviewVideoFrameTiming
}
