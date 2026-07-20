import { createContext, useCallback, useContext, type PropsWithChildren } from 'react'
import {
	BaseBoxShapeUtil,
	HTMLContainer,
	T,
	createShapeId,
	type Editor,
	type RecordProps,
	type TLCameraOptions,
	type TLShape,
} from 'tldraw'
import { runReviewSystemMutation } from './reviewSystemMutation'

export const REVIEW_VIDEO_SHAPE_TYPE = 'review-video' as const

const REVIEW_VIDEO_ROLE = 'shotgrid-review-video-source'
const REVIEW_VIDEO_SCHEMA_VERSION = 1

const positiveSafeInteger = T.number.check('positive safe integer', (value) => {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new RangeError('Expected a positive safe integer')
	}
})

declare module 'tldraw' {
	export interface TLGlobalShapePropsMap {
		[REVIEW_VIDEO_SHAPE_TYPE]: {
			attachmentId: number
			h: number
			name: string
			versionId: number
			w: number
		}
	}
}

export type ReviewVideoShape = TLShape<typeof REVIEW_VIDEO_SHAPE_TYPE>

/** Runtime-only playback information. The URL must never be copied into a tldraw record. */
export interface ReviewVideoSource {
	attachmentId: number
	contentType: 'video/mp4'
	height: number
	name: string
	url: string
	versionId: number
	width: number
}

export interface ReviewVideoRuntime {
	onVideoElement?(element: HTMLVideoElement | null): void
	source: ReviewVideoSource
}

const ReviewVideoRuntimeContext = createContext<ReviewVideoRuntime | null>(null)

export function ReviewVideoSourceProvider({
	children,
	value,
}: PropsWithChildren<{ value: ReviewVideoRuntime }>) {
	assertReviewVideoSource(value.source)
	return (
		<ReviewVideoRuntimeContext.Provider value={value}>
			{children}
		</ReviewVideoRuntimeContext.Provider>
	)
}

export class ReviewVideoShapeUtil extends BaseBoxShapeUtil<ReviewVideoShape> {
	static override type = REVIEW_VIDEO_SHAPE_TYPE
	static override props: RecordProps<ReviewVideoShape> = {
		attachmentId: positiveSafeInteger,
		h: positiveSafeInteger,
		name: T.string,
		versionId: positiveSafeInteger,
		w: positiveSafeInteger,
	}

	override getDefaultProps(): ReviewVideoShape['props'] {
		return {
			attachmentId: 1,
			h: 1,
			name: 'Review video',
			versionId: 1,
			w: 1,
		}
	}

	override canBeLaidOut() {
		return false
	}

	override canBind() {
		return false
	}

	override canEdit() {
		return false
	}

	override canResize() {
		return false
	}

	override canSnap() {
		return false
	}

	override canTabTo() {
		return false
	}

	override hideResizeHandles() {
		return true
	}

	override hideRotateHandle() {
		return true
	}

	override hideSelectionBoundsBg() {
		return true
	}

	override hideSelectionBoundsFg() {
		return true
	}

	override isAspectRatioLocked() {
		return true
	}

	override isExportBoundsContainer() {
		return true
	}

	override component(shape: ReviewVideoShape) {
		return <ReviewVideoShapeView shape={shape} />
	}

	override getIndicatorPath(shape: ReviewVideoShape) {
		const path = new Path2D()
		path.rect(0, 0, shape.props.w, shape.props.h)
		return path
	}

	/** Video pixels are composited at the requested frame by the dedicated review exporter. */
	override toSvg() {
		return null
	}
}

export const reviewVideoShapeUtils = [ReviewVideoShapeUtil] as const

export function getReviewVideoShapeId(versionId: number) {
	assertPositiveSafeInteger(versionId, 'versionId')
	return createShapeId(`shotgrid-review-video-${versionId}`)
}

export function getReviewVideoElementId(versionId: number) {
	assertPositiveSafeInteger(versionId, 'versionId')
	return `shotgrid-review-video-element-${versionId}`
}

export function getReviewVideoShapeProps(source: ReviewVideoSource): ReviewVideoShape['props'] {
	assertReviewVideoSource(source)
	return {
		attachmentId: source.attachmentId,
		h: source.height,
		name: source.name,
		versionId: source.versionId,
		w: source.width,
	}
}

export function isReviewVideoShapeForSource(
	shape: TLShape | undefined,
	source: ReviewVideoSource
): shape is ReviewVideoShape {
	assertReviewVideoSource(source)
	if (!shape || shape.type !== REVIEW_VIDEO_SHAPE_TYPE) return false
	const props = shape.props as ReviewVideoShape['props']
	return (
		shape.id === getReviewVideoShapeId(source.versionId) &&
		props.attachmentId === source.attachmentId &&
		props.h === source.height &&
		props.name === source.name &&
		props.versionId === source.versionId &&
		props.w === source.width
	)
}

export function installReviewVideo(
	editor: Editor,
	source: ReviewVideoSource,
	options: { localOnly?: boolean } = {}
) {
	assertReviewVideoSource(source)
	const shapeId = getReviewVideoShapeId(source.versionId)
	const existingShape = editor.getShape(shapeId)
	const createdBackground = !existingShape
	const sourceChanged = !isReviewVideoShapeForSource(existingShape, source)

	const install = () =>
		runReviewSystemMutation(editor, () =>
			editor.run(
				() => {
					if (existingShape && existingShape.type !== REVIEW_VIDEO_SHAPE_TYPE) {
						editor.deleteShape(existingShape)
					}

					const currentShape = editor.getShape(shapeId)
					if (currentShape?.type === REVIEW_VIDEO_SHAPE_TYPE) {
						editor.updateShape<ReviewVideoShape>({
							id: shapeId,
							isLocked: true,
							meta: reviewVideoMeta(source),
							opacity: 1,
							props: getReviewVideoShapeProps(source),
							rotation: 0,
							type: REVIEW_VIDEO_SHAPE_TYPE,
							x: 0,
							y: 0,
						})
					} else {
						editor.createShape<ReviewVideoShape>({
							id: shapeId,
							isLocked: true,
							meta: reviewVideoMeta(source),
							opacity: 1,
							props: getReviewVideoShapeProps(source),
							rotation: 0,
							type: REVIEW_VIDEO_SHAPE_TYPE,
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

	editor.setCameraOptions(getReviewVideoCameraOptions(source.width, source.height))
	if (sourceChanged) editor.setCamera(editor.getCamera(), { reset: true })

	return { createdBackground, shapeId, sourceChanged }
}

export function protectReviewVideo(
	editor: Editor,
	source: ReviewVideoSource,
	options: { localOnly?: boolean } = {}
) {
	assertReviewVideoSource(source)
	const shapeId = getReviewVideoShapeId(source.versionId)
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
			editor.store.mergeRemoteChanges(sendToBack)
		})
	}

	const disposers = [
		editor.sideEffects.registerBeforeChangeHandler('shape', (previous, next, changeSource) => {
			if (next.id !== shapeId) return next
			if (changeSource === 'remote') return next
			if (previous.type !== REVIEW_VIDEO_SHAPE_TYPE || next.type !== REVIEW_VIDEO_SHAPE_TYPE) {
				return previous
			}
			return {
				...next,
				index: previous.index,
				isLocked: true,
				meta: reviewVideoMeta(source),
				opacity: 1,
				parentId: previous.parentId,
				props: getReviewVideoShapeProps(source),
				rotation: 0,
				x: 0,
				y: 0,
			}
		}),
		editor.sideEffects.registerBeforeDeleteHandler('shape', (shape, changeSource) => {
			if (changeSource !== 'remote' && shape.id === shapeId) return false
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

export function getReviewVideoCameraOptions(
	width: number,
	height: number
): Partial<TLCameraOptions> {
	assertPositiveSafeInteger(width, 'width')
	assertPositiveSafeInteger(height, 'height')
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

export function findReviewVideoElement(
	editor: Pick<Editor, 'getContainer'>,
	source: Pick<ReviewVideoSource, 'attachmentId' | 'versionId'>
) {
	assertPositiveSafeInteger(source.versionId, 'versionId')
	assertPositiveSafeInteger(source.attachmentId, 'attachmentId')
	const element = editor
		.getContainer()
		.querySelector(`#${getReviewVideoElementId(source.versionId)}`)
	if (element?.tagName !== 'VIDEO') return null
	if (
		element.getAttribute('data-review-video-shape-id') !== getReviewVideoShapeId(source.versionId)
	) {
		return null
	}
	if (element.getAttribute('data-review-video-attachment-id') !== String(source.attachmentId)) {
		return null
	}
	return element as HTMLVideoElement
}

function ReviewVideoShapeView({ shape }: { shape: ReviewVideoShape }) {
	const runtime = useContext(ReviewVideoRuntimeContext)
	const onVideoElement = runtime?.onVideoElement
	const setVideoElement = useCallback(
		(element: HTMLVideoElement | null) => onVideoElement?.(element),
		[onVideoElement]
	)
	const source = runtime?.source
	const matches = source ? isReviewVideoShapeForSource(shape, source) : false

	return (
		<HTMLContainer
			id={shape.id}
			style={{
				backgroundColor: '#000',
				height: shape.props.h,
				overflow: 'hidden',
				pointerEvents: 'none',
				width: shape.props.w,
			}}
		>
			{source && matches ? (
				<video
					aria-label={shape.props.name}
					autoPlay={false}
					controls={false}
					crossOrigin="anonymous"
					data-review-video-attachment-id={source.attachmentId}
					data-review-video-shape-id={shape.id}
					disablePictureInPicture
					disableRemotePlayback
					draggable={false}
					id={getReviewVideoElementId(source.versionId)}
					key={`${source.attachmentId}:${source.url}`}
					loop={false}
					playsInline
					preload="metadata"
					ref={setVideoElement}
					style={{ display: 'block', height: '100%', objectFit: 'contain', width: '100%' }}
					tabIndex={-1}
				>
					<source src={source.url} type="video/mp4" />
				</video>
			) : null}
		</HTMLContainer>
	)
}

function reviewVideoMeta(source: ReviewVideoSource) {
	return {
		attachmentId: source.attachmentId,
		height: source.height,
		role: REVIEW_VIDEO_ROLE,
		schemaVersion: REVIEW_VIDEO_SCHEMA_VERSION,
		versionId: source.versionId,
		width: source.width,
	}
}

function assertReviewVideoSource(source: ReviewVideoSource): void {
	assertPositiveSafeInteger(source.attachmentId, 'attachmentId')
	assertPositiveSafeInteger(source.versionId, 'versionId')
	assertPositiveSafeInteger(source.width, 'width')
	assertPositiveSafeInteger(source.height, 'height')
	if (source.contentType !== 'video/mp4') {
		throw new TypeError('contentType must be video/mp4')
	}
	if (typeof source.name !== 'string' || source.name.trim().length === 0) {
		throw new TypeError('name must be a non-empty string')
	}
	if (typeof source.url !== 'string' || source.url.trim().length === 0) {
		throw new TypeError('url must be a non-empty string')
	}
}

function assertPositiveSafeInteger(value: number, label: string): void {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new RangeError(`${label} must be a positive safe integer`)
	}
}
