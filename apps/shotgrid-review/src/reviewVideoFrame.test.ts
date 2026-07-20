import type { Editor, TLShapeId } from 'tldraw'
import { describe, expect, it, vi } from 'vitest'
import { renderReviewVideoFramePng, seekReviewVideoFrame } from './reviewVideoFrame'

describe('seekReviewVideoFrame', () => {
	it('pauses, seeks, and reports the frame time presented by the browser', async () => {
		const video = makeVideo({ currentTime: 0, duration: 5, presentedTime: 2.02 })

		await expect(seekReviewVideoFrame(video.element, 2)).resolves.toEqual({
			mediaTimeSeconds: 2.02,
			requestedTimeSeconds: 2,
		})
		expect(video.pause).toHaveBeenCalledOnce()
		expect(video.currentTime()).toBe(2)
		expect(video.requestVideoFrameCallback).toHaveBeenCalledOnce()
		expect(video.events).toEqual(['arm-presentation', 'start-seek', 'present-frame', 'seeked'])
	})

	it('clamps a request at the media duration without seeking beyond the source', async () => {
		const video = makeVideo({ currentTime: 0, duration: 5 })

		const result = await seekReviewVideoFrame(video.element, 10)

		expect(result.requestedTimeSeconds).toBeLessThan(5)
		expect(video.currentTime()).toBe(result.requestedTimeSeconds)
	})

	it('rejects an aborted operation before changing the video', async () => {
		const controller = new AbortController()
		controller.abort()
		const video = makeVideo({ currentTime: 0, duration: 5 })

		await expect(seekReviewVideoFrame(video.element, 1, controller.signal)).rejects.toMatchObject({
			name: 'AbortError',
		})
		expect(video.pause).not.toHaveBeenCalled()
	})

	it('waits for initial frame data without assigning the current time to itself', async () => {
		const video = makeVideo({ currentTime: 0, duration: 5, readyState: 1 })

		const result = seekReviewVideoFrame(video.element, 0)
		video.makeDataReady()

		await expect(result).resolves.toEqual({ mediaTimeSeconds: 0, requestedTimeSeconds: 0 })
		expect(video.currentTimeAssignments()).toBe(0)
		expect(video.load).toHaveBeenCalledOnce()
		expect(video.requestVideoFrameCallback).toHaveBeenCalledOnce()
	})

	it('requests initial data before seeking a metadata-only video to a later frame', async () => {
		const video = makeVideo({ currentTime: 0, duration: 5, readyState: 1 })

		const result = seekReviewVideoFrame(video.element, 2)
		video.makeDataReady()

		await expect(result).resolves.toEqual({ mediaTimeSeconds: 2, requestedTimeSeconds: 2 })
		expect(video.load).toHaveBeenCalledOnce()
		expect(video.currentTime()).toBe(2)
		expect(video.currentTimeAssignments()).toBe(1)
	})

	it('waits for a slider seek already in flight before accepting the presented frame', async () => {
		const video = makeVideo({
			currentTime: 2,
			duration: 5,
			presentedTime: 2.02,
			seeking: true,
		})

		const result = seekReviewVideoFrame(video.element, 2)
		video.finishPendingSeek()

		await expect(result).resolves.toEqual({
			mediaTimeSeconds: 2.02,
			requestedTimeSeconds: 2,
		})
		expect(video.currentTimeAssignments()).toBe(0)
		expect(video.requestVideoFrameCallback).toHaveBeenCalledOnce()
	})

	it('waits for seek completion before using the animation-frame fallback', async () => {
		const video = makeVideo({
			commitCurrentTimeOnSeeked: true,
			currentTime: 0,
			duration: 5,
			hasVideoFrameCallback: false,
		})

		await expect(seekReviewVideoFrame(video.element, 2)).resolves.toEqual({
			mediaTimeSeconds: 2,
			requestedTimeSeconds: 2,
		})
		expect(video.events).toEqual(['start-seek', 'seeked'])
	})
})

describe('renderReviewVideoFramePng', () => {
	it('exports the source frame without calling toImage for an empty annotation set', async () => {
		const video = makeVideo({ currentTime: 2, duration: 5, height: 1080, width: 1920 })
		const editor = makeEditor()
		const canvas = makeCanvas(1920, 1080)

		const result = await renderReviewVideoFramePng({
			createCanvas: () => canvas.element,
			editor,
			getAnnotationShapeIds: () => [],
			height: 1080,
			targetTimeSeconds: 2,
			video: video.element,
			width: 1920,
		})

		expect(result.blob.type).toBe('image/png')
		expect(editor.toImage).not.toHaveBeenCalled()
		expect(canvas.drawImage).toHaveBeenCalledOnce()
		expect(canvas.drawImage).toHaveBeenCalledWith(video.element, 0, 0, 1920, 1080)
	})

	it('renders a transparent annotation layer over the natural-resolution frame', async () => {
		const video = makeVideo({ currentTime: 1, duration: 5, height: 720, width: 1280 })
		const annotationPng = new Blob(['annotation'], { type: 'image/png' })
		const editor = makeEditor(annotationPng)
		const canvas = makeCanvas(1280, 720)
		const close = vi.fn()
		const bitmap = { close, height: 720, width: 1280 } as unknown as ImageBitmap
		const createImageBitmap = vi.fn(async () => bitmap)
		const annotationShapeIds = ['shape:note'] as TLShapeId[]

		await renderReviewVideoFramePng({
			createCanvas: () => canvas.element,
			createImageBitmap,
			editor,
			getAnnotationShapeIds: () => annotationShapeIds,
			height: 720,
			targetTimeSeconds: 1,
			video: video.element,
			width: 1280,
		})

		expect(editor.toImage).toHaveBeenCalledWith(annotationShapeIds, {
			background: false,
			bounds: expect.objectContaining({ h: 720, w: 1280, x: 0, y: 0 }),
			format: 'png',
			padding: 0,
			pixelRatio: 1,
			scale: 1,
		})
		expect(canvas.drawImage).toHaveBeenNthCalledWith(2, bitmap, 0, 0, 1280, 720)
		expect(close).toHaveBeenCalledOnce()
	})

	it('selects annotations from the single authoritative frame presented by the browser', async () => {
		const video = makeVideo({
			currentTime: 0,
			duration: 5,
			height: 720,
			presentedTime: 2.04,
			width: 1280,
		})
		const editor = makeEditor()
		const canvas = makeCanvas(1280, 720)
		const getAnnotationShapeIds = vi.fn(() => [] as TLShapeId[])

		const result = await renderReviewVideoFramePng({
			createCanvas: () => canvas.element,
			editor,
			getAnnotationShapeIds,
			height: 720,
			targetTimeSeconds: 2,
			video: video.element,
			width: 1280,
		})

		expect(result.mediaTimeSeconds).toBe(2.04)
		expect(getAnnotationShapeIds).toHaveBeenCalledOnce()
		expect(getAnnotationShapeIds).toHaveBeenCalledWith(2.04)
		expect(video.requestVideoFrameCallback).toHaveBeenCalledOnce()
	})

	it('fails closed when decoded dimensions do not match the expected source', async () => {
		const video = makeVideo({ currentTime: 1, duration: 5, height: 720, width: 1280 })

		await expect(
			renderReviewVideoFramePng({
				createCanvas: () => makeCanvas(1920, 1080).element,
				editor: makeEditor(),
				getAnnotationShapeIds: () => [],
				height: 1080,
				targetTimeSeconds: 1,
				video: video.element,
				width: 1920,
			})
		).rejects.toThrow('does not match the expected source resolution')
	})
})

function makeVideo(options: {
	commitCurrentTimeOnSeeked?: boolean
	currentTime: number
	duration: number
	hasVideoFrameCallback?: boolean
	height?: number
	presentedTime?: number
	readyState?: number
	seeking?: boolean
	width?: number
}) {
	const element = new EventTarget() as HTMLVideoElement
	let currentTime = options.currentTime
	let currentTimeAssignments = 0
	let pendingCurrentTime: number | undefined
	let readyState = options.readyState ?? 4
	let seeking = options.seeking ?? false
	const events: string[] = []
	const load = vi.fn()
	const pause = vi.fn()
	const requestVideoFrameCallback = vi.fn((callback: VideoFrameRequestCallback) => {
		events.push('arm-presentation')
		queueMicrotask(() => {
			events.push('present-frame')
			callback(0, {
				expectedDisplayTime: 0,
				height: options.height ?? 1080,
				mediaTime: options.presentedTime ?? currentTime,
				presentationTime: 0,
				presentedFrames: 1,
				processingDuration: 0,
				width: options.width ?? 1920,
			})
		})
		return 1
	})
	Object.defineProperties(element, {
		cancelVideoFrameCallback: { configurable: true, value: vi.fn() },
		currentTime: {
			configurable: true,
			get: () => currentTime,
			set: (value: number) => {
				events.push('start-seek')
				currentTimeAssignments++
				if (options.commitCurrentTimeOnSeeked) pendingCurrentTime = value
				else currentTime = value
				seeking = true
				queueMicrotask(() => {
					if (pendingCurrentTime !== undefined) {
						currentTime = pendingCurrentTime
						pendingCurrentTime = undefined
					}
					seeking = false
					events.push('seeked')
					element.dispatchEvent(new Event('seeked'))
				})
			},
		},
		duration: { configurable: true, value: options.duration },
		load: { configurable: true, value: load },
		pause: { configurable: true, value: pause },
		preload: { configurable: true, writable: true, value: 'metadata' },
		readyState: { configurable: true, get: () => readyState },
		requestVideoFrameCallback: {
			configurable: true,
			value: options.hasVideoFrameCallback === false ? undefined : requestVideoFrameCallback,
		},
		seeking: { configurable: true, get: () => seeking },
		videoHeight: { configurable: true, value: options.height ?? 1080 },
		videoWidth: { configurable: true, value: options.width ?? 1920 },
	})
	return {
		currentTime: () => currentTime,
		currentTimeAssignments: () => currentTimeAssignments,
		element,
		events,
		finishPendingSeek: () => {
			seeking = false
			element.dispatchEvent(new Event('seeked'))
		},
		load,
		makeDataReady: () => {
			readyState = 2
			element.dispatchEvent(new Event('loadeddata'))
		},
		pause,
		requestVideoFrameCallback,
	}
}

function makeEditor(annotationPng = new Blob(['annotation'], { type: 'image/png' })) {
	return {
		toImage: vi.fn(async () => ({ blob: annotationPng })),
	} as unknown as Editor
}

function makeCanvas(width: number, height: number) {
	const drawImage = vi.fn()
	const context = { drawImage } as unknown as CanvasRenderingContext2D
	const element = {
		getContext: vi.fn(() => context),
		height,
		toBlob: vi.fn((callback: BlobCallback) => callback(new Blob(['png'], { type: 'image/png' }))),
		width,
	} as unknown as HTMLCanvasElement
	return { drawImage, element }
}
