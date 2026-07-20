import {
	type ReviewHealth,
	type ReviewNoteOptions,
	type ReviewPlaylist,
	type ReviewProject,
	type ReviewPublicationErrorContext,
	type ReviewPublicationRequest,
	type ReviewPublicationResult,
	type ReviewUser,
	type ReviewVersion,
	isReviewApiErrorEnvelope,
	isReviewHealth,
	isReviewNoteOptions,
	isReviewPlaylist,
	isReviewProject,
	isReviewPublicationResult,
	isReviewUser,
	isReviewVersion,
} from '@tldraw/shotgrid-review-contracts'

type FetchImplementation = typeof globalThis.fetch
type Guard<T> = (value: unknown) => value is T

interface ParsedReviewApiResponse {
	payload: unknown
	requestId?: string
	status: number
}

const MAX_RESPONSE_BODY_BYTES = 16 * 1024 * 1024
const MAX_RESPONSE_ITEMS = 10_000

export interface ReviewApiClient {
	getCurrentReviewer(signal?: AbortSignal): Promise<ReviewUser>
	getHealth(signal?: AbortSignal): Promise<ReviewHealth>
	getNoteOptions(
		playlistId: number,
		versionId: number,
		signal?: AbortSignal
	): Promise<ReviewNoteOptions>
	getVersion(playlistId: number, versionId: number, signal?: AbortSignal): Promise<ReviewVersion>
	listPlaylists(projectId: number, signal?: AbortSignal): Promise<ReviewPlaylist[]>
	listProjects(signal?: AbortSignal): Promise<ReviewProject[]>
	listVersions(playlistId: number, signal?: AbortSignal): Promise<ReviewVersion[]>
	publishReview(
		playlistId: number,
		versionId: number,
		publicationId: string,
		request: ReviewPublicationRequest,
		signal?: AbortSignal
	): Promise<ReviewPublicationResult>
}

export interface CreateReviewApiClientOptions {
	baseUrl: string
	fetch?: FetchImplementation
}

interface ReviewApiClientErrorOptions {
	code: string
	message: string
	publication?: ReviewPublicationErrorContext
	requestId?: string
	retryable: boolean
	status: number
}

export class ReviewApiClientError extends Error {
	readonly code: string
	readonly publication?: ReviewPublicationErrorContext
	readonly requestId?: string
	readonly retryable: boolean
	readonly status: number

	constructor(options: ReviewApiClientErrorOptions) {
		super(options.message)
		this.name = 'ReviewApiClientError'
		this.code = options.code
		this.publication = options.publication
		this.requestId = options.requestId
		this.retryable = options.retryable
		this.status = options.status
	}
}

export function createReviewApiClient({
	baseUrl,
	fetch: fetchImplementation = globalThis.fetch,
}: CreateReviewApiClientOptions): ReviewApiClient {
	const normalizedBaseUrl = normalizeBaseUrl(baseUrl)

	async function request(
		path: string,
		options: {
			body?: string
			method?: 'GET' | 'PUT'
			signal?: AbortSignal
		} = {}
	): Promise<ParsedReviewApiResponse> {
		const { body, method = 'GET', signal } = options
		let response: Response
		try {
			response = await fetchImplementation(`${normalizedBaseUrl}${path}`, {
				body,
				cache: 'no-store',
				headers: {
					Accept: 'application/json',
					...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
				},
				method,
				redirect: 'error',
				signal,
			})
		} catch (error) {
			throw normalizeFetchError(error, signal)
		}

		const requestId = response.headers.get('x-request-id') || undefined
		let payload: unknown
		try {
			payload = await readJsonResponse(response)
		} catch (error) {
			if (signal?.aborted || isAbortError(error)) throw requestAbortedError()
			if (error instanceof ReviewApiClientError) throw error
			throw invalidResponseError(response.status, requestId)
		}

		if (isReviewApiErrorEnvelope(payload)) {
			throw new ReviewApiClientError({
				code: payload.error.code,
				message: payload.error.message,
				publication: payload.error.publication,
				requestId: payload.error.requestId ?? requestId,
				retryable: payload.error.retryable,
				status: response.status,
			})
		}

		if (!response.ok) {
			throw new ReviewApiClientError({
				code: 'HTTP_ERROR',
				message: 'The review API request failed.',
				requestId,
				retryable: response.status === 429 || response.status >= 500,
				status: response.status,
			})
		}

		return { payload, requestId, status: response.status }
	}

	return {
		async getCurrentReviewer(signal) {
			return unwrapData(await request('/review/me', { signal }), isReviewUser)
		},

		async getHealth(signal) {
			const response = await request('/health', { signal })
			if (!isReviewHealth(response.payload)) {
				throw invalidResponseError(response.status, response.requestId)
			}
			return response.payload
		},

		async getNoteOptions(playlistId, versionId, signal) {
			const validPlaylistId = requirePositiveId(playlistId, 'playlistId')
			const validVersionId = requirePositiveId(versionId, 'versionId')
			const response = await request(
				`/review/playlists/${validPlaylistId}/versions/${validVersionId}/note-options`,
				{ signal }
			)
			const options = unwrapData(response, isReviewNoteOptions)
			const recipientIds = options.recipients.map((recipient) => recipient.id)
			if (
				options.links.version.id !== validVersionId ||
				recipientIds.length > MAX_RESPONSE_ITEMS ||
				new Set(recipientIds).size !== recipientIds.length
			) {
				throw invalidResponseError(response.status, response.requestId)
			}
			return options
		},

		async getVersion(playlistId, versionId, signal) {
			const validPlaylistId = requirePositiveId(playlistId, 'playlistId')
			const validVersionId = requirePositiveId(versionId, 'versionId')
			const version = unwrapData(
				await request(`/review/playlists/${validPlaylistId}/versions/${validVersionId}`, {
					signal,
				}),
				isReviewVersion
			)
			return resolveReviewVersionMediaUrls(version, normalizedBaseUrl)
		},

		async listPlaylists(projectId, signal) {
			const validProjectId = requirePositiveId(projectId, 'projectId')
			return unwrapDataArray(
				await request(`/review/projects/${validProjectId}/playlists`, { signal }),
				isReviewPlaylist
			)
		},

		async listProjects(signal) {
			return unwrapDataArray(await request('/review/projects', { signal }), isReviewProject)
		},

		async listVersions(playlistId, signal) {
			const validPlaylistId = requirePositiveId(playlistId, 'playlistId')
			const versions = unwrapDataArray(
				await request(`/review/playlists/${validPlaylistId}/versions`, { signal }),
				isReviewVersion
			)
			return versions.map((version) => resolveReviewVersionMediaUrls(version, normalizedBaseUrl))
		},

		async publishReview(playlistId, versionId, publicationId, publication, signal) {
			const validPlaylistId = requirePositiveId(playlistId, 'playlistId')
			const validVersionId = requirePositiveId(versionId, 'versionId')
			const validPublicationId = requirePublicationId(publicationId)
			let body: string
			try {
				body = JSON.stringify(publication)
			} catch {
				throw invalidRequestError('publication request must be JSON serializable')
			}
			let response: ParsedReviewApiResponse
			try {
				response = await request(
					`/review/playlists/${validPlaylistId}/versions/${validVersionId}/publications/${validPublicationId}`,
					{ body, method: 'PUT', signal }
				)
			} catch (error) {
				if (
					error instanceof ReviewApiClientError &&
					error.publication &&
					(error.publication.publicationId !== validPublicationId ||
						(error.publication.stage !== 'note-creation' &&
							error.publication.links.version.id !== validVersionId))
				) {
					throw invalidResponseError(error.status, error.requestId)
				}
				throw error
			}
			const result = unwrapData(response, isReviewPublicationResult)
			const decodedAttachmentSize = decodedCanonicalBase64Length(
				publication.attachment.contentBase64
			)
			if (
				result.publicationId !== validPublicationId ||
				result.note.versionId !== validVersionId ||
				result.links.version.id !== validVersionId ||
				result.note.subject !== publication.subject ||
				result.note.content !== publication.content ||
				result.attachment.fileName !== publication.attachment.fileName ||
				result.attachment.contentType !== publication.attachment.contentType ||
				decodedAttachmentSize === null ||
				result.attachment.sizeBytes !== decodedAttachmentSize
			) {
				throw invalidResponseError(response.status, response.requestId)
			}
			return result
		},
	}
}

export function decodedCanonicalBase64Length(value: string): number | null {
	if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
		return null
	}
	const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0
	if (padding === 2 && (base64CharacterValue(value[value.length - 3]) & 0x0f) !== 0) {
		return null
	}
	if (padding === 1 && (base64CharacterValue(value[value.length - 2]) & 0x03) !== 0) {
		return null
	}
	const decodedLength = (value.length / 4) * 3 - padding
	return decodedLength > 0 ? decodedLength : null
}

function base64CharacterValue(character: string) {
	const codePoint = character.charCodeAt(0)
	if (codePoint >= 65 && codePoint <= 90) return codePoint - 65
	if (codePoint >= 97 && codePoint <= 122) return codePoint - 71
	if (codePoint >= 48 && codePoint <= 57) return codePoint + 4
	return character === '+' ? 62 : 63
}

function resolveReviewVersionMediaUrls(version: ReviewVersion, baseUrl: string): ReviewVersion {
	if (!version.media) return version
	const url = resolveReviewMediaUrl(version.media.url, baseUrl)
	const thumbnailUrl = resolveReviewMediaUrl(version.media.thumbnailUrl, baseUrl)
	if (url === version.media.url && thumbnailUrl === version.media.thumbnailUrl) return version
	return { ...version, media: { ...version.media, thumbnailUrl, url } }
}

function resolveReviewMediaUrl(value: string, baseUrl: string): string
function resolveReviewMediaUrl(value: null, baseUrl: string): null
function resolveReviewMediaUrl(value: null | string, baseUrl: string): null | string
function resolveReviewMediaUrl(value: null | string, baseUrl: string) {
	return value?.startsWith('/review/') ? `${baseUrl}${value}` : value
}

function normalizeBaseUrl(value: string) {
	const baseUrl = value.trim()
	if (baseUrl === '' || baseUrl.includes('\\')) throw invalidRequestError('baseUrl is invalid')

	if (baseUrl.startsWith('/')) {
		if (baseUrl.startsWith('//') || baseUrl.includes('?') || baseUrl.includes('#')) {
			throw invalidRequestError('baseUrl is invalid')
		}
		const normalized = baseUrl.replace(/\/+$/, '')
		if (normalized.includes('//')) throw invalidRequestError('baseUrl is invalid')
		return normalized
	}

	let url: URL
	try {
		url = new URL(baseUrl)
	} catch {
		throw invalidRequestError('baseUrl is invalid')
	}

	if (
		(url.protocol !== 'http:' && url.protocol !== 'https:') ||
		(url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) ||
		url.username !== '' ||
		url.password !== '' ||
		url.search !== '' ||
		url.hash !== '' ||
		url.pathname.includes('//')
	) {
		throw invalidRequestError('baseUrl is invalid')
	}

	url.pathname = url.pathname.replace(/\/+$/, '')
	return url.toString().replace(/\/$/, '')
}

function isLoopbackHostname(hostname: string) {
	return hostname === '127.0.0.1' || hostname === '[::1]' || hostname === 'localhost'
}

function requirePositiveId(value: number, field: string) {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw invalidRequestError(`${field} must be a positive safe integer`)
	}
	return value
}

function requirePublicationId(value: string) {
	if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
		throw invalidRequestError('publicationId must be a canonical UUID v4')
	}
	return value
}

async function readJsonResponse(response: Response): Promise<unknown> {
	const declaredLength = response.headers.get('content-length')?.trim()
	if (
		declaredLength &&
		/^\d+$/.test(declaredLength) &&
		Number(declaredLength) > MAX_RESPONSE_BODY_BYTES
	) {
		await cancelResponseBody(response)
		throw invalidResponseError(response.status, response.headers.get('x-request-id') || undefined)
	}

	if (!response.body) {
		throw invalidResponseError(response.status, response.headers.get('x-request-id') || undefined)
	}

	const reader = response.body.getReader()
	const decoder = new TextDecoder('utf-8', { fatal: true })
	const decodedChunks: string[] = []
	let byteLength = 0
	let cancellationAttempted = false
	const cancelReader = async () => {
		if (cancellationAttempted) return
		cancellationAttempted = true
		try {
			await reader.cancel()
		} catch {
			// Preserve the invalid-response error that caused cancellation.
		}
	}
	try {
		for (;;) {
			const { done, value } = await reader.read()
			if (done) break

			byteLength += value.byteLength
			if (byteLength > MAX_RESPONSE_BODY_BYTES) {
				await cancelReader()
				throw invalidResponseError(
					response.status,
					response.headers.get('x-request-id') || undefined
				)
			}
			decodedChunks.push(decoder.decode(value, { stream: true }))
		}
		decodedChunks.push(decoder.decode())
	} catch (error) {
		await cancelReader()
		throw error
	} finally {
		reader.releaseLock()
	}

	const text = decodedChunks.join('')
	if (text.trim() === '') {
		throw invalidResponseError(response.status, response.headers.get('x-request-id') || undefined)
	}
	return JSON.parse(text)
}

async function cancelResponseBody(response: Response) {
	try {
		await response.body?.cancel()
	} catch {
		// Preserve the bounded invalid-response error when cancellation fails.
	}
}

function unwrapData<T>(response: ParsedReviewApiResponse, guard: Guard<T>): T {
	if (!isDataEnvelope(response.payload) || !guard(response.payload.data)) {
		throw invalidResponseError(response.status, response.requestId)
	}
	return response.payload.data
}

function unwrapDataArray<T>(response: ParsedReviewApiResponse, guard: Guard<T>): T[] {
	if (
		!isDataEnvelope(response.payload) ||
		!Array.isArray(response.payload.data) ||
		response.payload.data.length > MAX_RESPONSE_ITEMS ||
		!response.payload.data.every(guard)
	) {
		throw invalidResponseError(response.status, response.requestId)
	}
	return response.payload.data
}

function isDataEnvelope(value: unknown): value is { data: unknown } {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false
	const keys = Object.keys(value)
	return keys.length === 1 && keys[0] === 'data'
}

function normalizeFetchError(error: unknown, signal: AbortSignal | undefined) {
	if (error instanceof ReviewApiClientError) return error
	if (signal?.aborted || isAbortError(error)) return requestAbortedError()
	return new ReviewApiClientError({
		code: 'NETWORK_ERROR',
		message: 'The review API could not be reached.',
		retryable: true,
		status: 0,
	})
}

function isAbortError(error: unknown) {
	return (
		error !== null &&
		typeof error === 'object' &&
		'name' in error &&
		(error as { name?: unknown }).name === 'AbortError'
	)
}

function invalidRequestError(message: string) {
	return new ReviewApiClientError({
		code: 'INVALID_REQUEST',
		message,
		retryable: false,
		status: 0,
	})
}

function invalidResponseError(status: number, requestId?: string) {
	return new ReviewApiClientError({
		code: 'INVALID_RESPONSE',
		message: 'The review API returned an invalid response.',
		requestId,
		retryable: false,
		status,
	})
}

function requestAbortedError() {
	return new ReviewApiClientError({
		code: 'REQUEST_ABORTED',
		message: 'The review API request was aborted.',
		retryable: false,
		status: 0,
	})
}
