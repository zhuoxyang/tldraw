// @vitest-environment jsdom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { createShapeId, type Editor, type TLShape, type TLShapeId } from 'tldraw'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	REVIEW_VIDEO_SHAPE_TYPE,
	ReviewVideoShapeUtil,
	ReviewVideoSourceProvider,
	findReviewVideoElement,
	getReviewVideoCameraOptions,
	getReviewVideoElementId,
	getReviewVideoShapeId,
	getReviewVideoShapeProps,
	installReviewVideo,
	isReviewVideoShapeForSource,
	protectReviewVideo,
	type ReviewVideoShape,
	type ReviewVideoSource,
} from './reviewVideoShape'

;(
	globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const source: ReviewVideoSource = {
	attachmentId: 8801,
	contentType: 'video/mp4',
	height: 1080,
	name: 'shot_010_comp_v014',
	url: '/api/review/media/attachments/8801?signature=secret-one',
	versionId: 301,
	width: 1920,
}

let root: Root | undefined
let container: HTMLDivElement | undefined

afterEach(() => {
	if (root) act(() => root?.unmount())
	container?.remove()
	root = undefined
	container = undefined
})

describe('review video identity and dimensions', () => {
	it('uses deterministic ids without persisting the signed media URL', () => {
		expect(getReviewVideoShapeId(source.versionId)).toBe(getReviewVideoShapeId(source.versionId))
		expect(getReviewVideoShapeId(source.versionId)).not.toBe(getReviewVideoShapeId(302))
		expect(getReviewVideoElementId(source.versionId)).toBe('shotgrid-review-video-element-301')
		expect(getReviewVideoShapeProps(source)).toEqual({
			attachmentId: 8801,
			h: 1080,
			name: 'shot_010_comp_v014',
			versionId: 301,
			w: 1920,
		})
		expect(JSON.stringify(getReviewVideoShapeProps(source))).not.toContain('signature')
	})

	it('requires natural positive-integer dimensions and source identities', () => {
		for (const patch of [
			{ attachmentId: 0 },
			{ attachmentId: 1.5 },
			{ height: 0 },
			{ versionId: -1 },
			{ width: Number.MAX_SAFE_INTEGER + 1 },
		] satisfies Array<Partial<ReviewVideoSource>>) {
			expect(() => getReviewVideoShapeProps({ ...source, ...patch })).toThrow(
				'positive safe integer'
			)
		}
		expect(() =>
			getReviewVideoShapeProps({ ...source, contentType: 'video/mp4; codecs=avc1' as 'video/mp4' })
		).toThrow('contentType must be video/mp4')
	})

	it('constrains the camera to the exact natural video frame', () => {
		expect(getReviewVideoCameraOptions(1920, 1080)).toEqual({
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
})

describe('ReviewVideoShapeUtil runtime lifecycle', () => {
	it('renders a controlled MP4 element and releases its ref on identity changes and unmount', () => {
		const onVideoElement = vi.fn()
		const util = new ReviewVideoShapeUtil({} as Editor)
		const shape = makeShape(source)
		mount(
			<ReviewVideoSourceProvider value={{ onVideoElement, source }}>
				{util.component(shape)}
			</ReviewVideoSourceProvider>
		)

		const video = container?.querySelector('video')
		expect(video).toBeInstanceOf(HTMLVideoElement)
		expect(video?.autoplay).toBe(false)
		expect(video?.controls).toBe(false)
		expect(video?.loop).toBe(false)
		expect(video?.playsInline).toBe(true)
		expect(video?.preload).toBe('metadata')
		expect(video?.hasAttribute('disablepictureinpicture')).toBe(true)
		expect(video?.hasAttribute('disableremoteplayback')).toBe(true)
		expect(video?.querySelector('source')).toMatchObject({
			src: expect.stringContaining('/api/review/media/attachments/8801?signature=secret-one'),
			type: 'video/mp4',
		})
		expect(onVideoElement).toHaveBeenLastCalledWith(video)
		expect(
			findReviewVideoElement(
				{ getContainer: () => container! },
				{ attachmentId: source.attachmentId, versionId: source.versionId }
			)
		).toBe(video)

		const replacedSource = {
			...source,
			attachmentId: 8802,
			url: '/api/review/media/attachments/8802?signature=secret-two',
		}
		render(
			<ReviewVideoSourceProvider value={{ onVideoElement, source: replacedSource }}>
				{util.component(shape)}
			</ReviewVideoSourceProvider>
		)
		expect(container?.querySelector('video')).toBeNull()
		expect(container?.textContent).not.toContain('secret-two')
		expect(onVideoElement).toHaveBeenLastCalledWith(null)

		render(
			<ReviewVideoSourceProvider value={{ onVideoElement, source: replacedSource }}>
				{util.component(makeShape(replacedSource))}
			</ReviewVideoSourceProvider>
		)
		expect(container?.querySelector('source')?.getAttribute('src')).toContain('secret-two')

		act(() => root?.unmount())
		root = undefined
		expect(onVideoElement).toHaveBeenLastCalledWith(null)
	})

	it('finds only the expected attachment inside the provided editor container', () => {
		mount(
			<ReviewVideoSourceProvider value={{ source }}>
				{new ReviewVideoShapeUtil({} as Editor).component(makeShape(source))}
			</ReviewVideoSourceProvider>
		)
		const editor = { getContainer: () => container! }
		expect(
			findReviewVideoElement(editor, { attachmentId: 9999, versionId: source.versionId })
		).toBeNull()

		const otherContainer = document.createElement('div')
		expect(
			findReviewVideoElement(
				{ getContainer: () => otherContainer },
				{ attachmentId: source.attachmentId, versionId: source.versionId }
			)
		).toBeNull()
	})

	it('omits video pixels from the generic SVG exporter', () => {
		const util = new ReviewVideoShapeUtil({} as Editor)
		expect(util.toSvg()).toBeNull()
		expect(util.isExportBoundsContainer()).toBe(true)
	})
})

describe('review video installation and protection', () => {
	it('installs one locked bottom shape at natural dimensions without a URL record', () => {
		const harness = makeInstallEditor()
		const result = installReviewVideo(harness.editor, source)

		expect(result).toEqual({
			createdBackground: true,
			shapeId: getReviewVideoShapeId(source.versionId),
			sourceChanged: true,
		})
		expect(harness.createShape).toHaveBeenCalledWith(
			expect.objectContaining({
				id: getReviewVideoShapeId(source.versionId),
				isLocked: true,
				opacity: 1,
				props: getReviewVideoShapeProps(source),
				rotation: 0,
				type: REVIEW_VIDEO_SHAPE_TYPE,
				x: 0,
				y: 0,
			})
		)
		expect(JSON.stringify(harness.createShape.mock.calls[0][0])).not.toContain('signature')
		expect(harness.sendToBack).toHaveBeenCalledWith([result.shapeId])
		expect(harness.setCameraOptions).toHaveBeenCalledWith(
			getReviewVideoCameraOptions(source.width, source.height)
		)
		expect(harness.setCamera).toHaveBeenCalledWith({ x: 1, y: 2, z: 3 }, { reset: true })
	})

	it('restores every mutable field, blocks deletion, and keeps the source at the bottom', () => {
		const shape = makeShape(source)
		const harness = makeProtectionEditor(shape)
		const dispose = protectReviewVideo(harness.editor, source)

		expect(harness.sendToBack).toHaveBeenCalledWith([shape.id])
		const changed = harness.beforeChange?.(shape, {
			...shape,
			index: 'z9',
			isLocked: false,
			meta: { leakedUrl: source.url },
			opacity: 0.2,
			parentId: createShapeId('wrong-parent'),
			props: { ...shape.props, attachmentId: 9999, h: 1, name: 'wrong', w: 1 },
			rotation: Math.PI,
			x: 200,
			y: 300,
		} as unknown as ReviewVideoShape) as ReviewVideoShape
		expect(changed).toMatchObject({
			index: shape.index,
			isLocked: true,
			opacity: 1,
			parentId: shape.parentId,
			props: getReviewVideoShapeProps(source),
			rotation: 0,
			x: 0,
			y: 0,
		})
		expect(JSON.stringify(changed)).not.toContain(source.url)
		expect(harness.beforeDelete?.(shape)).toBe(false)
		expect(harness.beforeDelete?.(makeShape({ ...source, versionId: 302 }))).toBeUndefined()

		harness.ids = [createShapeId('annotation'), shape.id]
		harness.afterCreate?.()
		expect(harness.sendToBack).toHaveBeenLastCalledWith([shape.id])
		dispose()
		expect(harness.disposers.every((disposer) => disposer.mock.calls.length === 1)).toBe(true)
	})

	it('binds identity to both the Version and Attachment', () => {
		const shape = makeShape(source)
		expect(isReviewVideoShapeForSource(shape, source)).toBe(true)
		expect(isReviewVideoShapeForSource(shape, { ...source, attachmentId: 8802 })).toBe(false)
		expect(isReviewVideoShapeForSource(shape, { ...source, versionId: 302 })).toBe(false)
	})
})

function makeShape(value: ReviewVideoSource): ReviewVideoShape {
	return {
		id: getReviewVideoShapeId(value.versionId),
		index: 'a1',
		isLocked: true,
		meta: {},
		opacity: 1,
		parentId: createShapeId('page-parent'),
		props: getReviewVideoShapeProps(value),
		rotation: 0,
		type: REVIEW_VIDEO_SHAPE_TYPE,
		typeName: 'shape',
		x: 0,
		y: 0,
	} as ReviewVideoShape
}

function mount(node: React.ReactNode) {
	container = document.createElement('div')
	document.body.appendChild(container)
	root = createRoot(container)
	render(node)
}

function render(node: React.ReactNode) {
	act(() => root?.render(node))
}

function makeInstallEditor() {
	let shape: ReviewVideoShape | undefined
	const pageId = createShapeId('current-page')
	const createShape = vi.fn((partial: Partial<ReviewVideoShape>) => {
		shape = { ...makeShape(source), ...partial, parentId: pageId } as ReviewVideoShape
	})
	const sendToBack = vi.fn()
	const setCamera = vi.fn()
	const setCameraOptions = vi.fn()
	const editor = {
		createShape,
		deleteShape: vi.fn(() => {
			shape = undefined
		}),
		getCamera: () => ({ x: 1, y: 2, z: 3 }),
		getCurrentPageId: () => pageId,
		getShape: () => shape,
		moveShapesToPage: vi.fn(),
		run: (operation: () => void) => operation(),
		sendToBack,
		setCamera,
		setCameraOptions,
		updateShape: vi.fn((partial: Partial<ReviewVideoShape>) => {
			shape = { ...shape, ...partial } as ReviewVideoShape
		}),
	} as unknown as Editor
	return { createShape, editor, sendToBack, setCamera, setCameraOptions }
}

function makeProtectionEditor(shape: ReviewVideoShape) {
	let beforeChange: ((previous: TLShape, next: TLShape) => TLShape) | undefined
	let beforeDelete: ((record: TLShape) => false | undefined) | undefined
	let afterCreate: (() => void) | undefined
	const disposers = [vi.fn(), vi.fn(), vi.fn(), vi.fn()]
	const sendToBack = vi.fn(() => {
		harness.ids = [shape.id]
	})
	const harness = {
		afterCreate,
		beforeChange,
		beforeDelete,
		disposers,
		editor: undefined as unknown as Editor,
		ids: [createShapeId('annotation'), shape.id] as TLShapeId[],
		sendToBack,
	}
	harness.editor = {
		getShape: (id: TLShapeId) => (id === shape.id ? shape : undefined),
		getSortedChildIdsForParent: () => harness.ids,
		run: (operation: () => void) => operation(),
		sendToBack,
		sideEffects: {
			registerAfterChangeHandler: (_type: string, handler: () => void) => {
				harness.afterCreate = handler
				return disposers[3]
			},
			registerAfterCreateHandler: (_type: string, handler: () => void) => {
				harness.afterCreate = handler
				return disposers[2]
			},
			registerBeforeChangeHandler: (
				_type: string,
				handler: (previous: TLShape, next: TLShape) => TLShape
			) => {
				harness.beforeChange = handler
				return disposers[0]
			},
			registerBeforeDeleteHandler: (
				_type: string,
				handler: (record: TLShape) => false | undefined
			) => {
				harness.beforeDelete = handler
				return disposers[1]
			},
		},
	} as unknown as Editor
	return harness
}
