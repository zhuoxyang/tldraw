import {
	createReviewCollaborationPresence,
	type ReviewCollaborationPermission,
	type ReviewImageMedia,
	type ReviewMedia,
	type ReviewUser,
	type ReviewVideoMedia,
} from '@tldraw/shotgrid-review-contracts'
import { TLRemoteSyncError, TLSyncErrorCloseEventReason, useSync } from '@tldraw/sync'
import { useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import {
	UserRecordType,
	atom,
	defaultShapeUtils,
	type TLAssetStore,
	type TLStore,
	type TLUserId,
} from 'tldraw'
import { getReviewImageIds } from './reviewAnnotationEditor'
import { ReviewApiClientError, type ReviewApiClient } from './reviewApiClient'
import { reviewVideoShapeUtils } from './reviewVideoShape'

export interface ReviewCollaborationCanvasProps {
	api: ReviewApiClient
	apiBaseUrl: string
	children(store: TLStore, state: { isOffline: boolean; isViewer: boolean }): ReactNode
	media: ReviewMedia
	playlistId: number
	reviewer: ReviewUser
	versionId: number
}

/**
 * Owns the single remote annotation store for an active review. Media records are installed by
 * the child canvas as local-only remote changes; this store only persists review annotations.
 */
export function ReviewCollaborationCanvas(props: ReviewCollaborationCanvasProps) {
	return <ReviewCollaborationRoom key={reviewCollaborationScopeKey(props)} {...props} />
}

function ReviewCollaborationRoom(props: ReviewCollaborationCanvasProps) {
	const [fatalFailure, setFatalFailure] = useState<ReviewCollaborationFailure | null>(null)
	return fatalFailure ? (
		<ReviewCollaborationMessage title={fatalFailure.title}>
			{fatalFailure.message}
		</ReviewCollaborationMessage>
	) : (
		<ReviewCollaborationSync {...props} onFatalFailure={setFatalFailure} />
	)
}

interface ReviewCollaborationFailure {
	message: string
	title: string
}

function ReviewCollaborationSync(
	props: ReviewCollaborationCanvasProps & {
		onFatalFailure(failure: ReviewCollaborationFailure): void
	}
) {
	const { api, apiBaseUrl, media, onFatalFailure, playlistId, reviewer, versionId } = props
	const roomIdRef = useRef<string | null>(null)
	const [permission, setPermission] = useState<ReviewCollaborationPermission | null>(null)
	const [ticketFailure, setTicketFailure] = useState<ReviewCollaborationFailure | null>(null)
	const { color, userId, userName } = createReviewCollaborationPresence(reviewer)
	const users = useMemo(
		() => ({
			currentUser: atom(
				`shotgrid-review-user:${userId}`,
				UserRecordType.create({
					color,
					id: userId as TLUserId,
					imageUrl: '',
					meta: {},
					name: userName,
				})
			),
		}),
		[color, userId, userName]
	)
	const mediaAssetUrl = media.kind === 'image' ? media.url : null
	const assets = useMemo(
		() =>
			createReviewCollaborationAssetStore(
				media.kind === 'image' ? { kind: 'image', url: mediaAssetUrl! } : { kind: 'video' },
				versionId
			),
		[media.kind, mediaAssetUrl, versionId]
	)
	const uri = useCallback(async () => {
		try {
			const session = await api.createCollaborationSession(playlistId, versionId)
			if (roomIdRef.current !== null && roomIdRef.current !== session.roomId) {
				throw new ReviewCollaborationRoomChangedError()
			}
			let socketUrl: string
			try {
				socketUrl = resolveReviewCollaborationSocketUrl(
					session.socketUrl,
					apiBaseUrl,
					globalThis.location.href
				)
			} catch (error) {
				throw new ReviewCollaborationDescriptorError(error)
			}
			roomIdRef.current = session.roomId
			setPermission(session.permission)
			setTicketFailure(null)
			return socketUrl
		} catch (error) {
			const failure = reviewCollaborationTicketFailure(error)
			if (isFatalReviewCollaborationTicketError(error)) onFatalFailure(failure)
			else setTicketFailure(failure)
			throw error
		}
	}, [api, apiBaseUrl, onFatalFailure, playlistId, versionId])
	// Every review room advertises one schema. Register the local-only video source type even for
	// image reviews so a poisoned remote record can never exploit an apparently compatible schema.
	const shapeUtils = useMemo(() => [...defaultShapeUtils, ...reviewVideoShapeUtils], [])
	const synced = useSync({ assets, shapeUtils, uri, users })

	if (synced.status === 'loading') {
		return ticketFailure ? (
			<ReviewCollaborationMessage busy title={ticketFailure.title}>
				{ticketFailure.message}
			</ReviewCollaborationMessage>
		) : (
			<ReviewCollaborationMessage busy title="Joining review room" />
		)
	}
	if (synced.status === 'error') {
		const failure = reviewCollaborationFailure(synced.error)
		return (
			<ReviewCollaborationMessage title={failure.title}>
				{failure.message}
			</ReviewCollaborationMessage>
		)
	}

	return (
		<div className="review-collaboration" data-connection-status={synced.connectionStatus}>
			{synced.connectionStatus === 'offline' ? (
				<div className="review-collaboration__offline" role="status">
					{ticketFailure?.message ?? 'Reconnecting to the review room…'}
				</div>
			) : null}
			{props.children(synced.store, {
				isOffline: synced.connectionStatus === 'offline',
				isViewer: permission !== 'editor',
			})}
		</div>
	)
}

class ReviewCollaborationRoomChangedError extends Error {
	constructor() {
		super('The review room identity changed during reconnect.')
		this.name = 'ReviewCollaborationRoomChangedError'
	}
}

class ReviewCollaborationDescriptorError extends Error {
	constructor(cause: unknown) {
		super('The review service returned an unusable collaboration descriptor.', { cause })
		this.name = 'ReviewCollaborationDescriptorError'
	}
}

function isFatalReviewCollaborationTicketError(error: unknown) {
	return (
		error instanceof ReviewCollaborationRoomChangedError ||
		error instanceof ReviewCollaborationDescriptorError ||
		(error instanceof ReviewApiClientError && !error.retryable)
	)
}

function reviewCollaborationScopeKey(props: ReviewCollaborationCanvasProps) {
	const mediaIdentity =
		props.media.kind === 'video'
			? `video:${props.media.attachmentId}`
			: `image:${props.media.contentType}:${props.media.width}x${props.media.height}:${props.media.url}`
	return JSON.stringify([
		props.apiBaseUrl,
		props.playlistId,
		props.versionId,
		mediaIdentity,
		props.reviewer.kind,
		props.reviewer.id,
		props.reviewer.login,
		props.reviewer.name,
	])
}

function reviewCollaborationTicketFailure(error: unknown) {
	if (error instanceof ReviewCollaborationRoomChangedError) {
		return {
			message: 'Refresh the Version before editing so annotations cannot cross media revisions.',
			title: 'Review media changed',
		}
	}
	if (error instanceof ReviewCollaborationDescriptorError) {
		return {
			message: 'Reload after the review application and API configuration have been corrected.',
			title: 'Invalid collaboration response',
		}
	}
	if (error instanceof ReviewApiClientError) {
		switch (error.code) {
			case 'AUTHENTICATION_REQUIRED':
				return {
					message: 'Authenticate through the trusted review gateway, then reload this page.',
					title: 'Review authentication required',
				}
			case 'PERMISSION_DENIED':
			case 'NOT_FOUND':
				return {
					message: 'Your reviewer cannot join this Version-specific review room.',
					title: 'Review room unavailable',
				}
			case 'COLLABORATION_UNAVAILABLE':
				return {
					message: 'The review room is at capacity. Retrying with a fresh ticket…',
					title: 'Review room is busy',
				}
		}
	}
	return {
		message: 'The app is retrying the review service with a fresh authorization ticket.',
		title: 'Could not authorize collaboration',
	}
}

export function resolveReviewCollaborationSocketUrl(
	socketUrl: string,
	apiBaseUrl: string,
	locationHref: string
) {
	const applicationUrl = new URL(locationHref)
	const apiUrl = new URL(apiBaseUrl, applicationUrl)
	if (
		(apiUrl.protocol !== 'http:' && apiUrl.protocol !== 'https:') ||
		apiUrl.username !== '' ||
		apiUrl.password !== ''
	) {
		throw new Error('The review API base URL cannot be used for collaboration.')
	}
	if (!socketUrl.startsWith('/api/review/sync/')) {
		throw new Error('The review API returned an invalid collaboration socket URL.')
	}
	const resolved = new URL(socketUrl, apiUrl.origin)
	if (resolved.origin !== apiUrl.origin) {
		throw new Error('The review collaboration socket must use the review API origin.')
	}
	resolved.protocol = resolved.protocol === 'https:' ? 'wss:' : 'ws:'
	return resolved.toString()
}

export function createReviewCollaborationAssetStore(
	media: Pick<ReviewImageMedia, 'kind' | 'url'> | Pick<ReviewVideoMedia, 'kind'>,
	versionId: number
): TLAssetStore {
	const sourceAssetId = media.kind === 'image' ? getReviewImageIds(versionId).assetId : undefined
	return {
		async upload(asset) {
			if (media.kind !== 'image' || asset.type !== 'image' || asset.id !== sourceAssetId) {
				throw new Error('Review rooms do not accept uploaded assets.')
			}
			return { src: media.url }
		},
		resolve(asset) {
			if (
				media.kind !== 'image' ||
				asset.type !== 'image' ||
				asset.id !== sourceAssetId ||
				asset.props.src !== media.url
			) {
				return null
			}
			return media.url
		},
	}
}

function reviewCollaborationFailure(error: Error) {
	if (error instanceof TLRemoteSyncError) {
		switch (error.reason) {
			case TLSyncErrorCloseEventReason.CLIENT_TOO_OLD:
				return {
					message: 'Refresh this page to load the current review schema.',
					title: 'Review client update required',
				}
			case TLSyncErrorCloseEventReason.SERVER_TOO_OLD:
				return {
					message: 'The review service must be upgraded before this room can be opened.',
					title: 'Review service update required',
				}
			case TLSyncErrorCloseEventReason.INVALID_RECORD:
				return {
					message:
						'The server rejected an incompatible review record. Reload before editing again.',
					title: 'Review data rejected safely',
				}
			case TLSyncErrorCloseEventReason.FORBIDDEN:
				return {
					message: 'Your authenticated reviewer does not have access to this room.',
					title: 'Review room unavailable',
				}
			case TLSyncErrorCloseEventReason.ROOM_FULL:
				return {
					message: 'This pilot room has reached its active reviewer limit. Try again shortly.',
					title: 'Review room is full',
				}
		}
	}
	return {
		message: 'The persistent review room could not be opened safely. Reload to try again.',
		title: 'Collaboration unavailable',
	}
}

function ReviewCollaborationMessage({
	busy = false,
	children,
	title,
}: {
	busy?: boolean
	children?: ReactNode
	title: string
}) {
	return (
		<div aria-busy={busy || undefined} className="review-canvas-message" role="status">
			<strong>{title}</strong>
			{children ? <span>{children}</span> : null}
		</div>
	)
}
