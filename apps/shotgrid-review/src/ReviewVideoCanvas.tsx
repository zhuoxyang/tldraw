import type { ReviewVideoMedia } from '@tldraw/shotgrid-review-contracts'
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	type ComponentProps,
} from 'react'
import {
	DefaultToolbar,
	SVGContainer,
	Tldraw,
	ToolbarItem,
	atom,
	getSnapshot,
	loadSnapshot,
	track,
	useEditor,
	type Editor,
	type JsonObject,
	type TLBinding,
	type TLComponents,
	type TLShape,
	type TLShapeId,
	type TLStore,
	type TLUiOverrides,
} from 'tldraw'
import { disableReviewExternalContent, ReviewMarkerTool } from './reviewAnnotationEditor'
import {
	REVIEW_ANNOTATION_TARGET_META_KEY,
	createFrameAnnotationTarget,
	createTimeAnnotationTarget,
	isReviewAnnotationVisibleAtPlayhead,
	normalizeReviewAnnotationTarget,
	type ReviewAnnotationTarget,
} from './reviewAnnotationTarget'
import { sanitizeReviewFileNameBase } from './reviewPublication'
import { renderReviewVideoFramePng, seekReviewVideoFrame } from './reviewVideoFrame'
import {
	REVIEW_VIDEO_SHAPE_TYPE,
	ReviewVideoSourceProvider,
	getReviewVideoShapeId,
	installReviewVideo,
	protectReviewVideo,
	reviewVideoShapeUtils,
	type ReviewVideoSource,
} from './reviewVideoShape'
import {
	createReviewVideoSnapshot,
	createReviewVideoSnapshotSource,
	MAX_REVIEW_VIDEO_SNAPSHOT_BYTES,
	parseReviewVideoSnapshotJson,
	serializeReviewVideoSnapshot,
	type ReviewVideoSnapshotContext,
} from './reviewVideoSnapshot'
import {
	clampReviewVideoTime,
	createReviewVideoTiming,
	formatReviewVideoTime,
	formatReviewVideoTimecode,
	frameToMediaTime,
	MAX_REVIEW_VIDEO_DURATION_SECONDS,
	mediaTimeToFrame,
	type ReviewVideoTiming,
} from './reviewVideoTiming'

const REVIEW_EDITOR_OPTIONS = { maxPages: 1, selectLockedShapes: false } as const
const REVIEW_TOOLS = new Set(['arrow', 'draw', 'rectangle', 'review-marker', 'select', 'text'])
const ANNOTATION_SHAPE_TYPES = new Set(['arrow', 'draw', 'geo', 'text'])
const DEFAULT_VIDEO_WIDTH = 1_920
const DEFAULT_VIDEO_HEIGHT = 1_080
const MAX_VIDEO_DIMENSION = 8_192
const MAX_VIDEO_PIXELS = 16_777_216

const baseReviewVideoUiOverrides: TLUiOverrides = {
	tools(editor, tools) {
		tools['review-marker'] = {
			icon: 'geo-ellipse',
			id: 'review-marker',
			kbd: 'n',
			label: 'Number marker',
			onSelect: () => editor.setCurrentTool('review-marker'),
		}
		for (const id of Object.keys(tools)) {
			if (!REVIEW_TOOLS.has(id)) delete tools[id]
		}
		return tools
	},
}

export interface ReviewVideoCanvasProps {
	allowSnapshotImport?: boolean
	collaborationReadOnly?: boolean
	documentKey: string
	licenseKey?: string
	media: ReviewVideoMedia
	persistenceKey?: string
	projectId: number
	reviewScope: string
	store?: TLStore
	versionId: number
	versionName: string
}

interface ReadyVideoMetadata {
	durationSeconds: number
	height: number
	timing: ReviewVideoTiming
	width: number
}

interface ReviewVideoVisibilityState {
	timeSeconds: number
	timing: ReviewVideoTiming | null
}

type MetadataState =
	| { status: 'loading' }
	| { message: string; status: 'error' }
	| ({ status: 'ready' } & ReadyVideoMetadata)

type OperationState =
	| { status: 'idle' }
	| { label: string; status: 'working' }
	| { message: string; status: 'error' | 'success' }

export function ReviewVideoCanvas({
	allowSnapshotImport = true,
	collaborationReadOnly = false,
	documentKey,
	licenseKey,
	media,
	persistenceKey,
	projectId,
	reviewScope,
	store,
	versionId,
	versionName,
}: ReviewVideoCanvasProps) {
	const initialDimensions = resolveInitialVideoDimensions(media)
	const [editor, setEditor] = useState<Editor | null>(null)
	const [video, setVideo] = useState<HTMLVideoElement | null>(null)
	const [metadata, setMetadata] = useState<MetadataState>({ status: 'loading' })
	const [videoMetadataReady, setVideoMetadataReady] = useState(false)
	const [currentTime, setCurrentTime] = useState(0)
	const [playing, setPlaying] = useState(false)
	const [seeking, setSeeking] = useState(false)
	const [frameReady, setFrameReady] = useState(false)
	const [annotationSpan, setAnnotationSpan] = useState(1)
	const [operation, setOperation] = useState<OperationState>({ status: 'idle' })
	const visibility = useMemo(
		() =>
			atom<ReviewVideoVisibilityState>(`review-video-visibility:${documentKey}`, {
				timeSeconds: 0,
				timing: null,
			}),
		[documentKey]
	)
	const playheadBucketRef = useRef<string>('initial')
	const currentTimeRef = useRef(0)
	const targetRef = useRef<ReviewAnnotationTarget | null>(null)
	const protectionRef = useRef<null | (() => void)>(null)
	const seekControllerRef = useRef<AbortController | null>(null)
	const operationInFlightRef = useRef(false)
	const mountedRef = useRef(true)
	const editableInputRef = useRef<HTMLInputElement>(null)
	const review = useMemo<ReviewVideoSnapshotContext>(
		() => ({ projectId, scope: reviewScope, versionId }),
		[projectId, reviewScope, versionId]
	)

	useLayoutEffect(() => {
		mountedRef.current = true
		return () => {
			mountedRef.current = false
			seekControllerRef.current?.abort()
			protectionRef.current?.()
			protectionRef.current = null
		}
	}, [])

	const source = useMemo<ReviewVideoSource>(
		() => ({
			attachmentId: media.attachmentId,
			contentType: 'video/mp4',
			height: metadata.status === 'ready' ? metadata.height : initialDimensions.height,
			name: versionName,
			url: media.url,
			versionId,
			width: metadata.status === 'ready' ? metadata.width : initialDimensions.width,
		}),
		[
			initialDimensions.height,
			initialDimensions.width,
			media.attachmentId,
			media.url,
			metadata,
			versionId,
			versionName,
		]
	)

	const handleMount = useCallback((mountedEditor: Editor) => {
		disableReviewExternalContent(mountedEditor)
		mountedEditor.updateInstanceState({ isReadonly: true })
		setEditor(mountedEditor)
	}, [])

	const handleVideoElement = useCallback((element: HTMLVideoElement | null) => {
		seekControllerRef.current?.abort()
		seekControllerRef.current = null
		setVideo(element)
		setVideoMetadataReady(false)
		setFrameReady(false)
		setSeeking(element !== null)
		if (!element) {
			setPlaying(false)
		}
	}, [])

	const syncPlayhead = useCallback(
		(timeSeconds: number, timing: ReviewVideoTiming | null) => {
			if (!Number.isFinite(timeSeconds) || timeSeconds < 0) return
			const normalized = timing ? clampReviewVideoTime(timing, timeSeconds) : timeSeconds
			currentTimeRef.current = normalized
			setCurrentTime(normalized)
			const bucket = reviewVideoPlayheadBucket(timing, normalized)
			const previousVisibility = visibility.get()
			if (bucket !== playheadBucketRef.current || previousVisibility.timing !== timing) {
				playheadBucketRef.current = bucket
				visibility.set({ timeSeconds: normalized, timing })
				if (editor && timing) clearHiddenReviewSelection(editor, timing, normalized)
			}
		},
		[editor, visibility]
	)

	useEffect(() => {
		if (!video) return
		const readMetadata = () => {
			if (video.readyState < 1) return
			try {
				const ready = resolveReviewVideoMetadata(media, video)
				setMetadata((current) =>
					current.status === 'ready' && sameReadyVideoMetadata(current, ready)
						? current
						: { ...ready, status: 'ready' }
				)
				setVideoMetadataReady(true)
			} catch (error) {
				setVideoMetadataReady(false)
				setFrameReady(false)
				setMetadata({ message: videoErrorMessage(error), status: 'error' })
			}
		}
		const handleError = () => {
			setVideoMetadataReady(false)
			setFrameReady(false)
			setMetadata({ message: 'The MP4 could not be decoded by this browser.', status: 'error' })
		}
		video.addEventListener('loadedmetadata', readMetadata)
		video.addEventListener('durationchange', readMetadata)
		video.addEventListener('error', handleError)
		readMetadata()
		return () => {
			video.removeEventListener('loadedmetadata', readMetadata)
			video.removeEventListener('durationchange', readMetadata)
			video.removeEventListener('error', handleError)
		}
	}, [media, video])

	useEffect(() => {
		if (!video || metadata.status !== 'ready' || !videoMetadataReady) return
		let videoFrameCallbackId: number | undefined
		let animationFrameId: number | undefined
		const timing = metadata.timing
		const update = (mediaTime = video.currentTime) => syncPlayhead(mediaTime, timing)
		const canSyncPosition = () => !video.seeking && !seekControllerRef.current
		const scheduleFrame = () => {
			if (video.paused || video.ended) return
			if (typeof video.requestVideoFrameCallback === 'function') {
				videoFrameCallbackId = video.requestVideoFrameCallback((_now, frame) => {
					if (canSyncPosition()) update(frame.mediaTime)
					scheduleFrame()
				})
			} else if (typeof requestAnimationFrame === 'function') {
				animationFrameId = requestAnimationFrame(() => {
					if (canSyncPosition()) update()
					scheduleFrame()
				})
			}
		}
		const handlePlay = () => {
			editor?.updateInstanceState({ isReadonly: true })
			setPlaying(true)
			scheduleFrame()
		}
		const handlePause = () => {
			setPlaying(false)
			if (canSyncPosition()) update()
		}
		const handleSeeking = () => {
			editor?.updateInstanceState({ isReadonly: true })
			setSeeking(true)
		}
		const handleSeeked = () => {
			if (seekControllerRef.current) return
			setSeeking(false)
			update()
		}
		const handlePosition = () => {
			if (canSyncPosition()) update()
		}
		video.addEventListener('play', handlePlay)
		video.addEventListener('pause', handlePause)
		video.addEventListener('ended', handlePause)
		video.addEventListener('seeking', handleSeeking)
		video.addEventListener('seeked', handleSeeked)
		video.addEventListener('timeupdate', handlePosition)
		setPlaying(!video.paused && !video.ended)
		if (canSyncPosition()) update()
		if (!video.paused && !video.ended) scheduleFrame()
		return () => {
			if (videoFrameCallbackId !== undefined) {
				video.cancelVideoFrameCallback?.(videoFrameCallbackId)
			}
			if (animationFrameId !== undefined) cancelAnimationFrame(animationFrameId)
			video.removeEventListener('play', handlePlay)
			video.removeEventListener('pause', handlePause)
			video.removeEventListener('ended', handlePause)
			video.removeEventListener('seeking', handleSeeking)
			video.removeEventListener('seeked', handleSeeked)
			video.removeEventListener('timeupdate', handlePosition)
		}
	}, [editor, metadata, syncPlayhead, video, videoMetadataReady])

	useEffect(() => {
		if (!editor) return
		const localOnly = store !== undefined
		const install = () => installReviewVideo(editor, source, { localOnly })
		install()
		protectionRef.current?.()
		protectionRef.current = protectReviewVideo(editor, source, { localOnly })
		const stopWatching = localOnly
			? editor.store.listen(
					() => {
						if (!editor.getShape(getReviewVideoShapeId(source.versionId))) install()
					},
					{ scope: 'document', source: 'remote' }
				)
			: undefined
		return () => {
			stopWatching?.()
			protectionRef.current?.()
			protectionRef.current = null
		}
	}, [editor, source, store])

	useEffect(() => {
		if (!editor || metadata.status !== 'ready') return
		const timing = metadata.timing
		const reportTemporalRelationshipError = () =>
			setOperation({
				message: 'Groups and arrow bindings must use one identical frame or time span.',
				status: 'error',
			})
		const pendingPageReparents = new Set<TLShapeId>()
		const disposeCreate = editor.sideEffects.registerBeforeCreateHandler(
			'shape',
			(shape, changeSource) => {
				if (changeSource === 'remote') return shape
				if (!isTargetedAnnotationShape(shape) || !targetRef.current) return shape
				const targetedShape = {
					...shape,
					meta: {
						...shape.meta,
						[REVIEW_ANNOTATION_TARGET_META_KEY]: targetRef.current as unknown as JsonObject,
					},
				}
				if (isReviewAnnotationShapeParentCompatible(editor, targetedShape, timing)) {
					return targetedShape
				}
				reportTemporalRelationshipError()
				pendingPageReparents.add(targetedShape.id)
				return targetedShape
			}
		)
		const disposeShapeCreate = editor.sideEffects.registerAfterCreateHandler(
			'shape',
			(shape, changeSource) => {
				if (changeSource === 'remote') return
				if (!pendingPageReparents.delete(shape.id)) return
				editor.reparentShapes([shape.id], editor.getCurrentPageId())
			}
		)
		const disposeChange = editor.sideEffects.registerBeforeChangeHandler(
			'shape',
			(previous, next, changeSource) => {
				if (changeSource === 'remote') return next
				if (isTargetedAnnotationShape(next)) {
					try {
						normalizeReviewAnnotationTarget(next.meta[REVIEW_ANNOTATION_TARGET_META_KEY], timing)
					} catch {
						return previous
					}
				}
				if (
					(isTargetedAnnotationShape(next) || next.type === 'group') &&
					!isReviewAnnotationShapeParentCompatible(editor, next, timing)
				) {
					reportTemporalRelationshipError()
					return previous
				}
				return next
			}
		)
		const disposeBindingCreate = editor.sideEffects.registerAfterCreateHandler(
			'binding',
			(binding, changeSource) => {
				if (changeSource === 'remote') return
				if (isReviewAnnotationBindingCompatible(editor, binding, timing)) return
				editor.deleteBinding(binding)
				reportTemporalRelationshipError()
			}
		)
		const disposeBindingChange = editor.sideEffects.registerBeforeChangeHandler(
			'binding',
			(previous, next, changeSource) => {
				if (changeSource === 'remote') return next
				if (isReviewAnnotationBindingCompatible(editor, next, timing)) return next
				reportTemporalRelationshipError()
				return previous
			}
		)
		const disposeShapeChange = editor.sideEffects.registerAfterChangeHandler(
			'shape',
			(previous, next, changeSource) => {
				if (changeSource === 'remote') return
				const bindings = getReviewAnnotationBindingsForChangedShape(editor, previous, next)
				const incompatible = bindings.filter(
					(binding) => !isReviewAnnotationBindingCompatible(editor, binding, timing)
				)
				if (incompatible.length === 0) return
				editor.deleteBindings(incompatible)
				reportTemporalRelationshipError()
			}
		)
		return () => {
			pendingPageReparents.clear()
			disposeCreate()
			disposeShapeCreate()
			disposeChange()
			disposeBindingCreate()
			disposeBindingChange()
			disposeShapeChange()
		}
	}, [editor, metadata])

	const annotationTarget = useMemo(
		() =>
			metadata.status === 'ready'
				? createTargetForAnnotationSpan(metadata.timing, currentTime, annotationSpan)
				: null,
		[annotationSpan, currentTime, metadata]
	)
	targetRef.current = annotationTarget
	const snapshotSource = useMemo(
		() =>
			metadata.status === 'ready'
				? createReviewVideoSnapshotSource({
						attachmentId: media.attachmentId,
						contentType: 'video/mp4',
						durationSeconds: metadata.durationSeconds,
						firstFrame: media.firstFrame,
						frameCount: media.frameCount,
						frameRate: media.frameRate,
						frameRateMode: media.frameRateMode,
						height: metadata.height,
						lastFrame: media.lastFrame,
						width: metadata.width,
					})
				: null,
		[media, metadata]
	)

	useEffect(() => {
		if (!editor) return
		const readonly =
			collaborationReadOnly ||
			metadata.status !== 'ready' ||
			!frameReady ||
			!annotationTarget ||
			playing ||
			seeking ||
			operation.status === 'working'
		editor.updateInstanceState({ isReadonly: readonly })
	}, [
		annotationTarget,
		collaborationReadOnly,
		editor,
		frameReady,
		metadata.status,
		operation.status,
		playing,
		seeking,
	])

	const timingMode = metadata.status === 'ready' ? metadata.timing.mode : null
	useEffect(() => {
		setAnnotationSpan(timingMode === 'time' ? 0.1 : 1)
	}, [timingMode])

	const getShapeVisibility = useCallback(
		(shape: TLShape, visibilityEditor: Editor) => {
			if (shape.type === REVIEW_VIDEO_SHAPE_TYPE) return 'inherit' as const
			const currentVisibility = visibility.get()
			if (!currentVisibility.timing) {
				return 'hidden' as const
			}
			try {
				const target =
					shape.type === 'group'
						? getReviewAnnotationGroupTarget(visibilityEditor, shape.id, currentVisibility.timing)
						: isTargetedAnnotationShape(shape)
							? shape.meta[REVIEW_ANNOTATION_TARGET_META_KEY]
							: null
				if (!target) return 'hidden' as const
				return isReviewAnnotationVisibleAtPlayhead(
					target,
					currentVisibility.timing,
					currentVisibility.timeSeconds
				)
					? ('inherit' as const)
					: ('hidden' as const)
			} catch {
				return 'hidden' as const
			}
		},
		[visibility]
	)

	const preciseSeek = useCallback(
		async (targetTimeSeconds: number) => {
			if (!video || metadata.status !== 'ready' || operationInFlightRef.current) return
			const previousTime = currentTimeRef.current
			seekControllerRef.current?.abort()
			const controller = new AbortController()
			seekControllerRef.current = controller
			const requestedTime = clampReviewVideoTime(metadata.timing, targetTimeSeconds)
			setCurrentTime(requestedTime)
			editor?.updateInstanceState({ isReadonly: true })
			setSeeking(true)
			setOperation({ status: 'idle' })
			try {
				const result = await seekReviewVideoFrame(video, requestedTime, controller.signal)
				if (!controller.signal.aborted) {
					syncPlayhead(result.mediaTimeSeconds, metadata.timing)
					setFrameReady(true)
				}
			} catch (error) {
				if (!controller.signal.aborted) {
					setCurrentTime(previousTime)
					setFrameReady(false)
					setMetadata({ message: videoErrorMessage(error), status: 'error' })
				}
			} finally {
				if (seekControllerRef.current === controller) {
					seekControllerRef.current = null
					setSeeking(false)
				}
			}
		},
		[editor, metadata, syncPlayhead, video]
	)

	useEffect(() => {
		if (!editor || !video || metadata.status !== 'ready' || !videoMetadataReady || frameReady)
			return
		seekControllerRef.current?.abort()
		const controller = new AbortController()
		seekControllerRef.current = controller
		editor?.updateInstanceState({ isReadonly: true })
		setSeeking(true)
		void seekReviewVideoFrame(video, currentTimeRef.current, controller.signal)
			.then((result) => {
				if (controller.signal.aborted || !mountedRef.current) return
				syncPlayhead(result.mediaTimeSeconds, metadata.timing)
				setFrameReady(true)
			})
			.catch((error) => {
				if (controller.signal.aborted || !mountedRef.current) return
				setMetadata({ message: videoErrorMessage(error), status: 'error' })
			})
			.finally(() => {
				if (seekControllerRef.current !== controller) return
				seekControllerRef.current = null
				if (mountedRef.current) setSeeking(false)
			})
		return () => {
			controller.abort()
			if (seekControllerRef.current === controller) {
				seekControllerRef.current = null
				if (mountedRef.current) setSeeking(false)
			}
		}
	}, [editor, frameReady, metadata, syncPlayhead, video, videoMetadataReady])

	const step = useCallback(
		(direction: -1 | 1) => {
			if (metadata.status !== 'ready' || !frameReady || seeking) return
			const timing = metadata.timing
			if (timing.mode === 'frames') {
				const frame = mediaTimeToFrame(timing, currentTimeRef.current)
				const nextFrame = Math.min(timing.lastFrame, Math.max(timing.firstFrame, frame + direction))
				void preciseSeek(frameToMediaTime(timing, nextFrame))
				return
			}
			void preciseSeek(clampReviewVideoTime(timing, currentTimeRef.current + direction * 0.1))
		},
		[frameReady, metadata, preciseSeek, seeking]
	)

	const togglePlayback = useCallback(() => {
		if (
			!video ||
			metadata.status !== 'ready' ||
			!frameReady ||
			seeking ||
			video.seeking ||
			operationInFlightRef.current
		) {
			return
		}
		setOperation({ status: 'idle' })
		if (video.paused || video.ended) {
			editor?.updateInstanceState({ isReadonly: true })
			void video.play().catch((error) => {
				setOperation({ message: videoErrorMessage(error), status: 'error' })
			})
		} else {
			video.pause()
		}
	}, [editor, frameReady, metadata.status, seeking, video])

	const exportFrame = useCallback(async () => {
		if (
			!editor ||
			!video ||
			metadata.status !== 'ready' ||
			!frameReady ||
			seeking ||
			video.seeking ||
			operationInFlightRef.current
		) {
			return
		}
		const requestedTimeSeconds = currentTimeRef.current
		operationInFlightRef.current = true
		seekControllerRef.current?.abort()
		const controller = new AbortController()
		seekControllerRef.current = controller
		video.pause()
		editor.updateInstanceState({ isReadonly: true })
		setSeeking(true)
		setOperation({ label: 'Rendering source-resolution video frame', status: 'working' })
		let framePresented = false
		try {
			const rendered = await renderReviewVideoFramePng({
				editor,
				getAnnotationShapeIds: (mediaTimeSeconds) => {
					framePresented = true
					syncPlayhead(mediaTimeSeconds, metadata.timing)
					return getVisibleReviewAnnotationShapeIds(
						editor,
						metadata.timing,
						mediaTimeSeconds,
						getReviewVideoShapeId(versionId)
					)
				},
				height: metadata.height,
				signal: controller.signal,
				targetTimeSeconds: requestedTimeSeconds,
				video,
				width: metadata.width,
			})
			if (controller.signal.aborted || !mountedRef.current) return
			syncPlayhead(rendered.mediaTimeSeconds, metadata.timing)
			const targetLabel = reviewVideoExportTargetLabel(metadata.timing, rendered.mediaTimeSeconds)
			downloadBlob(
				rendered.blob,
				`${sanitizeReviewFileNameBase(versionName)}.${targetLabel}.annotated.png`
			)
			setOperation({ message: 'Current video frame exported.', status: 'success' })
		} catch (error) {
			if (!controller.signal.aborted && mountedRef.current) {
				setOperation({ message: videoErrorMessage(error), status: 'error' })
				if (!framePresented) {
					setFrameReady(false)
					setMetadata({ message: videoErrorMessage(error), status: 'error' })
				}
			}
		} finally {
			if (seekControllerRef.current === controller) {
				seekControllerRef.current = null
				if (mountedRef.current) setSeeking(false)
			}
			operationInFlightRef.current = false
			if (controller.signal.aborted && mountedRef.current) setOperation({ status: 'idle' })
		}
	}, [editor, frameReady, metadata, seeking, syncPlayhead, versionId, versionName, video])

	const saveEditable = useCallback(() => {
		if (!editor || !snapshotSource || !frameReady || seeking || operationInFlightRef.current) return
		try {
			const envelope = createReviewVideoSnapshot({
				review,
				snapshot: getSnapshot(editor.store),
				source: snapshotSource,
			})
			const serialized = serializeReviewVideoSnapshot(envelope)
			downloadBlob(
				new Blob([serialized], { type: 'application/json' }),
				`${sanitizeReviewFileNameBase(versionName)}.video-review.json`
			)
			setOperation({ message: 'Editable video snapshot saved.', status: 'success' })
		} catch (error) {
			setOperation({ message: videoErrorMessage(error), status: 'error' })
		}
	}, [editor, frameReady, review, seeking, snapshotSource, versionName])

	const openEditable = useCallback(
		async (file: File) => {
			if (
				!editor ||
				!snapshotSource ||
				metadata.status !== 'ready' ||
				!frameReady ||
				seeking ||
				operationInFlightRef.current
			) {
				return
			}
			const timing = metadata.timing
			operationInFlightRef.current = true
			seekControllerRef.current?.abort()
			video?.pause()
			setOperation({ label: 'Opening editable video snapshot', status: 'working' })
			try {
				const previousSnapshot = getSnapshot(editor.store)
				if (file.size > MAX_REVIEW_VIDEO_SNAPSHOT_BYTES) {
					throw new Error('The editable video snapshot exceeds the 16 MiB limit.')
				}
				const envelope = parseReviewVideoSnapshotJson(await file.text(), review, snapshotSource)
				protectionRef.current?.()
				protectionRef.current = null
				try {
					loadSnapshot(editor.store, envelope.snapshot)
					installReviewVideo(editor, source)
				} catch (error) {
					loadSnapshot(editor.store, previousSnapshot)
					installReviewVideo(editor, source)
					throw error
				} finally {
					protectionRef.current = protectReviewVideo(editor, source)
				}
				editor.setCurrentTool('select')
				clearHiddenReviewSelection(editor, timing, currentTimeRef.current)
				visibility.set({ timeSeconds: currentTimeRef.current, timing })
				setOperation({ message: 'Editable video snapshot opened.', status: 'success' })
			} catch (error) {
				setOperation({ message: videoErrorMessage(error), status: 'error' })
			} finally {
				operationInFlightRef.current = false
			}
		},
		[editor, frameReady, metadata, review, seeking, snapshotSource, source, video, visibility]
	)

	const sourceShapeId = getReviewVideoShapeId(versionId)
	const uiOverrides = useMemo<TLUiOverrides>(
		() => ({
			...baseReviewVideoUiOverrides,
			actions(actionEditor, actions) {
				const groupAction = actions.group
				return {
					...actions,
					group: {
						...groupAction,
						onSelect(source) {
							const onlySelectedShape = actionEditor.getOnlySelectedShape()
							if (onlySelectedShape?.type === 'group') {
								groupAction.onSelect(source)
								return
							}
							if (
								metadata.status !== 'ready' ||
								!canGroupReviewAnnotationShapes(
									actionEditor,
									actionEditor.getSelectedShapes(),
									metadata.timing
								)
							) {
								setOperation({
									message: 'Only annotations with one identical frame or time span can be grouped.',
									status: 'error',
								})
								return
							}
							groupAction.onSelect(source)
						},
					},
				}
			},
		}),
		[metadata]
	)
	const components = useMemo<TLComponents>(
		() => ({
			ActionsMenu: null,
			ContextMenu: null,
			HelpMenu: null,
			InFrontOfTheCanvas: () => <ReviewVideoBoundsOverlay sourceShapeId={sourceShapeId} />,
			KeyboardShortcutsDialog: null,
			MainMenu: null,
			PageMenu: null,
			QuickActions: null,
			SharePanel: null,
			Toolbar: FocusedReviewVideoToolbar,
		}),
		[sourceShapeId]
	)
	const persistenceIdentity = [
		media.attachmentId,
		media.frameRateMode,
		media.frameCount ?? 'unknown-count',
		media.frameRate ?? 'unknown-rate',
		media.firstFrame ?? 'unknown-first',
		media.lastFrame ?? 'unknown-last',
		media.durationSeconds === null ? 'unknown-duration' : `${media.durationSeconds}s`,
		media.width === null ? 'unknown-width' : `${media.width}w`,
		media.height === null ? 'unknown-height' : `${media.height}h`,
	].join(':')
	const editorDisabled =
		collaborationReadOnly ||
		metadata.status !== 'ready' ||
		!frameReady ||
		!annotationTarget ||
		playing ||
		seeking ||
		operation.status === 'working' ||
		!editor ||
		!video

	return (
		<div className="review-video-editor">
			<ReviewVideoSourceProvider value={{ onVideoElement: handleVideoElement, source }}>
				<Tldraw
					components={components}
					getShapeVisibility={getShapeVisibility}
					key={`${documentKey}:${persistenceIdentity}`}
					licenseKey={licenseKey}
					onMount={handleMount}
					options={REVIEW_EDITOR_OPTIONS}
					overrides={uiOverrides}
					{...(store
						? { store }
						: persistenceKey
							? { persistenceKey: `${persistenceKey}:video-${persistenceIdentity}` }
							: {})}
					shapeUtils={reviewVideoShapeUtils}
					tools={[ReviewMarkerTool]}
				/>
			</ReviewVideoSourceProvider>
			<div className="review-video-controls" aria-label="Video review controls">
				<div className="review-video-controls__transport">
					<button disabled={editorDisabled} onClick={() => step(-1)} type="button">
						Previous{' '}
						{metadata.status === 'ready' && metadata.timing.mode === 'frames' ? 'frame' : '0.1s'}
					</button>
					<button
						disabled={
							metadata.status !== 'ready' ||
							!frameReady ||
							!video ||
							seeking ||
							operation.status === 'working'
						}
						onClick={togglePlayback}
						type="button"
					>
						{playing ? 'Pause' : 'Play'}
					</button>
					<button disabled={editorDisabled} onClick={() => step(1)} type="button">
						Next{' '}
						{metadata.status === 'ready' && metadata.timing.mode === 'frames' ? 'frame' : '0.1s'}
					</button>
					<strong>{reviewVideoPlayheadLabel(metadata, currentTime)}</strong>
				</div>
				<label className="review-video-controls__scrubber">
					<span>Timeline</span>
					<input
						disabled={
							metadata.status !== 'ready' || !frameReady || !video || operation.status === 'working'
						}
						max={metadata.status === 'ready' ? metadata.durationSeconds : 0}
						min={0}
						onChange={(event) => {
							if (!video || metadata.status !== 'ready') return
							const targetTime = clampReviewVideoTime(
								metadata.timing,
								Number(event.currentTarget.value)
							)
							void preciseSeek(targetTime)
						}}
						step={
							metadata.status === 'ready' && metadata.timing.mode === 'frames'
								? 1 / metadata.timing.frameRate
								: 0.001
						}
						type="range"
						value={currentTime}
					/>
				</label>
				<label>
					<span>
						New annotation span (
						{metadata.status === 'ready' && metadata.timing.mode === 'frames'
							? 'frames'
							: 'seconds'}
						)
					</span>
					<input
						disabled={
							metadata.status !== 'ready' ||
							!frameReady ||
							playing ||
							seeking ||
							operation.status === 'working'
						}
						min={metadata.status === 'ready' && metadata.timing.mode === 'frames' ? 1 : 0.001}
						onChange={(event) => setAnnotationSpan(Number(event.currentTarget.value))}
						step={metadata.status === 'ready' && metadata.timing.mode === 'frames' ? 1 : 0.1}
						type="number"
						value={annotationSpan}
					/>
				</label>
				<button disabled={editorDisabled} onClick={() => void exportFrame()} type="button">
					Export current frame PNG
				</button>
				<button disabled={editorDisabled} onClick={saveEditable} type="button">
					Save editable
				</button>
				{allowSnapshotImport ? (
					<>
						<button
							disabled={editorDisabled}
							onClick={() => editableInputRef.current?.click()}
							type="button"
						>
							Open editable
						</button>
						<input
							accept="application/json,.json"
							aria-label="Open editable video review snapshot"
							hidden
							onChange={(event) => {
								const file = event.currentTarget.files?.[0]
								event.currentTarget.value = ''
								if (file) void openEditable(file)
							}}
							ref={editableInputRef}
							type="file"
						/>
					</>
				) : null}
				{metadata.status === 'loading' ? (
					<span aria-live="polite">Loading MP4 metadata…</span>
				) : metadata.status === 'ready' && !frameReady ? (
					<span aria-live="polite">Decoding the current video frame…</span>
				) : metadata.status === 'error' ? (
					<span className="review-editor-actions__error" role="alert">
						{metadata.message}
					</span>
				) : metadata.timing.mode === 'time' ? (
					<span role="note">
						Frame-accurate metadata is unavailable (
						{fallbackReasonLabel(metadata.timing.fallbackReason)}). Annotations and exports use
						decoded media time.
					</span>
				) : null}
				{metadata.status === 'ready' && !annotationTarget ? (
					<span className="review-editor-actions__error" role="alert">
						Choose a valid positive annotation span before drawing.
					</span>
				) : null}
				{operation.status === 'working' ? (
					<span aria-live="polite">{operation.label}…</span>
				) : operation.status === 'error' ? (
					<span className="review-editor-actions__error" role="alert">
						{operation.message}
					</span>
				) : operation.status === 'success' ? (
					<span aria-live="polite">{operation.message}</span>
				) : null}
			</div>
		</div>
	)
}

export function resolveReviewVideoMetadata(
	media: ReviewVideoMedia,
	video: Pick<HTMLVideoElement, 'duration' | 'videoHeight' | 'videoWidth'>
): ReadyVideoMetadata {
	assertVideoDimensions(video.videoWidth, video.videoHeight)
	if (
		(media.width !== null && media.width !== video.videoWidth) ||
		(media.height !== null && media.height !== video.videoHeight)
	) {
		throw new Error('The decoded video dimensions do not match ShotGrid metadata.')
	}
	if (!Number.isFinite(video.duration) || video.duration <= 0) {
		throw new Error('The decoded video duration is invalid.')
	}
	if (video.duration > MAX_REVIEW_VIDEO_DURATION_SECONDS) {
		throw new Error('The decoded video duration exceeds the 24-hour review limit.')
	}
	const timing = createReviewVideoTiming({
		durationSeconds: video.duration,
		firstFrame: media.firstFrame,
		frameCount: media.frameCount,
		frameRate: media.frameRate,
		frameRateMode: media.frameRateMode,
		lastFrame: media.lastFrame,
	})
	return {
		durationSeconds: video.duration,
		height: video.videoHeight,
		timing,
		width: video.videoWidth,
	}
}

export function createTargetForAnnotationSpan(
	timing: ReviewVideoTiming,
	currentTimeSeconds: number,
	span: number
): ReviewAnnotationTarget | null {
	if (!Number.isFinite(span)) return null
	const currentTime = clampReviewVideoTime(timing, currentTimeSeconds)
	if (timing.mode === 'frames') {
		if (!Number.isSafeInteger(span) || span < 1) return null
		const startFrame = mediaTimeToFrame(timing, currentTime)
		return createFrameAnnotationTarget(
			startFrame,
			Math.min(timing.lastFrame, startFrame + span - 1)
		)
	}
	if (span < 0.001) return null
	const maximumTime = timing.durationSeconds ?? currentTime + span
	return createTimeAnnotationTarget(currentTime, Math.min(maximumTime, currentTime + span))
}

export function getVisibleReviewAnnotationShapeIds(
	editor: Pick<Editor, 'getCurrentPageShapes'>,
	timing: ReviewVideoTiming,
	currentTimeSeconds: number,
	sourceShapeId: TLShapeId
) {
	const ids: TLShapeId[] = []
	for (const shape of editor.getCurrentPageShapes()) {
		if (shape.id === sourceShapeId || !isTargetedAnnotationShape(shape)) continue
		try {
			if (
				isReviewAnnotationVisibleAtPlayhead(
					shape.meta[REVIEW_ANNOTATION_TARGET_META_KEY],
					timing,
					currentTimeSeconds
				)
			) {
				ids.push(shape.id)
			}
		} catch {
			// Invalid or stale targets fail closed and are not exported.
		}
	}
	return ids
}

export function getReviewAnnotationGroupTarget(
	editor: Pick<Editor, 'getShape' | 'getSortedChildIdsForParent'>,
	groupId: TLShapeId,
	timing: ReviewVideoTiming
): ReviewAnnotationTarget | null {
	const result = scanReviewAnnotationGroup(editor, groupId, timing)
	return result.status === 'target' ? result.target : null
}

type ReviewAnnotationTargetScan =
	| { status: 'empty' }
	| { status: 'invalid' }
	| { key: string; status: 'target'; target: ReviewAnnotationTarget }

function scanReviewAnnotationGroup(
	editor: Pick<Editor, 'getShape' | 'getSortedChildIdsForParent'>,
	groupId: TLShapeId,
	timing: ReviewVideoTiming,
	excludedShapeId?: TLShapeId
): ReviewAnnotationTargetScan {
	const pending = [...editor.getSortedChildIdsForParent(groupId)]
	const visited = new Set<TLShapeId>([groupId])
	let target: ReviewAnnotationTarget | null = null
	let key: string | null = null
	while (pending.length > 0) {
		const id = pending.pop()
		if (!id) return { status: 'invalid' }
		if (id === excludedShapeId) continue
		if (visited.has(id)) return { status: 'invalid' }
		visited.add(id)
		const shape = editor.getShape(id)
		if (!shape) return { status: 'invalid' }
		if (shape.type === 'group') {
			pending.push(...editor.getSortedChildIdsForParent(shape.id))
			continue
		}
		if (!isTargetedAnnotationShape(shape)) return { status: 'invalid' }
		let normalized: ReviewAnnotationTarget
		try {
			normalized = normalizeReviewAnnotationTarget(
				shape.meta[REVIEW_ANNOTATION_TARGET_META_KEY],
				timing
			)
		} catch {
			return { status: 'invalid' }
		}
		const normalizedKey = reviewAnnotationTargetKey(normalized)
		if (key !== null && key !== normalizedKey) return { status: 'invalid' }
		target = normalized
		key = normalizedKey
	}
	return target && key ? { key, status: 'target', target } : { status: 'empty' }
}

function getReviewAnnotationShapeTarget(
	editor: Pick<Editor, 'getShape' | 'getSortedChildIdsForParent'>,
	shape: TLShape,
	timing: ReviewVideoTiming
): { key: string; target: ReviewAnnotationTarget } | null {
	if (shape.type === 'group') {
		const result = scanReviewAnnotationGroup(editor, shape.id, timing)
		return result.status === 'target' ? result : null
	}
	if (!isTargetedAnnotationShape(shape)) return null
	try {
		const target = normalizeReviewAnnotationTarget(
			shape.meta[REVIEW_ANNOTATION_TARGET_META_KEY],
			timing
		)
		return { key: reviewAnnotationTargetKey(target), target }
	} catch {
		return null
	}
}

export function canGroupReviewAnnotationShapes(
	editor: Pick<Editor, 'getShape' | 'getSortedChildIdsForParent'>,
	shapes: readonly TLShape[],
	timing: ReviewVideoTiming
) {
	if (shapes.length < 2) return false
	let key: string | null = null
	for (const shape of shapes) {
		const target = getReviewAnnotationShapeTarget(editor, shape, timing)
		if (!target) return false
		if (key !== null && key !== target.key) return false
		key = target.key
	}
	return key !== null
}

export function isReviewAnnotationShapeParentCompatible(
	editor: Pick<Editor, 'getShape' | 'getSortedChildIdsForParent'>,
	shape: TLShape,
	timing: ReviewVideoTiming
) {
	let target: { key: string; target: ReviewAnnotationTarget } | null
	if (shape.type === 'group') {
		const groupTarget = scanReviewAnnotationGroup(editor, shape.id, timing)
		if (groupTarget.status === 'invalid') return false
		if (groupTarget.status === 'empty') return true
		target = groupTarget
	} else {
		target = getReviewAnnotationShapeTarget(editor, shape, timing)
		if (!target) return false
	}
	let excludedShapeId = shape.id
	let parentId = shape.parentId as TLShapeId
	const visited = new Set<TLShapeId>()
	while (!visited.has(parentId)) {
		visited.add(parentId)
		const parent = editor.getShape(parentId)
		if (!parent || parent.type !== 'group') return true
		const parentTarget = scanReviewAnnotationGroup(editor, parent.id, timing, excludedShapeId)
		if (parentTarget.status === 'invalid') return false
		if (parentTarget.status === 'target' && parentTarget.key !== target.key) return false
		excludedShapeId = parent.id
		parentId = parent.parentId as TLShapeId
	}
	return false
}

export function isReviewAnnotationBindingCompatible(
	editor: Pick<Editor, 'getShape' | 'getSortedChildIdsForParent'>,
	binding: Pick<TLBinding, 'fromId' | 'toId' | 'type'>,
	timing: ReviewVideoTiming
) {
	if (binding.type !== 'arrow') return false
	const from = editor.getShape(binding.fromId)
	const to = editor.getShape(binding.toId)
	if (!from || from.type !== 'arrow' || !to) return false
	const fromTarget = getReviewAnnotationShapeTarget(editor, from, timing)
	const toTarget = getReviewAnnotationShapeTarget(editor, to, timing)
	return Boolean(fromTarget && toTarget && fromTarget.key === toTarget.key)
}

function getReviewAnnotationBindingsForChangedShape(
	editor: Pick<
		Editor,
		'getBindingsFromShape' | 'getBindingsToShape' | 'getShape' | 'getSortedChildIdsForParent'
	>,
	previous: TLShape,
	next: TLShape
) {
	const shapeIds = new Set<TLShapeId>()
	const addShapeAndGroupAncestors = (shape: TLShape) => {
		shapeIds.add(shape.id)
		let parentId = shape.parentId as TLShapeId
		const visited = new Set<TLShapeId>()
		while (!visited.has(parentId)) {
			visited.add(parentId)
			const parent = editor.getShape(parentId)
			if (!parent || parent.type !== 'group') return
			shapeIds.add(parent.id)
			parentId = parent.parentId as TLShapeId
		}
	}
	addShapeAndGroupAncestors(previous)
	addShapeAndGroupAncestors(next)

	const bindings = new Map<TLBinding['id'], TLBinding>()
	for (const shapeId of shapeIds) {
		for (const binding of editor.getBindingsFromShape(shapeId, 'arrow')) {
			bindings.set(binding.id, binding)
		}
		for (const binding of editor.getBindingsToShape(shapeId, 'arrow')) {
			bindings.set(binding.id, binding)
		}
	}
	return [...bindings.values()]
}

function FocusedReviewVideoToolbar(props: ComponentProps<typeof DefaultToolbar>) {
	return (
		<DefaultToolbar {...props}>
			<ToolbarItem tool="select" />
			<ToolbarItem tool="draw" />
			<ToolbarItem tool="arrow" />
			<ToolbarItem tool="rectangle" />
			<ToolbarItem tool="text" />
			<ToolbarItem tool="review-marker" />
		</DefaultToolbar>
	)
}

const ReviewVideoBoundsOverlay = track(function ReviewVideoBoundsOverlay({
	sourceShapeId,
}: {
	sourceShapeId: TLShapeId
}) {
	const editor = useEditor()
	const bounds = editor.getShapePageBounds(sourceShapeId)
	if (!bounds) return null
	const viewport = editor.getViewportScreenBounds()
	const topLeft = editor.pageToViewport(bounds)
	const bottomRight = editor.pageToViewport({ x: bounds.maxX, y: bounds.maxY })
	const path = [
		'M -10 -10',
		`L ${viewport.maxX + 10} -10`,
		`L ${viewport.maxX + 10} ${viewport.maxY + 10}`,
		'L -10 ' + (viewport.maxY + 10),
		'Z',
		`M ${topLeft.x} ${topLeft.y}`,
		`L ${bottomRight.x} ${topLeft.y}`,
		`L ${bottomRight.x} ${bottomRight.y}`,
		`L ${topLeft.x} ${bottomRight.y}`,
		'Z',
	].join(' ')
	return (
		<SVGContainer className="review-image-bounds-overlay">
			<path d={path} fillRule="evenodd" />
		</SVGContainer>
	)
})

function clearHiddenReviewSelection(
	editor: Pick<
		Editor,
		'getSelectedShapeIds' | 'getShape' | 'getSortedChildIdsForParent' | 'setSelectedShapes'
	>,
	timing: ReviewVideoTiming,
	currentTimeSeconds: number
) {
	const visible = editor.getSelectedShapeIds().filter((id) => {
		const shape = editor.getShape(id)
		if (!shape || shape.type === REVIEW_VIDEO_SHAPE_TYPE) return false
		try {
			const target =
				shape.type === 'group'
					? getReviewAnnotationGroupTarget(editor, shape.id, timing)
					: isTargetedAnnotationShape(shape)
						? shape.meta[REVIEW_ANNOTATION_TARGET_META_KEY]
						: null
			if (!target) return false
			return isReviewAnnotationVisibleAtPlayhead(target, timing, currentTimeSeconds)
		} catch {
			return false
		}
	})
	if (visible.length !== editor.getSelectedShapeIds().length) editor.setSelectedShapes(visible)
}

function isTargetedAnnotationShape(shape: TLShape) {
	return ANNOTATION_SHAPE_TYPES.has(shape.type)
}

function reviewAnnotationTargetKey(target: ReviewAnnotationTarget) {
	return target.kind === 'frame'
		? `frame:${target.startFrame}:${target.endFrame}`
		: `time:${target.startTimeMs}:${target.endTimeMs}`
}

function reviewVideoPlayheadBucket(timing: ReviewVideoTiming | null, timeSeconds: number) {
	if (!timing) return `time:${Math.round(timeSeconds * 1_000)}`
	return timing.mode === 'frames'
		? `frame:${mediaTimeToFrame(timing, clampReviewVideoTime(timing, timeSeconds))}`
		: `time:${Math.round(timeSeconds * 1_000)}`
}

function reviewVideoPlayheadLabel(metadata: MetadataState, timeSeconds: number) {
	if (metadata.status !== 'ready') return 'Time pending'
	if (metadata.timing.mode === 'frames') {
		const frame = mediaTimeToFrame(
			metadata.timing,
			clampReviewVideoTime(metadata.timing, timeSeconds)
		)
		const prefix = metadata.timing.frameNumbering === 'relative' ? 'Relative frame' : 'Frame'
		return `${prefix} ${frame} · ${formatReviewVideoTimecode(metadata.timing, frame)} NDF`
	}
	return formatReviewVideoTime(clampReviewVideoTime(metadata.timing, timeSeconds))
}

function reviewVideoExportTargetLabel(timing: ReviewVideoTiming, timeSeconds: number) {
	if (timing.mode === 'frames') {
		return `frame-${mediaTimeToFrame(timing, clampReviewVideoTime(timing, timeSeconds))}`
	}
	return `time-${Math.round(clampReviewVideoTime(timing, timeSeconds) * 1_000)}ms`
}

function fallbackReasonLabel(
	reason: Extract<ReviewVideoTiming, { mode: 'time' }>['fallbackReason']
) {
	return reason.replaceAll('-', ' ')
}

function resolveInitialVideoDimensions(media: ReviewVideoMedia) {
	if (media.width !== null && media.height !== null) {
		try {
			assertVideoDimensions(media.width, media.height)
			return { height: media.height, width: media.width }
		} catch {
			// The decoded metadata path will surface the authoritative error.
		}
	}
	return { height: DEFAULT_VIDEO_HEIGHT, width: DEFAULT_VIDEO_WIDTH }
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
		throw new Error('The decoded video dimensions are invalid or too large.')
	}
}

function sameReadyVideoMetadata(left: ReadyVideoMetadata, right: ReadyVideoMetadata) {
	if (
		left.durationSeconds !== right.durationSeconds ||
		left.height !== right.height ||
		left.width !== right.width ||
		left.timing.mode !== right.timing.mode
	) {
		return false
	}
	if (left.timing.mode === 'time' || right.timing.mode === 'time') {
		return (
			left.timing.mode === 'time' &&
			right.timing.mode === 'time' &&
			left.timing.durationSeconds === right.timing.durationSeconds &&
			left.timing.fallbackReason === right.timing.fallbackReason
		)
	}
	return (
		left.timing.durationSeconds === right.timing.durationSeconds &&
		left.timing.firstFrame === right.timing.firstFrame &&
		left.timing.frameCount === right.timing.frameCount &&
		left.timing.frameNumbering === right.timing.frameNumbering &&
		left.timing.frameRate === right.timing.frameRate &&
		left.timing.lastFrame === right.timing.lastFrame &&
		left.timing.nominalFrameRate === right.timing.nominalFrameRate
	)
}

function downloadBlob(blob: Blob, fileName: string) {
	const url = URL.createObjectURL(blob)
	const anchor = document.createElement('a')
	anchor.download = fileName
	anchor.href = url
	anchor.rel = 'noopener'
	anchor.click()
	setTimeout(() => URL.revokeObjectURL(url), 0)
}

function videoErrorMessage(error: unknown) {
	return error instanceof Error && error.message
		? error.message
		: 'The video review operation failed.'
}
