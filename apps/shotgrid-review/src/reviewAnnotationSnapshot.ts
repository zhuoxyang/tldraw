import { structuredClone, type TLEditorSnapshot } from 'tldraw'

export const REVIEW_ANNOTATION_SNAPSHOT_KIND = 'shotgrid-review-annotation'
export const REVIEW_ANNOTATION_SNAPSHOT_VERSION = 1
export const MAX_REVIEW_ANNOTATION_RECORDS = 5_000
export const MAX_REVIEW_ANNOTATION_SNAPSHOT_BYTES = 16 * 1024 * 1024
const REVIEW_IMAGE_ROLE = 'shotgrid-review-source'

export interface ReviewAnnotationContext {
	projectId: number
	scope: string
	versionId: number
}

export interface ReviewAnnotationSource {
	contentType: string
	height: number
	sha256: string
	width: number
}

export interface ReviewAnnotationSnapshot {
	kind: typeof REVIEW_ANNOTATION_SNAPSHOT_KIND
	review: ReviewAnnotationContext
	savedAt: string | null
	schemaVersion: typeof REVIEW_ANNOTATION_SNAPSHOT_VERSION
	snapshot: TLEditorSnapshot
	source: ReviewAnnotationSource
}

export class ReviewAnnotationSnapshotError extends Error {
	readonly code:
		| 'INVALID_SNAPSHOT'
		| 'SNAPSHOT_CONTEXT_MISMATCH'
		| 'SNAPSHOT_SOURCE_MISMATCH'
		| 'UNSUPPORTED_SNAPSHOT_VERSION'

	constructor(code: ReviewAnnotationSnapshotError['code'], message: string) {
		super(message)
		this.name = 'ReviewAnnotationSnapshotError'
		this.code = code
	}
}

export function createReviewAnnotationSnapshot(options: {
	review: ReviewAnnotationContext
	savedAt?: string
	snapshot: TLEditorSnapshot
	source: ReviewAnnotationSource
}): ReviewAnnotationSnapshot {
	const value = {
		kind: REVIEW_ANNOTATION_SNAPSHOT_KIND,
		review: options.review,
		savedAt: options.savedAt ?? new Date().toISOString(),
		schemaVersion: REVIEW_ANNOTATION_SNAPSHOT_VERSION,
		snapshot: options.snapshot,
		source: options.source,
	}
	return parseReviewAnnotationSnapshot(value, options.review)
}

export function parseReviewAnnotationSnapshotJson(
	json: string,
	expectedReview: ReviewAnnotationContext
) {
	let value: unknown
	try {
		value = JSON.parse(json)
	} catch {
		throw invalidSnapshot()
	}
	return parseReviewAnnotationSnapshot(value, expectedReview)
}

export function parseReviewAnnotationSnapshot(
	value: unknown,
	expectedReview: ReviewAnnotationContext
): ReviewAnnotationSnapshot {
	const record = requireRecord(value)
	const schemaVersion = record.schemaVersion
	if (schemaVersion !== 0 && schemaVersion !== REVIEW_ANNOTATION_SNAPSHOT_VERSION) {
		throw new ReviewAnnotationSnapshotError(
			'UNSUPPORTED_SNAPSHOT_VERSION',
			'This editable review snapshot version is not supported.'
		)
	}

	const migrated = schemaVersion === 0 ? migrateVersionZero(record) : parseVersionOne(record)
	if (!sameReviewContext(migrated.review, expectedReview)) {
		throw new ReviewAnnotationSnapshotError(
			'SNAPSHOT_CONTEXT_MISMATCH',
			'This editable snapshot belongs to a different ShotGrid review item.'
		)
	}
	return structuredClone(migrated)
}

export function assertReviewAnnotationSource(
	snapshotSource: ReviewAnnotationSource,
	currentSource: ReviewAnnotationSource
) {
	if (
		snapshotSource.contentType !== currentSource.contentType ||
		snapshotSource.height !== currentSource.height ||
		snapshotSource.width !== currentSource.width ||
		snapshotSource.sha256 !== currentSource.sha256
	) {
		throw new ReviewAnnotationSnapshotError(
			'SNAPSHOT_SOURCE_MISMATCH',
			'This editable snapshot was created for different review media.'
		)
	}
}

export function serializeReviewAnnotationSnapshot(snapshot: ReviewAnnotationSnapshot) {
	let json: string
	try {
		json = JSON.stringify(snapshot)
	} catch {
		throw invalidSnapshot('it cannot be serialized')
	}
	if (new TextEncoder().encode(json).byteLength > MAX_REVIEW_ANNOTATION_SNAPSHOT_BYTES) {
		throw invalidSnapshot('it exceeds the 16 MiB limit')
	}
	return json
}

export function sanitizeReviewAnnotationSnapshot(
	snapshot: TLEditorSnapshot,
	sourceAssetId: string
): TLEditorSnapshot {
	const sanitized = structuredClone(snapshot)
	const store = sanitized.document.store as unknown as Record<string, unknown>
	for (const [key, value] of Object.entries(store)) {
		if (!isRecord(value) || (key !== sourceAssetId && value.id !== sourceAssetId)) continue
		if (value.typeName === 'asset' && isRecord(value.props)) value.props.src = null
	}
	return sanitized
}

export function assertReviewAnnotationRecords(
	snapshot: TLEditorSnapshot,
	options: { sourceAssetId: string; sourceShapeId: string }
) {
	const records = Object.entries(snapshot.document.store as unknown as Record<string, unknown>)
	if (records.length > MAX_REVIEW_ANNOTATION_RECORDS) {
		throw invalidSnapshot('it contains too many records')
	}
	let assetCount = 0
	let documentCount = 0
	let pageCount = 0
	let sourceShapeCount = 0
	let userCount = 0

	for (const [key, value] of records) {
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
				pageCount++
				break
			case 'asset':
				assetCount++
				if (record.id !== options.sourceAssetId || record.type !== 'image') {
					throw invalidSnapshot('it contains an unsupported asset')
				}
				break
			case 'shape':
				if (record.id === options.sourceShapeId) {
					if (record.type !== 'image') throw invalidSnapshot('the source shape is not an image')
					sourceShapeCount++
				} else if (!isAllowedAnnotationShape(record.type)) {
					throw invalidSnapshot(`it contains an unsupported ${String(record.type)} shape`)
				}
				break
			case 'binding':
				if (record.type !== 'arrow') throw invalidSnapshot('it contains an unsupported binding')
				break
			case 'user':
				userCount++
				if (userCount > 32 || record.imageUrl !== '') {
					throw invalidSnapshot('it contains unsupported user attribution')
				}
				break
			default:
				throw invalidSnapshot(`it contains an unsupported ${record.typeName} record`)
		}
	}

	if (assetCount !== 1 || documentCount !== 1 || pageCount !== 1 || sourceShapeCount !== 1) {
		throw invalidSnapshot(
			`expected one document, page, source asset, and source shape but found ${documentCount}, ${pageCount}, ${assetCount}, and ${sourceShapeCount}`
		)
	}
}

function migrateVersionZero(record: Record<string, unknown>): ReviewAnnotationSnapshot {
	requireExactKeys(record, ['review', 'schemaVersion', 'snapshot', 'source'])
	const review = parseReviewContext(record.review)
	const snapshot = parseEditorSnapshot(record.snapshot)
	return {
		kind: REVIEW_ANNOTATION_SNAPSHOT_KIND,
		review,
		savedAt: null,
		schemaVersion: REVIEW_ANNOTATION_SNAPSHOT_VERSION,
		snapshot,
		source: parseVersionZeroSource(
			record.source,
			readLegacySourceDigest(snapshot, review.versionId)
		),
	}
}

function parseVersionOne(record: Record<string, unknown>): ReviewAnnotationSnapshot {
	requireExactKeys(record, ['kind', 'review', 'savedAt', 'schemaVersion', 'snapshot', 'source'])
	if (record.kind !== REVIEW_ANNOTATION_SNAPSHOT_KIND) throw invalidSnapshot()
	if (record.savedAt !== null && !isIsoTimestamp(record.savedAt)) throw invalidSnapshot()
	return {
		kind: REVIEW_ANNOTATION_SNAPSHOT_KIND,
		review: parseReviewContext(record.review),
		savedAt: record.savedAt,
		schemaVersion: REVIEW_ANNOTATION_SNAPSHOT_VERSION,
		snapshot: parseEditorSnapshot(record.snapshot),
		source: parseSource(record.source),
	}
}

function parseReviewContext(value: unknown): ReviewAnnotationContext {
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

function parseSource(value: unknown): ReviewAnnotationSource {
	const record = requireRecord(value)
	requireExactKeys(record, ['contentType', 'height', 'sha256', 'width'])
	if (
		typeof record.contentType !== 'string' ||
		!/^image\/[a-z0-9.+-]{1,80}$/i.test(record.contentType)
	) {
		throw invalidSnapshot()
	}
	const height = requireDimension(record.height)
	const width = requireDimension(record.width)
	if (
		height * width > 16_777_216 ||
		typeof record.sha256 !== 'string' ||
		!/^[a-f0-9]{64}$/.test(record.sha256)
	) {
		throw invalidSnapshot()
	}
	return {
		contentType: record.contentType.toLowerCase(),
		height,
		sha256: record.sha256,
		width,
	}
}

function parseVersionZeroSource(value: unknown, sha256: string): ReviewAnnotationSource {
	const record = requireRecord(value)
	requireExactKeys(record, ['contentType', 'height', 'width'])
	if (
		typeof record.contentType !== 'string' ||
		!/^image\/[a-z0-9.+-]{1,80}$/i.test(record.contentType)
	) {
		throw invalidSnapshot()
	}
	const height = requireDimension(record.height)
	const width = requireDimension(record.width)
	if (height * width > 16_777_216) throw invalidSnapshot()
	return {
		contentType: record.contentType.toLowerCase(),
		height,
		sha256,
		width,
	}
}

function readLegacySourceDigest(snapshot: TLEditorSnapshot, versionId: number) {
	const matchingDigests = Object.values(
		snapshot.document.store as unknown as Record<string, unknown>
	).flatMap((value) => {
		if (!isRecord(value) || value.typeName !== 'asset' || value.type !== 'image') return []
		const meta = value.meta
		if (
			!isRecord(meta) ||
			meta.role !== REVIEW_IMAGE_ROLE ||
			meta.versionId !== versionId ||
			typeof meta.sha256 !== 'string' ||
			!/^[a-f0-9]{64}$/.test(meta.sha256)
		) {
			return []
		}
		return [meta.sha256]
	})
	if (matchingDigests.length !== 1) {
		throw new ReviewAnnotationSnapshotError(
			'UNSUPPORTED_SNAPSHOT_VERSION',
			'This legacy editable snapshot cannot be bound safely to its source media.'
		)
	}
	return matchingDigests[0]
}

function parseEditorSnapshot(value: unknown): TLEditorSnapshot {
	const record = requireRecord(value)
	requireExactKeys(record, ['document', 'session'])
	const document = requireRecord(record.document)
	const session = requireRecord(record.session)
	if (
		!isRecord(document.schema) ||
		!isRecord(document.store) ||
		Object.keys(document.store).length > MAX_REVIEW_ANNOTATION_RECORDS
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

function sameReviewContext(left: ReviewAnnotationContext, right: ReviewAnnotationContext) {
	return (
		left.projectId === right.projectId &&
		left.scope === right.scope &&
		left.versionId === right.versionId
	)
}

function requirePositiveId(value: unknown) {
	if (!Number.isSafeInteger(value) || Number(value) <= 0) throw invalidSnapshot()
	return Number(value)
}

function requireDimension(value: unknown) {
	if (!Number.isSafeInteger(value) || Number(value) <= 0 || Number(value) > 8_192) {
		throw invalidSnapshot()
	}
	return Number(value)
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

function invalidSnapshot(reason?: string) {
	return new ReviewAnnotationSnapshotError(
		'INVALID_SNAPSHOT',
		reason
			? `The editable review snapshot is invalid because ${reason}.`
			: 'The editable review snapshot is invalid.'
	)
}
