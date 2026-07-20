// @vitest-environment jsdom

import type { ReviewImageMedia, ReviewNoteOptions } from '@tldraw/shotgrid-review-contracts'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const imageMocks = vi.hoisted(() => ({
	decode: vi.fn(async () => ({ height: 1080, width: 1920 })),
	digest: vi.fn(async (blob: Blob) => (await blob.text()).padEnd(64, 'a').slice(0, 64)),
	fetch: vi.fn(),
	renderedPersistenceKeys: [] as string[],
}))

vi.mock('./reviewImage', () => ({
	decodeReviewImageDimensions: imageMocks.decode,
	digestReviewImage: imageMocks.digest,
	fetchReviewImage: imageMocks.fetch,
	resolveReviewImageDimensions: (_media: ReviewImageMedia, width: number, height: number) => ({
		height,
		width,
	}),
}))

vi.mock('tldraw', async (importOriginal) => {
	const original = await importOriginal<typeof import('tldraw')>()
	return {
		...original,
		Tldraw: ({ persistenceKey }: { persistenceKey?: string }) => {
			imageMocks.renderedPersistenceKeys.push(persistenceKey ?? 'none')
			return <div data-persistence-key={persistenceKey}>Mock editor</div>
		},
	}
})

import type { ReviewApiClient } from './reviewApiClient'
import { ReviewImageCanvas, type ReviewAnnotationEditorProps } from './ReviewImageCanvas'
import type { ReviewPublicationStore } from './reviewPublicationStore'

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
	recipients: [],
}
const api = {
	getNoteOptions: vi.fn(async () => noteOptions),
} as unknown as ReviewApiClient
const publicationStore = {
	addIfAbsent: vi.fn(),
	claimForSend: vi.fn(),
	finishSafeFailure: vi.fn(),
	get: vi.fn(async () => null),
	markCompleted: vi.fn(),
	markIndeterminate: vi.fn(),
	startNextAttempt: vi.fn(),
} satisfies ReviewPublicationStore

let cleanup: (() => void) | undefined

afterEach(() => {
	cleanup?.()
	cleanup = undefined
	imageMocks.fetch.mockReset()
	imageMocks.decode.mockClear()
	imageMocks.digest.mockClear()
	imageMocks.renderedPersistenceKeys.length = 0
	vi.mocked(api.getNoteOptions).mockClear()
	publicationStore.addIfAbsent.mockClear()
	publicationStore.claimForSend.mockClear()
	publicationStore.finishSafeFailure.mockClear()
	publicationStore.get.mockClear()
	publicationStore.markCompleted.mockClear()
	publicationStore.markIndeterminate.mockClear()
	publicationStore.startNextAttempt.mockClear()
})

describe('ReviewImageCanvas media isolation', () => {
	it('keeps the editor mounted while the same document refreshes identical source bytes', async () => {
		imageMocks.fetch.mockResolvedValueOnce(imageBlob('same-source'))
		const refresh = deferred<Blob>()
		imageMocks.fetch.mockReturnValueOnce(refresh.promise)
		const { container, render } = renderCanvas(baseProps())

		await act(async () => render(baseProps()))
		expect(container.textContent).toContain('Mock editor')
		const initialKey = container
			.querySelector('[data-persistence-key]')
			?.getAttribute('data-persistence-key')

		await act(async () => render({ ...baseProps(), media: { ...media } }))
		expect(container.textContent).toContain('Mock editor')
		expect(
			container.querySelector('[data-persistence-key]')?.getAttribute('data-persistence-key')
		).toBe(initialKey)

		await act(async () => refresh.resolve(imageBlob('same-source')))
		expect(
			container.querySelector('[data-persistence-key]')?.getAttribute('data-persistence-key')
		).toBe(initialKey)
	})

	it('never renders the previous source under a new document key', async () => {
		imageMocks.fetch.mockResolvedValueOnce(imageBlob('version-301'))
		const nextImage = deferred<Blob>()
		imageMocks.fetch.mockReturnValueOnce(nextImage.promise)
		const { container, render } = renderCanvas(baseProps())

		await act(async () => render(baseProps()))
		expect(container.textContent).toContain('Mock editor')
		imageMocks.renderedPersistenceKeys.length = 0

		const nextProps = {
			...baseProps(),
			documentKey: 'document-302',
			persistenceKey: 'persistence-302',
			versionId: 302,
			versionName: 'shot_020_v001',
		}
		await act(async () => render(nextProps))

		expect(container.textContent).toContain('Preparing review image')
		expect(container.textContent).not.toContain('Mock editor')
		expect(imageMocks.renderedPersistenceKeys).not.toContain(
			expect.stringContaining('persistence-302:source-version-301')
		)

		await act(async () => nextImage.resolve(imageBlob('version-302')))
		expect(container.textContent).toContain('Mock editor')
		expect(
			container.querySelector('[data-persistence-key]')?.getAttribute('data-persistence-key')
		).toContain('persistence-302:source-version-302')
	})
})

function baseProps(): ReviewAnnotationEditorProps {
	return {
		api,
		documentKey: 'document-301',
		media,
		persistenceKey: 'persistence-301',
		playlistId: 201,
		projectId: 101,
		publicationAccess: { status: 'enabled' },
		publicationStore,
		reviewScope: 'local-dev:mock:mock',
		versionId: 301,
		versionName: 'shot_010_v001',
	}
}

function imageBlob(identity: string) {
	return new Blob([identity], { type: 'image/png' })
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

function renderCanvas(initialProps: ReviewAnnotationEditorProps) {
	const container = document.createElement('div')
	const root = createRoot(container)
	cleanup = () => act(() => root.unmount())
	return {
		container,
		render: (props: ReviewAnnotationEditorProps = initialProps) =>
			root.render(<ReviewImageCanvas {...props} />),
	}
}
