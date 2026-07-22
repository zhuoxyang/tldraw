import type { ReviewMedia, ReviewVersion } from '@tldraw/shotgrid-review-contracts'
import type { ReactNode } from 'react'
import 'tldraw/tldraw.css'
import { reviewConfig } from './config'
import { createReviewApiClient } from './reviewApiClient'
import type { ReviewBrowserLoadResult, ReadyReviewBrowser } from './reviewBrowser'
import { ReviewCollaborationCanvas } from './ReviewCollaborationCanvas'
import { ReviewDecisionPanel, reviewDecisionAccessForReviewerKind } from './ReviewDecisionPanel'
import { ReviewImageCanvas, reviewPublicationAccessForReviewerKind } from './ReviewImageCanvas'
import { ReviewVideoCanvas } from './ReviewVideoCanvas'
import { useReviewBrowser } from './useReviewBrowser'

const reviewApi = createReviewApiClient({ baseUrl: reviewConfig.apiBaseUrl })

function ReviewHeader({
	changeStreamStatus,
	state,
}: {
	changeStreamStatus: ReturnType<typeof useReviewBrowser>['changeStreamStatus']
	state?: ReviewBrowserLoadResult
}) {
	const changeStreamLive = changeStreamStatus === 'live'
	return (
		<header className="review-header">
			<div>
				<p className="review-eyebrow">{state?.project?.name ?? 'Production review'}</p>
				<h1>ShotGrid review</h1>
			</div>
			<div className="review-header__status">
				<span
					className={`change-stream-badge change-stream-badge--${changeStreamLive ? 'live' : 'reconnecting'}`}
					title={
						changeStreamLive
							? 'ShotGrid changes are updating this review automatically.'
							: 'Automatic ShotGrid updates are reconnecting.'
					}
				>
					{changeStreamLive ? 'Live updates' : 'Reconnecting'}
				</span>
				{state ? (
					<span className={`mode-badge mode-badge--${state.health.mode}`}>
						{state.health.mode === 'mock' ? 'Mock API' : 'ShotGrid API'}
					</span>
				) : (
					<span className="mode-badge">Connecting</span>
				)}
				<span className="reviewer">{state?.reviewer.name ?? 'Reviewer pending'}</span>
			</div>
		</header>
	)
}

function ReviewMessage({
	announcement = 'status',
	busy = false,
	children,
	requestId,
	onRetry,
	title,
}: {
	announcement?: 'alert' | 'status'
	busy?: boolean
	children: ReactNode
	requestId?: string
	onRetry?(): void
	title: string
}) {
	return (
		<main className="review-message">
			<div
				aria-busy={busy || undefined}
				aria-live={announcement === 'alert' ? 'assertive' : 'polite'}
				role={announcement}
			>
				<p className="review-eyebrow">ShotGrid review</p>
				<h2>{title}</h2>
				<p>{children}</p>
				{requestId ? <code>Request {requestId}</code> : null}
				{onRetry ? (
					<button onClick={onRetry} type="button">
						Try again
					</button>
				) : null}
			</div>
		</main>
	)
}

function ReviewWorkspace({
	busy,
	externalChangeRevision,
	onRefresh,
	onSelectPlaylist,
	onSelectProject,
	onSelectVersion,
	refreshError,
	refreshing,
	state,
}: {
	busy: boolean
	externalChangeRevision: number
	onRefresh(): void
	onSelectPlaylist(id: number): void
	onSelectProject(id: number): void
	onSelectVersion(id: number): void
	refreshError: ReturnType<typeof useReviewBrowser>['refreshError']
	refreshing: boolean
	state: ReviewBrowserLoadResult
}) {
	const selectedVersion = state.status === 'ready' ? state.version : undefined
	return (
		<div aria-busy={busy || undefined} className="review-workspace">
			<aside className="review-sidebar">
				<label className="review-field">
					<span>Project</span>
					<select
						aria-disabled={busy || undefined}
						onChange={(event) => onSelectProject(Number(event.currentTarget.value))}
						value={state.project?.id ?? ''}
					>
						{state.projects.map((project) => (
							<option key={project.id} value={project.id}>
								{project.name}
							</option>
						))}
					</select>
				</label>

				<label className="review-field">
					<span>Playlist</span>
					<select
						aria-disabled={busy || undefined}
						disabled={!state.playlists?.length}
						onChange={(event) => onSelectPlaylist(Number(event.currentTarget.value))}
						value={state.playlist?.id ?? ''}
					>
						{state.playlists?.length ? null : <option value="">No playlists</option>}
						{state.playlists?.map((playlist) => (
							<option key={playlist.id} value={playlist.id}>
								{playlist.name}
							</option>
						))}
					</select>
				</label>

				<div className="playlist-heading">
					<p className="review-eyebrow">Versions</p>
					<h2>{state.playlist?.name ?? 'No playlist selected'}</h2>
					<span>
						{state.versions?.length ?? 0} loaded
						{state.playlist?.description ? ` · ${state.playlist.description}` : ''}
					</span>
				</div>

				<nav aria-label="Review versions" className="version-list">
					{state.versions?.map((version, index) => {
						const isActive = version.id === selectedVersion?.id
						return (
							<button
								aria-current={isActive ? 'page' : undefined}
								className="version-card"
								disabled={isActive}
								key={version.id}
								onClick={() => onSelectVersion(version.id)}
								type="button"
							>
								<span className="version-index">{String(index + 1).padStart(2, '0')}</span>
								<span className="version-card__body">
									<strong>{version.name}</strong>
									<small>{version.task?.name ?? version.entity?.name ?? 'No task context'}</small>
								</span>
								<span className="review-status">{formatStatus(version.statusCode)}</span>
							</button>
						)
					})}
				</nav>
			</aside>

			{state.status === 'ready' ? (
				<ActiveReview
					busy={busy}
					externalChangeRevision={externalChangeRevision}
					onRefresh={onRefresh}
					refreshError={refreshError}
					refreshing={refreshing}
					state={state}
				/>
			) : (
				<EmptyReview scope={state.scope} />
			)}
		</div>
	)
}

function EmptyReview({ scope }: { scope: 'playlists' | 'projects' | 'versions' }) {
	const copy = {
		playlists: {
			message: 'This project has no accessible Playlists. Choose another project to continue.',
			title: 'No Playlists available',
		},
		projects: {
			message: 'Your ShotGrid account does not currently have access to an active project.',
			title: 'No projects available',
		},
		versions: {
			message: 'This Playlist does not contain any accessible Versions. Choose another Playlist.',
			title: 'No Versions available',
		},
	}[scope]

	return <ReviewMessage title={copy.title}>{copy.message}</ReviewMessage>
}

function ActiveReview({
	busy,
	externalChangeRevision,
	onRefresh,
	refreshError,
	refreshing,
	state,
}: {
	busy: boolean
	externalChangeRevision: number
	onRefresh(): void
	refreshError: ReturnType<typeof useReviewBrowser>['refreshError']
	refreshing: boolean
	state: ReadyReviewBrowser
}) {
	const { health, playlist, project, reviewer, version } = state
	const reviewerIdentity =
		reviewer.id === null ? reviewer.login || reviewer.name : String(reviewer.id)
	const reviewerScope = `${reviewer.kind}-${encodeURIComponent(reviewerIdentity)}`
	const gatewayScope = `${reviewConfig.dataMode}-${health.mode}-${encodeURIComponent(reviewConfig.apiBaseUrl)}`
	const canvasKey = `shotgrid-review:v4:${reviewConfig.storageNamespace}:${gatewayScope}:project-${project.id}:version-${version.id}:user-${reviewerScope}`
	const reviewApiOrigin = new URL(reviewConfig.apiBaseUrl, globalThis.location.href).origin
	const reviewScope = `${reviewConfig.storageNamespace}:${reviewConfig.dataMode}:${health.mode}:${encodeURIComponent(reviewApiOrigin)}:${encodeURIComponent(reviewConfig.apiBaseUrl)}`

	return (
		<main aria-busy={busy || refreshing || undefined} className="review-main">
			<section className="review-toolbar" aria-label="Active review item">
				<div>
					<p className="review-eyebrow">Active version</p>
					<h2>{version.name}</h2>
				</div>
				<div className="review-toolbar__meta">
					<span>{version.entity?.name ?? 'No entity'}</span>
					<span>{version.task?.name ?? 'No task'}</span>
					{reviewer.kind === 'service' ? <span>Session-only canvas</span> : null}
					<ReviewDecisionPanel
						access={reviewDecisionAccessForReviewerKind(reviewer.kind)}
						api={reviewApi}
						disabled={busy || refreshing}
						externalChangeRevision={externalChangeRevision}
						onStatusRefresh={onRefresh}
						playlistId={playlist.id}
						versionId={version.id}
					/>
					{refreshError ? (
						<span className="refresh-error" role="alert" title={refreshError.message}>
							Refresh failed
						</span>
					) : null}
					<button disabled={busy || refreshing} onClick={onRefresh} type="button">
						{refreshing ? 'Refreshing…' : 'Refresh media'}
					</button>
				</div>
			</section>

			<div className="review-stage">
				<VersionInspector version={version} />
				<section className="review-canvas" aria-label={`Annotation canvas for ${version.name}`}>
					{version.media ? (
						<ReviewCollaborationCanvas
							api={reviewApi}
							apiBaseUrl={reviewConfig.apiBaseUrl}
							media={version.media}
							playlistId={playlist.id}
							reviewer={reviewer}
							versionId={version.id}
						>
							{(store, collaboration) =>
								version.media?.kind === 'image' ? (
									<ReviewImageCanvas
										allowSnapshotImport={false}
										api={reviewApi}
										collaborationReadOnly={collaboration.isViewer || collaboration.isOffline}
										documentKey={`${canvasKey}:playlist-${playlist.id}`}
										externalChangeRevision={externalChangeRevision}
										licenseKey={reviewConfig.tldrawLicenseKey}
										media={version.media}
										playlistId={playlist.id}
										projectId={project.id}
										publicationAccess={reviewPublicationAccessForReviewerKind(reviewer.kind)}
										reviewScope={reviewScope}
										store={store}
										versionId={version.id}
										versionName={version.name}
									/>
								) : version.media?.kind === 'video' ? (
									<ReviewVideoCanvas
										allowSnapshotImport={false}
										collaborationReadOnly={collaboration.isViewer || collaboration.isOffline}
										documentKey={`${canvasKey}:playlist-${playlist.id}`}
										externalChangeRevision={externalChangeRevision}
										key={`${canvasKey}:playlist-${playlist.id}:attachment-${version.media.attachmentId}`}
										licenseKey={reviewConfig.tldrawLicenseKey}
										media={version.media}
										projectId={project.id}
										reviewScope={reviewScope}
										store={store}
										versionId={version.id}
										versionName={version.name}
									/>
								) : null
							}
						</ReviewCollaborationCanvas>
					) : (
						<UnavailableAnnotationCanvas />
					)}
				</section>
			</div>
		</main>
	)
}

function UnavailableAnnotationCanvas() {
	return (
		<div className="review-canvas-message" role="status">
			<strong>No supported media to annotate</strong>
			<span>Attach an accessible image or browser-playable MP4 to this ShotGrid Version.</span>
		</div>
	)
}

function VersionInspector({ version }: { version: ReviewVersion }) {
	return (
		<aside className="version-inspector" aria-label="Version details">
			<MediaPreview media={version.media} name={version.name} />
			<dl className="version-metadata">
				<Metadata label="Status" value={formatStatus(version.statusCode)} />
				<Metadata
					label="Entity"
					value={version.entity ? `${version.entity.type} · ${version.entity.name}` : 'Not set'}
				/>
				<Metadata label="Task" value={version.task?.name ?? 'Not set'} />
				<Metadata
					label="Submitted by"
					value={version.submittedBy?.name ?? version.createdBy?.name ?? 'Unknown'}
				/>
				<Metadata label="Created" value={formatDate(version.createdAt)} />
			</dl>
			<div className="version-description">
				<p className="review-eyebrow">Description</p>
				<p>{version.description || 'No description was provided for this Version.'}</p>
			</div>
		</aside>
	)
}

function MediaPreview({ media, name }: { media: ReviewMedia | null; name: string }) {
	if (!media) {
		return (
			<div className="media-preview media-preview--empty">
				<span>No review media</span>
			</div>
		)
	}

	const previewUrl = media.kind === 'image' ? media.url : media.thumbnailUrl
	return (
		<div className="media-preview">
			{previewUrl ? (
				<img alt={`Preview of ${name}`} referrerPolicy="no-referrer" src={previewUrl} />
			) : (
				<div className="media-preview__placeholder">Video preview unavailable</div>
			)}
			<div className="media-preview__footer">
				<span>{media.kind === 'video' ? formatVideoMetadata(media) : 'Reference image'}</span>
				{media.kind === 'image' ? (
					<a href={media.url} rel="noreferrer" target="_blank">
						Open source
					</a>
				) : (
					<span>Frame-aware playback</span>
				)}
			</div>
		</div>
	)
}

function Metadata({ label, value }: { label: string; value: string }) {
	return (
		<div>
			<dt>{label}</dt>
			<dd>{value}</dd>
		</div>
	)
}

function formatStatus(statusCode: string | null) {
	if (!statusCode) return 'No status'
	return statusCode.toUpperCase()
}

function formatDate(value: string) {
	const date = new Date(value)
	return Number.isNaN(date.getTime())
		? 'Unknown'
		: new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}

function formatVideoMetadata(media: Extract<ReviewMedia, { kind: 'video' }>) {
	const parts = ['Video']
	if (media.frameCount) parts.push(`${media.frameCount} frames`)
	if (media.frameRate) parts.push(`${media.frameRate} fps`)
	return parts.join(' · ')
}

function App() {
	const {
		changeStreamStatus,
		externalChangeRevision,
		navigating,
		refresh,
		refreshError,
		refreshing,
		retry,
		selectPlaylist,
		selectProject,
		selectVersion,
		state,
	} = useReviewBrowser(reviewApi)
	const loadedState = state.status === 'ready' || state.status === 'empty' ? state : undefined

	return (
		<div className="review-app">
			<ReviewHeader changeStreamStatus={changeStreamStatus} state={loadedState} />
			{state.status === 'loading' ? (
				<ReviewMessage busy title="Loading review workspace">
					Fetching your permitted ShotGrid projects, Playlists, and Versions.
				</ReviewMessage>
			) : state.status === 'error' ? (
				<ReviewMessage
					announcement="alert"
					onRetry={state.error.retryable ? retry : undefined}
					requestId={state.error.requestId}
					title={state.error.title}
				>
					{state.error.message}
				</ReviewMessage>
			) : (
				<ReviewWorkspace
					busy={navigating}
					externalChangeRevision={externalChangeRevision}
					onRefresh={refresh}
					onSelectPlaylist={selectPlaylist}
					onSelectProject={selectProject}
					onSelectVersion={selectVersion}
					refreshError={refreshError}
					refreshing={refreshing}
					state={state}
				/>
			)}
		</div>
	)
}

export default App
