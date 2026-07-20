// @vitest-environment jsdom

import type { ReviewVideoMedia } from '@tldraw/shotgrid-review-contracts'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(
	globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const videoCanvasMocks = vi.hoisted(() => ({
	createSnapshot: vi.fn(),
	createSnapshotSource: vi.fn(),
	disableExternalContent: vi.fn(),
	duration: 1,
	editor: undefined as unknown as Record<string, unknown>,
	editorMounts: 0,
	getSnapshot: vi.fn(() => ({ document: {}, session: {} })),
	installVideo: vi.fn(),
	loadSnapshot: vi.fn(),
	metadataReady: false,
	onVideoElement: undefined as ((element: HTMLVideoElement | null) => void) | undefined,
	parseSnapshot: vi.fn(),
	paused: true,
	play: vi.fn(),
	protectVideo: vi.fn(),
	readonlyHistory: [] as boolean[],
	renderFrame: vi.fn(),
	seek: vi.fn(),
	selectedIds: [] as string[],
	serializeSnapshot: vi.fn(() => '{}'),
	shapes: new Map<string, unknown>(),
	tldrawProps: undefined as
		| {
				getShapeVisibility?(shape: unknown): 'hidden' | 'inherit'
				onMount?(editor: unknown): void
		  }
		| undefined,
	video: null as HTMLVideoElement | null,
	videoCurrentTime: 0,
	videoHeight: 1080,
	videoWidth: 1920,
}))

vi.mock('tldraw', async () => {
	const React = await import('react')
	return {
		DefaultToolbar: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
		SVGContainer: ({ children }: { children?: React.ReactNode }) => <svg>{children}</svg>,
		Tldraw: ({
			getShapeVisibility,
			onMount,
			persistenceKey,
		}: {
			getShapeVisibility?(shape: unknown): 'hidden' | 'inherit'
			onMount?(editor: unknown): void
			persistenceKey?: string
		}) => {
			videoCanvasMocks.tldrawProps = { getShapeVisibility, onMount }
			React.useEffect(() => {
				videoCanvasMocks.editorMounts++
				onMount?.(videoCanvasMocks.editor)
			}, [getShapeVisibility, onMount, persistenceKey])
			return <div data-testid="mock-tldraw">Mock video editor</div>
		},
		ToolbarItem: ({ tool }: { tool: string }) => <span>{tool}</span>,
		atom: <T,>(_name: string, initialValue: T) => {
			let value = initialValue
			return {
				get: () => value,
				set: (next: T) => {
					value = next
				},
			}
		},
		getSnapshot: videoCanvasMocks.getSnapshot,
		loadSnapshot: videoCanvasMocks.loadSnapshot,
		track: <T,>(component: T) => component,
		useEditor: () => videoCanvasMocks.editor,
	}
})

vi.mock('./reviewAnnotationEditor', () => ({
	disableReviewExternalContent: videoCanvasMocks.disableExternalContent,
	ReviewMarkerTool: class ReviewMarkerTool {},
}))

vi.mock('./reviewPublication', () => ({
	sanitizeReviewFileNameBase: (value: string) => value,
}))

vi.mock('./reviewVideoFrame', () => ({
	renderReviewVideoFramePng: videoCanvasMocks.renderFrame,
	seekReviewVideoFrame: videoCanvasMocks.seek,
}))

vi.mock('./reviewVideoShape', async () => {
	const React = await import('react')
	return {
		REVIEW_VIDEO_SHAPE_TYPE: 'review-video',
		ReviewVideoSourceProvider: ({
			children,
			value,
		}: {
			children?: React.ReactNode
			value: { onVideoElement?(element: HTMLVideoElement | null): void }
		}) => {
			const { onVideoElement } = value
			videoCanvasMocks.onVideoElement = onVideoElement
			const setVideo = React.useCallback(
				(element: HTMLVideoElement | null) => {
					if (element) configureVideoElement(element)
					videoCanvasMocks.video = element
					onVideoElement?.(element)
				},
				[onVideoElement]
			)
			return (
				<>
					{children}
					<video data-testid="mock-review-video" ref={setVideo} />
				</>
			)
		},
		getReviewVideoShapeId: (versionId: number) => `shape:review-video-${versionId}`,
		installReviewVideo: videoCanvasMocks.installVideo,
		protectReviewVideo: videoCanvasMocks.protectVideo,
		reviewVideoShapeUtils: [],
	}
})

vi.mock('./reviewVideoSnapshot', () => ({
	MAX_REVIEW_VIDEO_SNAPSHOT_BYTES: 16 * 1024 * 1024,
	createReviewVideoSnapshot: videoCanvasMocks.createSnapshot,
	createReviewVideoSnapshotSource: videoCanvasMocks.createSnapshotSource,
	parseReviewVideoSnapshotJson: videoCanvasMocks.parseSnapshot,
	serializeReviewVideoSnapshot: videoCanvasMocks.serializeSnapshot,
}))

import { REVIEW_ANNOTATION_TARGET_META_KEY } from './reviewAnnotationTarget'
import { ReviewVideoCanvas } from './ReviewVideoCanvas'

const media: ReviewVideoMedia = {
	attachmentId: 901,
	contentType: 'video/mp4',
	durationSeconds: 1,
	fileName: 'shot_010.mp4',
	firstFrame: 1001,
	frameCount: 24,
	frameRate: 24,
	frameRateMode: 'constant',
	height: null,
	kind: 'video',
	lastFrame: 1024,
	thumbnailUrl: null,
	url: '/api/review/playlists/201/versions/301/media/video/901',
	width: null,
}

let root: Root | undefined
let container: HTMLDivElement | undefined

beforeEach(() => {
	vi.clearAllMocks()
	videoCanvasMocks.metadataReady = false
	videoCanvasMocks.onVideoElement = undefined
	videoCanvasMocks.editorMounts = 0
	videoCanvasMocks.paused = true
	videoCanvasMocks.readonlyHistory.length = 0
	videoCanvasMocks.selectedIds = []
	videoCanvasMocks.shapes.clear()
	videoCanvasMocks.tldrawProps = undefined
	videoCanvasMocks.video = null
	videoCanvasMocks.videoCurrentTime = 0

	const register = vi.fn(() => vi.fn())
	videoCanvasMocks.editor = {
		deleteBinding: vi.fn(),
		deleteBindings: vi.fn(),
		getBindingsFromShape: vi.fn(() => []),
		getBindingsToShape: vi.fn(() => []),
		getCurrentPageShapes: vi.fn(() => [...videoCanvasMocks.shapes.values()]),
		getCurrentPageId: vi.fn(() => 'page:page'),
		getSelectedShapeIds: vi.fn(() => [...videoCanvasMocks.selectedIds]),
		getShape: vi.fn((id: string) => videoCanvasMocks.shapes.get(id)),
		setCurrentTool: vi.fn(),
		setSelectedShapes: vi.fn((ids: string[]) => {
			videoCanvasMocks.selectedIds = [...ids]
		}),
		sideEffects: {
			registerAfterChangeHandler: register,
			registerAfterCreateHandler: register,
			registerBeforeChangeHandler: register,
			registerBeforeCreateHandler: register,
		},
		store: {},
		updateInstanceState: vi.fn(({ isReadonly }: { isReadonly: boolean }) => {
			videoCanvasMocks.readonlyHistory.push(isReadonly)
		}),
	}
	videoCanvasMocks.protectVideo.mockImplementation(() => vi.fn())
	videoCanvasMocks.seek.mockImplementation(
		async (_video: HTMLVideoElement, targetTimeSeconds: number) => {
			videoCanvasMocks.videoCurrentTime = targetTimeSeconds
			return {
				mediaTimeSeconds: targetTimeSeconds,
				requestedTimeSeconds: targetTimeSeconds,
			}
		}
	)
	videoCanvasMocks.createSnapshotSource.mockImplementation((options) => ({
		...options,
		durationMs: options.durationSeconds * 1_000,
	}))
	videoCanvasMocks.createSnapshot.mockImplementation((options) => options)
	videoCanvasMocks.parseSnapshot.mockReturnValue({ snapshot: { document: {}, session: {} } })
	videoCanvasMocks.play.mockImplementation(async () => {
		videoCanvasMocks.paused = false
		videoCanvasMocks.video?.dispatchEvent(new Event('play'))
	})
})

afterEach(() => {
	if (root) act(() => root?.unmount())
	container?.remove()
	root = undefined
	container = undefined
})

describe('ReviewVideoCanvas controls', () => {
	it('locks editing during playback and navigates exact neighboring frames', async () => {
		videoCanvasMocks.metadataReady = true
		await mountCanvas()
		const annotation = {
			id: 'shape:annotation',
			meta: {
				[REVIEW_ANNOTATION_TARGET_META_KEY]: {
					endFrame: 1001,
					kind: 'frame',
					startFrame: 1001,
				},
			},
			type: 'draw',
		}
		videoCanvasMocks.shapes.set(annotation.id, annotation)
		videoCanvasMocks.selectedIds = [annotation.id]

		expect(videoCanvasMocks.readonlyHistory.at(-1)).toBe(false)
		expect(videoCanvasMocks.tldrawProps?.getShapeVisibility?.(annotation)).toBe('inherit')

		await clickButton('Next frame')
		expect(videoCanvasMocks.seek).toHaveBeenLastCalledWith(
			videoCanvasMocks.video,
			expect.closeTo(1.5 / 24),
			expect.any(AbortSignal)
		)
		expect(videoCanvasMocks.tldrawProps?.getShapeVisibility?.(annotation)).toBe('hidden')
		expect(videoCanvasMocks.selectedIds).toEqual([])

		await clickButton('Previous frame')
		expect(videoCanvasMocks.seek).toHaveBeenLastCalledWith(
			videoCanvasMocks.video,
			expect.closeTo(0.5 / 24),
			expect.any(AbortSignal)
		)
		expect(videoCanvasMocks.tldrawProps?.getShapeVisibility?.(annotation)).toBe('inherit')

		await clickButton('Play')
		expect(videoCanvasMocks.readonlyHistory.at(-1)).toBe(true)
		expect(findButton('Pause').disabled).toBe(false)
		expect(findButton('Next frame').disabled).toBe(true)
		expect(findButton('Save editable').disabled).toBe(true)

		await clickButton('Pause')
		expect(videoCanvasMocks.readonlyHistory.at(-1)).toBe(false)
		expect(findButton('Next frame').disabled).toBe(false)
	})

	it('enables editable actions only after metadata is ready and disables them while opening', async () => {
		await mountCanvas()
		expect(findButton('Save editable').disabled).toBe(true)
		expect(findButton('Open editable').disabled).toBe(true)
		expect(container?.textContent).toContain('Loading MP4 metadata')

		videoCanvasMocks.metadataReady = true
		await act(async () => {
			videoCanvasMocks.video?.dispatchEvent(new Event('loadedmetadata'))
		})
		expect(videoCanvasMocks.editorMounts).toBe(1)
		await act(async () => {
			videoCanvasMocks.video?.dispatchEvent(new Event('durationchange'))
		})
		expect(videoCanvasMocks.editorMounts).toBe(1)
		expect(findButton('Save editable').disabled).toBe(false)
		expect(findButton('Open editable').disabled).toBe(false)

		const fileText = deferred<string>()
		const file = {
			size: 2,
			text: () => fileText.promise,
		} as File
		const input = container?.querySelector<HTMLInputElement>('input[type="file"]')
		expect(input).toBeTruthy()
		Object.defineProperty(input, 'files', { configurable: true, value: [file] })
		act(() => input?.dispatchEvent(new Event('change', { bubbles: true })))
		await act(async () => Promise.resolve())

		expect(container?.textContent).toContain('Opening editable video snapshot')
		expect(findButton('Save editable').disabled).toBe(true)
		expect(findButton('Open editable').disabled).toBe(true)
		expect(findButton('Next frame').disabled).toBe(true)

		await act(async () => {
			fileText.resolve('{}')
			await fileText.promise
		})
		expect(videoCanvasMocks.parseSnapshot).toHaveBeenCalled()
		expect(videoCanvasMocks.loadSnapshot).toHaveBeenCalled()
		expect(container?.textContent).toContain('Editable video snapshot opened')
		expect(findButton('Save editable').disabled).toBe(false)
		expect(findButton('Open editable').disabled).toBe(false)
	})

	it('keeps editing locked until a controlled seek presents its decoded frame', async () => {
		videoCanvasMocks.metadataReady = true
		await mountCanvas()
		const annotation = {
			id: 'shape:annotation',
			meta: {
				[REVIEW_ANNOTATION_TARGET_META_KEY]: {
					endFrame: 1001,
					kind: 'frame',
					startFrame: 1001,
				},
			},
			type: 'draw',
		}
		videoCanvasMocks.shapes.set(annotation.id, annotation)
		expect(videoCanvasMocks.tldrawProps?.getShapeVisibility?.(annotation)).toBe('inherit')

		const presented = deferred<{ mediaTimeSeconds: number; requestedTimeSeconds: number }>()
		videoCanvasMocks.seek.mockImplementationOnce(() => presented.promise)
		const scrubber = container?.querySelector<HTMLInputElement>('input[type="range"]')
		expect(scrubber).toBeTruthy()
		await act(async () => {
			if (!scrubber) return
			setNativeInputValue(scrubber, '0.1')
			scrubber.dispatchEvent(new Event('input', { bubbles: true }))
			await Promise.resolve()
		})

		expect(findButton('Save editable').disabled).toBe(true)
		expect(videoCanvasMocks.tldrawProps?.getShapeVisibility?.(annotation)).toBe('inherit')
		await act(async () => {
			videoCanvasMocks.video?.dispatchEvent(new Event('seeked'))
		})
		expect(findButton('Save editable').disabled).toBe(true)
		expect(videoCanvasMocks.tldrawProps?.getShapeVisibility?.(annotation)).toBe('inherit')

		await act(async () => {
			presented.resolve({ mediaTimeSeconds: 0.1, requestedTimeSeconds: 0.1 })
			await presented.promise
			await Promise.resolve()
			await Promise.resolve()
		})
		expect(findButton('Save editable').disabled).toBe(false)
		expect(videoCanvasMocks.tldrawProps?.getShapeVisibility?.(annotation)).toBe('hidden')
	})

	it('does not unlock the editor until the initial decoded frame is ready', async () => {
		videoCanvasMocks.metadataReady = true
		const presented = deferred<{ mediaTimeSeconds: number; requestedTimeSeconds: number }>()
		videoCanvasMocks.seek.mockImplementationOnce(() => presented.promise)

		await mountCanvas()
		expect(findButton('Play').disabled).toBe(true)
		expect(findButton('Save editable').disabled).toBe(true)
		expect(videoCanvasMocks.readonlyHistory.at(-1)).toBe(true)

		await act(async () => {
			presented.resolve({ mediaTimeSeconds: 0, requestedTimeSeconds: 0 })
			await presented.promise
			await Promise.resolve()
			await Promise.resolve()
		})
		expect(findButton('Play').disabled).toBe(false)
		expect(findButton('Save editable').disabled).toBe(false)
		expect(videoCanvasMocks.readonlyHistory.at(-1)).toBe(false)
	})

	it('clears an exporting state when its video element is replaced', async () => {
		videoCanvasMocks.metadataReady = true
		await mountCanvas()
		videoCanvasMocks.renderFrame.mockImplementationOnce(
			({ signal }: { signal: AbortSignal }) =>
				new Promise((_resolve, reject) => {
					signal.addEventListener(
						'abort',
						() => reject(new DOMException('The video operation was aborted.', 'AbortError')),
						{ once: true }
					)
				})
		)

		await clickButton('Export current frame PNG')
		expect(container?.textContent).toContain('Rendering source-resolution video frame')
		await act(async () => {
			videoCanvasMocks.onVideoElement?.(null)
			await Promise.resolve()
			await Promise.resolve()
		})

		expect(container?.textContent).not.toContain('Rendering source-resolution video frame')
	})

	it('releases the operation lock when snapshot capture fails before opening', async () => {
		videoCanvasMocks.metadataReady = true
		await mountCanvas()
		videoCanvasMocks.getSnapshot.mockImplementationOnce(() => {
			throw new Error('The editor store is unavailable.')
		})
		const file = { size: 2, text: vi.fn(async () => '{}') } as unknown as File
		const input = container?.querySelector<HTMLInputElement>('input[type="file"]')
		expect(input).toBeTruthy()
		Object.defineProperty(input, 'files', { configurable: true, value: [file] })
		await act(async () => {
			input?.dispatchEvent(new Event('change', { bubbles: true }))
			await Promise.resolve()
		})

		expect(container?.textContent).toContain('The editor store is unavailable.')
		expect(findButton('Save editable').disabled).toBe(false)
		const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {})
		try {
			await clickButton('Save editable')
			expect(videoCanvasMocks.createSnapshot).toHaveBeenCalledOnce()
		} finally {
			anchorClick.mockRestore()
		}
	})
})

async function mountCanvas() {
	container = document.createElement('div')
	document.body.appendChild(container)
	root = createRoot(container)
	await act(async () => {
		root?.render(
			<ReviewVideoCanvas
				documentKey="document-301"
				media={media}
				persistenceKey="review-301"
				projectId={101}
				reviewScope="local-dev:mock:mock"
				versionId={301}
				versionName="shot_010_v001"
			/>
		)
	})
}

async function clickButton(label: string) {
	await act(async () => {
		findButton(label).click()
		await Promise.resolve()
	})
}

function findButton(label: string) {
	const button = [...(container?.querySelectorAll('button') ?? [])].find((candidate) =>
		candidate.textContent?.replace(/\s+/g, ' ').trim().includes(label)
	)
	if (!button) throw new Error(`Could not find button: ${label}`)
	return button
}

function configureVideoElement(video: HTMLVideoElement) {
	Object.defineProperties(video, {
		currentTime: {
			configurable: true,
			get: () => videoCanvasMocks.videoCurrentTime,
			set: (value: number) => {
				videoCanvasMocks.videoCurrentTime = value
			},
		},
		duration: { configurable: true, get: () => videoCanvasMocks.duration },
		ended: { configurable: true, get: () => false },
		paused: { configurable: true, get: () => videoCanvasMocks.paused },
		readyState: { configurable: true, get: () => (videoCanvasMocks.metadataReady ? 1 : 0) },
		videoHeight: { configurable: true, get: () => videoCanvasMocks.videoHeight },
		videoWidth: { configurable: true, get: () => videoCanvasMocks.videoWidth },
	})
	video.play = videoCanvasMocks.play
	video.pause = () => {
		videoCanvasMocks.paused = true
		video.dispatchEvent(new Event('pause'))
	}
}

function setNativeInputValue(input: HTMLInputElement, value: string) {
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
	if (!setter) throw new Error('HTMLInputElement.value setter is unavailable.')
	setter.call(input, value)
}

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((promiseResolve) => {
		resolve = promiseResolve
	})
	return { promise, resolve }
}
