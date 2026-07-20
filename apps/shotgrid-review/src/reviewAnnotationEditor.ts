import {
	AssetRecordType,
	StateNode,
	createShapeId,
	toRichText,
	type Box,
	type Editor,
	type TLCameraOptions,
	type TLImageAsset,
	type TLImageShape,
	type TLShape,
} from 'tldraw'
import { runReviewSystemMutation } from './reviewSystemMutation'

const REVIEW_IMAGE_ROLE = 'shotgrid-review-source'
const REVIEW_MARKER_ROLE = 'shotgrid-review-numbered-marker'

export interface LoadedReviewImage {
	blob: Blob
	contentType: string
	height: number
	name: string
	sha256: string
	versionId: number
	width: number
}

export function getReviewImageIds(versionId: number) {
	if (!Number.isSafeInteger(versionId) || versionId <= 0) {
		throw new RangeError('versionId must be a positive safe integer')
	}
	return {
		assetId: AssetRecordType.createId(`shotgrid-review-source-${versionId}`),
		shapeId: createShapeId(`shotgrid-review-source-${versionId}`),
	}
}

export function disableReviewExternalContent(editor: Editor) {
	editor.registerExternalContentHandler('embed', null)
	editor.registerExternalContentHandler('excalidraw', null)
	editor.registerExternalContentHandler('file-replace', null)
	editor.registerExternalContentHandler('files', null)
	editor.registerExternalContentHandler('svg-text', null)
	editor.registerExternalContentHandler('tldraw', null)
	editor.registerExternalContentHandler('url', null)
}

export async function installReviewImage(
	editor: Editor,
	image: LoadedReviewImage,
	signal?: AbortSignal,
	options: { localOnly?: boolean } = {}
) {
	const { assetId, shapeId } = getReviewImageIds(image.versionId)
	const file = new File(
		[image.blob],
		`version-${image.versionId}.${extensionFor(image.contentType)}`,
		{
			type: image.contentType,
		}
	)
	const asset: TLImageAsset = {
		id: assetId,
		meta: {
			height: image.height,
			role: REVIEW_IMAGE_ROLE,
			schemaVersion: 1,
			sha256: image.sha256,
			versionId: image.versionId,
			width: image.width,
		},
		props: {
			h: image.height,
			isAnimated: false,
			mimeType: image.contentType,
			name: image.name,
			src: null,
			w: image.width,
		},
		type: 'image',
		typeName: 'asset',
	}
	const uploaded = await editor.uploadAsset(asset, file, signal)
	if (signal?.aborted) throw new DOMException('The image installation was aborted.', 'AbortError')
	asset.props.src = uploaded.src
	if (uploaded.meta) asset.meta = { ...asset.meta, ...uploaded.meta }

	const existingAsset = editor.getAsset(assetId)
	const existingShape = editor.getShape(shapeId)
	const createdBackground = !existingShape
	const install = () =>
		runReviewSystemMutation(editor, () =>
			editor.run(
				() => {
					if (existingShape && existingShape.type !== 'image') editor.deleteShape(existingShape)
					if (existingAsset && existingAsset.type !== 'image') editor.deleteAssets([existingAsset])

					if (editor.getAsset(assetId)) editor.updateAssets([asset])
					else editor.createAssets([asset])

					const currentShape = editor.getShape(shapeId)
					if (currentShape?.type === 'image') {
						editor.updateShape<TLImageShape>({
							id: shapeId,
							isLocked: true,
							meta: imageMeta(image),
							opacity: 1,
							props: getReviewImageShapeProps(image, assetId),
							rotation: 0,
							type: 'image',
							x: 0,
							y: 0,
						})
					} else {
						editor.createShape<TLImageShape>({
							id: shapeId,
							isLocked: true,
							meta: imageMeta(image),
							opacity: 1,
							props: getReviewImageShapeProps(image, assetId),
							rotation: 0,
							type: 'image',
							x: 0,
							y: 0,
						})
					}

					const background = editor.getShape(shapeId)
					if (background && background.parentId !== editor.getCurrentPageId()) {
						editor.moveShapesToPage([background], editor.getCurrentPageId())
					}
					editor.sendToBack([shapeId])
				},
				{ history: 'ignore', ignoreShapeLock: true }
			)
		)
	if (options.localOnly) editor.store.mergeRemoteChanges(install)
	else install()

	configureReviewCamera(editor, image, createdBackground)
	return { assetId, createdBackground, shapeId }
}

export function protectReviewImage(
	editor: Editor,
	image: LoadedReviewImage,
	options: { localOnly?: boolean } = {}
) {
	const { assetId, shapeId } = getReviewImageIds(image.versionId)
	let disposed = false
	let repairScheduled = false
	const ensureBackgroundIsBottom = () => {
		const shape = editor.getShape(shapeId)
		if (!shape) return
		const siblings = editor.getSortedChildIdsForParent(shape.parentId)
		if (siblings[0] === shapeId) return
		const sendToBack = () =>
			runReviewSystemMutation(editor, () =>
				editor.run(() => editor.sendToBack([shapeId]), {
					history: 'ignore',
					ignoreShapeLock: true,
				})
			)
		if (!options.localOnly) {
			sendToBack()
			return
		}
		if (repairScheduled) return
		repairScheduled = true
		queueMicrotask(() => {
			repairScheduled = false
			if (disposed) return
			const current = editor.getShape(shapeId)
			if (!current || editor.getSortedChildIdsForParent(current.parentId)[0] === shapeId) {
				return
			}
			// Side-effect callbacks run inside a Store atomic operation. Defer the local-only
			// repair so mergeRemoteChanges cannot nest and the source index is never uploaded.
			editor.store.mergeRemoteChanges(sendToBack)
		})
	}

	const disposers = [
		editor.sideEffects.registerBeforeChangeHandler('shape', (previous, next, source) => {
			if (next.id !== shapeId) return next
			if (source === 'remote') return next
			if (next.type !== 'image' || previous.type !== 'image') return previous
			return {
				...next,
				isLocked: true,
				meta: imageMeta(image),
				opacity: 1,
				parentId: previous.parentId,
				props: getReviewImageShapeProps(image, assetId),
				rotation: 0,
				x: 0,
				y: 0,
			}
		}),
		editor.sideEffects.registerBeforeDeleteHandler('shape', (shape, source) => {
			if (source !== 'remote' && shape.id === shapeId) return false
		}),
		editor.sideEffects.registerBeforeDeleteHandler('asset', (asset, source) => {
			if (source !== 'remote' && asset.id === assetId) return false
		}),
		editor.sideEffects.registerAfterCreateHandler('shape', ensureBackgroundIsBottom),
		editor.sideEffects.registerAfterChangeHandler('shape', ensureBackgroundIsBottom),
	]
	ensureBackgroundIsBottom()
	return () => {
		disposed = true
		disposers.forEach((dispose) => dispose())
	}
}

export function getReviewCameraOptions(width: number, height: number): Partial<TLCameraOptions> {
	return {
		constraints: {
			baseZoom: 'fit-max-100',
			behavior: 'contain',
			bounds: { h: height, w: width, x: 0, y: 0 },
			initialZoom: 'fit-max-100',
			origin: { x: 0.5, y: 0.5 },
			padding: { x: 32, y: 32 },
		},
	}
}

export function getReviewExportOptions(bounds: Box) {
	return {
		background: true,
		bounds,
		format: 'png' as const,
		padding: 0,
		pixelRatio: 1,
		scale: 1,
	}
}

export function getNextReviewMarkerNumber(shapes: readonly TLShape[]) {
	return (
		shapes.reduce((highest, shape) => {
			const markerNumber = shape.meta.reviewMarkerNumber
			return Number.isSafeInteger(markerNumber) && Number(markerNumber) > highest
				? Number(markerNumber)
				: highest
		}, 0) + 1
	)
}

export function getReviewMarkerSize(width: number, height: number) {
	return Math.max(36, Math.min(96, Math.round(Math.min(width, height) * 0.05)))
}

export class ReviewMarkerTool extends StateNode {
	static override id = 'review-marker'

	override onEnter() {
		this.editor.setCursor({ rotation: 0, type: 'cross' })
	}

	override onPointerUp() {
		const source = this.editor
			.getCurrentPageShapes()
			.find(
				(shape) =>
					shape.meta.role === REVIEW_IMAGE_ROLE || (shape.type === 'review-video' && shape.isLocked)
			)
		if (!source || (source.type !== 'image' && source.type !== 'review-video')) {
			this.editor.setCurrentTool('select')
			return
		}

		const markerNumber = getNextReviewMarkerNumber(this.editor.getCurrentPageShapes())
		const size = getReviewMarkerSize(source.props.w, source.props.h)
		const point = this.editor.inputs.getCurrentPagePoint()
		this.editor.createShape({
			meta: { reviewAnnotation: REVIEW_MARKER_ROLE, reviewMarkerNumber: markerNumber },
			props: {
				color: 'red',
				fill: 'solid',
				geo: 'ellipse',
				h: size,
				labelColor: 'white',
				richText: toRichText(String(markerNumber)),
				w: size,
			},
			type: 'geo',
			x: point.x - size / 2,
			y: point.y - size / 2,
		})

		if (!this.editor.getInstanceState().isToolLocked) this.editor.setCurrentTool('select')
	}
}

function configureReviewCamera(editor: Editor, image: LoadedReviewImage, reset: boolean) {
	editor.setCameraOptions(getReviewCameraOptions(image.width, image.height))
	if (reset) editor.setCamera(editor.getCamera(), { reset: true })
}

function imageMeta(image: LoadedReviewImage) {
	return {
		height: image.height,
		role: REVIEW_IMAGE_ROLE,
		schemaVersion: 1,
		sha256: image.sha256,
		versionId: image.versionId,
		width: image.width,
	}
}

export function getReviewImageShapeProps(
	image: LoadedReviewImage,
	assetId: ReturnType<typeof getReviewImageIds>['assetId']
): TLImageShape['props'] {
	return {
		altText: image.name,
		assetId,
		crop: null,
		flipX: false,
		flipY: false,
		h: image.height,
		playing: false,
		url: '',
		w: image.width,
	}
}

function extensionFor(contentType: string) {
	if (contentType === 'image/jpeg') return 'jpg'
	if (contentType === 'image/webp') return 'webp'
	return 'png'
}
