import type {
	ReviewImageMedia,
	ReviewPublicationErrorContext,
	ReviewPublicationResult,
	ReviewUser,
} from '@tldraw/shotgrid-review-contracts'
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
	getSnapshot,
	loadSnapshot,
	track,
	useEditor,
	type Editor,
	type TLComponents,
	type TLStore,
	type TLShapeId,
	type TLUiOverrides,
} from 'tldraw'
import {
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
import { type ReviewApiClient, ReviewApiClientError } from './reviewApiClient'
import {
	decodeReviewImageDimensions,
	digestReviewImage,
	fetchReviewImage,
	resolveReviewImageDimensions,
} from './reviewImage'
import {
	createReviewPublicationId,
	prepareReviewPublication,
	renderReviewPng,
	sanitizeReviewFileNameBase,
	type PreparedReviewPublication,
} from './reviewPublication'
import {
	ReviewPublicationPanel,
	type ReviewNoteOptionsState,
	type ReviewPublicationFormValue,
	type ReviewPublicationViewState,
} from './ReviewPublicationPanel'
import {
	createStoredReviewPublication,
	reviewPublicationStore as defaultReviewPublicationStore,
	type ReviewPublicationStore,
} from './reviewPublicationStore'
import { reviewVideoShapeUtils } from './reviewVideoShape'

const REVIEW_EDITOR_OPTIONS = { maxPages: 1, selectLockedShapes: false } as const
const REVIEW_TOOLS = new Set(['arrow', 'draw', 'rectangle', 'review-marker', 'select', 'text'])
const SAFE_PRE_MUTATION_PUBLICATION_ERRORS = new Set([
	'AUTHENTICATION_REQUIRED',
	'CONFIGURATION_ERROR',
	'INVALID_REQUEST',
	'INVALID_SHOTGRID_PATH',
	'NOT_FOUND',
	'PERMISSION_DENIED',
	'SHOTGRID_AUTH_FAILED',
	'SHOTGRID_PERMISSION_DENIED',
])

export const SERVICE_PUBLICATION_DISABLED_MESSAGE =
	'Publishing requires SHOTGRID_SUDO_AS_LOGIN to resolve a human reviewer. Service identities can browse, annotate, and export only.'

export type ReviewPublicationAccess =
	| { status: 'enabled' }
	| { message: string; status: 'disabled' }

export function reviewPublicationAccessForReviewerKind(
	kind: ReviewUser['kind']
): ReviewPublicationAccess {
	return kind === 'human'
		? { status: 'enabled' }
		: { message: SERVICE_PUBLICATION_DISABLED_MESSAGE, status: 'disabled' }
}

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
	allowSnapshotImport?: boolean
	api: ReviewApiClient
	collaborationReadOnly?: boolean
	documentKey: string
	licenseKey?: string
	media: ReviewImageMedia
	persistenceKey?: string
	playlistId: number
	projectId: number
	publicationAccess: ReviewPublicationAccess
	publicationStore?: ReviewPublicationStore
	reviewScope: string
	store?: TLStore
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

interface PublicationContext {
	active: boolean
	generation: number
	storageKey: string
}

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
	allowSnapshotImport = true,
	api,
	collaborationReadOnly = false,
	documentKey,
	image,
	licenseKey,
	persistenceKey,
	playlistId,
	projectId,
	publicationAccess,
	publicationStore = defaultReviewPublicationStore,
	refreshWarning,
	reviewScope,
	store,
	versionName,
}: ReviewAnnotationEditorProps & { image: LoadedReviewImage; refreshWarning?: string }) {
	const [editor, setEditor] = useState<Editor | null>(null)
	const [installation, setInstallation] = useState<OperationState>({ status: 'idle' })
	const [operation, setOperation] = useState<OperationState>({ status: 'idle' })
	const [noteOptionsAttempt, setNoteOptionsAttempt] = useState(0)
	const [noteOptions, setNoteOptions] = useState<ReviewNoteOptionsState>({ status: 'loading' })
	const [publication, setPublication] = useState<ReviewPublicationViewState>({
		label: 'Checking for a saved publication',
		status: 'restoring',
	})
	const operationInFlightRef = useRef(false)
	const pendingPublicationRef = useRef<PreparedReviewPublication | null>(null)
	const publicationGenerationRef = useRef(0)
	const senderClaimIdRef = useRef<string | null>(null)
	const sharedRetryRef = useRef(false)
	const protectionRef = useRef<null | (() => void)>(null)
	const publicationStorageKey = `${documentKey}:publication:playlist-${playlistId}:version-${image.versionId}`
	const publicationContextRef = useRef<PublicationContext | null>(null)
	const readonlyRestoreRef = useRef<null | (() => void)>(null)
	const collaborationReadOnlyRef = useRef(collaborationReadOnly)
	collaborationReadOnlyRef.current = collaborationReadOnly
	const noteOptionsRef = useRef(noteOptions)
	noteOptionsRef.current = noteOptions
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
		editor.updateInstanceState({ isReadonly: collaborationReadOnly })
	}, [collaborationReadOnly, editor])

	useLayoutEffect(() => {
		const context: PublicationContext = {
			active: true,
			generation: (publicationContextRef.current?.generation ?? 0) + 1,
			storageKey: publicationStorageKey,
		}
		publicationContextRef.current = context
		operationInFlightRef.current = false
		publicationGenerationRef.current = 0
		senderClaimIdRef.current = null
		sharedRetryRef.current = false
		return () => {
			context.active = false
			readonlyRestoreRef.current?.()
			readonlyRestoreRef.current = null
		}
	}, [publicationStorageKey])

	useEffect(() => {
		let cancelled = false
		pendingPublicationRef.current = null
		publicationGenerationRef.current = 0
		senderClaimIdRef.current = null
		sharedRetryRef.current = false
		if (publicationAccess.status === 'disabled') {
			setPublication({ status: 'idle' })
			return
		}
		setPublication({ label: 'Checking for a saved publication', status: 'restoring' })
		void publicationStore
			.get(publicationStorageKey)
			.then((stored) => {
				if (cancelled) return
				if (!stored) {
					setPublication({ status: 'idle' })
					return
				}
				publicationGenerationRef.current = stored.generation
				if (stored.status === 'idle') {
					setPublication({ status: 'idle' })
					return
				}
				if (stored.status === 'completed') {
					pendingPublicationRef.current = null
					setPublication({ result: stored.result, status: 'success' })
					return
				}
				pendingPublicationRef.current = stored.prepared
				sharedRetryRef.current = stored.status === 'pending' && stored.claim !== null
				const draft = publicationDraftFromPrepared(stored.prepared)
				if (stored.status === 'indeterminate') {
					setPublication({
						draft,
						message: indeterminatePublicationMessage(stored.requestId, stored.uncertainty),
						publicationId: stored.prepared.publicationId,
						status: 'indeterminate',
						uncertainty: stored.uncertainty ?? undefined,
					})
					return
				}
				setPublication({
					draft,
					message: `A saved publication is ready to resume. Publication ${stored.prepared.publicationId}.`,
					publicationId: stored.prepared.publicationId,
					retryReady: true,
					status: 'error',
				})
			})
			.catch((error) => {
				if (cancelled) return
				setPublication({
					message: `Publishing is blocked because saved publication state could not be checked. ${editorErrorMessage(error)}`,
					status: 'blocked',
				})
			})
		return () => {
			cancelled = true
		}
	}, [publicationAccess.status, publicationStorageKey, publicationStore])

	useEffect(() => {
		if (publicationAccess.status === 'disabled') return
		const controller = new AbortController()
		setNoteOptions({ status: 'loading' })
		void api
			.getNoteOptions(playlistId, image.versionId, controller.signal)
			.then((options) => {
				if (!controller.signal.aborted) setNoteOptions({ options, status: 'ready' })
			})
			.catch((error) => {
				if (!controller.signal.aborted) {
					setNoteOptions({ message: publicationErrorMessage(error), status: 'error' })
				}
			})
		return () => controller.abort()
	}, [api, image.versionId, noteOptionsAttempt, playlistId, publicationAccess.status])

	useEffect(() => {
		if (!editor) return
		const controller = new AbortController()
		let installing = false
		const localOnly = store !== undefined
		const install = async (announce: boolean) => {
			if (installing || controller.signal.aborted) return
			installing = true
			if (announce) {
				setInstallation({ label: 'Installing protected source image', status: 'working' })
			}
			try {
				await installReviewImage(editor, image, controller.signal, { localOnly })
				if (controller.signal.aborted) return
				protectionRef.current?.()
				protectionRef.current = protectReviewImage(editor, image, { localOnly })
				setInstallation({ status: 'idle' })
			} catch (error) {
				if (!controller.signal.aborted) {
					setInstallation({ message: editorErrorMessage(error), status: 'error' })
				}
			} finally {
				installing = false
			}
		}
		setInstallation({ label: 'Installing protected source image', status: 'working' })
		void install(true)
		const stopWatching = localOnly
			? editor.store.listen(
					() => {
						const { assetId, shapeId } = getReviewImageIds(image.versionId)
						if (!editor.getAsset(assetId) || !editor.getShape(shapeId)) void install(false)
					},
					{ scope: 'document', source: 'remote' }
				)
			: undefined
		return () => {
			controller.abort()
			stopWatching?.()
			protectionRef.current?.()
			protectionRef.current = null
		}
	}, [editor, image, store])

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
				`${sanitizeReviewFileNameBase(versionName)}.review.json`
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
			const blob = await renderReviewPng(editor, image)
			downloadBlob(blob, `${sanitizeReviewFileNameBase(versionName)}.annotated.png`)
			setOperation({ message: 'Flattened PNG exported.', status: 'success' })
		} catch (error) {
			setOperation({ message: editorErrorMessage(error), status: 'error' })
		} finally {
			operationInFlightRef.current = false
		}
	}, [editor, image, installation.status, versionName])

	const publishReview = useCallback(
		async (draft: ReviewPublicationFormValue) => {
			const context = publicationContextRef.current
			if (
				!editor ||
				!context ||
				publicationAccess.status === 'disabled' ||
				!isCurrentPublicationContext(publicationContextRef.current, context) ||
				installation.status !== 'idle' ||
				operationInFlightRef.current
			) {
				return
			}
			operationInFlightRef.current = true
			const attemptGeneration = publicationGenerationRef.current
			let prepared = pendingPublicationRef.current
			const existingSenderClaimId = senderClaimIdRef.current
			let restoreEditing: null | (() => void) = null
			try {
				if (!prepared) {
					try {
						const wasReadonly = editor.getInstanceState().isReadonly
						editor.updateInstanceState({ isReadonly: true })
						let restored = false
						restoreEditing = () => {
							if (restored) return
							restored = true
							editor.updateInstanceState({
								isReadonly: wasReadonly || collaborationReadOnlyRef.current,
							})
							if (readonlyRestoreRef.current === restoreEditing) {
								readonlyRestoreRef.current = null
							}
						}
						readonlyRestoreRef.current = restoreEditing
						setPublication({ label: 'Rendering full-resolution PNG', status: 'working' })
						const png = await renderReviewPng(editor, image)
						if (!isCurrentPublicationContext(publicationContextRef.current, context)) return
						prepared = await prepareReviewPublication({
							content: draft.content,
							fileName: `${sanitizeReviewFileNameBase(versionName)}.annotated.png`,
							generation: attemptGeneration,
							png,
							recipientIds: draft.recipientIds,
							subject: draft.subject,
						})
						if (!isCurrentPublicationContext(publicationContextRef.current, context)) return
						setPublication({ label: 'Saving a durable retry payload', status: 'working' })
						const candidate = prepared
						const stored = await publicationStore.addIfAbsent(
							createStoredReviewPublication({
								documentKey: context.storageKey,
								prepared,
								status: 'pending',
							})
						)
						if (!isCurrentPublicationContext(publicationContextRef.current, context)) return
						if (stored.record.status === 'completed') {
							publicationGenerationRef.current = stored.record.generation
							pendingPublicationRef.current = null
							senderClaimIdRef.current = null
							sharedRetryRef.current = false
							setPublication({ result: stored.record.result, status: 'success' })
							return
						}
						if (stored.record.status === 'idle' || stored.record.generation !== attemptGeneration) {
							publicationGenerationRef.current = stored.record.generation
							pendingPublicationRef.current = null
							senderClaimIdRef.current = null
							sharedRetryRef.current = false
							setPublication({
								message:
									'Another tab advanced this review to a newer publication attempt. Reload the review before publishing.',
								status: 'blocked',
							})
							return
						}
						prepared = stored.record.prepared
						pendingPublicationRef.current = prepared
						sharedRetryRef.current = stored.record.sharedRetry || stored.record.claim !== null
						if (stored.record.status === 'indeterminate') {
							setPublication({
								draft: publicationDraftFromPrepared(prepared),
								message: indeterminatePublicationMessage(
									stored.record.requestId,
									stored.record.uncertainty
								),
								publicationId: prepared.publicationId,
								status: 'indeterminate',
								uncertainty: stored.record.uncertainty ?? undefined,
							})
							return
						}
						if (
							!stored.created &&
							(stored.record.prepared.publicationId !== candidate.publicationId ||
								stored.record.prepared.fingerprint !== candidate.fingerprint)
						) {
							setPublication({
								draft: publicationDraftFromPrepared(prepared),
								message: `Another tab saved publication ${prepared.publicationId} with frozen Note values. Review those locked values, then choose Retry publish to confirm sending that publication.`,
								publicationId: prepared.publicationId,
								retryReady: true,
								status: 'error',
							})
							return
						}
					} catch (error) {
						throw new Error(
							`The publication could not be saved safely, so nothing was sent. ${editorErrorMessage(error)}`
						)
					} finally {
						restoreEditing?.()
						restoreEditing = null
					}
				}
				if (!prepared || !isCurrentPublicationContext(publicationContextRef.current, context)) {
					return
				}
				const claimId = existingSenderClaimId ?? createReviewPublicationId()
				const claim = await publicationStore.claimForSend(
					context.storageKey,
					prepared.publicationId,
					prepared.generation,
					claimId,
					sharedRetryRef.current
				)
				if (!isCurrentPublicationContext(publicationContextRef.current, context)) return
				if (claim.status === 'completed') {
					if (isCurrentPublicationContext(publicationContextRef.current, context)) {
						publicationGenerationRef.current = claim.record.generation
						pendingPublicationRef.current = null
						senderClaimIdRef.current = null
						sharedRetryRef.current = false
						setPublication({ result: claim.record.result, status: 'success' })
					}
					return
				}
				if (claim.status === 'busy') {
					if (isCurrentPublicationContext(publicationContextRef.current, context)) {
						sharedRetryRef.current = true
						setPublication({
							draft: publicationDraftFromPrepared(prepared),
							message:
								'Another tab owns this saved publication send. Its claim does not expire automatically; check ShotGrid or return to the original tab before retrying.',
							publicationId: prepared.publicationId,
							retryReady: true,
							status: 'error',
						})
					}
					return
				}
				if (claim.status === 'conflict') {
					if (isCurrentPublicationContext(publicationContextRef.current, context)) {
						if (claim.record) publicationGenerationRef.current = claim.record.generation
						pendingPublicationRef.current = null
						senderClaimIdRef.current = null
						sharedRetryRef.current = false
						setPublication({
							message:
								'Another tab advanced or replaced this publication attempt. Reload the review before publishing.',
							status: 'blocked',
						})
					}
					return
				}
				if (isCurrentPublicationContext(publicationContextRef.current, context)) {
					senderClaimIdRef.current = claimId
					sharedRetryRef.current = claim.record.sharedRetry
				}
				if (isCurrentPublicationContext(publicationContextRef.current, context)) {
					setPublication({ label: 'Publishing Note and attachment', status: 'working' })
				}
				let result: ReviewPublicationResult
				try {
					result = await api.publishReview(
						playlistId,
						image.versionId,
						prepared.publicationId,
						prepared.request
					)
				} catch (error) {
					const message = publicationErrorMessage(error)
					const preparedDraft = publicationDraftFromPrepared(prepared)
					if (
						error instanceof ReviewApiClientError &&
						(error.code === 'PUBLICATION_INDETERMINATE' || error.code === 'PUBLICATION_CONFLICT')
					) {
						try {
							const stored = await publicationStore.markIndeterminate(
								context.storageKey,
								prepared.publicationId,
								prepared.generation,
								claimId,
								error.requestId,
								error.publication
							)
							if (stored.status === 'completed') {
								if (isCurrentPublicationContext(publicationContextRef.current, context)) {
									publicationGenerationRef.current = stored.generation
									pendingPublicationRef.current = null
									senderClaimIdRef.current = null
									sharedRetryRef.current = false
									setPublication({ result: stored.result, status: 'success' })
								}
								return
							}
						} catch (storageError) {
							if (isCurrentPublicationContext(publicationContextRef.current, context)) {
								setPublication({
									message: `${message} Publishing is locked, and the indeterminate state could not be saved. Do not refresh; check ShotGrid using publication ${prepared.publicationId}. ${editorErrorMessage(storageError)}`,
									status: 'blocked',
								})
							}
							return
						}
						if (isCurrentPublicationContext(publicationContextRef.current, context)) {
							senderClaimIdRef.current = null
							sharedRetryRef.current = false
							setPublication({
								draft: preparedDraft,
								message: `${message} Check ShotGrid for the Note and attachment before starting another publication.`,
								publicationId: prepared.publicationId,
								status: 'indeterminate',
								uncertainty: error.publication,
							})
						}
						return
					}
					const retryReady =
						!(error instanceof ReviewApiClientError) ||
						error.retryable ||
						!isSafePreMutationPublicationError(error.code)
					if (retryReady) {
						if (isCurrentPublicationContext(publicationContextRef.current, context)) {
							setPublication({
								draft: preparedDraft,
								message: `${message} Retrying will reuse the same publication and PNG.`,
								publicationId: prepared.publicationId,
								retryReady: true,
								status: 'error',
							})
						}
						return
					}
					try {
						const finished = await publicationStore.finishSafeFailure(
							context.storageKey,
							prepared.publicationId,
							prepared.generation,
							claimId
						)
						if (!isCurrentPublicationContext(publicationContextRef.current, context)) return
						if (finished.status === 'completed') {
							publicationGenerationRef.current = finished.record.generation
							pendingPublicationRef.current = null
							senderClaimIdRef.current = null
							sharedRetryRef.current = false
							setPublication({ result: finished.record.result, status: 'success' })
							return
						}
						if (finished.status === 'conflict') {
							setPublication({
								message: `${message} Another tab changed the saved publication, so publishing is blocked until this review is reloaded.`,
								status: 'blocked',
							})
							return
						}
						publicationGenerationRef.current = finished.record.generation
						pendingPublicationRef.current = null
						senderClaimIdRef.current = null
						sharedRetryRef.current = false
						setPublication({
							allowedRecipientIds: allowedPublicationRecipientIds(noteOptionsRef.current),
							message,
							retryReady: false,
							status: 'error',
						})
					} catch (storageError) {
						if (isCurrentPublicationContext(publicationContextRef.current, context)) {
							setPublication({
								message: `${message} A new publication is blocked until the saved retry payload can be removed. ${editorErrorMessage(storageError)}`,
								status: 'blocked',
							})
						}
					}
					return
				}

				let warning: string | undefined
				let completedResult = result
				try {
					const completed = await publicationStore.markCompleted(
						context.storageKey,
						prepared.publicationId,
						prepared.generation,
						claimId,
						result
					)
					completedResult = completed.result
					if (isCurrentPublicationContext(publicationContextRef.current, context)) {
						publicationGenerationRef.current = completed.generation
						pendingPublicationRef.current = null
						senderClaimIdRef.current = null
						sharedRetryRef.current = false
					}
				} catch (error) {
					warning = `The completed publication could not be recorded locally. Do not publish again until this review is reloaded and checked in ShotGrid. ${editorErrorMessage(error)}`
				}
				if (isCurrentPublicationContext(publicationContextRef.current, context)) {
					setPublication({ result: completedResult, status: 'success', warning })
				}
			} catch (error) {
				if (isCurrentPublicationContext(publicationContextRef.current, context)) {
					setPublication({
						message: editorErrorMessage(error),
						retryReady: false,
						status: 'error',
					})
				}
			} finally {
				if (isCurrentPublicationContext(publicationContextRef.current, context)) {
					operationInFlightRef.current = false
				}
			}
		},
		[
			api,
			editor,
			image,
			installation.status,
			playlistId,
			publicationAccess.status,
			publicationStore,
			versionName,
		]
	)

	const startAnotherPublication = useCallback(async () => {
		const context = publicationContextRef.current
		if (
			!context ||
			publicationAccess.status === 'disabled' ||
			!isCurrentPublicationContext(publicationContextRef.current, context) ||
			operationInFlightRef.current
		) {
			return
		}
		const expectedGeneration = publicationGenerationRef.current
		operationInFlightRef.current = true
		setPublication({ label: 'Starting a new publication attempt', status: 'working' })
		try {
			const record = await publicationStore.startNextAttempt(context.storageKey, expectedGeneration)
			if (!isCurrentPublicationContext(publicationContextRef.current, context)) return
			publicationGenerationRef.current = record.generation
			pendingPublicationRef.current = null
			senderClaimIdRef.current = null
			sharedRetryRef.current = false
			if (record.status === 'idle' && record.generation === expectedGeneration + 1) {
				setPublication({ status: 'idle' })
				return
			}
			if (record.status === 'completed') {
				setPublication({
					result: record.result,
					status: 'success',
					warning: 'Another tab still owns the completed publication state.',
				})
				return
			}
			setPublication({
				message:
					'Another tab changed this publication attempt. Reload the review before starting another Note.',
				status: 'blocked',
			})
		} catch (error) {
			if (isCurrentPublicationContext(publicationContextRef.current, context)) {
				setPublication({
					message: `A new publication attempt could not be started safely. ${editorErrorMessage(error)}`,
					status: 'blocked',
				})
			}
		} finally {
			if (isCurrentPublicationContext(publicationContextRef.current, context)) {
				operationInFlightRef.current = false
			}
		}
	}, [publicationAccess.status, publicationStore])

	const imageShapeId = getReviewImageIds(image.versionId).shapeId
	const editorActionsDisabled =
		!editor ||
		installation.status !== 'idle' ||
		operation.status === 'working' ||
		publication.status === 'working'
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
			SharePanel: null,
			Toolbar: FocusedReviewToolbar,
		}),
		[imageShapeId]
	)

	return (
		<div className="review-image-editor">
			<Tldraw
				components={components}
				key={documentKey}
				licenseKey={licenseKey}
				onMount={handleMount}
				options={REVIEW_EDITOR_OPTIONS}
				overrides={reviewUiOverrides}
				{...(store ? { store } : persistenceKey ? { persistenceKey } : {})}
				shapeUtils={reviewVideoShapeUtils}
				tools={[ReviewMarkerTool]}
			/>
			<ReviewEditorActions
				defaultSubject={`Review: ${versionName}`}
				disabled={editorActionsDisabled}
				noteOptions={noteOptions}
				onExport={() => void exportPng()}
				onOpen={allowSnapshotImport ? (file) => void openEditable(file) : undefined}
				onPublish={(draft) => void publishReview(draft)}
				onRetryNoteOptions={() => setNoteOptionsAttempt((value) => value + 1)}
				onSave={saveEditable}
				onStartAnother={() => void startAnotherPublication()}
				operation={visibleOperation}
				publicationAccess={publicationAccess}
				publication={publication}
			/>
		</div>
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
	defaultSubject,
	disabled,
	noteOptions,
	onExport,
	onOpen,
	onPublish,
	onRetryNoteOptions,
	onSave,
	onStartAnother,
	operation,
	publicationAccess,
	publication,
}: {
	defaultSubject: string
	disabled: boolean
	noteOptions: ReviewNoteOptionsState
	onExport(): void
	onOpen?(file: File): void
	onPublish(value: ReviewPublicationFormValue): void
	onRetryNoteOptions(): void
	onSave(): void
	onStartAnother(): void
	operation: OperationState
	publicationAccess: ReviewPublicationAccess
	publication: ReviewPublicationViewState
}) {
	const inputRef = useRef<HTMLInputElement>(null)
	return (
		<div className="review-editor-actions">
			<div className="review-editor-actions__buttons">
				<button disabled={disabled} onClick={onSave} type="button">
					Save editable
				</button>
				{onOpen ? (
					<button disabled={disabled} onClick={() => inputRef.current?.click()} type="button">
						Open editable
					</button>
				) : null}
				<button disabled={disabled} onClick={onExport} type="button">
					Export PNG
				</button>
				{onOpen ? (
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
				) : null}
			</div>
			{publicationAccess.status === 'disabled' ? (
				<div className="review-publication__disabled" role="note">
					<strong>Publishing unavailable</strong>
					<span>{publicationAccess.message}</span>
				</div>
			) : (
				<ReviewPublicationPanel
					defaultSubject={defaultSubject}
					disabled={disabled}
					noteOptions={noteOptions}
					onPublish={onPublish}
					onRetryOptions={onRetryNoteOptions}
					onStartAnother={onStartAnother}
					publication={publication}
				/>
			)}
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

function isCurrentPublicationContext(
	current: PublicationContext | null,
	expected: PublicationContext
) {
	return expected.active && current === expected
}

function allowedPublicationRecipientIds(noteOptions: ReviewNoteOptionsState) {
	if (noteOptions.status !== 'ready') return []
	return noteOptions.options.recipients.flatMap((recipient) =>
		recipient.kind === 'human' && recipient.id !== null ? [recipient.id] : []
	)
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

function publicationErrorMessage(error: unknown) {
	if (error instanceof ReviewApiClientError) {
		return error.requestId ? `${error.message} Request ${error.requestId}.` : error.message
	}
	return editorErrorMessage(error)
}

function publicationDraftFromPrepared(
	prepared: PreparedReviewPublication
): ReviewPublicationFormValue {
	return {
		content: prepared.request.content,
		recipientIds: prepared.request.recipientIds.slice(),
		subject: prepared.request.subject,
	}
}

function indeterminatePublicationMessage(
	requestId: string | null,
	uncertainty: ReviewPublicationErrorContext | null
) {
	const request = requestId ? ` Request ${requestId}.` : ''
	const known =
		uncertainty?.stage === 'attachment-completion'
			? uncertainty.attachmentId
				? ` Note #${uncertainty.noteId} and Attachment #${uncertainty.attachmentId} are known; check whether Attachment completion finished.`
				: ` Note #${uncertainty.noteId} is known; check whether Attachment completion finished.`
			: uncertainty?.stage === 'note-created'
				? ` Note #${uncertainty.noteId} is known; check its Attachment state.`
				: ' The Note creation outcome is not known.'
	return `This publication has an indeterminate outcome.${request}${known} Check ShotGrid before starting another publication.`
}

function isSafePreMutationPublicationError(code: string) {
	return SAFE_PRE_MUTATION_PUBLICATION_ERRORS.has(code)
}
