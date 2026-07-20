import {
	MAX_REVIEW_VIDEO_DURATION_SECONDS,
	MAX_REVIEW_VIDEO_FRAME_NUMBER,
	mediaTimeToFrame,
	type ReviewVideoTiming,
} from './reviewVideoTiming'

export const REVIEW_ANNOTATION_TARGET_META_KEY = 'reviewAnnotationTarget'

export interface ReviewFrameAnnotationTarget {
	endFrame: number
	kind: 'frame'
	startFrame: number
}

export interface ReviewTimeAnnotationTarget {
	endTimeMs: number
	kind: 'time'
	startTimeMs: number
}

export type ReviewAnnotationTarget = ReviewFrameAnnotationTarget | ReviewTimeAnnotationTarget

export class ReviewAnnotationTargetError extends Error {
	readonly code: 'INVALID_TARGET' | 'TARGET_OUT_OF_BOUNDS' | 'TARGET_TIMING_MISMATCH'

	constructor(code: ReviewAnnotationTargetError['code'], message: string) {
		super(message)
		this.name = 'ReviewAnnotationTargetError'
		this.code = code
	}
}

export function createFrameAnnotationTarget(
	startFrame: number,
	endFrame = startFrame
): ReviewFrameAnnotationTarget {
	return parseReviewAnnotationTarget({
		endFrame,
		kind: 'frame',
		startFrame,
	}) as ReviewFrameAnnotationTarget
}

export function createTimeAnnotationTarget(
	startTimeSeconds: number,
	endTimeSeconds = startTimeSeconds
): ReviewTimeAnnotationTarget {
	assertOrderedMediaTimes(startTimeSeconds, endTimeSeconds)
	return parseReviewAnnotationTarget({
		endTimeMs: mediaTimeToMilliseconds(endTimeSeconds),
		kind: 'time',
		startTimeMs: mediaTimeToMilliseconds(startTimeSeconds),
	}) as ReviewTimeAnnotationTarget
}

/** Creates a canonical target in the timing model's honest precision. */
export function createReviewAnnotationTarget(
	timing: ReviewVideoTiming,
	startTimeSeconds: number,
	endTimeSeconds = startTimeSeconds
): ReviewAnnotationTarget {
	assertOrderedMediaTimes(startTimeSeconds, endTimeSeconds)
	if (timing.durationSeconds !== null && endTimeSeconds > timing.durationSeconds) {
		throw targetOutOfBounds()
	}
	if (timing.mode === 'frames') {
		return createFrameAnnotationTarget(
			mediaTimeToFrame(timing, startTimeSeconds),
			mediaTimeToFrame(timing, endTimeSeconds)
		)
	}
	return createTimeAnnotationTarget(startTimeSeconds, endTimeSeconds)
}

/** Strictly parses the persisted discriminated union and rejects unknown or non-canonical keys. */
export function parseReviewAnnotationTarget(value: unknown): ReviewAnnotationTarget {
	const record = requireRecord(value)
	if (record.kind === 'frame') {
		requireExactKeys(record, ['endFrame', 'kind', 'startFrame'])
		const startFrame = requireFrame(record.startFrame)
		const endFrame = requireFrame(record.endFrame)
		if (endFrame < startFrame) throw invalidTarget()
		return { endFrame, kind: 'frame', startFrame }
	}
	if (record.kind === 'time') {
		requireExactKeys(record, ['endTimeMs', 'kind', 'startTimeMs'])
		const startTimeMs = requireTimeMilliseconds(record.startTimeMs)
		const endTimeMs = requireTimeMilliseconds(record.endTimeMs)
		if (endTimeMs < startTimeMs) throw invalidTarget()
		return { endTimeMs, kind: 'time', startTimeMs }
	}
	throw invalidTarget()
}

/** Validates a parsed target against the currently decoded source and returns a canonical copy. */
export function normalizeReviewAnnotationTarget(
	value: unknown,
	timing: ReviewVideoTiming
): ReviewAnnotationTarget {
	const target = parseReviewAnnotationTarget(value)
	if (target.kind === 'frame') {
		if (timing.mode !== 'frames') {
			throw new ReviewAnnotationTargetError(
				'TARGET_TIMING_MISMATCH',
				'Frame annotations require verified constant-frame-rate media.'
			)
		}
		if (target.startFrame < timing.firstFrame || target.endFrame > timing.lastFrame) {
			throw targetOutOfBounds()
		}
		return target
	}

	if (
		timing.durationSeconds !== null &&
		target.endTimeMs > mediaTimeToMilliseconds(timing.durationSeconds)
	) {
		throw targetOutOfBounds()
	}
	return target
}

/** Uses inclusive range bounds. Invalid playhead values are never treated as visible. */
export function isReviewAnnotationVisibleAtPlayhead(
	value: unknown,
	timing: ReviewVideoTiming,
	currentTimeSeconds: number
) {
	const target = normalizeReviewAnnotationTarget(value, timing)
	if (
		!Number.isFinite(currentTimeSeconds) ||
		currentTimeSeconds < 0 ||
		currentTimeSeconds > MAX_REVIEW_VIDEO_DURATION_SECONDS ||
		(timing.durationSeconds !== null && currentTimeSeconds > timing.durationSeconds)
	) {
		return false
	}
	if (target.kind === 'frame') {
		if (timing.mode !== 'frames') {
			throw new ReviewAnnotationTargetError(
				'TARGET_TIMING_MISMATCH',
				'Frame annotations require verified constant-frame-rate media.'
			)
		}
		const currentFrame = mediaTimeToFrame(timing, currentTimeSeconds)
		return currentFrame >= target.startFrame && currentFrame <= target.endFrame
	}
	const currentTimeMs = mediaTimeToMilliseconds(currentTimeSeconds)
	return currentTimeMs >= target.startTimeMs && currentTimeMs <= target.endTimeMs
}

export function mediaTimeToMilliseconds(timeSeconds: number) {
	if (
		!Number.isFinite(timeSeconds) ||
		timeSeconds < 0 ||
		timeSeconds > MAX_REVIEW_VIDEO_DURATION_SECONDS
	) {
		throw invalidTarget()
	}
	return Math.round(timeSeconds * 1_000)
}

function requireRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalidTarget()
	return value as Record<string, unknown>
}

function requireExactKeys(record: Record<string, unknown>, expected: string[]) {
	const actual = Object.keys(record).sort()
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
		throw invalidTarget()
	}
}

function requireFrame(value: unknown) {
	if (
		!Number.isSafeInteger(value) ||
		(value as number) < 0 ||
		(value as number) > MAX_REVIEW_VIDEO_FRAME_NUMBER
	) {
		throw invalidTarget()
	}
	return value as number
}

function requireTimeMilliseconds(value: unknown) {
	if (
		!Number.isSafeInteger(value) ||
		(value as number) < 0 ||
		(value as number) > MAX_REVIEW_VIDEO_DURATION_SECONDS * 1_000
	) {
		throw invalidTarget()
	}
	return value as number
}

function assertOrderedMediaTimes(startTimeSeconds: number, endTimeSeconds: number) {
	if (
		!Number.isFinite(startTimeSeconds) ||
		!Number.isFinite(endTimeSeconds) ||
		startTimeSeconds < 0 ||
		endTimeSeconds < startTimeSeconds ||
		endTimeSeconds > MAX_REVIEW_VIDEO_DURATION_SECONDS
	) {
		throw invalidTarget()
	}
}

function invalidTarget() {
	return new ReviewAnnotationTargetError(
		'INVALID_TARGET',
		'The review annotation target is invalid.'
	)
}

function targetOutOfBounds() {
	return new ReviewAnnotationTargetError(
		'TARGET_OUT_OF_BOUNDS',
		'The review annotation target is outside the source media.'
	)
}
