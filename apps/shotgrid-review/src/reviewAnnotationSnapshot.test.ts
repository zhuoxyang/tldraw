import { structuredClone, type TLEditorSnapshot } from 'tldraw'
import { describe, expect, it } from 'vitest'
import {
	assertReviewAnnotationRecords,
	assertReviewAnnotationSource,
	createReviewAnnotationSnapshot,
	parseReviewAnnotationSnapshot,
	parseReviewAnnotationSnapshotJson,
	REVIEW_ANNOTATION_SNAPSHOT_KIND,
	sanitizeReviewAnnotationSnapshot,
	serializeReviewAnnotationSnapshot,
} from './reviewAnnotationSnapshot'

const review = { projectId: 101, scope: 'studio-sandbox:shotgrid', versionId: 301 }
const source = {
	contentType: 'image/png',
	height: 1080,
	sha256: 'a'.repeat(64),
	width: 1920,
}
const snapshot = {
	document: { schema: {}, store: { 'document:document': { typeName: 'document' } } },
	session: { currentPageId: 'page:page', version: 0 },
} as unknown as TLEditorSnapshot

describe('review annotation snapshots', () => {
	it('round-trips the current editable snapshot envelope', () => {
		const value = createReviewAnnotationSnapshot({
			review,
			savedAt: '2026-07-20T00:00:00.000Z',
			snapshot,
			source,
		})

		expect(parseReviewAnnotationSnapshotJson(JSON.stringify(value), review)).toEqual(value)
		expect(value).toMatchObject({
			kind: REVIEW_ANNOTATION_SNAPSHOT_KIND,
			schemaVersion: 1,
		})
	})

	it('migrates the version-zero envelope without changing editable tldraw data', () => {
		const legacySnapshot = structuredClone(snapshot)
		;(legacySnapshot.document.store as unknown as Record<string, unknown>)['asset:source'] = {
			id: 'asset:source',
			meta: {
				role: 'shotgrid-review-source',
				sha256: source.sha256,
				versionId: review.versionId,
			},
			props: { src: null },
			type: 'image',
			typeName: 'asset',
		}
		const migrated = parseReviewAnnotationSnapshot(
			{
				review,
				schemaVersion: 0,
				snapshot: legacySnapshot,
				source: { contentType: source.contentType, height: source.height, width: source.width },
			},
			review
		)

		expect(migrated).toMatchObject({
			kind: REVIEW_ANNOTATION_SNAPSHOT_KIND,
			review,
			savedAt: null,
			schemaVersion: 1,
			snapshot: legacySnapshot,
			source,
		})
		expect(() => assertReviewAnnotationSource(migrated.source, source)).not.toThrow()
	})

	it('rejects a legacy snapshot that has no trustworthy source digest to migrate', () => {
		expect(() =>
			parseReviewAnnotationSnapshot(
				{
					review,
					schemaVersion: 0,
					snapshot,
					source: { contentType: source.contentType, height: source.height, width: source.width },
				},
				review
			)
		).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_SNAPSHOT_VERSION' }))
	})

	it('requires a source digest in version-one snapshots', () => {
		const value = createReviewAnnotationSnapshot({ review, snapshot, source })
		expect(() =>
			parseReviewAnnotationSnapshot({ ...value, source: { ...value.source, sha256: null } }, review)
		).toThrow(expect.objectContaining({ code: 'INVALID_SNAPSHOT' }))
	})

	it('refuses to save an editable snapshot larger than its own open limit', () => {
		const value = createReviewAnnotationSnapshot({ review, snapshot, source })
		;(value.snapshot.session as unknown as Record<string, unknown>).oversized = 'x'.repeat(
			16 * 1024 * 1024
		)
		expect(() => serializeReviewAnnotationSnapshot(value)).toThrow(
			expect.objectContaining({ code: 'INVALID_SNAPSHOT' })
		)
	})

	it('binds snapshots to the decoded source digest and dimensions', () => {
		expect(() =>
			assertReviewAnnotationSource(source, { ...source, sha256: 'b'.repeat(64) })
		).toThrow(expect.objectContaining({ code: 'SNAPSHOT_SOURCE_MISMATCH' }))
		expect(() => assertReviewAnnotationSource(source, source)).not.toThrow()
	})

	it('rejects snapshots for another Version before loading tldraw records', () => {
		const value = createReviewAnnotationSnapshot({ review, snapshot, source })
		expect(() => parseReviewAnnotationSnapshot(value, { ...review, versionId: 302 })).toThrow(
			expect.objectContaining({ code: 'SNAPSHOT_CONTEXT_MISMATCH' })
		)
	})

	it('rejects future schema versions and malformed editor payloads', () => {
		expect(() => parseReviewAnnotationSnapshot({ schemaVersion: 2 }, review)).toThrow(
			expect.objectContaining({ code: 'UNSUPPORTED_SNAPSHOT_VERSION' })
		)
		expect(() =>
			parseReviewAnnotationSnapshot(
				{
					kind: REVIEW_ANNOTATION_SNAPSHOT_KIND,
					review,
					savedAt: null,
					schemaVersion: 1,
					snapshot: { document: {}, session: {} },
					source,
				},
				review
			)
		).toThrow(expect.objectContaining({ code: 'INVALID_SNAPSHOT' }))
	})

	it('rejects unknown envelope fields instead of silently accepting them', () => {
		const value = createReviewAnnotationSnapshot({ review, snapshot, source })
		expect(() => parseReviewAnnotationSnapshot({ ...value, unexpected: true }, review)).toThrow(
			expect.objectContaining({ code: 'INVALID_SNAPSHOT' })
		)
	})

	it('removes local asset locations from portable editable snapshots', () => {
		const withAsset = structuredClone(snapshot)
		const store = withAsset.document.store as unknown as Record<string, unknown>
		store['asset:wrong-key'] = {
			id: 'asset:source',
			props: { src: 'asset:source' },
			type: 'image',
			typeName: 'asset',
		} as never

		const sanitizedStore = sanitizeReviewAnnotationSnapshot(withAsset, 'asset:source').document
			.store as unknown as Record<string, { props: { src: unknown } }>
		expect(sanitizedStore['asset:wrong-key'].props.src).toBeNull()
	})

	it('allows only a single protected source image and editable annotation records', () => {
		const editable = structuredClone(snapshot)
		const store: Record<string, unknown> = {
			'document:document': { id: 'document:document', typeName: 'document' },
			'page:page': { id: 'page:page', typeName: 'page' },
			'user:reviewer': {
				color: '#1d4ed8',
				id: 'user:reviewer',
				imageUrl: '',
				meta: {},
				name: 'Reviewer',
				typeName: 'user',
			},
			'asset:source': {
				id: 'asset:source',
				props: { src: null },
				type: 'image',
				typeName: 'asset',
			},
			'shape:source': { id: 'shape:source', type: 'image', typeName: 'shape' },
			'shape:draw': { id: 'shape:draw', type: 'draw', typeName: 'shape' },
		}
		editable.document.store = store as never

		expect(() =>
			assertReviewAnnotationRecords(editable, {
				sourceAssetId: 'asset:source',
				sourceShapeId: 'shape:source',
			})
		).not.toThrow()

		store['shape:video'] = {
			id: 'shape:video',
			type: 'video',
			typeName: 'shape',
		}
		expect(() =>
			assertReviewAnnotationRecords(editable, {
				sourceAssetId: 'asset:source',
				sourceShapeId: 'shape:source',
			})
		).toThrow(/invalid/i)

		delete store['shape:video']
		store['asset:external'] = {
			id: 'asset:external',
			props: { src: 'https://evil.example/image.png' },
			type: 'image',
			typeName: 'asset',
		}
		expect(() =>
			assertReviewAnnotationRecords(editable, {
				sourceAssetId: 'asset:source',
				sourceShapeId: 'shape:source',
			})
		).toThrow(/unsupported asset/i)

		delete store['asset:external']
		store['asset:wrong-key'] = store['asset:source']
		delete store['asset:source']
		expect(() =>
			assertReviewAnnotationRecords(editable, {
				sourceAssetId: 'asset:source',
				sourceShapeId: 'shape:source',
			})
		).toThrow(/store key/i)
	})
})
