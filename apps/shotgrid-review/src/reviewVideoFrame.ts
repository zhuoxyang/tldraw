import { Box, type Editor, type TLShapeId } from 'tldraw'

const DEFAULT_FRAME_WAIT_TIMEOUT_MS = 5_000
const MAX_VIDEO_DIMENSION = 8_192
const MAX_VIDEO_PIXELS = 16_777_216

export interface ReviewVideoSeekResult {
	mediaTimeSeconds: number
	requestedTimeSeconds: number
}

export interface RenderReviewVideoFrameOptions {
	createCanvas?(width: number, height: number): HTMLCanvasElement
	createImageBitmap?: typeof globalThis.createImageBitmap
	editor: Editor
	getAnnotationShapeIds(mediaTimeSeconds: number): readonly TLShapeId[]
	height: number
	signal?: AbortSignal
	targetTimeSeconds: number
	video: HTMLVideoElement
	width: number
}

export interface RenderedReviewVideoFrame extends ReviewVideoSeekResult {
	blob: Blob
}

/**
 * Pause and seek a review video, then wait for the decoded frame to be presented. The returned
 * media time is authoritative for the exported image; a caller may derive a display frame label
 * from it, but must not substitute metadata for the decoded video position.
 */
export async function seekReviewVideoFrame(
	video: HTMLVideoElement,
	targetTimeSeconds: number,
	signal?: AbortSignal,
	timeoutMs = DEFAULT_FRAME_WAIT_TIMEOUT_MS
): Promise<ReviewVideoSeekResult> {
	assertUsableVideo(video)
	if (!Number.isFinite(targetTimeSeconds) || targetTimeSeconds < 0) {
		throw new Error('The requested video time is invalid.')
	}
	if (signal?.aborted) throw abortError()

	const endEpsilon = Math.min(0.001, video.duration / 1_000_000)
	const maximumTime = Math.max(0, video.duration - endEpsilon)
	const requestedTimeSeconds = Math.min(targetTimeSeconds, maximumTime)
	video.pause()

	let presentation: PresentedFrameWaiter | null = null
	try {
		if (video.seeking) {
			presentation = createPresentedFrameWaiter(video, signal, timeoutMs)
			await waitForPendingSeek(video, signal, timeoutMs)
		}
		if (video.readyState < 2) {
			presentation?.cancel()
			presentation = createPresentedFrameWaiter(video, signal, timeoutMs)
			const currentData = waitForCurrentData(video, signal, timeoutMs)
			requestCurrentVideoData(video)
			await currentData
		}
		const requiresSeek = Math.abs(video.currentTime - requestedTimeSeconds) > 0.000_5
		if (requiresSeek) {
			presentation?.cancel()
			presentation = createPresentedFrameWaiter(video, signal, timeoutMs)
			await waitForSeek(video, requestedTimeSeconds, signal, timeoutMs)
		}

		presentation?.armFallback()
		const mediaTimeSeconds = presentation ? await presentation.promise : video.currentTime
		if (!Number.isFinite(mediaTimeSeconds) || mediaTimeSeconds < 0) {
			throw new Error('The browser did not present a valid video frame.')
		}
		return { mediaTimeSeconds, requestedTimeSeconds }
	} catch (error) {
		presentation?.cancel()
		throw error
	}
}

/** Render the decoded video frame and the supplied annotation shapes into a 1:1 PNG. */
export async function renderReviewVideoFramePng(
	options: RenderReviewVideoFrameOptions
): Promise<RenderedReviewVideoFrame> {
	assertVideoDimensions(options.width, options.height)
	const seek = await seekReviewVideoFrame(options.video, options.targetTimeSeconds, options.signal)
	if (options.video.videoWidth !== options.width || options.video.videoHeight !== options.height) {
		throw new Error('The decoded video frame does not match the expected source resolution.')
	}
	const annotationShapeIds = options.getAnnotationShapeIds(seek.mediaTimeSeconds)
	if (new Set(annotationShapeIds).size !== annotationShapeIds.length) {
		throw new Error('The video annotation export contains duplicate shapes.')
	}

	const createCanvas =
		options.createCanvas ??
		((width: number, height: number) => {
			const canvas = document.createElement('canvas')
			canvas.width = width
			canvas.height = height
			return canvas
		})
	const canvas = createCanvas(options.width, options.height)
	if (canvas.width !== options.width || canvas.height !== options.height) {
		throw new Error('The video export canvas does not match the source resolution.')
	}
	const context = canvas.getContext('2d', { alpha: false })
	if (!context) throw new Error('The browser could not create a video export canvas.')

	try {
		context.drawImage(options.video, 0, 0, options.width, options.height)
	} catch (error) {
		throw new Error('The decoded video frame could not be copied for export.', { cause: error })
	}

	if (annotationShapeIds.length > 0) {
		const { blob: annotationPng } = await options.editor.toImage([...annotationShapeIds], {
			background: false,
			bounds: new Box(0, 0, options.width, options.height),
			format: 'png',
			padding: 0,
			pixelRatio: 1,
			scale: 1,
		})
		if (annotationPng.type !== 'image/png' || annotationPng.size === 0) {
			throw new Error('The editor did not produce a valid annotation layer.')
		}
		const createBitmap = options.createImageBitmap ?? globalThis.createImageBitmap
		if (typeof createBitmap !== 'function') {
			throw new Error('The browser cannot decode the annotation layer for export.')
		}
		const annotation = await createBitmap(annotationPng)
		try {
			if (annotation.width !== options.width || annotation.height !== options.height) {
				throw new Error('The annotation layer does not match the source resolution.')
			}
			context.drawImage(annotation, 0, 0, options.width, options.height)
		} finally {
			annotation.close()
		}
	}

	const blob = await canvasToPng(canvas)
	return { ...seek, blob }
}

function requestCurrentVideoData(video: HTMLVideoElement) {
	try {
		video.preload = 'auto'
		video.load()
	} catch (error) {
		throw new Error('The browser could not request the current video frame.', { cause: error })
	}
}

function waitForPendingSeek(
	video: HTMLVideoElement,
	signal: AbortSignal | undefined,
	timeoutMs: number
) {
	return new Promise<void>((resolve, reject) => {
		let settled = false
		const finish = (error?: Error) => {
			if (settled) return
			settled = true
			clearTimeout(timeout)
			video.removeEventListener('seeked', handleSeeked)
			video.removeEventListener('error', handleError)
			signal?.removeEventListener('abort', handleAbort)
			if (error) reject(error)
			else resolve()
		}
		const handleSeeked = () => finish()
		const handleError = () => finish(new Error('The pending video seek could not be decoded.'))
		const handleAbort = () => finish(abortError())
		const timeout = setTimeout(
			() => finish(new Error('Timed out while waiting for the pending video seek.')),
			timeoutMs
		)
		video.addEventListener('seeked', handleSeeked, { once: true })
		video.addEventListener('error', handleError, { once: true })
		signal?.addEventListener('abort', handleAbort, { once: true })
		queueMicrotask(() => {
			if (!video.seeking) finish()
		})
	})
}

function waitForSeek(
	video: HTMLVideoElement,
	targetTimeSeconds: number,
	signal: AbortSignal | undefined,
	timeoutMs: number
) {
	return new Promise<void>((resolve, reject) => {
		let settled = false
		const finish = (error?: Error) => {
			if (settled) return
			settled = true
			clearTimeout(timeout)
			video.removeEventListener('seeked', handleSeeked)
			video.removeEventListener('error', handleError)
			signal?.removeEventListener('abort', handleAbort)
			if (error) reject(error)
			else resolve()
		}
		const handleSeeked = () => finish()
		const handleError = () => finish(new Error('The requested video frame could not be decoded.'))
		const handleAbort = () => finish(abortError())
		const timeout = setTimeout(
			() => finish(new Error('Timed out while seeking the requested video frame.')),
			timeoutMs
		)
		video.addEventListener('seeked', handleSeeked, { once: true })
		video.addEventListener('error', handleError, { once: true })
		signal?.addEventListener('abort', handleAbort, { once: true })
		try {
			video.currentTime = targetTimeSeconds
		} catch (error) {
			finish(new Error('The requested video time could not be selected.', { cause: error }))
		}
	})
}

interface PresentedFrameWaiter {
	armFallback(): void
	cancel(): void
	promise: Promise<number>
}

function createPresentedFrameWaiter(
	video: HTMLVideoElement,
	signal: AbortSignal | undefined,
	timeoutMs: number
): PresentedFrameWaiter {
	let cancel = () => {}
	let armFallback = () => {}
	const promise = new Promise<number>((resolve, reject) => {
		let settled = false
		let callbackId: number | undefined
		let animationFrameId: number | undefined
		const finish = (mediaTime?: number, error?: Error) => {
			if (settled) return
			settled = true
			if (timeout !== undefined) clearTimeout(timeout)
			if (callbackId !== undefined) video.cancelVideoFrameCallback?.(callbackId)
			if (animationFrameId !== undefined) cancelAnimationFrame(animationFrameId)
			video.removeEventListener('error', handleError)
			signal?.removeEventListener('abort', handleAbort)
			if (error) reject(error)
			else resolve(mediaTime ?? video.currentTime)
		}
		const handleAbort = () => finish(undefined, abortError())
		const handleError = () =>
			finish(undefined, new Error('The requested video frame could not be presented.'))
		cancel = () => finish(video.currentTime)
		const signalAlreadyAborted = signal?.aborted ?? false
		const timeout = signalAlreadyAborted
			? undefined
			: setTimeout(
					() => finish(undefined, new Error('Timed out while decoding the requested video frame.')),
					timeoutMs
				)
		if (signalAlreadyAborted) {
			finish(undefined, abortError())
			return
		}
		video.addEventListener('error', handleError, { once: true })
		signal?.addEventListener('abort', handleAbort, { once: true })

		if (typeof video.requestVideoFrameCallback === 'function') {
			callbackId = video.requestVideoFrameCallback((_now, metadata) => finish(metadata.mediaTime))
			return
		}
		armFallback = () => {
			if (settled || animationFrameId !== undefined) return
			if (typeof requestAnimationFrame === 'function') {
				animationFrameId = requestAnimationFrame(() => {
					animationFrameId = requestAnimationFrame(() => finish(video.currentTime))
				})
				return
			}
			queueMicrotask(() => finish(video.currentTime))
		}
	})
	void promise.catch(() => {})
	return { armFallback: () => armFallback(), cancel: () => cancel(), promise }
}

function waitForCurrentData(
	video: HTMLVideoElement,
	signal: AbortSignal | undefined,
	timeoutMs: number
) {
	return new Promise<void>((resolve, reject) => {
		let settled = false
		const finish = (error?: Error) => {
			if (settled) return
			settled = true
			clearTimeout(timeout)
			video.removeEventListener('loadeddata', handleData)
			video.removeEventListener('canplay', handleData)
			video.removeEventListener('error', handleError)
			signal?.removeEventListener('abort', handleAbort)
			if (error) reject(error)
			else resolve()
		}
		const handleData = () => {
			if (video.readyState >= 2) finish()
		}
		const handleError = () => finish(new Error('The requested video frame could not be decoded.'))
		const handleAbort = () => finish(abortError())
		const timeout = setTimeout(
			() => finish(new Error('Timed out while loading the requested video frame.')),
			timeoutMs
		)
		video.addEventListener('loadeddata', handleData)
		video.addEventListener('canplay', handleData)
		video.addEventListener('error', handleError, { once: true })
		signal?.addEventListener('abort', handleAbort, { once: true })
		queueMicrotask(handleData)
	})
}

function canvasToPng(canvas: HTMLCanvasElement) {
	return new Promise<Blob>((resolve, reject) => {
		try {
			canvas.toBlob((blob) => {
				if (!blob || blob.type !== 'image/png' || blob.size === 0) {
					reject(new Error('The browser did not produce a valid video review PNG.'))
					return
				}
				resolve(blob)
			}, 'image/png')
		} catch (error) {
			reject(new Error('The video review PNG could not be encoded.', { cause: error }))
		}
	})
}

function assertUsableVideo(video: HTMLVideoElement) {
	if (
		!Number.isFinite(video.duration) ||
		video.duration <= 0 ||
		!Number.isSafeInteger(video.videoWidth) ||
		!Number.isSafeInteger(video.videoHeight)
	) {
		throw new Error('The review video metadata is not ready.')
	}
	assertVideoDimensions(video.videoWidth, video.videoHeight)
}

function assertVideoDimensions(width: number, height: number) {
	if (
		!Number.isSafeInteger(width) ||
		!Number.isSafeInteger(height) ||
		width <= 0 ||
		height <= 0 ||
		width > MAX_VIDEO_DIMENSION ||
		height > MAX_VIDEO_DIMENSION ||
		width * height > MAX_VIDEO_PIXELS
	) {
		throw new Error('The review video dimensions are invalid or too large.')
	}
}

function abortError() {
	return new DOMException('The video operation was aborted.', 'AbortError')
}
