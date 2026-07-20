import type {
	ReviewNoteOptions,
	ReviewPublicationErrorContext,
	ReviewPublicationResult,
} from '@tldraw/shotgrid-review-contracts'
import { useEffect, useState, type FormEvent } from 'react'
import {
	MAX_REVIEW_PUBLICATION_CONTENT_LENGTH,
	MAX_REVIEW_PUBLICATION_RECIPIENTS,
	MAX_REVIEW_PUBLICATION_SUBJECT_LENGTH,
} from './reviewPublication'

export interface ReviewPublicationFormValue {
	content: string
	recipientIds: number[]
	subject: string
}

export type ReviewNoteOptionsState =
	| { status: 'loading' }
	| { message: string; status: 'error' }
	| { options: ReviewNoteOptions; status: 'ready' }

export type ReviewPublicationViewState =
	| { status: 'idle' }
	| { message: string; status: 'blocked' }
	| { label: string; status: 'restoring' }
	| { label: string; status: 'working' }
	| {
			allowedRecipientIds?: number[]
			draft?: ReviewPublicationFormValue
			message: string
			publicationId?: string
			retryReady: boolean
			status: 'error'
	  }
	| {
			draft: ReviewPublicationFormValue
			message: string
			publicationId: string
			status: 'indeterminate'
			uncertainty?: ReviewPublicationErrorContext
	  }
	| { result: ReviewPublicationResult; status: 'success'; warning?: string }

export function ReviewPublicationPanel({
	defaultSubject,
	disabled,
	noteOptions,
	onPublish,
	onRetryOptions,
	onStartAnother,
	publication,
}: {
	defaultSubject: string
	disabled: boolean
	noteOptions: ReviewNoteOptionsState
	onPublish(value: ReviewPublicationFormValue): void
	onRetryOptions(): void
	onStartAnother(): void
	publication: ReviewPublicationViewState
}) {
	const [expanded, setExpanded] = useState(false)
	const [subject, setSubject] = useState(defaultSubject)
	const [content, setContent] = useState('')
	const [recipientIds, setRecipientIds] = useState<number[]>([])
	const retryLocked = publication.status === 'error' && publication.retryReady
	useEffect(() => {
		if (
			(publication.status === 'error' || publication.status === 'indeterminate') &&
			publication.draft
		) {
			setSubject(publication.draft.subject)
			setContent(publication.draft.content)
			setRecipientIds(publication.draft.recipientIds)
		}
	}, [publication])
	useEffect(() => {
		if (
			publication.status === 'error' &&
			!publication.retryReady &&
			publication.allowedRecipientIds
		) {
			const allowed = new Set(publication.allowedRecipientIds)
			setRecipientIds((current) => current.filter((id) => allowed.has(id)))
		}
	}, [publication])
	const inputsDisabled =
		disabled ||
		publication.status === 'blocked' ||
		publication.status === 'restoring' ||
		publication.status === 'working' ||
		publication.status === 'indeterminate' ||
		publication.status === 'success' ||
		retryLocked
	const submitDisabled =
		disabled ||
		(!retryLocked && noteOptions.status !== 'ready') ||
		publication.status === 'blocked' ||
		publication.status === 'restoring' ||
		publication.status === 'working' ||
		publication.status === 'indeterminate' ||
		publication.status === 'success' ||
		(!retryLocked && (subject.trim().length === 0 || content.trim().length === 0))

	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault()
		if (submitDisabled) return
		onPublish({ content, recipientIds, subject })
	}

	return (
		<div className="review-publication">
			<button
				aria-expanded={expanded}
				disabled={disabled && !expanded}
				onClick={() => setExpanded((value) => !value)}
				type="button"
			>
				{expanded ? 'Close publishing' : 'Publish review'}
			</button>
			{expanded ? (
				<form className="review-publication__form" onSubmit={submit}>
					<div className="review-publication__heading">
						<strong>Publish to ShotGrid</strong>
						<span>The flattened PNG will be attached to a new Note.</span>
					</div>

					{noteOptions.status === 'loading' ? (
						<p aria-live="polite">Loading Note options…</p>
					) : noteOptions.status === 'error' ? (
						<div className="review-publication__notice" role="alert">
							<span>{noteOptions.message}</span>
							<button disabled={disabled} onClick={onRetryOptions} type="button">
								Retry options
							</button>
						</div>
					) : (
						<>
							<PublicationLinks options={noteOptions.options} />
							<label>
								<span>Subject</span>
								<input
									disabled={inputsDisabled}
									maxLength={MAX_REVIEW_PUBLICATION_SUBJECT_LENGTH}
									onChange={(event) => setSubject(event.currentTarget.value)}
									required
									value={subject}
								/>
							</label>
							<label>
								<span>Note</span>
								<textarea
									disabled={inputsDisabled}
									maxLength={MAX_REVIEW_PUBLICATION_CONTENT_LENGTH}
									onChange={(event) => setContent(event.currentTarget.value)}
									required
									rows={4}
									value={content}
								/>
							</label>
							<RecipientOptions
								disabled={inputsDisabled}
								onChange={setRecipientIds}
								options={noteOptions.options}
								selected={recipientIds}
							/>
						</>
					)}

					{publication.status === 'restoring' || publication.status === 'working' ? (
						<p aria-live="polite">{publication.label}…</p>
					) : publication.status === 'blocked' ? (
						<div
							className="review-publication__notice review-publication__notice--error"
							role="alert"
						>
							<span>{publication.message}</span>
						</div>
					) : publication.status === 'error' ? (
						<div
							className="review-publication__notice review-publication__notice--error"
							role="alert"
						>
							<span>{publication.message}</span>
						</div>
					) : publication.status === 'indeterminate' ? (
						<div
							className="review-publication__notice review-publication__notice--error"
							role="alert"
						>
							<span>{publication.message}</span>
							<code>Publication {publication.publicationId}</code>
							{publication.uncertainty ? (
								<PublicationUncertainty context={publication.uncertainty} />
							) : null}
						</div>
					) : publication.status === 'success' ? (
						<PublicationSuccess
							onStartAnother={onStartAnother}
							result={publication.result}
							warning={publication.warning}
						/>
					) : null}

					{noteOptions.status === 'ready' || retryLocked ? (
						<button className="review-publication__submit" disabled={submitDisabled} type="submit">
							{retryLocked ? 'Retry publish' : 'Publish Note and PNG'}
						</button>
					) : null}
				</form>
			) : null}
		</div>
	)
}

function PublicationUncertainty({ context }: { context: ReviewPublicationErrorContext }) {
	if (context.stage === 'attachment-completion') {
		return (
			<>
				<strong>Stage: Attachment completion</strong>
				<span>Known Note #{context.noteId}</span>
				{context.attachmentId ? <span>Known Attachment #{context.attachmentId}</span> : null}
				<span>
					Check this Note and its Attachment in ShotGrid for Version {context.links.version.name} ·
					#{context.links.version.id}.
				</span>
			</>
		)
	}
	if (context.stage === 'note-created') {
		return (
			<>
				<strong>Stage: Note created</strong>
				<span>Known Note #{context.noteId}</span>
				<span>
					Check this Note in ShotGrid before deciding whether its Attachment still needs attention.
				</span>
			</>
		)
	}
	return (
		<>
			<strong>Stage: Note creation</strong>
			<span>No Note ID is known. Check ShotGrid before taking any further action.</span>
		</>
	)
}

function PublicationLinks({ options }: { options: ReviewNoteOptions }) {
	const { links } = options
	return (
		<dl aria-label="ShotGrid links" className="review-publication__links">
			<PublicationLink label="Project" link={links.project} />
			<PublicationLink label="Version" link={links.version} />
			<PublicationLink label="Entity" link={links.entity} />
			<PublicationLink label="Task" link={links.task} />
		</dl>
	)
}

function PublicationLink({
	label,
	link,
}: {
	label: string
	link: { id: number; name: string; type?: string } | null
}) {
	return (
		<div>
			<dt>{label}</dt>
			<dd>{link ? `${link.name} · #${link.id}` : 'Not linked'}</dd>
		</div>
	)
}

function RecipientOptions({
	disabled,
	onChange,
	options,
	selected,
}: {
	disabled: boolean
	onChange(ids: number[]): void
	options: ReviewNoteOptions
	selected: number[]
}) {
	const recipients = options.recipients.filter(
		(recipient): recipient is typeof recipient & { id: number } =>
			recipient.kind === 'human' && recipient.id !== null
	)
	return (
		<fieldset className="review-publication__recipients" disabled={disabled}>
			<legend>Recipients</legend>
			{recipients.length === 0 ? <span>No HumanUser recipients are available.</span> : null}
			{recipients.map((recipient) => (
				<label key={recipient.id}>
					<input
						checked={selected.includes(recipient.id)}
						disabled={
							disabled ||
							(!selected.includes(recipient.id) &&
								selected.length >= MAX_REVIEW_PUBLICATION_RECIPIENTS)
						}
						onChange={(event) =>
							onChange(
								event.currentTarget.checked
									? [...selected, recipient.id]
									: selected.filter((id) => id !== recipient.id)
							)
						}
						type="checkbox"
					/>
					<span>{recipient.name}</span>
				</label>
			))}
		</fieldset>
	)
}

function PublicationSuccess({
	onStartAnother,
	result,
	warning,
}: {
	onStartAnother(): void
	result: ReviewPublicationResult
	warning?: string
}) {
	return (
		<div className="review-publication__success" role="status">
			<strong>Published to ShotGrid</strong>
			<code>Publication {result.publicationId}</code>
			<span>Note #{result.note.id}</span>
			<span>
				{result.attachment.id === null
					? 'Attachment uploaded'
					: `Attachment #${result.attachment.id}`}
			</span>
			<button onClick={onStartAnother} type="button">
				Start another publication
			</button>
			{warning ? <span className="review-publication__cleanup-warning">{warning}</span> : null}
		</div>
	)
}
