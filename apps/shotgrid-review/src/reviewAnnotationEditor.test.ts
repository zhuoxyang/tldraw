import { Box, createShapeId, type Editor, type TLShape, type TLShapeId } from 'tldraw'
import { describe, expect, it, vi } from 'vitest'
import {
	disableReviewExternalContent,
	getNextReviewMarkerNumber,
	getReviewCameraOptions,
	getReviewExportOptions,
	getReviewImageIds,
	getReviewImageShapeProps,
	getReviewMarkerSize,
	protectReviewImage,
} from './reviewAnnotationEditor'

describe('review annotation editor helpers', () => {
	it('disables external content that would create unsupported assets or shapes', () => {
		const registerExternalContentHandler = vi.fn()
		disableReviewExternalContent({ registerExternalContentHandler } as unknown as Editor)

		expect(registerExternalContentHandler.mock.calls).toEqual([
			['embed', null],
			['excalidraw', null],
			['file-replace', null],
			['files', null],
			['svg-text', null],
			['tldraw', null],
			['url', null],
		])
	})
	it('uses deterministic media ids that do not depend on expiring URLs', () => {
		expect(getReviewImageIds(301)).toEqual(getReviewImageIds(301))
		expect(getReviewImageIds(301)).not.toEqual(getReviewImageIds(302))
		expect(getReviewImageIds(301).shapeId).not.toContain('https')
	})

	it('constrains the camera to the complete source image', () => {
		expect(getReviewCameraOptions(1920, 1080)).toEqual({
			constraints: {
				baseZoom: 'fit-max-100',
				behavior: 'contain',
				bounds: { h: 1080, w: 1920, x: 0, y: 0 },
				initialZoom: 'fit-max-100',
				origin: { x: 0.5, y: 0.5 },
				padding: { x: 32, y: 32 },
			},
		})
	})

	it('exports one source pixel per PNG pixel with no padding', () => {
		const bounds = new Box(0, 0, 1920, 1080)
		expect(getReviewExportOptions(bounds)).toEqual({
			background: true,
			bounds,
			format: 'png',
			padding: 0,
			pixelRatio: 1,
			scale: 1,
		})
	})

	it('resets every mutable source-image property to a safe full-frame value', () => {
		const image = {
			blob: new Blob(['image'], { type: 'image/png' }),
			contentType: 'image/png',
			height: 1080,
			name: 'shot_010_lgt_v014',
			sha256: 'a'.repeat(64),
			versionId: 301,
			width: 1920,
		}
		const { assetId } = getReviewImageIds(image.versionId)

		expect(getReviewImageShapeProps(image, assetId)).toEqual({
			altText: image.name,
			assetId,
			crop: null,
			flipX: false,
			flipY: false,
			h: 1080,
			playing: false,
			url: '',
			w: 1920,
		})
	})

	it('continues numbered markers from the highest editable marker', () => {
		const shapes = [
			{ id: createShapeId('one'), meta: { reviewMarkerNumber: 1 } },
			{ id: createShapeId('three'), meta: { reviewMarkerNumber: 3 } },
			{ id: createShapeId('ignored'), meta: { reviewMarkerNumber: '9' } },
		] as unknown as TLShape[]
		expect(getNextReviewMarkerNumber(shapes)).toBe(4)
	})

	it('scales markers with source pixels inside readable limits', () => {
		expect(getReviewMarkerSize(320, 180)).toBe(36)
		expect(getReviewMarkerSize(1920, 1080)).toBe(54)
		expect(getReviewMarkerSize(8192, 4096)).toBe(96)
	})

	it('defers local-only image layer repairs outside store side effects', async () => {
		const image = {
			blob: new Blob(['image'], { type: 'image/png' }),
			contentType: 'image/png',
			height: 1080,
			name: 'shot_010_lgt_v014',
			sha256: 'a'.repeat(64),
			versionId: 301,
			width: 1920,
		}
		const { shapeId } = getReviewImageIds(image.versionId)
		const parentId = createShapeId('page-parent')
		const shape = { id: shapeId, parentId, type: 'image' } as TLShape
		let ids = [createShapeId('annotation'), shapeId] as TLShapeId[]
		let insideSideEffect = false
		let afterChange: (() => void) | undefined
		const sendToBack = vi.fn(() => {
			ids = [shapeId]
		})
		const mergeRemoteChanges = vi.fn((operation: () => void) => {
			if (insideSideEffect) throw new Error('nested remote merge')
			operation()
		})
		const editor = {
			getIsReadonly: () => false,
			getShape: (id: TLShapeId) => (id === shapeId ? shape : undefined),
			getSortedChildIdsForParent: () => ids,
			run: (operation: () => void) => operation(),
			sendToBack,
			sideEffects: {
				registerAfterChangeHandler: (_type: string, handler: () => void) => {
					afterChange = handler
					return vi.fn()
				},
				registerAfterCreateHandler: (_type: string, handler: () => void) => {
					afterChange = handler
					return vi.fn()
				},
				registerBeforeChangeHandler: () => vi.fn(),
				registerBeforeDeleteHandler: () => vi.fn(),
			},
			store: { mergeRemoteChanges },
		} as unknown as Editor
		const dispose = protectReviewImage(editor, image, { localOnly: true })

		expect(mergeRemoteChanges).not.toHaveBeenCalled()
		await Promise.resolve()
		expect(mergeRemoteChanges).toHaveBeenCalledOnce()

		ids = [createShapeId('new-annotation'), shapeId]
		insideSideEffect = true
		afterChange?.()
		insideSideEffect = false
		expect(mergeRemoteChanges).toHaveBeenCalledOnce()
		await Promise.resolve()
		expect(mergeRemoteChanges).toHaveBeenCalledTimes(2)

		dispose()
	})
})
