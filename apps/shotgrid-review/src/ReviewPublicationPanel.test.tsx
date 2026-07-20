// @vitest-environment jsdom

import type { ReviewNoteOptions, ReviewPublicationResult } from '@tldraw/shotgrid-review-contracts'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReviewPublicationPanel, type ReviewPublicationViewState } from './ReviewPublicationPanel'

const noteOptions: ReviewNoteOptions = {
	links: {
		entity: { id: 401, name: 'shot_010', type: 'Shot' },
		project: { id: 101, name: 'Northstar', type: 'Project' },
		task: { id: 501, name: 'Compositing' },
		version: { id: 301, name: 'shot_010_comp_v001', type: 'Version' },
	},
	recipients: [
		{ avatarUrl: null, id: 7, kind: 'human', login: 'lead', name: 'Review lead' },
		{ avatarUrl: null, id: null, kind: 'service', login: null, name: 'Review service' },
	],
}

const publicationResult: ReviewPublicationResult = {
	attachment: {
		contentType: 'image/png',
		fileName: 'shot_010.annotated.png',
		id: 901,
		noteId: 801,
		sizeBytes: 1024,
	},
	links: noteOptions.links,
	note: {
		content: 'Please address marker 1.',
		createdAt: '2026-07-21T00:00:00Z',
		createdBy: noteOptions.recipients[0],
		frame: null,
		id: 801,
		projectId: 101,
		subject: 'Review: shot_010_comp_v001',
		versionId: 301,
	},
	publicationId: '11111111-1111-4111-8111-111111111111',
	status: 'complete',
}

let root: Root | undefined

afterEach(() => {
	if (root) act(() => root?.unmount())
	root = undefined
})

describe('ReviewPublicationPanel', () => {
	it('keeps a failed publication draft locked and retries the same form values', () => {
		const onPublish = vi.fn()
		const view = renderPanel({ onPublish })

		click(button(view.container, 'Publish review'))
		expect(view.container.textContent).toContain('shot_010_comp_v001 · #301')
		expect(view.container.textContent).toContain('Compositing · #501')
		expect(view.container.textContent).not.toContain('Review service')

		const subject = view.container.querySelector<HTMLInputElement>('input:not([type="checkbox"])')!
		const content = view.container.querySelector<HTMLTextAreaElement>('textarea')!
		const recipient = view.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!
		changeValue(content, 'Please address marker 1.')
		click(recipient)
		submit(view.container.querySelector('form')!)

		const expectedDraft = {
			content: 'Please address marker 1.',
			recipientIds: [7],
			subject: 'Review: shot_010_comp_v001',
		}
		expect(onPublish).toHaveBeenLastCalledWith(expectedDraft)

		view.render({
			message: 'The gateway timed out. Retrying will reuse the same publication and PNG.',
			retryReady: true,
			status: 'error',
		})
		expect(subject.disabled).toBe(true)
		expect(content.value).toBe(expectedDraft.content)
		submit(view.container.querySelector('form')!)
		expect(onPublish).toHaveBeenCalledTimes(2)
		expect(onPublish).toHaveBeenLastCalledWith(expectedDraft)

		expect(view.container.textContent).not.toContain('Edit draft')
	})

	it('shows successful ShotGrid identifiers without clearing the entered Note', () => {
		const onStartAnother = vi.fn()
		const view = renderPanel({ onStartAnother })
		click(button(view.container, 'Publish review'))
		const content = view.container.querySelector<HTMLTextAreaElement>('textarea')!
		changeValue(content, 'Keep this draft visible.')

		view.render({ result: publicationResult, status: 'success' })

		expect(content.value).toBe('Keep this draft visible.')
		expect(view.container.textContent).toContain('Note #801')
		expect(view.container.textContent).toContain('Attachment #901')
		expect(view.container.textContent).toContain(`Publication ${publicationResult.publicationId}`)
		expect(button(view.container, 'Publish Note and PNG').disabled).toBe(true)
		click(button(view.container, 'Start another publication'))
		expect(onStartAnother).toHaveBeenCalledOnce()
	})

	it('retries a recovered frozen payload even when Note options fail to load', () => {
		const onPublish = vi.fn()
		const draft = {
			content: 'Recovered content.',
			recipientIds: [7],
			subject: 'Recovered subject',
		}
		const view = renderPanel({
			noteOptions: { message: 'Options are unavailable.', status: 'error' },
			onPublish,
			publication: {
				draft,
				message: 'A saved publication is ready to resume.',
				publicationId: publicationResult.publicationId,
				retryReady: true,
				status: 'error',
			},
		})
		click(button(view.container, 'Publish review'))

		expect(view.container.textContent).toContain('Options are unavailable')
		expect(button(view.container, 'Retry publish').disabled).toBe(false)
		submit(view.container.querySelector('form')!)
		expect(onPublish).toHaveBeenCalledWith(draft)
	})

	it('prunes recipients that are no longer in the current allowlist after a safe rejection', () => {
		const view = renderPanel()
		click(button(view.container, 'Publish review'))
		const recipient = view.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!
		click(recipient)
		expect(recipient.checked).toBe(true)

		view.render({
			allowedRecipientIds: [],
			message: 'The recipients are no longer valid.',
			retryReady: false,
			status: 'error',
		})

		expect(recipient.checked).toBe(false)
	})

	it('blocks an indeterminate publication and exposes Note-option retry errors', () => {
		const onRetryOptions = vi.fn()
		const view = renderPanel({
			noteOptions: { message: 'Options failed. Request request-options.', status: 'error' },
			onRetryOptions,
			publication: {
				draft: {
					content: 'Please address marker 1.',
					recipientIds: [7],
					subject: 'Review: shot_010_comp_v001',
				},
				message: 'Publication outcome is indeterminate. Request request-publish.',
				publicationId: '11111111-1111-4111-8111-111111111111',
				status: 'indeterminate',
				uncertainty: {
					attachmentId: 901,
					links: noteOptions.links,
					noteId: 801,
					publicationId: '11111111-1111-4111-8111-111111111111',
					stage: 'attachment-completion',
				},
			},
		})
		click(button(view.container, 'Publish review'))

		expect(view.container.textContent).toContain('Request request-options')
		expect(view.container.textContent).toContain('Request request-publish')
		expect(view.container.textContent).toContain('Stage: Attachment completion')
		expect(view.container.textContent).toContain('Known Note #801')
		expect(view.container.textContent).toContain('Known Attachment #901')
		expect(view.container.textContent).toContain('Check this Note and its Attachment')
		click(button(view.container, 'Retry options'))
		expect(onRetryOptions).toHaveBeenCalledOnce()
	})

	it('shows a known Note without inventing an Attachment during the note-created stage', () => {
		const view = renderPanel({
			publication: {
				draft: { content: 'Frozen', recipientIds: [], subject: 'Frozen' },
				message: 'The publication outcome is indeterminate.',
				publicationId: publicationResult.publicationId,
				status: 'indeterminate',
				uncertainty: {
					links: noteOptions.links,
					noteId: 801,
					publicationId: publicationResult.publicationId,
					stage: 'note-created',
				},
			},
		})
		click(button(view.container, 'Publish review'))

		expect(view.container.textContent).toContain('Stage: Note created')
		expect(view.container.textContent).toContain('Known Note #801')
		expect(view.container.textContent).not.toContain('Known Attachment')
	})
})

function renderPanel(
	overrides: Partial<{
		noteOptions: Parameters<typeof ReviewPublicationPanel>[0]['noteOptions']
		onPublish: Parameters<typeof ReviewPublicationPanel>[0]['onPublish']
		onRetryOptions(): void
		onStartAnother(): void
		publication: ReviewPublicationViewState
	}> = {}
) {
	const container = document.createElement('div')
	root = createRoot(container)
	const props = {
		defaultSubject: 'Review: shot_010_comp_v001',
		disabled: false,
		noteOptions: { options: noteOptions, status: 'ready' } as const,
		onPublish: vi.fn(),
		onRetryOptions: vi.fn(),
		onStartAnother: vi.fn(),
		publication: { status: 'idle' } as ReviewPublicationViewState,
		...overrides,
	}
	const render = (publication: ReviewPublicationViewState = props.publication) => {
		act(() => root?.render(<ReviewPublicationPanel {...props} publication={publication} />))
	}
	render()
	return { container, render }
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

function submit(form: HTMLFormElement) {
	act(() => form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
}

function changeValue(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
	const prototype =
		element instanceof HTMLTextAreaElement
			? HTMLTextAreaElement.prototype
			: HTMLInputElement.prototype
	const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
	act(() => {
		setter?.call(element, value)
		element.dispatchEvent(new Event('input', { bubbles: true }))
	})
}
