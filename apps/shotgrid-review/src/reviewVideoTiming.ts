export const MAX_REVIEW_VIDEO_DURATION_SECONDS = 24 * 60 * 60
export const MAX_REVIEW_VIDEO_FRAME_COUNT = 1_000_000
export const MAX_REVIEW_VIDEO_FRAME_NUMBER = 10_000_000
export const MAX_REVIEW_VIDEO_FRAME_RATE = 240

const MIN_REVIEW_VIDEO_FRAME_RATE = 1
const LAST_FRAME_SEEK_EPSILON_SECONDS = 0.000_001

export type ReviewVideoTimingFallbackReason =
	| 'inconsistent-duration'
	| 'inconsistent-frame-range'
	| 'invalid-duration'
	| 'invalid-frame-count'
	| 'invalid-frame-range'
	| 'invalid-frame-rate'
	| 'missing-duration'
	| 'missing-frame-count'
	| 'missing-frame-rate'
	| 'unverified-frame-rate'
	| 'variable-frame-rate'

export interface ReviewVideoTimingInput {
	durationSeconds?: number | null
	firstFrame?: number | null
	frameCount?: number | null
	frameRate?: number | null
	frameRateMode?: 'constant' | 'unknown' | 'variable'
	lastFrame?: number | null
}

export interface ReviewVideoFrameTiming {
	durationSeconds: number
	firstFrame: number
	frameCount: number
	frameNumbering: 'relative' | 'source'
	frameRate: number
	lastFrame: number
	mode: 'frames'
	nominalFrameRate: number
}

export interface ReviewVideoTimeTiming {
	durationSeconds: number | null
	fallbackReason: ReviewVideoTimingFallbackReason
	mode: 'time'
}

export type ReviewVideoTiming = ReviewVideoFrameTiming | ReviewVideoTimeTiming

/**
 * Builds a frame timing model only when all constant-frame-rate claims agree with the browser's
 * decoded duration. Missing source-frame labels use explicit relative numbering; incomplete or
 * contradictory rate/count/duration inputs remain usable as a time-only model, from which callers
 * must not derive frame numbers.
 */
export function createReviewVideoTiming(input: ReviewVideoTimingInput): ReviewVideoTiming {
	const duration = readDuration(input.durationSeconds)
	if (duration.error) return timeOnly(null, duration.error)
	if (input.frameRateMode === 'variable') {
		return timeOnly(duration.value, 'variable-frame-rate')
	}
	if (input.frameRateMode === 'unknown') {
		return timeOnly(duration.value, 'unverified-frame-rate')
	}

	const frameRate = input.frameRate
	if (frameRate === null || frameRate === undefined) {
		return timeOnly(duration.value, 'missing-frame-rate')
	}
	if (!isValidFrameRate(frameRate)) {
		return timeOnly(duration.value, 'invalid-frame-rate')
	}

	const frameCount = input.frameCount
	if (frameCount === null || frameCount === undefined) {
		return timeOnly(duration.value, 'missing-frame-count')
	}
	if (!isValidFrameCount(frameCount)) {
		return timeOnly(duration.value, 'invalid-frame-count')
	}

	const hasFirstFrame = input.firstFrame !== null && input.firstFrame !== undefined
	const hasLastFrame = input.lastFrame !== null && input.lastFrame !== undefined
	if (
		(hasFirstFrame && !isValidFrameNumber(input.firstFrame as number)) ||
		(hasLastFrame && !isValidFrameNumber(input.lastFrame as number))
	) {
		return timeOnly(duration.value, 'invalid-frame-range')
	}

	let firstFrame: number
	let lastFrame: number
	let frameNumbering: ReviewVideoFrameTiming['frameNumbering']
	if (!hasFirstFrame && !hasLastFrame) {
		firstFrame = 0
		lastFrame = frameCount - 1
		frameNumbering = 'relative'
	} else if (hasFirstFrame && !hasLastFrame) {
		firstFrame = input.firstFrame as number
		lastFrame = firstFrame + frameCount - 1
		frameNumbering = 'source'
	} else if (!hasFirstFrame && hasLastFrame) {
		lastFrame = input.lastFrame as number
		firstFrame = lastFrame - frameCount + 1
		frameNumbering = 'source'
	} else {
		firstFrame = input.firstFrame as number
		lastFrame = input.lastFrame as number
		frameNumbering = 'source'
	}
	if (!isValidFrameNumber(firstFrame) || !isValidFrameNumber(lastFrame) || lastFrame < firstFrame) {
		return timeOnly(duration.value, 'invalid-frame-range')
	}
	if (lastFrame - firstFrame + 1 !== frameCount) {
		return timeOnly(duration.value, 'inconsistent-frame-range')
	}

	const expectedDuration = frameCount / frameRate
	const durationTolerance = Math.max(0.002, Math.min(0.05, 0.5 / frameRate))
	if (Math.abs(duration.value - expectedDuration) > durationTolerance) {
		return timeOnly(duration.value, 'inconsistent-duration')
	}

	return {
		durationSeconds: duration.value,
		firstFrame,
		frameCount,
		frameNumbering,
		frameRate,
		lastFrame,
		mode: 'frames',
		nominalFrameRate: Math.round(frameRate),
	}
}

/** Returns the center of a source frame, clamped just inside the browser's final media boundary. */
export function frameToMediaTime(timing: ReviewVideoFrameTiming, frame: number) {
	assertFrameInTiming(timing, frame)
	const centerTime = (frame - timing.firstFrame + 0.5) / timing.frameRate
	const finalSeekTime = Math.max(
		0,
		timing.durationSeconds - Math.min(LAST_FRAME_SEEK_EPSILON_SECONDS, timing.durationSeconds / 2)
	)
	return Math.min(centerTime, finalSeekTime)
}

/** Resolves a browser media time to a source frame without extrapolating outside the media. */
export function mediaTimeToFrame(timing: ReviewVideoFrameTiming, timeSeconds: number) {
	assertMediaTime(timeSeconds, timing.durationSeconds)
	const relativeFrame = Math.floor(timeSeconds * timing.frameRate)
	return Math.min(timing.lastFrame, timing.firstFrame + relativeFrame)
}

export function clampReviewVideoTime(timing: ReviewVideoTiming, timeSeconds: number) {
	if (!Number.isFinite(timeSeconds)) {
		throw new RangeError('Review video time must be finite.')
	}
	const upperBound = timing.durationSeconds ?? MAX_REVIEW_VIDEO_DURATION_SECONDS
	return Math.min(upperBound, Math.max(0, timeSeconds))
}

/** Formats source-frame-relative, non-drop-frame timecode. */
export function formatReviewVideoTimecode(timing: ReviewVideoFrameTiming, frame: number) {
	assertFrameInTiming(timing, frame)
	const relativeFrame = frame - timing.firstFrame
	const frames = relativeFrame % timing.nominalFrameRate
	const totalSeconds = Math.floor(relativeFrame / timing.nominalFrameRate)
	const seconds = totalSeconds % 60
	const totalMinutes = Math.floor(totalSeconds / 60)
	const minutes = totalMinutes % 60
	const hours = Math.floor(totalMinutes / 60)
	return `${padAtLeastTwo(hours)}:${padTwo(minutes)}:${padTwo(seconds)}:${padTwo(frames)}`
}

/** Formats time-only positions at the model's honest millisecond precision. */
export function formatReviewVideoTime(timeSeconds: number) {
	if (
		!Number.isFinite(timeSeconds) ||
		timeSeconds < 0 ||
		timeSeconds > MAX_REVIEW_VIDEO_DURATION_SECONDS
	) {
		throw new RangeError('Review video time is outside the supported range.')
	}
	const totalMilliseconds = Math.round(timeSeconds * 1_000)
	const milliseconds = totalMilliseconds % 1_000
	const totalSeconds = Math.floor(totalMilliseconds / 1_000)
	const seconds = totalSeconds % 60
	const totalMinutes = Math.floor(totalSeconds / 60)
	const minutes = totalMinutes % 60
	const hours = Math.floor(totalMinutes / 60)
	return `${padAtLeastTwo(hours)}:${padTwo(minutes)}:${padTwo(seconds)}.${String(milliseconds).padStart(3, '0')}`
}

function readDuration(
	value: number | null | undefined
):
	| { error: 'invalid-duration' | 'missing-duration'; value: null }
	| { error: null; value: number } {
	if (value === null || value === undefined) {
		return { error: 'missing-duration', value: null }
	}
	if (!Number.isFinite(value) || value <= 0 || value > MAX_REVIEW_VIDEO_DURATION_SECONDS) {
		return { error: 'invalid-duration', value: null }
	}
	return { error: null, value }
}

function isValidFrameRate(value: number) {
	return (
		Number.isFinite(value) &&
		value >= MIN_REVIEW_VIDEO_FRAME_RATE &&
		value <= MAX_REVIEW_VIDEO_FRAME_RATE
	)
}

function isValidFrameCount(value: number) {
	return Number.isSafeInteger(value) && value >= 1 && value <= MAX_REVIEW_VIDEO_FRAME_COUNT
}

function isValidFrameNumber(value: number) {
	return Number.isSafeInteger(value) && value >= 0 && value <= MAX_REVIEW_VIDEO_FRAME_NUMBER
}

function timeOnly(
	durationSeconds: number | null,
	fallbackReason: ReviewVideoTimingFallbackReason
): ReviewVideoTimeTiming {
	return { durationSeconds, fallbackReason, mode: 'time' }
}

function assertFrameInTiming(timing: ReviewVideoFrameTiming, frame: number) {
	if (!Number.isSafeInteger(frame) || frame < timing.firstFrame || frame > timing.lastFrame) {
		throw new RangeError('Review video frame is outside the source frame range.')
	}
}

function assertMediaTime(timeSeconds: number, durationSeconds: number) {
	if (!Number.isFinite(timeSeconds) || timeSeconds < 0 || timeSeconds > durationSeconds) {
		throw new RangeError('Review video time is outside the browser media duration.')
	}
}

function padTwo(value: number) {
	return String(value).padStart(2, '0')
}

function padAtLeastTwo(value: number) {
	return String(value).padStart(2, '0')
}
