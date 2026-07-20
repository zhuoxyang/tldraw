import { Tldraw } from 'tldraw'
import 'tldraw/tldraw.css'
import { reviewConfig } from './config'
import { mockReviewPlaylist } from './mockReviewData'
import { parseReviewRoute } from './reviewRoute'

function App() {
	const route = parseReviewRoute(window.location.pathname)
	const requestedVersionId = route?.playlistId === mockReviewPlaylist.id ? route.versionId : null
	const activeVersion =
		mockReviewPlaylist.versions.find((version) => version.id === requestedVersionId) ??
		mockReviewPlaylist.versions[0]

	return (
		<div className="review-app">
			<header className="review-header">
				<div>
					<p className="review-eyebrow">{mockReviewPlaylist.project}</p>
					<h1>ShotGrid review</h1>
				</div>
				<div className="review-header__status">
					<span className={`mode-badge mode-badge--${reviewConfig.dataMode}`}>
						{reviewConfig.dataMode === 'mock' ? 'Mock data' : 'ShotGrid connected'}
					</span>
					<span className="reviewer">Reviewer · Zhuo</span>
				</div>
			</header>

			<div className="review-workspace">
				<aside className="review-sidebar">
					<div className="playlist-heading">
						<p className="review-eyebrow">Playlist</p>
						<h2>{mockReviewPlaylist.code}</h2>
						<span>{mockReviewPlaylist.versions.length} versions</span>
					</div>

					<nav aria-label="Review versions" className="version-list">
						{mockReviewPlaylist.versions.map((version, index) => {
							const isActive = version.id === activeVersion.id
							return (
								<a
									aria-current={isActive ? 'page' : undefined}
									className="version-card"
									href={`/review/${mockReviewPlaylist.id}/${version.id}`}
									key={version.id}
								>
									<span className="version-index">{String(index + 1).padStart(2, '0')}</span>
									<span className="version-card__body">
										<strong>{version.code}</strong>
										<small>
											{version.task} · {version.artist}
										</small>
									</span>
									<span
										className={`review-status review-status--${version.status.replace(' ', '-').toLowerCase()}`}
									>
										{version.status}
									</span>
								</a>
							)
						})}
					</nav>
				</aside>

				<main className="review-main">
					<section className="review-toolbar" aria-label="Active review item">
						<div>
							<p className="review-eyebrow">Active version</p>
							<h2>{activeVersion.code}</h2>
						</div>
						<div className="review-toolbar__meta">
							<span>{activeVersion.task}</span>
							<span>{activeVersion.artist}</span>
							<button disabled type="button">
								Publish review
							</button>
						</div>
					</section>

					<section
						className="review-canvas"
						aria-label={`Annotation canvas for ${activeVersion.code}`}
					>
						<Tldraw
							licenseKey={reviewConfig.tldrawLicenseKey}
							persistenceKey={`shotgrid-review:${mockReviewPlaylist.id}:${activeVersion.id}`}
						/>
					</section>
				</main>
			</div>
		</div>
	)
}

export default App
