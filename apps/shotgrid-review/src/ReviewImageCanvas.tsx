import type { ReviewImageMedia } from '@tldraw/shotgrid-review-contracts'
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentProps } from 'react'
import {
	DefaultToolbar,
	SVGContainer,
	Tldraw,
	ToolbarItem,
	Box,
	getSnapshot,
	loadSnapshot,
	track,
	useEditor,
	type Editor,
	type TLComponents,
	type TLShapeId,
	type TLUiOverrides,
} from 'tldraw'
import {
	getReviewExportOptions,
	getReviewImageIds,
	disableReviewExternalContent,
	installReviewImage,
	protectReviewImage,
	ReviewMarkerTool,
	type LoadedReviewImage,
} from './reviewAnnotationEditor'
import {
	assertReviewAnnotationRecords,
	assertReviewAnnotationSource,
	createReviewAnnotationSnapshot,
	MAX_REVIEW_ANNOTATION_SNAPSHOT_BYTES,
	parseReviewAnnotationSnapshotJson,
	sanitizeReviewAnnotationSnapshot,
	serializeReviewAnnotationSnapshot,
	type ReviewAnnotationContext,
	type ReviewAnnotationSource,
} from './reviewAnnotationSnapshot'
import {
	decodeReviewImageDimensions,
	digestReviewImage,
	fetchReviewImage,
	resolveReviewImageDimensions,
} from './reviewImage'

const REVIEW_EDITOR_OPTIONS = { maxPages: 1, selectLockedShapes: false } as const
const REVIEW_TOOLS = new Set(['arrow', 'draw', 'rectangle', 'review-marker', 'select', 'text'])

const reviewUiOverrides: TLUiOverrides = {
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

export interface ReviewAnnotationEditorProps {
	documentKey: string
	licenseKey?: string
	media: ReviewImageMedia
	persistenceKey?: string
	projectId: number
	reviewScope: string
	versionId: number
	versionName: string
}

type ImageLoadState =
	| { status: 'loading' }
	| { documentKey: string; error: string; status: 'error' }
	| { documentKey: string; image: LoadedReviewImage; status: 'ready'; warning?: string }

type OperationState =
	| { status: 'idle' }
	| { label: string; status: 'working' }
	| { message: string; status: 'error' | 'success' }

export function ReviewImageCanvas(props: ReviewAnnotationEditorProps) {
	const [attempt, setAttempt] = useState(0)
	const [state, setState] = useState<ImageLoadState>({ status: 'loading' })

	useEffect(() => {
		const controller = new AbortController()
		setState((current) =>
			current.status === 'ready' && current.documentKey === props.documentKey
				? current
				: { status: 'loading' }
		)
		void (async () => {
			try {
				const blob = await fetchReviewImage(props.media, controller.signal)
				const [decoded, sha256] = await Promise.all([
					decodeReviewImageDimensions(blob, controller.signal),
					digestReviewImage(blob),
				])
				const dimensions = resolveReviewImageDimensions(props.media, decoded.width, decoded.height)
				if (controller.signal.aborted) return
				const nextImage: LoadedReviewImage = {
					blob,
					contentType: blob.type,
					height: dimensions.height,
					name: props.versionName,
					sha256,
					versionId: props.versionId,
					width: dimensions.width,
				}
				setState((current) => {
					if (
						current.status === 'ready' &&
						current.documentKey === props.documentKey &&
						sameReviewImage(current.image, nextImage)
					) {
						return current.warning
							? { documentKey: current.documentKey, image: current.image, status: 'ready' }
							: current
					}
					return { documentKey: props.documentKey, image: nextImage, status: 'ready' }
				})
			} catch (error) {
				if (controller.signal.aborted) return
				const message = imageErrorMessage(error)
				setState((current) =>
					current.status === 'ready' && current.documentKey === props.documentKey
						? { ...current, warning: `Media refresh failed: ${message}` }
						: { documentKey: props.documentKey, error: message, status: 'error' }
				)
			}
		})()
		return () => controller.abort()
	}, [attempt, props.documentKey, props.media, props.versionId, props.versionName])

	if (state.status === 'loading' || state.documentKey !== props.documentKey) {
		return <ReviewCanvasMessage busy title="Preparing review image" />
	}
	if (state.status === 'error') {
		return (
			<ReviewCanvasMessage
				action="Try image again"
				onAction={() => setAttempt((value) => value + 1)}
				title="Image annotation unavailable"
			>
				{state.error}
			</ReviewCanvasMessage>
		)
	}

	const sourceIdentity = `${state.image.sha256}:${state.image.width}x${state.image.height}`
	return (
		<ReadyReviewAnnotationEditor
			key={`${props.documentKey}:${sourceIdentity}`}
			{...props}
			image={state.image}
			persistenceKey={
				props.persistenceKey ? `${props.persistenceKey}:source-${sourceIdentity}` : undefined
			}
			refreshWarning={state.warning}
		/>
	)
}

function ReadyReviewAnnotationEditor({
	documentKey,
	image,
	licenseKey,
	persistenceKey,
	projectId,
	refreshWarning,
	reviewScope,
	versionName,
}: ReviewAnnotationEditorProps & { image: LoadedReviewImage; refreshWarning?: string }) {
	const [editor, setEditor] = useState<Editor | null>(null)
	const [installation, setInstallation] = useState<OperationState>({ status: 'idle' })
	const [operation, setOperation] = useState<OperationState>({ status: 'idle' })
	const operationInFlightRef = useRef(false)
	const protectionRef = useRef<null | (() => void)>(null)
	const review = useMemo<ReviewAnnotationContext>(
		() => ({ projectId, scope: reviewScope, versionId: image.versionId }),
		[image.versionId, projectId, reviewScope]
	)
	const source = useMemo<ReviewAnnotationSource>(
		() => ({
			contentType: image.contentType,
			height: image.height,
			sha256: image.sha256,
			width: image.width,
		}),
		[image]
	)
	const handleMount = useCallback((mountedEditor: Editor) => {
		disableReviewExternalContent(mountedEditor)
		setEditor(mountedEditor)
	}, [])

	useEffect(() => {
		if (!editor) return
		const controller = new AbortController()
		setInstallation({ label: 'Installing protected source image', status: 'working' })
		void installReviewImage(editor, image, controller.signal)
			.then(() => {
				if (controller.signal.aborted) return
				protectionRef.current?.()
				protectionRef.current = protectReviewImage(editor, image)
				setInstallation({ status: 'idle' })
			})
			.catch((error) => {
				if (controller.signal.aborted) return
				setInstallation({ message: editorErrorMessage(error), status: 'error' })
			})
		return () => {
			controller.abort()
			protectionRef.current?.()
			protectionRef.current = null
		}
	}, [editor, image])

	const saveEditable = useCallback(() => {
		if (!editor || installation.status !== 'idle' || operationInFlightRef.current) return
		try {
			const { assetId, shapeId } = getReviewImageIds(image.versionId)
			const snapshot = sanitizeReviewAnnotationSnapshot(getSnapshot(editor.store), assetId)
			assertReviewAnnotationRecords(snapshot, { sourceAssetId: assetId, sourceShapeId: shapeId })
			const envelope = createReviewAnnotationSnapshot({ review, snapshot, source })
			const serialized = serializeReviewAnnotationSnapshot(envelope)
			downloadBlob(
				new Blob([serialized], { type: 'application/json' }),
				`${fileNameBase(versionName)}.review.json`
			)
			setOperation({ message: 'Editable snapshot saved.', status: 'success' })
		} catch (error) {
			setOperation({ message: editorErrorMessage(error), status: 'error' })
		}
	}, [editor, image.versionId, installation.status, review, source, versionName])

	const openEditable = useCallback(
		async (file: File) => {
			if (!editor || installation.status !== 'idle' || operationInFlightRef.current) return
			operationInFlightRef.current = true
			setOperation({ label: 'Opening editable snapshot', status: 'working' })
			try {
				if (file.size > MAX_REVIEW_ANNOTATION_SNAPSHOT_BYTES) {
					throw new Error('The editable snapshot exceeds the 16 MiB limit.')
				}
				const envelope = parseReviewAnnotationSnapshotJson(await file.text(), review)
				assertReviewAnnotationSource(envelope.source, source)
				const { assetId, shapeId } = getReviewImageIds(image.versionId)
				assertReviewAnnotationRecords(envelope.snapshot, {
					sourceAssetId: assetId,
					sourceShapeId: shapeId,
				})
				const snapshot = sanitizeReviewAnnotationSnapshot(envelope.snapshot, assetId)
				protectionRef.current?.()
				protectionRef.current = null
				try {
					loadSnapshot(editor.store, snapshot)
					await installReviewImage(editor, image)
				} finally {
					protectionRef.current = protectReviewImage(editor, image)
				}
				editor.setCurrentTool('select')
				setOperation({ message: 'Editable snapshot opened.', status: 'success' })
			} catch (error) {
				setOperation({ message: editorErrorMessage(error), status: 'error' })
			} finally {
				operationInFlightRef.current = false
			}
		},
		[editor, image, installation.status, review, source]
	)

	const exportPng = useCallback(async () => {
		if (!editor || installation.status !== 'idle' || operationInFlightRef.current) return
		operationInFlightRef.current = true
		setOperation({ label: 'Rendering full-resolution PNG', status: 'working' })
		try {
			const { assetId, shapeId } = getReviewImageIds(image.versionId)
			assertReviewAnnotationRecords(getSnapshot(editor.store), {
				sourceAssetId: assetId,
				sourceShapeId: shapeId,
			})
			const asset = editor.getAsset(assetId)
			const shape = editor.getShape(shapeId)
			if (asset?.type !== 'image' || shape?.type !== 'image' || !shape.isLocked) {
				throw new Error('The protected source image is missing from this review.')
			}
			if (!asset.props.src || !/^(asset:|data:image\/)/.test(asset.props.src)) {
				throw new Error('The source image is not stored locally and cannot be exported safely.')
			}
			const resolvedSource = await editor.resolveAssetUrl(assetId, {
				shouldResolveToOriginal: true,
			})
			if (!resolvedSource || !/^(blob:|data:image\/)/.test(resolvedSource)) {
				throw new Error('The local source image could not be resolved for export.')
			}

			const bounds = new Box(0, 0, image.width, image.height)
			const { blob } = await editor.toImage(
				[...editor.getCurrentPageShapeIds()],
				getReviewExportOptions(bounds)
			)
			if (blob.type !== 'image/png') throw new Error('The editor did not produce a PNG image.')
			const exported = await decodeReviewImageDimensions(blob)
			if (exported.width !== image.width || exported.height !== image.height) {
				throw new Error('The exported PNG does not match the source image resolution.')
			}
			downloadBlob(blob, `${fileNameBase(versionName)}.annotated.png`)
			setOperation({ message: 'Flattened PNG exported.', status: 'success' })
		} catch (error) {
			setOperation({ message: editorErrorMessage(error), status: 'error' })
		} finally {
			operationInFlightRef.current = false
		}
	}, [editor, image, installation.status, versionName])

	const imageShapeId = getReviewImageIds(image.versionId).shapeId
	const editorActionsDisabled =
		!editor || installation.status !== 'idle' || operation.status === 'working'
	const visibleOperation = useMemo<OperationState>(
		() =>
			installation.status !== 'idle'
				? installation
				: operation.status === 'idle' && refreshWarning
					? { message: refreshWarning, status: 'error' }
					: operation,
		[installation, operation, refreshWarning]
	)
	const components = useMemo<TLComponents>(
		() => ({
			ActionsMenu: null,
			ContextMenu: null,
			HelpMenu: null,
			InFrontOfTheCanvas: () => <ReviewBoundsOverlay imageShapeId={imageShapeId} />,
			KeyboardShortcutsDialog: null,
			MainMenu: null,
			PageMenu: null,
			QuickActions: null,
			SharePanel: () => (
				<ReviewEditorActions
					disabled={editorActionsDisabled}
					onExport={() => void exportPng()}
					onOpen={(file) => void openEditable(file)}
					onSave={saveEditable}
					operation={visibleOperation}
				/>
			),
			Toolbar: FocusedReviewToolbar,
		}),
		[editorActionsDisabled, exportPng, imageShapeId, openEditable, saveEditable, visibleOperation]
	)

	return (
		<Tldraw
			components={components}
			key={documentKey}
			licenseKey={licenseKey}
			onMount={handleMount}
			options={REVIEW_EDITOR_OPTIONS}
			overrides={reviewUiOverrides}
			{...(persistenceKey ? { persistenceKey } : {})}
			tools={[ReviewMarkerTool]}
		/>
	)
}

function FocusedReviewToolbar(props: ComponentProps<typeof DefaultToolbar>) {
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

function ReviewEditorActions({
	disabled,
	onExport,
	onOpen,
	onSave,
	operation,
}: {
	disabled: boolean
	onExport(): void
	onOpen(file: File): void
	onSave(): void
	operation: OperationState
}) {
	const inputRef = useRef<HTMLInputElement>(null)
	return (
		<div className="review-editor-actions">
			<div className="review-editor-actions__buttons">
				<button disabled={disabled} onClick={onSave} type="button">
					Save editable
				</button>
				<button disabled={disabled} onClick={() => inputRef.current?.click()} type="button">
					Open editable
				</button>
				<button disabled={disabled} onClick={onExport} type="button">
					Export PNG
				</button>
				<input
					accept="application/json,.json"
					aria-label="Open editable review snapshot"
					hidden
					onChange={(event) => {
						const file = event.currentTarget.files?.[0]
						event.currentTarget.value = ''
						if (file) onOpen(file)
					}}
					ref={inputRef}
					type="file"
				/>
			</div>
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
	)
}

const ReviewBoundsOverlay = track(function ReviewBoundsOverlay({
	imageShapeId,
}: {
	imageShapeId: TLShapeId
}) {
	const editor = useEditor()
	const imageBounds = editor.getShapePageBounds(imageShapeId)
	if (!imageBounds) return null
	const viewport = editor.getViewportScreenBounds()
	const topLeft = editor.pageToViewport(imageBounds)
	const bottomRight = editor.pageToViewport({ x: imageBounds.maxX, y: imageBounds.maxY })
	const path = [
		'M -10 -10',
		`L ${viewport.maxX + 10} -10`,
		`L ${viewport.maxX + 10} ${viewport.maxY + 10}`,
		`L -10 ${viewport.maxY + 10}`,
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

function ReviewCanvasMessage({
	action,
	busy = false,
	children,
	onAction,
	title,
}: {
	action?: string
	busy?: boolean
	children?: string
	onAction?(): void
	title: string
}) {
	return (
		<div aria-busy={busy || undefined} className="review-canvas-message" role="status">
			<strong>{title}</strong>
			{children ? <span>{children}</span> : null}
			{action && onAction ? (
				<button onClick={onAction} type="button">
					{action}
				</button>
			) : null}
		</div>
	)
}

function downloadBlob(blob: Blob, fileName: string) {
	const url = URL.createObjectURL(blob)
	const link = document.createElement('a')
	link.download = fileName
	link.href = url
	link.style.display = 'none'
	document.body.appendChild(link)
	link.click()
	link.remove()
	setTimeout(() => URL.revokeObjectURL(url), 0)
}

function fileNameBase(value: string) {
	const normalized = value
		.normalize('NFKC')
		.replace(/[<>:"/\\|?*]/g, '-')
		.replace(/\p{Cc}/gu, '-')
		.replace(/[. ]+$/g, '')
		.slice(0, 96)
	return normalized || 'shotgrid-review'
}

function imageErrorMessage(error: unknown) {
	return error instanceof Error
		? error.message
		: 'The review image could not be loaded safely. Try refreshing the media.'
}

function sameReviewImage(left: LoadedReviewImage, right: LoadedReviewImage) {
	return (
		left.contentType === right.contentType &&
		left.height === right.height &&
		left.sha256 === right.sha256 &&
		left.versionId === right.versionId &&
		left.width === right.width
	)
}

function editorErrorMessage(error: unknown) {
	return error instanceof Error ? error.message : 'The review operation could not be completed.'
}
