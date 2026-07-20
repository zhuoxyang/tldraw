import type {
	ReviewHealth,
	ReviewPlaylist,
	ReviewProject,
	ReviewUser,
	ReviewVersion,
} from '@tldraw/shotgrid-review-contracts'
import type { ReviewApiClient } from './reviewApiClient'

export interface ReviewSelectionRequest {
	projectId: number | null
	playlistId: number | null
	versionId: number | null
}

interface ReviewBrowserContext {
	health: ReviewHealth
	reviewer: ReviewUser
	projects: ReviewProject[]
	project?: ReviewProject
	playlists?: ReviewPlaylist[]
	playlist?: ReviewPlaylist
	versions?: ReviewVersion[]
}

export interface ReadyReviewBrowser extends ReviewBrowserContext {
	status: 'ready'
	project: ReviewProject
	playlists: ReviewPlaylist[]
	playlist: ReviewPlaylist
	versions: ReviewVersion[]
	version: ReviewVersion
}

export interface EmptyReviewBrowser extends ReviewBrowserContext {
	status: 'empty'
	scope: 'projects' | 'playlists' | 'versions'
}

export type ReviewBrowserLoadResult = ReadyReviewBrowser | EmptyReviewBrowser

export class ReviewBrowserNotFoundError extends Error {
	constructor() {
		super('The requested ShotGrid review item was not found')
		this.name = 'ReviewBrowserNotFoundError'
	}
}

export class ReviewBrowserInvalidResponseError extends Error {
	constructor() {
		super('The review API returned inconsistent ShotGrid relationships')
		this.name = 'ReviewBrowserInvalidResponseError'
	}
}

export const rootReviewSelection: ReviewSelectionRequest = Object.freeze({
	playlistId: null,
	projectId: null,
	versionId: null,
})

export async function loadReviewBrowser(
	api: ReviewApiClient,
	request: ReviewSelectionRequest,
	signal?: AbortSignal
): Promise<ReviewBrowserLoadResult> {
	const [health, reviewer, projects] = await Promise.all([
		api.getHealth(signal),
		api.getCurrentReviewer(signal),
		api.listProjects(signal),
	])

	if (projects.length === 0) {
		if (hasRequestedSelection(request)) throw new ReviewBrowserNotFoundError()
		return { health, projects, reviewer, scope: 'projects', status: 'empty' }
	}

	const legacySelection = request.projectId === null && request.playlistId !== null
	let project: ReviewProject
	let playlists: ReviewPlaylist[]
	let refreshedLegacyVersion: ReviewVersion | undefined

	if (legacySelection) {
		refreshedLegacyVersion = await api.getVersion(request.playlistId!, request.versionId!, signal)
		assertVersionIdentity(refreshedLegacyVersion, request.versionId!)
		project = requireSelection(projects, refreshedLegacyVersion.projectId)
		playlists = await api.listPlaylists(project.id, signal)
	} else {
		project = request.projectId ? requireSelection(projects, request.projectId) : projects[0]
		playlists = await api.listPlaylists(project.id, signal)
	}

	assertPlaylistProjects(playlists, project.id)
	if (playlists.length === 0) {
		if (request.playlistId !== null) throw new ReviewBrowserNotFoundError()
		return { health, playlists, project, projects, reviewer, scope: 'playlists', status: 'empty' }
	}

	const playlist = request.playlistId
		? requireSelection(playlists, request.playlistId)
		: playlists[0]
	const versions = await api.listVersions(playlist.id, signal)
	assertVersionRelationships(versions, project.id, playlist.id)

	if (versions.length === 0) {
		if (request.versionId !== null) throw new ReviewBrowserNotFoundError()
		return {
			health,
			playlist,
			playlists,
			project,
			projects,
			reviewer,
			scope: 'versions',
			status: 'empty',
			versions,
		}
	}

	const listedVersion = request.versionId
		? requireSelection(versions, request.versionId)
		: versions[0]
	const version =
		refreshedLegacyVersion?.id === listedVersion.id
			? refreshedLegacyVersion
			: await api.getVersion(playlist.id, listedVersion.id, signal)
	assertVersionIdentity(version, listedVersion.id)
	assertVersionRelationships([version], project.id, playlist.id)

	return {
		health,
		playlist,
		playlists,
		project,
		projects,
		reviewer,
		status: 'ready',
		version,
		versions: versions.map((candidate) => (candidate.id === version.id ? version : candidate)),
	}
}

export async function refreshReadyReviewBrowser(
	api: ReviewApiClient,
	state: ReadyReviewBrowser,
	signal?: AbortSignal
): Promise<ReadyReviewBrowser> {
	const version = await api.getVersion(state.playlist.id, state.version.id, signal)
	assertVersionIdentity(version, state.version.id)
	assertVersionRelationships([version], state.project.id, state.playlist.id)
	return {
		...state,
		version,
		versions: state.versions.map((candidate) =>
			candidate.id === version.id ? version : candidate
		),
	}
}

function requireSelection<T extends { id: number }>(items: T[], id: number): T {
	const selected = items.find((item) => item.id === id)
	if (!selected) throw new ReviewBrowserNotFoundError()
	return selected
}

function assertPlaylistProjects(playlists: ReviewPlaylist[], projectId: number) {
	if (playlists.some((playlist) => playlist.projectId !== projectId)) {
		throw new ReviewBrowserInvalidResponseError()
	}
}

function assertVersionRelationships(
	versions: ReviewVersion[],
	projectId: number,
	playlistId: number
) {
	if (
		versions.some((version) => version.projectId !== projectId || version.playlistId !== playlistId)
	) {
		throw new ReviewBrowserInvalidResponseError()
	}
}

function assertVersionIdentity(version: ReviewVersion, expectedVersionId: number) {
	if (version.id !== expectedVersionId) throw new ReviewBrowserInvalidResponseError()
}

function hasRequestedSelection(request: ReviewSelectionRequest) {
	return request.projectId !== null || request.playlistId !== null || request.versionId !== null
}
