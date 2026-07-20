import { structuredClone, type TLEditorSnapshot } from 'tldraw'
import type { ReviewAnnotationContext } from './reviewAnnotationSnapshot'
import {
	normalizeReviewAnnotationTarget,
	REVIEW_ANNOTATION_TARGET_META_KEY,
	mediaTimeToMilliseconds,
} from './reviewAnnotationTarget'
import { getReviewVideoShapeId, REVIEW_VIDEO_SHAPE_TYPE } from './reviewVideoShape'
import {
	createReviewVideoTiming,
	MAX_REVIEW_VIDEO_DURATION_SECONDS,
	type ReviewVideoTiming,
} from './reviewVideoTiming'

export const REVIEW_VIDEO_SNAPSHOT_KIND = 'shotgrid-review-video-annotation'
export const REVIEW_VIDEO_SNAPSHOT_VERSION = 1
export const MAX_REVIEW_VIDEO_SNAPSHOT_RECORDS = 5_000
export const MAX_REVIEW_VIDEO_SNAPSHOT_BYTES = 16 * 1024 * 1024

const MAX_REVIEW_VIDEO_DIMENSION = 8_192
const MAX_REVIEW_VIDEO_PIXELS = 16_777_216
const MAX_REVIEW_VIDEO_USERS = 32
const REVIEW_VIDEO_ROLE = 'shotgrid-review-video-source'
const REVIEW_VIDEO_SOURCE_SCHEMA_VERSION = 1

export type ReviewVideoSnapshotContext = ReviewAnnotationContext

/** A URL-free fingerprint of the decoded video and the ShotGrid timing metadata used to review it. */
export interface ReviewVideoSnapshotSource {
	attachmentId: number
	contentType: 'video/mp4'
	durationMs: number
	firstFrame: number | null
	frameCount: number | null
	frameRate: number | null
	frameRateMode: 'constant' | 'unknown' | 'variable'
	height: number
	lastFrame: number | null
	width: number
}

export interface ReviewVideoSnapshot {
	kind: typeof REVIEW_VIDEO_SNAPSHOT_KIND
	review: ReviewVideoSnapshotContext
	savedAt: string | null
	schemaVersion: typeof REVIEW_VIDEO_SNAPSHOT_VERSION
	snapshot: TLEditorSnapshot
	source: ReviewVideoSnapshotSource
}

export class ReviewVideoSnapshotError extends Error {
	readonly code:
		| 'INVALID_SNAPSHOT'
		| 'SNAPSHOT_CONTEXT_MISMATCH'
		| 'SNAPSHOT_SOURCE_MISMATCH'
		| 'UNSUPPORTED_SNAPSHOT_VERSION'

	constructor(code: ReviewVideoSnapshotError['code'], message: string) {
		super(message)
		this.name = 'ReviewVideoSnapshotError'
		this.code = code
	}
}

/** Converts the browser's decoded duration to the canonical millisecond source fingerprint. */
export function createReviewVideoSnapshotSource(
	options: Omit<ReviewVideoSnapshotSource, 'durationMs'> & { durationSeconds: number }
): ReviewVideoSnapshotSource {
	let durationMs: number
	try {
		durationMs = mediaTimeToMilliseconds(options.durationSeconds)
	} catch {
		throw invalidSnapshot('the decoded video duration is invalid')
	}
	return parseSource({
		attachmentId: options.attachmentId,
		contentType: options.contentType,
		durationMs,
		firstFrame: options.firstFrame,
		frameCount: options.frameCount,
		frameRate: options.frameRate,
		frameRateMode: options.frameRateMode,
		height: options.height,
		lastFrame: options.lastFrame,
		width: options.width,
	})
}

export function createReviewVideoSnapshot(options: {
	review: ReviewVideoSnapshotContext
	savedAt?: string
	snapshot: TLEditorSnapshot
	source: ReviewVideoSnapshotSource
}): ReviewVideoSnapshot {
	return parseReviewVideoSnapshot(
		{
			kind: REVIEW_VIDEO_SNAPSHOT_KIND,
			review: options.review,
			savedAt: options.savedAt ?? new Date().toISOString(),
			schemaVersion: REVIEW_VIDEO_SNAPSHOT_VERSION,
			snapshot: options.snapshot,
			source: options.source,
		},
		options.review,
		options.source
	)
}

export function parseReviewVideoSnapshotJson(
	json: string,
	expectedReview: ReviewVideoSnapshotContext,
	currentSource?: ReviewVideoSnapshotSource
) {
	if (
		typeof json !== 'string' ||
		new TextEncoder().encode(json).byteLength > MAX_REVIEW_VIDEO_SNAPSHOT_BYTES
	) {
		throw invalidSnapshot('it exceeds the 16 MiB limit')
	}
	let value: unknown
	try {
		value = JSON.parse(json)
	} catch {
		throw invalidSnapshot()
	}
	return parseReviewVideoSnapshot(value, expectedReview, currentSource)
}

/**
 * Parses the strict envelope and validates its document records. Pass the currently decoded source
 * when loading persisted data so any Attachment, dimension, duration, or timing change fails closed.
 */
export function parseReviewVideoSnapshot(
	value: unknown,
	expectedReview: ReviewVideoSnapshotContext,
	currentSource?: ReviewVideoSnapshotSource
): ReviewVideoSnapshot {
	assertSerializedSize(value)
	const record = requireRecord(value)
	if (record.schemaVersion !== REVIEW_VIDEO_SNAPSHOT_VERSION) {
		throw new ReviewVideoSnapshotError(
			'UNSUPPORTED_SNAPSHOT_VERSION',
			'This editable video review snapshot version is not supported.'
		)
	}
	requireExactKeys(record, ['kind', 'review', 'savedAt', 'schemaVersion', 'snapshot', 'source'])
	if (record.kind !== REVIEW_VIDEO_SNAPSHOT_KIND) throw invalidSnapshot()
	if (record.savedAt !== null && !isIsoTimestamp(record.savedAt)) throw invalidSnapshot()

	const review = parseReviewContext(record.review)
	if (!sameReviewContext(review, expectedReview)) {
		throw new ReviewVideoSnapshotError(
			'SNAPSHOT_CONTEXT_MISMATCH',
			'This editable video snapshot belongs to a different ShotGrid review item.'
		)
	}
	const source = parseSource(record.source)
	if (currentSource) assertReviewVideoSnapshotSource(source, currentSource)
	const snapshot = parseEditorSnapshot(record.snapshot)
	assertReviewVideoSnapshotRecords(snapshot, { review, source })

	try {
		return structuredClone({
			kind: REVIEW_VIDEO_SNAPSHOT_KIND,
			review,
			savedAt: record.savedAt,
			schemaVersion: REVIEW_VIDEO_SNAPSHOT_VERSION,
			snapshot,
			source,
		})
	} catch {
		throw invalidSnapshot('it contains values that cannot be cloned')
	}
}

export function serializeReviewVideoSnapshot(snapshot: ReviewVideoSnapshot) {
	const validated = parseReviewVideoSnapshot(snapshot, snapshot.review, snapshot.source)
	let json: string
	try {
		json = JSON.stringify(validated)
	} catch {
		throw invalidSnapshot('it cannot be serialized')
	}
	if (new TextEncoder().encode(json).byteLength > MAX_REVIEW_VIDEO_SNAPSHOT_BYTES) {
		throw invalidSnapshot('it exceeds the 16 MiB limit')
	}
	return json
}

/** Rejects stale editable data instead of silently applying it to changed media. */
export function assertReviewVideoSnapshotSource(
	snapshotSource: ReviewVideoSnapshotSource,
	currentSource: ReviewVideoSnapshotSource
) {
	const saved = parseSource(snapshotSource)
	const current = parseSource(currentSource)
	if (
		saved.attachmentId !== current.attachmentId ||
		saved.contentType !== current.contentType ||
		saved.durationMs !== current.durationMs ||
		saved.firstFrame !== current.firstFrame ||
		saved.frameCount !== current.frameCount ||
		saved.frameRate !== current.frameRate ||
		saved.frameRateMode !== current.frameRateMode ||
		saved.height !== current.height ||
		saved.lastFrame !== current.lastFrame ||
		saved.width !== current.width
	) {
		throw new ReviewVideoSnapshotError(
			'SNAPSHOT_SOURCE_MISMATCH',
			'This editable video snapshot was created for different review media or timing metadata.'
		)
	}
}

export function getReviewVideoSnapshotTiming(source: ReviewVideoSnapshotSource): ReviewVideoTiming {
	const parsed = parseSource(source)
	return createReviewVideoTiming({
		durationSeconds: parsed.durationMs / 1_000,
		firstFrame: parsed.firstFrame,
		frameCount: parsed.frameCount,
		frameRate: parsed.frameRate,
		frameRateMode: parsed.frameRateMode,
		lastFrame: parsed.lastFrame,
	})
}

/**
 * Ensures a document contains only the protected source video and supported review annotations.
 * Every non-group annotation is checked against the source's current frame/time boundaries.
 */
export function assertReviewVideoSnapshotRecords(
	snapshot: TLEditorSnapshot,
	options: { review: ReviewVideoSnapshotContext; source: ReviewVideoSnapshotSource }
) {
	const review = parseReviewContext(options.review)
	const source = parseSource(options.source)
	const expectedSourceShapeId = getReviewVideoShapeId(review.versionId)
	const timing = getReviewVideoSnapshotTiming(source)
	const store = snapshot.document.store as unknown as Record<string, unknown>
	const entries = Object.entries(store)
	if (entries.length > MAX_REVIEW_VIDEO_SNAPSHOT_RECORDS) {
		throw invalidSnapshot('it contains too many records')
	}

	const pages: Record<string, unknown>[] = []
	const shapes = new Map<string, Record<string, unknown>>()
	const bindings: Record<string, unknown>[] = []
	const groupTargetKeys = new Map<string, string>()
	const shapeTargetKeys = new Map<string, string>()
	let documentCount = 0
	let sourceShapeCount = 0
	let userCount = 0

	for (const [key, value] of entries) {
		const record = requireRecord(value)
		if (typeof record.id !== 'string' || typeof record.typeName !== 'string') {
			throw invalidSnapshot('a record has no valid identity')
		}
		if (key !== record.id) throw invalidSnapshot('a store key does not match its record id')

		switch (record.typeName) {
			case 'document':
				documentCount++
				break
			case 'page':
				pages.push(record)
				break
			case 'shape':
				shapes.set(record.id, record)
				if (record.id === expectedSourceShapeId) {
					sourceShapeCount++
				} else if (!isAllowedAnnotationShape(record.type)) {
					throw invalidSnapshot(`it contains an unsupported ${String(record.type)} shape`)
				}
				break
			case 'binding':
				if (record.type !== 'arrow') throw invalidSnapshot('it contains an unsupported binding')
				bindings.push(record)
				break
			case 'user':
				userCount++
				if (userCount > MAX_REVIEW_VIDEO_USERS || record.imageUrl !== '') {
					throw invalidSnapshot('it contains unsupported user attribution')
				}
				break
			case 'asset':
				throw invalidSnapshot('video review snapshots cannot contain assets or media URLs')
			default:
				throw invalidSnapshot(`it contains an unsupported ${record.typeName} record`)
		}
	}

	if (documentCount !== 1 || pages.length !== 1 || sourceShapeCount !== 1) {
		throw invalidSnapshot(
			`expected one document, page, and review-video source shape but found ${documentCount}, ${pages.length}, and ${sourceShapeCount}`
		)
	}

	const pageId = pages[0].id as string
	const sourceShape = shapes.get(expectedSourceShapeId)
	if (!sourceShape) throw invalidSnapshot('the protected review-video source shape is missing')
	assertSourceShape(sourceShape, { pageId, review, source })

	for (const shape of shapes.values()) {
		if (shape.id === expectedSourceShapeId) continue
		assertAnnotationParent(shape, pageId, shapes, expectedSourceShapeId)
		if (shape.type !== 'group') {
			if (
				!isRecord(shape.meta) ||
				!Object.prototype.hasOwnProperty.call(shape.meta, REVIEW_ANNOTATION_TARGET_META_KEY)
			) {
				throw invalidSnapshot('an annotation shape has no frame or time target')
			}
			let target: ReturnType<typeof normalizeReviewAnnotationTarget>
			try {
				target = normalizeReviewAnnotationTarget(
					shape.meta[REVIEW_ANNOTATION_TARGET_META_KEY],
					timing
				)
			} catch {
				throw invalidSnapshot('an annotation target does not match the source timing boundaries')
			}
			const key = targetKey(target)
			shapeTargetKeys.set(shape.id as string, key)
			recordGroupTargetKeys(shape, key, pageId, shapes, groupTargetKeys)
		}
	}
	for (const shape of shapes.values()) {
		if (shape.type === 'group' && !groupTargetKeys.has(shape.id as string)) {
			throw invalidSnapshot('an annotation group is empty or has mixed frame/time targets')
		}
	}

	for (const binding of bindings) {
		if (typeof binding.fromId !== 'string' || typeof binding.toId !== 'string') {
			throw invalidSnapshot('an arrow binding has invalid shape references')
		}
		const from = shapes.get(binding.fromId)
		const to = shapes.get(binding.toId)
		if (
			!from ||
			from.type !== 'arrow' ||
			!to ||
			from.id === expectedSourceShapeId ||
			to.id === expectedSourceShapeId
		) {
			throw invalidSnapshot('an arrow binding references an unsupported shape')
		}
		const fromTargetKey = shapeTargetKeys.get(binding.fromId)
		const toTargetKey =
			to.type === 'group' ? groupTargetKeys.get(binding.toId) : shapeTargetKeys.get(binding.toId)
		if (!fromTargetKey || !toTargetKey || fromTargetKey !== toTargetKey) {
			throw invalidSnapshot('an arrow binding crosses frame/time targets')
		}
	}
}

function assertSourceShape(
	shape: Record<string, unknown>,
	options: {
		pageId: string
		review: ReviewVideoSnapshotContext
		source: ReviewVideoSnapshotSource
	}
) {
	if (
		shape.type !== REVIEW_VIDEO_SHAPE_TYPE ||
		shape.isLocked !== true ||
		shape.parentId !== options.pageId ||
		shape.x !== 0 ||
		shape.y !== 0 ||
		shape.rotation !== 0 ||
		shape.opacity !== 1
	) {
		throw invalidSnapshot('the review-video source shape is not protected')
	}

	const props = requireRecord(shape.props)
	requireExactKeys(props, ['attachmentId', 'h', 'name', 'versionId', 'w'])
	if (
		props.attachmentId !== options.source.attachmentId ||
		props.h !== options.source.height ||
		props.versionId !== options.review.versionId ||
		props.w !== options.source.width ||
		typeof props.name !== 'string' ||
		props.name.trim().length === 0 ||
		props.name.length > 1_024
	) {
		throw invalidSnapshot('the review-video source shape does not match its source fingerprint')
	}

	const meta = requireRecord(shape.meta)
	requireExactKeys(meta, ['attachmentId', 'height', 'role', 'schemaVersion', 'versionId', 'width'])
	if (
		meta.attachmentId !== options.source.attachmentId ||
		meta.height !== options.source.height ||
		meta.role !== REVIEW_VIDEO_ROLE ||
		meta.schemaVersion !== REVIEW_VIDEO_SOURCE_SCHEMA_VERSION ||
		meta.versionId !== options.review.versionId ||
		meta.width !== options.source.width
	) {
		throw invalidSnapshot('the review-video source metadata does not match its source fingerprint')
	}
}

function assertAnnotationParent(
	shape: Record<string, unknown>,
	pageId: string,
	shapes: Map<string, Record<string, unknown>>,
	sourceShapeId: string
) {
	if (typeof shape.parentId !== 'string') throw invalidSnapshot('an annotation has no valid parent')
	let parentId = shape.parentId
	const visited = new Set([shape.id as string])
	while (parentId !== pageId) {
		if (parentId === sourceShapeId || visited.has(parentId)) {
			throw invalidSnapshot('an annotation has an invalid parent hierarchy')
		}
		visited.add(parentId)
		const parent = shapes.get(parentId)
		if (!parent || parent.type !== 'group' || typeof parent.parentId !== 'string') {
			throw invalidSnapshot('an annotation has an unsupported parent')
		}
		parentId = parent.parentId
	}
}

function recordGroupTargetKeys(
	shape: Record<string, unknown>,
	key: string,
	pageId: string,
	shapes: Map<string, Record<string, unknown>>,
	groupTargetKeys: Map<string, string>
) {
	let parentId = shape.parentId as string
	while (parentId !== pageId) {
		const group = shapes.get(parentId)
		if (!group || group.type !== 'group')
			throw invalidSnapshot('an annotation has an invalid group')
		const existing = groupTargetKeys.get(parentId)
		if (existing !== undefined && existing !== key) {
			throw invalidSnapshot('an annotation group has mixed frame/time targets')
		}
		groupTargetKeys.set(parentId, key)
		parentId = group.parentId as string
	}
}

function targetKey(target: ReturnType<typeof normalizeReviewAnnotationTarget>) {
	return target.kind === 'frame'
		? `frame:${target.startFrame}:${target.endFrame}`
		: `time:${target.startTimeMs}:${target.endTimeMs}`
}

function parseReviewContext(value: unknown): ReviewVideoSnapshotContext {
	const record = requireRecord(value)
	requireExactKeys(record, ['projectId', 'scope', 'versionId'])
	if (typeof record.scope !== 'string' || !/^[a-z0-9._:%-]{1,512}$/i.test(record.scope)) {
		throw invalidSnapshot()
	}
	return {
		projectId: requirePositiveId(record.projectId),
		scope: record.scope,
		versionId: requirePositiveId(record.versionId),
	}
}

function parseSource(value: unknown): ReviewVideoSnapshotSource {
	const record = requireRecord(value)
	requireExactKeys(record, [
		'attachmentId',
		'contentType',
		'durationMs',
		'firstFrame',
		'frameCount',
		'frameRate',
		'frameRateMode',
		'height',
		'lastFrame',
		'width',
	])
	if (record.contentType !== 'video/mp4') throw invalidSnapshot()
	const durationMs = requireIntegerInRange(
		record.durationMs,
		1,
		MAX_REVIEW_VIDEO_DURATION_SECONDS * 1_000
	)
	const frameCount = requireNullableIntegerInRange(record.frameCount, 1, Number.MAX_SAFE_INTEGER)
	const frameRate = requireNullableFiniteNumberInRange(record.frameRate, Number.MIN_VALUE, Infinity)
	if (
		record.frameRateMode !== 'constant' &&
		record.frameRateMode !== 'unknown' &&
		record.frameRateMode !== 'variable'
	) {
		throw invalidSnapshot()
	}
	const firstFrame = requireNullableIntegerInRange(record.firstFrame, 0, Number.MAX_SAFE_INTEGER)
	const lastFrame = requireNullableIntegerInRange(record.lastFrame, 0, Number.MAX_SAFE_INTEGER)
	if (firstFrame !== null && lastFrame !== null && lastFrame < firstFrame) {
		throw invalidSnapshot()
	}
	const height = requireIntegerInRange(record.height, 1, MAX_REVIEW_VIDEO_DIMENSION)
	const width = requireIntegerInRange(record.width, 1, MAX_REVIEW_VIDEO_DIMENSION)
	if (height * width > MAX_REVIEW_VIDEO_PIXELS) throw invalidSnapshot()
	return {
		attachmentId: requirePositiveId(record.attachmentId),
		contentType: 'video/mp4',
		durationMs,
		firstFrame,
		frameCount,
		frameRate,
		frameRateMode: record.frameRateMode,
		height,
		lastFrame,
		width,
	}
}

function parseEditorSnapshot(value: unknown): TLEditorSnapshot {
	const record = requireRecord(value)
	requireExactKeys(record, ['document', 'session'])
	const document = requireRecord(record.document)
	requireExactKeys(document, ['schema', 'store'])
	const session = requireRecord(record.session)
	if (
		!isRecord(document.schema) ||
		!isRecord(document.store) ||
		Object.keys(document.store).length > MAX_REVIEW_VIDEO_SNAPSHOT_RECORDS
	) {
		throw invalidSnapshot()
	}
	return { document, session } as unknown as TLEditorSnapshot
}

function isAllowedAnnotationShape(value: unknown) {
	return (
		value === 'arrow' ||
		value === 'draw' ||
		value === 'geo' ||
		value === 'group' ||
		value === 'text'
	)
}

function sameReviewContext(left: ReviewVideoSnapshotContext, right: ReviewVideoSnapshotContext) {
	return (
		left.projectId === right.projectId &&
		left.scope === right.scope &&
		left.versionId === right.versionId
	)
}

function requirePositiveId(value: unknown) {
	return requireIntegerInRange(value, 1, Number.MAX_SAFE_INTEGER)
}

function requireIntegerInRange(value: unknown, minimum: number, maximum: number) {
	if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
		throw invalidSnapshot()
	}
	return Number(value)
}

function requireNullableIntegerInRange(value: unknown, minimum: number, maximum: number) {
	return value === null ? null : requireIntegerInRange(value, minimum, maximum)
}

function requireNullableFiniteNumberInRange(value: unknown, minimum: number, maximum: number) {
	if (value === null) return null
	if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
		throw invalidSnapshot()
	}
	return value
}

function isIsoTimestamp(value: unknown): value is string {
	if (typeof value !== 'string' || value.length > 40) return false
	const date = new Date(value)
	return !Number.isNaN(date.getTime()) && date.toISOString() === value
}

function requireExactKeys(record: Record<string, unknown>, expectedKeys: string[]) {
	const actualKeys = Object.keys(record).sort()
	const sortedExpectedKeys = [...expectedKeys].sort()
	if (
		actualKeys.length !== sortedExpectedKeys.length ||
		actualKeys.some((key, index) => key !== sortedExpectedKeys[index])
	) {
		throw invalidSnapshot()
	}
}

function requireRecord(value: unknown) {
	if (!isRecord(value)) throw invalidSnapshot()
	return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function assertSerializedSize(value: unknown) {
	let json: string
	try {
		json = JSON.stringify(value)
	} catch {
		throw invalidSnapshot('it cannot be serialized')
	}
	if (
		typeof json !== 'string' ||
		new TextEncoder().encode(json).byteLength > MAX_REVIEW_VIDEO_SNAPSHOT_BYTES
	) {
		throw invalidSnapshot('it exceeds the 16 MiB limit')
	}
}

function invalidSnapshot(reason?: string) {
	return new ReviewVideoSnapshotError(
		'INVALID_SNAPSHOT',
		reason
			? `The editable video review snapshot is invalid because ${reason}.`
			: 'The editable video review snapshot is invalid.'
	)
}
