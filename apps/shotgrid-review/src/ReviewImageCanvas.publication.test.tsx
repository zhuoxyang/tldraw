// @vitest-environment jsdom

import type {
	ReviewImageMedia,
	ReviewNoteOptions,
	ReviewPublicationResult,
} from '@tldraw/shotgrid-review-contracts'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

;(
	globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true

const publicationMocks = vi.hoisted(() => ({
	decode: vi.fn(async () => ({ height: 1080, width: 1920 })),
	digest: vi.fn(async () => 'a'.repeat(64)),
	editorReadonly: false,
	editsApplied: 0,
	fetch: vi.fn(async () => new Blob(['source'], { type: 'image/png' })),
	install: vi.fn(async () => undefined),
	tldrawMounts: 0,
	tldrawUnmounts: 0,
	prepare: vi.fn(),
	protect: vi.fn(() => vi.fn()),
	renderPng: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
}))

vi.mock('./reviewImage', () => ({
	decodeReviewImageDimensions: publicationMocks.decode,
	digestReviewImage: publicationMocks.digest,
	fetchReviewImage: publicationMocks.fetch,
	resolveReviewImageDimensions: (_media: ReviewImageMedia, width: number, height: number) => ({
		height,
		width,
	}),
}))

vi.mock('./reviewAnnotationEditor', async (importOriginal) => ({
	...(await importOriginal<typeof import('./reviewAnnotationEditor')>()),
	disableReviewExternalContent: vi.fn(),
	installReviewImage: publicationMocks.install,
	protectReviewImage: publicationMocks.protect,
}))

vi.mock('./reviewPublication', async (importOriginal) => ({
	...(await importOriginal<typeof import('./reviewPublication')>()),
	prepareReviewPublication: publicationMocks.prepare,
	renderReviewPng: publicationMocks.renderPng,
}))

vi.mock('tldraw', async (importOriginal) => {
	const original = await importOriginal<typeof import('tldraw')>()
	const { useEffect } = await import('react')
	return {
		...original,
		Tldraw: ({
			onMount,
			persistenceKey,
		}: {
			onMount?(editor: unknown): void
			persistenceKey?: string
		}) => {
			useEffect(() => {
				publicationMocks.tldrawMounts += 1
				onMount?.({
					getInstanceState: () => ({ isReadonly: publicationMocks.editorReadonly }),
					updateInstanceState: ({ isReadonly }: { isReadonly: boolean }) => {
						publicationMocks.editorReadonly = isReadonly
					},
				})
				return () => {
					publicationMocks.tldrawUnmounts += 1
				}
			}, [onMount])
			return <div data-persistence-key={persistenceKey}>Mock editor</div>
		},
	}
})

import { ReviewApiClientError, type ReviewApiClient } from './reviewApiClient'
import {
	ReviewImageCanvas,
	reviewPublicationAccessForReviewerKind,
	type ReviewAnnotationEditorProps,
} from './ReviewImageCanvas'
import {
	createCompletedReviewPublication,
	createIdleReviewPublication,
	createStoredReviewPublication,
	type ReviewPublicationStore,
} from './reviewPublicationStore'

const publicationId = '11111111-1111-4111-8111-111111111111'
const publicationStorageKey = 'document-301:publication:playlist-201:version-301'
const prepared = {
	fingerprint: 'c'.repeat(64),
	generation: 0,
	publicationId,
	request: {
		attachment: {
			contentBase64: 'cG5n',
			contentType: 'image/png' as const,
			fileName: 'shot_010_v001.annotated.png',
			sha256: 'b'.repeat(64),
		},
		content: 'Please address marker 1.',
		recipientIds: [7],
		subject: 'Review: shot_010_v001',
	},
}
const media: ReviewImageMedia = {
	contentType: 'image/png',
	height: 1080,
	kind: 'image',
	thumbnailUrl: '/mock-media/source.png',
	url: '/mock-media/source.png',
	width: 1920,
}
const noteOptions: ReviewNoteOptions = {
	links: {
		entity: { id: 401, name: 'shot_010', type: 'Shot' },
		project: { id: 101, name: 'Northstar', type: 'Project' },
		task: { id: 501, name: 'Compositing' },
		version: { id: 301, name: 'shot_010_v001', type: 'Version' },
	},
	recipients: [{ avatarUrl: null, id: 7, kind: 'human', login: 'lead', name: 'Review lead' }],
}
const publicationResult: ReviewPublicationResult = {
	attachment: {
		contentType: 'image/png',
		fileName: prepared.request.attachment.fileName,
		id: 901,
		noteId: 801,
		sizeBytes: 3,
	},
	links: noteOptions.links,
	note: {
		content: prepared.request.content,
		createdAt: '2026-07-21T00:00:00Z',
		createdBy: noteOptions.recipients[0],
		frame: null,
		id: 801,
		projectId: 101,
		subject: prepared.request.subject,
		versionId: 301,
	},
	publicationId,
	status: 'complete',
}

let root: Root | undefined

beforeEach(() => {
	vi.clearAllMocks()
	publicationMocks.editorReadonly = false
	publicationMocks.editsApplied = 0
	publicationMocks.tldrawMounts = 0
	publicationMocks.tldrawUnmounts = 0
	publicationMocks.prepare.mockImplementation(async ({ generation }) => ({
		...prepared,
		generation,
	}))
})

afterEach(() => {
	if (root) act(() => root?.unmount())
	root = undefined
})

describe('ReviewImageCanvas publication safety', () => {
	it('never initializes browser publication state for a service actor', async () => {
		const completed = createCompletedReviewPublication({
			documentKey: publicationStorageKey,
			prepared,
			result: publicationResult,
		})
		const store = publicationStore({ get: vi.fn(async () => completed) })
		const api = reviewApi()
		const container = await renderCanvas(
			{
				...baseProps(api, store),
				publicationAccess: reviewPublicationAccessForReviewerKind('service'),
			},
			{ expectPublishing: false }
		)

		expect(container.textContent).toContain('Publishing unavailable')
		expect(container.textContent).toContain('SHOTGRID_SUDO_AS_LOGIN')
		expect(container.textContent).toContain('human reviewer')
		expect(container.textContent).toContain('Mock editor')
		expect(button(container, 'Export PNG').disabled).toBe(false)
		expect(
			[...container.querySelectorAll('button')].some(
				(item) => item.textContent === 'Publish review'
			)
		).toBe(false)
		expect(container.textContent).not.toContain('Note #801')
		expect(store.get).not.toHaveBeenCalled()
		expect(store.addIfAbsent).not.toHaveBeenCalled()
		expect(store.claimForSend).not.toHaveBeenCalled()
		expect(api.getNoteOptions).not.toHaveBeenCalled()
		expect(api.publishReview).not.toHaveBeenCalled()
	})

	it('durably saves once, then reuses the exact id and payload after a retryable failure', async () => {
		const store = publicationStore()
		const api = reviewApi()
		vi.mocked(api.publishReview)
			.mockRejectedValueOnce(
				new ReviewApiClientError({
					code: 'SHOTGRID_TIMEOUT',
					message: 'ShotGrid timed out.',
					requestId: 'request-timeout',
					retryable: true,
					status: 504,
				})
			)
			.mockResolvedValueOnce(publicationResult)
		const container = await renderCanvas(baseProps(api, store))

		openPublication(container)
		enterPublication(container)
		submitPublication(container)
		await settle()

		expect(store.addIfAbsent).toHaveBeenCalledOnce()
		expect(api.publishReview).toHaveBeenCalledOnce()
		expect(container.textContent).toContain('Request request-timeout')
		expect(container.textContent).toContain('reuse the same publication and PNG')
		expect(publicationMocks.tldrawMounts).toBe(1)
		expect(publicationMocks.tldrawUnmounts).toBe(0)

		submitPublication(container)
		await settle()

		expect(publicationMocks.renderPng).toHaveBeenCalledOnce()
		expect(publicationMocks.prepare).toHaveBeenCalledOnce()
		expect(api.publishReview).toHaveBeenCalledTimes(2)
		expect(vi.mocked(api.publishReview).mock.calls[0][2]).toBe(publicationId)
		expect(vi.mocked(api.publishReview).mock.calls[1][2]).toBe(publicationId)
		expect(vi.mocked(api.publishReview).mock.calls[0][3]).toBe(
			vi.mocked(api.publishReview).mock.calls[1][3]
		)
		expect(store.markCompleted).toHaveBeenCalledWith(
			publicationStorageKey,
			publicationId,
			0,
			expect.any(String),
			publicationResult
		)
		expect(container.textContent).toContain('Note #801')
		expect(container.textContent).toContain('Attachment #901')
		expect(container.textContent).toContain('Mock editor')
		expect(publicationMocks.tldrawMounts).toBe(1)
		expect(publicationMocks.tldrawUnmounts).toBe(0)
	})

	it('coalesces duplicate submits while the PUT is in flight', async () => {
		const store = publicationStore()
		const api = reviewApi()
		const result = deferred<ReviewPublicationResult>()
		vi.mocked(api.publishReview).mockReturnValue(result.promise)
		const container = await renderCanvas(baseProps(api, store))

		openPublication(container)
		enterPublication(container)
		submitPublication(container)
		submitPublication(container)
		await settle()

		expect(store.addIfAbsent).toHaveBeenCalledOnce()
		expect(api.publishReview).toHaveBeenCalledOnce()
		await act(async () => result.resolve(publicationResult))
		await settle()
		expect(container.textContent).toContain('Note #801')
	})

	it('restores a pending payload and publishes without rerendering the PNG', async () => {
		const store = publicationStore({
			get: vi.fn(async () =>
				createStoredReviewPublication({
					documentKey: publicationStorageKey,
					prepared,
					status: 'pending',
				})
			),
		})
		const api = reviewApi()
		vi.mocked(api.publishReview).mockResolvedValue(publicationResult)
		const container = await renderCanvas(baseProps(api, store))

		openPublication(container)
		expect(container.textContent).toContain('saved publication is ready to resume')
		submitPublication(container)
		await settle()

		expect(publicationMocks.renderPng).not.toHaveBeenCalled()
		expect(publicationMocks.prepare).not.toHaveBeenCalled()
		expect(api.publishReview).toHaveBeenCalledWith(201, 301, publicationId, prepared.request)
		expect(store.markCompleted).toHaveBeenCalled()
	})

	it('does not call the mutation endpoint when durable storage fails', async () => {
		const store = publicationStore({
			addIfAbsent: vi.fn(async () => {
				throw new Error('Publication storage is full.')
			}),
		})
		const api = reviewApi()
		const container = await renderCanvas(baseProps(api, store))

		openPublication(container)
		enterPublication(container)
		submitPublication(container)
		await settle()

		expect(store.addIfAbsent).toHaveBeenCalledOnce()
		expect(api.publishReview).not.toHaveBeenCalled()
		expect(container.textContent).toContain('nothing was sent')
	})

	it('persists and locks an indeterminate outcome with its publication and request ids', async () => {
		const store = publicationStore()
		const api = reviewApi()
		const uncertainty = {
			attachmentId: 901,
			links: noteOptions.links,
			noteId: 801,
			publicationId,
			stage: 'attachment-completion' as const,
		}
		vi.mocked(api.publishReview).mockRejectedValue(
			new ReviewApiClientError({
				code: 'PUBLICATION_INDETERMINATE',
				message: 'The publication outcome is indeterminate.',
				publication: uncertainty,
				requestId: 'request-indeterminate',
				retryable: false,
				status: 502,
			})
		)
		const container = await renderCanvas(baseProps(api, store))

		openPublication(container)
		enterPublication(container)
		submitPublication(container)
		await settle()

		expect(store.addIfAbsent).toHaveBeenCalledOnce()
		expect(store.markIndeterminate).toHaveBeenCalledWith(
			publicationStorageKey,
			publicationId,
			0,
			expect.any(String),
			'request-indeterminate',
			uncertainty
		)
		expect(container.textContent).toContain(publicationId)
		expect(container.textContent).toContain('Request request-indeterminate')
		expect(container.textContent).toContain('Known Note #801')
		expect(container.textContent).toContain('Known Attachment #901')
		expect(container.textContent).toContain('Attachment completion')
		expect(button(container, 'Publish Note and PNG').disabled).toBe(true)
	})

	it('keeps an incomplete Note under the same id for retry', async () => {
		const store = publicationStore()
		const api = reviewApi()
		vi.mocked(api.publishReview).mockRejectedValue(
			new ReviewApiClientError({
				code: 'PUBLICATION_INCOMPLETE',
				message: 'The Note exists but its attachment is incomplete.',
				requestId: 'request-incomplete',
				retryable: false,
				status: 502,
			})
		)
		const container = await renderCanvas(baseProps(api, store))

		openPublication(container)
		enterPublication(container)
		submitPublication(container)
		await settle()

		expect(store.finishSafeFailure).not.toHaveBeenCalled()
		expect(container.textContent).toContain('Request request-incomplete')
		expect(container.textContent).toContain('reuse the same publication and PNG')
		expect(button(container, 'Retry publish')).toBeTruthy()
		expect(container.textContent).not.toContain('Edit draft')
	})

	it('keeps the durable payload when a PUT response is invalid', async () => {
		const store = publicationStore()
		const api = reviewApi()
		vi.mocked(api.publishReview).mockRejectedValue(
			new ReviewApiClientError({
				code: 'INVALID_RESPONSE',
				message: 'The review API returned an invalid response.',
				requestId: 'request-invalid-response',
				retryable: false,
				status: 200,
			})
		)
		const container = await renderCanvas(baseProps(api, store))

		openPublication(container)
		enterPublication(container)
		submitPublication(container)
		await settle()

		expect(store.finishSafeFailure).not.toHaveBeenCalled()
		expect(container.textContent).toContain('Request request-invalid-response')
		expect(container.textContent).toContain('Retry publish')
	})

	it('uses an existing payload when another tab wins the atomic create race', async () => {
		const existingPrepared = {
			...prepared,
			publicationId: '22222222-2222-4222-8222-222222222222',
			request: { ...prepared.request, content: 'Existing durable review.' },
		}
		const existingRecord = createStoredReviewPublication({
			documentKey: publicationStorageKey,
			prepared: existingPrepared,
			status: 'pending',
		})
		const store = publicationStore({
			addIfAbsent: vi.fn(async () => ({ created: false, record: existingRecord })),
		})
		const api = reviewApi()
		vi.mocked(api.publishReview).mockResolvedValue({
			...publicationResult,
			publicationId: existingPrepared.publicationId,
		})
		const container = await renderCanvas(baseProps(api, store))

		openPublication(container)
		enterPublication(container)
		submitPublication(container)
		await settle()
		expect(api.publishReview).not.toHaveBeenCalled()
		expect(container.textContent).toContain('Another tab saved publication')
		expect(container.textContent).toContain(existingPrepared.publicationId)

		submitPublication(container)
		await settle()

		expect(api.publishReview).toHaveBeenCalledWith(
			201,
			301,
			existingPrepared.publicationId,
			existingPrepared.request
		)
		expect(api.publishReview).not.toHaveBeenCalledWith(201, 301, publicationId, prepared.request)
	})

	it('blocks when an indeterminate compare-and-set loses ownership', async () => {
		const store = publicationStore({
			markIndeterminate: vi.fn(async () => {
				throw new Error('Another publication now owns this review key.')
			}),
		})
		const api = reviewApi()
		vi.mocked(api.publishReview).mockRejectedValue(
			new ReviewApiClientError({
				code: 'PUBLICATION_INDETERMINATE',
				message: 'The publication outcome is indeterminate.',
				requestId: 'request-cas',
				retryable: false,
				status: 502,
			})
		)
		const container = await renderCanvas(baseProps(api, store))

		openPublication(container)
		enterPublication(container)
		submitPublication(container)
		await settle()

		expect(container.textContent).toContain('indeterminate state could not be saved')
		expect(container.textContent).toContain(publicationId)
		expect(container.textContent).not.toContain('Retry publish')
	})

	it('freezes editing through render, hash, and durable save, then restores it before PUT settles', async () => {
		const capturedPng = deferred<Blob>()
		publicationMocks.renderPng.mockReturnValueOnce(capturedPng.promise)
		const result = deferred<ReviewPublicationResult>()
		const store = publicationStore()
		const api = reviewApi()
		vi.mocked(api.publishReview).mockReturnValue(result.promise)
		const container = await renderCanvas(baseProps(api, store))

		openPublication(container)
		enterPublication(container)
		submitPublication(container)
		expect(publicationMocks.editorReadonly).toBe(true)
		attemptEditorEdit()
		expect(publicationMocks.editsApplied).toBe(0)

		await act(async () => capturedPng.resolve(new Blob(['png'], { type: 'image/png' })))
		await settle()
		expect(api.publishReview).toHaveBeenCalledOnce()
		expect(publicationMocks.editorReadonly).toBe(false)
		attemptEditorEdit()
		expect(publicationMocks.editsApplied).toBe(1)

		await act(async () => result.resolve(publicationResult))
		await settle()
	})

	it('rejects a slow rendered candidate when another tab already advanced the generation', async () => {
		const capturedPng = deferred<Blob>()
		publicationMocks.renderPng.mockReturnValueOnce(capturedPng.promise)
		const store = publicationStore({
			addIfAbsent: vi.fn(async () => ({
				created: false,
				record: createIdleReviewPublication({
					documentKey: publicationStorageKey,
					generation: 1,
				}),
			})),
		})
		const api = reviewApi()
		const container = await renderCanvas(baseProps(api, store))

		openPublication(container)
		enterPublication(container)
		submitPublication(container)
		await act(async () => capturedPng.resolve(new Blob(['png'], { type: 'image/png' })))
		await settle()

		expect(api.publishReview).not.toHaveBeenCalled()
		expect(container.textContent).toContain('newer publication attempt')
		expect(publicationMocks.editorReadonly).toBe(false)
	})

	it('settles a deferred PUT only against its original Playlist context', async () => {
		const result = deferred<ReviewPublicationResult>()
		const store = publicationStore()
		const api = reviewApi()
		vi.mocked(api.publishReview).mockReturnValue(result.promise)
		const initialProps = baseProps(api, store)
		const container = await renderCanvas(initialProps)

		openPublication(container)
		enterPublication(container)
		submitPublication(container)
		await settle()
		expect(api.publishReview).toHaveBeenCalledOnce()

		const nextDocumentKey = 'document-301-playlist-202'
		await act(async () =>
			root?.render(
				<ReviewImageCanvas {...initialProps} documentKey={nextDocumentKey} playlistId={202} />
			)
		)
		await settle()
		expect(container.textContent).toContain('Mock editor')

		await act(async () => result.resolve(publicationResult))
		await settle()
		expect(store.markCompleted).toHaveBeenCalledWith(
			publicationStorageKey,
			publicationId,
			0,
			expect.any(String),
			publicationResult
		)
		expect(store.markCompleted).not.toHaveBeenCalledWith(
			expect.stringContaining(nextDocumentKey),
			expect.anything(),
			expect.anything(),
			expect.anything(),
			expect.anything()
		)
		expect(container.textContent).not.toContain('Note #801')
		expect(publicationMocks.tldrawMounts).toBe(2)
		expect(publicationMocks.tldrawUnmounts).toBe(1)
	})

	it('does not process a deferred sender claim after the Playlist and Version context changes', async () => {
		const claimGate = deferred<void>()
		let exposeClaimedRecord = false
		let claimedRecord: ReturnType<typeof createStoredReviewPublication> | null = null
		const store = publicationStore({
			claimForSend: vi.fn(async (key, id, generation, claimId) => {
				await claimGate.promise
				claimedRecord = createStoredReviewPublication({
					claim: { claimedAt: new Date().toISOString(), id: claimId },
					documentKey: key,
					prepared: { ...prepared, generation, publicationId: id },
					status: 'pending',
				})
				return { record: claimedRecord, status: 'claimed' as const }
			}),
			get: vi.fn(async (key) =>
				exposeClaimedRecord && key === publicationStorageKey ? claimedRecord : null
			),
		})
		const api = reviewApi()
		vi.mocked(api.publishReview).mockResolvedValue(publicationResult)
		const initialProps = baseProps(api, store)
		const container = await renderCanvas(initialProps)

		openPublication(container)
		enterPublication(container)
		submitPublication(container)
		await settle()
		expect(store.claimForSend).toHaveBeenCalledOnce()
		expect(api.publishReview).not.toHaveBeenCalled()

		await act(async () =>
			root?.render(
				<ReviewImageCanvas
					{...initialProps}
					documentKey="document-302-playlist-202"
					playlistId={202}
					versionId={302}
					versionName="shot_020_v001"
				/>
			)
		)
		await settle()
		exposeClaimedRecord = true
		await act(async () => claimGate.resolve())
		await settle()

		expect(api.publishReview).not.toHaveBeenCalled()
		expect(store.markCompleted).not.toHaveBeenCalled()
		openPublication(container)
		expect(container.textContent).not.toContain(publicationId)

		await act(async () => root?.render(<ReviewImageCanvas {...initialProps} />))
		await settle()
		openPublication(container)
		expect(container.textContent).toContain('saved publication is ready to resume')
		expect(container.textContent).toContain(publicationId)
		expect(button(container, 'Retry publish')).toBeTruthy()
		expect(api.publishReview).not.toHaveBeenCalled()
	})

	it('restores a completed tombstone with its result and never resends it', async () => {
		const completed = createCompletedReviewPublication({
			documentKey: publicationStorageKey,
			prepared,
			result: publicationResult,
		})
		const store = publicationStore({ get: vi.fn(async () => completed) })
		const api = reviewApi()
		const container = await renderCanvas(baseProps(api, store))

		openPublication(container)
		expect(container.textContent).toContain('Note #801')
		expect(container.textContent).toContain(`Publication ${publicationId}`)
		expect(api.publishReview).not.toHaveBeenCalled()
	})

	it('restores an indeterminate attachment stage with its known Note id', async () => {
		const uncertainty = {
			attachmentId: 901,
			links: noteOptions.links,
			noteId: 801,
			publicationId,
			stage: 'attachment-completion' as const,
		}
		const stored = createStoredReviewPublication({
			documentKey: publicationStorageKey,
			prepared,
			requestId: 'request-restored',
			status: 'indeterminate',
			uncertainty,
		})
		const store = publicationStore({ get: vi.fn(async () => stored) })
		const api = reviewApi()
		const container = await renderCanvas(baseProps(api, store))

		openPublication(container)
		expect(container.textContent).toContain('Request request-restored')
		expect(container.textContent).toContain(`Publication ${publicationId}`)
		expect(container.textContent).toContain('Known Note #801')
		expect(container.textContent).toContain('Known Attachment #901')
		expect(container.textContent).toContain('check whether Attachment completion finished')
		expect(api.publishReview).not.toHaveBeenCalled()
	})

	it('retries a recovered frozen payload when Note options fail', async () => {
		const store = publicationStore({
			get: vi.fn(async () =>
				createStoredReviewPublication({
					documentKey: publicationStorageKey,
					prepared,
					status: 'pending',
				})
			),
		})
		const api = reviewApi()
		vi.mocked(api.getNoteOptions).mockRejectedValue(new Error('Options unavailable.'))
		vi.mocked(api.publishReview).mockResolvedValue(publicationResult)
		const container = await renderCanvas(baseProps(api, store))

		openPublication(container)
		expect(container.textContent).toContain('Options unavailable')
		expect(button(container, 'Retry publish').disabled).toBe(false)
		submitPublication(container)
		await settle()

		expect(publicationMocks.renderPng).not.toHaveBeenCalled()
		expect(api.publishReview).toHaveBeenCalledWith(201, 301, publicationId, prepared.request)
		expect(container.textContent).toContain('Note #801')
	})

	it('prunes invalid recipients after the claim owner receives a safe rejection', async () => {
		const store = publicationStore()
		const api = reviewApi()
		const currentOptions = { ...noteOptions, recipients: [...noteOptions.recipients] }
		vi.mocked(api.getNoteOptions).mockResolvedValue(currentOptions)
		const response = deferred<ReviewPublicationResult>()
		vi.mocked(api.publishReview).mockReturnValue(response.promise)
		const container = await renderCanvas(baseProps(api, store))

		openPublication(container)
		enterPublication(container)
		expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked).toBe(true)
		submitPublication(container)
		currentOptions.recipients = []
		await act(async () =>
			response.reject(
				new ReviewApiClientError({
					code: 'INVALID_REQUEST',
					message: 'The selected recipient is no longer valid.',
					retryable: false,
					status: 400,
				})
			)
		)
		await settle()

		expect(store.finishSafeFailure).toHaveBeenCalled()
		expect(container.querySelector<HTMLInputElement>('input[type="checkbox"]')).toBeNull()
	})

	it('starts a second generation only through the explicit success action', async () => {
		const secondId = '22222222-2222-4222-8222-222222222222'
		const secondPrepared = {
			...prepared,
			fingerprint: 'd'.repeat(64),
			generation: 1,
			publicationId: secondId,
		}
		publicationMocks.prepare.mockResolvedValueOnce(prepared).mockResolvedValueOnce(secondPrepared)
		const secondResult: ReviewPublicationResult = {
			...publicationResult,
			attachment: { ...publicationResult.attachment, noteId: 802 },
			note: { ...publicationResult.note, id: 802 },
			publicationId: secondId,
		}
		const store = publicationStore()
		const api = reviewApi()
		vi.mocked(api.publishReview)
			.mockResolvedValueOnce(publicationResult)
			.mockResolvedValueOnce(secondResult)
		const container = await renderCanvas(baseProps(api, store))

		openPublication(container)
		enterPublication(container)
		submitPublication(container)
		await settle()
		click(button(container, 'Start another publication'))
		await settle()
		submitPublication(container)
		await settle()

		expect(store.startNextAttempt).toHaveBeenCalledWith(publicationStorageKey, 0)
		expect(api.publishReview).toHaveBeenNthCalledWith(1, 201, 301, publicationId, prepared.request)
		expect(api.publishReview).toHaveBeenNthCalledWith(2, 201, 301, secondId, secondPrepared.request)
		expect(container.textContent).toContain('Note #802')
	})
})

function baseProps(
	api: ReviewApiClient,
	store: ReviewPublicationStore
): ReviewAnnotationEditorProps {
	return {
		api,
		documentKey: 'document-301',
		media,
		persistenceKey: 'persistence-301',
		playlistId: 201,
		projectId: 101,
		publicationAccess: { status: 'enabled' },
		publicationStore: store,
		reviewScope: 'local-dev:mock:mock',
		versionId: 301,
		versionName: 'shot_010_v001',
	}
}

function reviewApi() {
	return {
		getNoteOptions: vi.fn(async () => noteOptions),
		publishReview: vi.fn(),
	} as unknown as ReviewApiClient
}

function publicationStore(
	overrides: Partial<ReviewPublicationStore> = {}
): ReviewPublicationStore & {
	addIfAbsent: ReturnType<typeof vi.fn>
	claimForSend: ReturnType<typeof vi.fn>
	finishSafeFailure: ReturnType<typeof vi.fn>
	get: ReturnType<typeof vi.fn>
	markCompleted: ReturnType<typeof vi.fn>
	markIndeterminate: ReturnType<typeof vi.fn>
	startNextAttempt: ReturnType<typeof vi.fn>
} {
	return {
		addIfAbsent: vi.fn(async (record) => ({ created: true, record })),
		claimForSend: vi.fn(async (key, id, generation, claimId) => ({
			record: createStoredReviewPublication({
				claim: { claimedAt: new Date().toISOString(), id: claimId },
				documentKey: key,
				prepared: { ...prepared, generation, publicationId: id },
				status: 'pending',
			}),
			status: 'claimed',
		})),
		finishSafeFailure: vi.fn(async (key, _id, generation) => ({
			record: createIdleReviewPublication({ documentKey: key, generation: generation + 1 }),
			status: 'advanced',
		})),
		get: vi.fn(async () => null),
		markCompleted: vi.fn(async (key, id, generation, _claimId, result) =>
			createCompletedReviewPublication({
				documentKey: key,
				prepared: { ...prepared, generation, publicationId: id },
				result,
			})
		),
		markIndeterminate: vi.fn(async (key, id, generation, _claimId, requestId, uncertainty) =>
			createStoredReviewPublication({
				documentKey: key,
				prepared: { ...prepared, generation, publicationId: id },
				requestId,
				status: 'indeterminate',
				uncertainty,
			})
		),
		startNextAttempt: vi.fn(async (key, generation) =>
			createIdleReviewPublication({ documentKey: key, generation: generation + 1 })
		),
		...overrides,
	} as never
}

async function renderCanvas(
	props: ReviewAnnotationEditorProps,
	options: { expectPublishing?: boolean } = {}
) {
	const container = document.createElement('div')
	root = createRoot(container)
	await act(async () => root?.render(<ReviewImageCanvas {...props} />))
	await settle()
	if (options.expectPublishing !== false && button(container, 'Publish review').disabled) {
		throw new Error('The publication controls did not become ready')
	}
	return container
}

function openPublication(container: HTMLElement) {
	click(button(container, 'Publish review'))
}

function enterPublication(container: HTMLElement) {
	const content = container.querySelector<HTMLTextAreaElement>('textarea')!
	changeValue(content, prepared.request.content)
	const recipient = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!
	click(recipient)
	if (button(container, 'Publish Note and PNG').disabled) {
		throw new Error(`Publication submit stayed disabled: ${container.textContent}`)
	}
}

function submitPublication(container: HTMLElement) {
	const form = container.querySelector<HTMLFormElement>('form')
	if (!form) throw new Error('Publication form not found')
	act(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
}

function button(container: HTMLElement, text: string) {
	const match = [...container.querySelectorAll('button')].find(
		(candidate) => candidate.textContent === text
	)
	if (!(match instanceof HTMLButtonElement)) throw new Error(`Button not found: ${text}`)
	return match
}

function click(element: HTMLElement) {
	act(() => element.click())
}

function changeValue(element: HTMLTextAreaElement, value: string) {
	const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
	act(() => {
		setter?.call(element, value)
		element.dispatchEvent(new Event('input', { bubbles: true }))
	})
}

function attemptEditorEdit() {
	if (!publicationMocks.editorReadonly) publicationMocks.editsApplied += 1
}

async function flush() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0))
	})
}

async function settle() {
	for (let index = 0; index < 5; index++) await flush()
}

function deferred<T>() {
	let resolve!: (value: T) => void
	let reject!: (error: unknown) => void
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = promiseResolve
		reject = promiseReject
	})
	return { promise, reject, resolve }
}
