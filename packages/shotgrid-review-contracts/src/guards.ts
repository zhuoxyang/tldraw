import {
	REVIEW_API_ERROR_CODES,
	type ReviewApiDataEnvelope,
	type ReviewApiErrorCode,
	type ReviewApiErrorEnvelope,
	type ReviewCollaborationPresence,
	type ReviewCollaborationSession,
	type ReviewChangeEvent,
	type ReviewChangeNotification,
	type ReviewDecisionContext,
	type ReviewDecisionHistoryEntry,
	type ReviewDecisionOption,
	type ReviewDecisionRequest,
	type ReviewDecisionResult,
	type ReviewEntityLink,
	type ReviewHealth,
	type ReviewImageMedia,
	type ReviewMedia,
	type ReviewNote,
	type ReviewNoteOptions,
	type ReviewPlaylist,
	type ReviewProject,
	type ReviewPublicationLinks,
	type ReviewPublicationErrorContext,
	type ReviewPublicationResult,
	type ReviewAttachmentResult,
	type ReviewTaskLink,
	type ReviewUser,
	type ReviewVersion,
	type ReviewVideoMedia,
} from './contracts'

export type ReviewRuntimeGuard<T> = (value: unknown) => value is T

const reviewApiErrorCodes = new Set<string>(REVIEW_API_ERROR_CODES)
const MAX_PUBLICATION_ATTACHMENT_BYTES = 10 * 1024 * 1024
const MAX_PUBLICATION_CONTENT_LENGTH = 10_000
const MAX_PUBLICATION_DISPLAY_TEXT_LENGTH = 255
const MAX_PUBLICATION_TIMESTAMP_LENGTH = 32
const MAX_DECISION_OPTIONS = 32
const MAX_DECISION_HISTORY_ENTRIES = 500
const MAX_DECISION_LABEL_LENGTH = 100
const MAX_MEDIA_FILE_NAME_LENGTH = 255
const DECISION_KEY_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/
const DECISION_STATUS_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const SHOTGRID_ENTITY_TYPE_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const COLLABORATION_ROOM_ID_PATTERN = /^r1_[A-Za-z0-9_-]{43}$/
const COLLABORATION_SOCKET_URL_PATTERN =
	/^\/api\/review\/sync\/(r1_[A-Za-z0-9_-]{43})\?ticket=([A-Za-z0-9_-]{43})$/
const COLLABORATION_HUMAN_USER_ID_PATTERN = /^user:shotgrid-human-([1-9][0-9]*)$/
const COLLABORATION_SERVICE_USER_ID_PATTERN = /^user:shotgrid-service-[0-9a-f]{8}$/
const REVIEW_COLLABORATION_COLORS = new Set([
	'#FF6B6B',
	'#4ECDC4',
	'#45B7D1',
	'#96CEB4',
	'#FFEAA7',
	'#DDA0DD',
	'#FF9F43',
	'#6C5CE7',
])
const REVIEW_CHANGE_ENTITY_TYPES = new Set(['Project', 'Playlist', 'Version', 'Note', 'Attachment'])
const REVIEW_CHANGE_OPERATIONS = new Set(['create', 'update', 'delete', 'revive'])
const MAX_REVIEW_CHANGE_SOURCE_EVENT_ID_LENGTH = 255
const MAX_REVIEW_CHANGE_ATTRIBUTE_NAME_LENGTH = 255

export function isReviewApiDataEnvelope<T>(
	value: unknown,
	isData: ReviewRuntimeGuard<T>
): value is ReviewApiDataEnvelope<T> {
	const record = readRecord(value)
	return (
		record !== null &&
		hasOnlyKeys(record, ['data']) &&
		hasOwn(record, 'data') &&
		isData(record.data)
	)
}

export function isReviewArrayOf<T>(value: unknown, isItem: ReviewRuntimeGuard<T>): value is T[] {
	return Array.isArray(value) && value.every((item) => isItem(item))
}

export function isReviewHealth(value: unknown): value is ReviewHealth {
	const record = readRecord(value)
	return (
		record !== null &&
		hasOnlyKeys(record, ['mode', 'status']) &&
		(record.mode === 'mock' || record.mode === 'shotgrid') &&
		record.status === 'ok'
	)
}

export function isReviewChangeEvent(value: unknown): value is ReviewChangeEvent {
	const record = readRecord(value)
	if (
		record === null ||
		!hasOnlyKeys(record, [
			'attributeName',
			'entity',
			'eventLogEntryId',
			'observedAt',
			'operation',
			'projectId',
			'sequence',
			'sourceEventId',
		]) ||
		!isPositiveId(record.sequence) ||
		!isPositiveId(record.eventLogEntryId) ||
		!isBoundedReviewChangeSourceEventId(record.sourceEventId) ||
		!isPositiveId(record.projectId) ||
		typeof record.operation !== 'string' ||
		!REVIEW_CHANGE_OPERATIONS.has(record.operation) ||
		!isNullableReviewChangeAttributeName(record.attributeName) ||
		!isCanonicalIsoTimestamp(record.observedAt)
	) {
		return false
	}

	const entity = readRecord(record.entity)
	return (
		entity !== null &&
		hasOnlyKeys(entity, ['id', 'type']) &&
		isPositiveId(entity.id) &&
		typeof entity.type === 'string' &&
		REVIEW_CHANGE_ENTITY_TYPES.has(entity.type)
	)
}

export function isReviewChangeNotification(value: unknown): value is ReviewChangeNotification {
	const record = readRecord(value)
	return record !== null && hasOnlyKeys(record, ['sequence']) && isPositiveId(record.sequence)
}

export function isReviewCollaborationSession(value: unknown): value is ReviewCollaborationSession {
	const record = readRecord(value)
	if (
		record === null ||
		!hasOnlyKeys(record, ['permission', 'roomId', 'socketUrl', 'ticketExpiresAt']) ||
		typeof record.roomId !== 'string' ||
		!COLLABORATION_ROOM_ID_PATTERN.test(record.roomId) ||
		(record.permission !== 'editor' && record.permission !== 'viewer') ||
		typeof record.socketUrl !== 'string' ||
		!isCanonicalIsoTimestamp(record.ticketExpiresAt)
	) {
		return false
	}

	const socketUrlMatch = COLLABORATION_SOCKET_URL_PATTERN.exec(record.socketUrl)
	return socketUrlMatch !== null && socketUrlMatch[1] === record.roomId
}

export function isReviewCollaborationPresence(
	value: unknown
): value is ReviewCollaborationPresence {
	const record = readRecord(value)
	if (
		record === null ||
		!hasOnlyKeys(record, ['color', 'userId', 'userName']) ||
		typeof record.userId !== 'string' ||
		!isNonEmptyString(record.userName) ||
		typeof record.color !== 'string' ||
		!REVIEW_COLLABORATION_COLORS.has(record.color)
	) {
		return false
	}

	const humanMatch = COLLABORATION_HUMAN_USER_ID_PATTERN.exec(record.userId)
	return humanMatch !== null
		? isPositiveId(Number(humanMatch[1]))
		: COLLABORATION_SERVICE_USER_ID_PATTERN.test(record.userId)
}

export function isReviewUser(value: unknown): value is ReviewUser {
	const record = readRecord(value)
	return (
		record !== null &&
		hasOnlyKeys(record, ['avatarUrl', 'id', 'kind', 'login', 'name']) &&
		(record.id === null || isPositiveId(record.id)) &&
		(record.kind === 'human' || record.kind === 'service') &&
		isNonEmptyString(record.name) &&
		isNullableString(record.login) &&
		isNullableSafeReviewUrl(record.avatarUrl)
	)
}

export function isReviewProject(value: unknown): value is ReviewProject {
	const record = readRecord(value)
	return (
		record !== null &&
		hasOnlyKeys(record, ['id', 'name', 'statusCode', 'thumbnailUrl']) &&
		isPositiveId(record.id) &&
		isNonEmptyString(record.name) &&
		isNullableString(record.statusCode) &&
		isNullableSafeReviewUrl(record.thumbnailUrl)
	)
}

export function isReviewPlaylist(value: unknown): value is ReviewPlaylist {
	const record = readRecord(value)
	return (
		record !== null &&
		hasOnlyKeys(record, ['description', 'id', 'name', 'projectId', 'updatedAt', 'versionCount']) &&
		isPositiveId(record.id) &&
		isPositiveId(record.projectId) &&
		isNonEmptyString(record.name) &&
		isNullableString(record.description) &&
		Number.isSafeInteger(record.versionCount) &&
		Number(record.versionCount) >= 0 &&
		isNonEmptyString(record.updatedAt)
	)
}

export function isReviewEntityLink(value: unknown): value is ReviewEntityLink {
	const record = readRecord(value)
	return (
		record !== null &&
		hasOnlyKeys(record, ['id', 'name', 'type']) &&
		isPositiveId(record.id) &&
		isNonEmptyString(record.type) &&
		isNonEmptyString(record.name)
	)
}

export function isReviewTaskLink(value: unknown): value is ReviewTaskLink {
	const record = readRecord(value)
	return (
		record !== null &&
		hasOnlyKeys(record, ['id', 'name']) &&
		isPositiveId(record.id) &&
		isNonEmptyString(record.name)
	)
}

export function isReviewPublicationLinks(value: unknown): value is ReviewPublicationLinks {
	const record = readRecord(value)
	return (
		record !== null &&
		hasOnlyKeys(record, ['entity', 'project', 'task', 'version']) &&
		isTypedReviewEntityLink(record.project, 'Project') &&
		isTypedReviewEntityLink(record.version, 'Version') &&
		(record.entity === null || isReviewEntityLink(record.entity)) &&
		(record.task === null || isReviewTaskLink(record.task))
	)
}

export function isReviewNoteOptions(value: unknown): value is ReviewNoteOptions {
	const record = readRecord(value)
	return (
		record !== null &&
		hasOnlyKeys(record, ['links', 'recipients']) &&
		isReviewArrayOf(record.recipients, isHumanReviewRecipient) &&
		isReviewPublicationLinks(record.links)
	)
}

export function isReviewNote(value: unknown): value is ReviewNote {
	const record = readRecord(value)
	return (
		record !== null &&
		hasOnlyKeys(record, [
			'content',
			'createdAt',
			'createdBy',
			'frame',
			'id',
			'projectId',
			'subject',
			'versionId',
		]) &&
		isPositiveId(record.id) &&
		isPositiveId(record.projectId) &&
		isPositiveId(record.versionId) &&
		isNonEmptyString(record.subject) &&
		isNonEmptyString(record.content) &&
		(record.frame === null || isNonNegativeInteger(record.frame)) &&
		isNonEmptyString(record.createdAt) &&
		isReviewUser(record.createdBy)
	)
}

export function isReviewDecisionOption(value: unknown): value is ReviewDecisionOption {
	const record = readRecord(value)
	return (
		record !== null &&
		hasOnlyKeys(record, ['key', 'label', 'statusCode']) &&
		isDecisionKey(record.key) &&
		isDecisionLabel(record.label) &&
		isDecisionStatusCode(record.statusCode)
	)
}

export function isReviewDecisionHistoryEntry(value: unknown): value is ReviewDecisionHistoryEntry {
	const record = readRecord(value)
	return (
		record !== null &&
		hasOnlyKeys(record, [
			'decidedAt',
			'decisionKey',
			'id',
			'previousStatusCode',
			'resultingStatusCode',
			'reviewer',
		]) &&
		isPositiveId(record.id) &&
		(record.decisionKey === null || isDecisionKey(record.decisionKey)) &&
		isBoundedTimestamp(record.decidedAt) &&
		(record.reviewer === null ||
			(isReviewUser(record.reviewer) && isBoundedPublicationUser(record.reviewer))) &&
		isNullableDecisionStatusCode(record.previousStatusCode) &&
		isNullableDecisionStatusCode(record.resultingStatusCode)
	)
}

export function isReviewDecisionContext(value: unknown): value is ReviewDecisionContext {
	const record = readRecord(value)
	if (
		record === null ||
		!hasOnlyKeys(record, [
			'currentStatusCode',
			'decisions',
			'history',
			'historyTruncated',
			'playlistId',
			'versionId',
		]) ||
		!isPositiveId(record.playlistId) ||
		!isPositiveId(record.versionId) ||
		!isNullableDecisionStatusCode(record.currentStatusCode) ||
		!Array.isArray(record.decisions) ||
		record.decisions.length === 0 ||
		record.decisions.length > MAX_DECISION_OPTIONS ||
		!record.decisions.every(isReviewDecisionOption) ||
		!Array.isArray(record.history) ||
		record.history.length > MAX_DECISION_HISTORY_ENTRIES ||
		!record.history.every(isReviewDecisionHistoryEntry) ||
		typeof record.historyTruncated !== 'boolean'
	) {
		return false
	}

	const decisions = record.decisions as ReviewDecisionOption[]
	if (
		new Set(decisions.map(({ key }) => key)).size !== decisions.length ||
		new Set(decisions.map(({ statusCode }) => statusCode)).size !== decisions.length
	) {
		return false
	}
	const decisionsByStatus = new Map(decisions.map((decision) => [decision.statusCode, decision]))
	const history = record.history as ReviewDecisionHistoryEntry[]
	if (new Set(history.map(({ id }) => id)).size !== history.length) return false
	return history.every(({ decisionKey, resultingStatusCode }) => {
		const expectedDecisionKey =
			resultingStatusCode === null
				? null
				: (decisionsByStatus.get(resultingStatusCode)?.key ?? null)
		return decisionKey === expectedDecisionKey
	})
}

export function isReviewDecisionRequest(value: unknown): value is ReviewDecisionRequest {
	const record = readRecord(value)
	return (
		record !== null &&
		hasOnlyKeys(record, ['decisionKey', 'expectedStatusCode']) &&
		isDecisionKey(record.decisionKey) &&
		isNullableDecisionStatusCode(record.expectedStatusCode)
	)
}

export function isReviewDecisionResult(value: unknown): value is ReviewDecisionResult {
	const record = readRecord(value)
	if (
		record === null ||
		!hasOnlyKeys(record, [
			'changed',
			'decisionKey',
			'playlistId',
			'previousStatusCode',
			'reviewer',
			'statusCode',
			'updatedAt',
			'versionId',
		]) ||
		typeof record.changed !== 'boolean'
	) {
		return false
	}
	if (
		!isPositiveId(record.playlistId) ||
		!isPositiveId(record.versionId) ||
		!isDecisionKey(record.decisionKey) ||
		!isNullableDecisionStatusCode(record.previousStatusCode) ||
		!isDecisionStatusCode(record.statusCode) ||
		!(record.updatedAt === null || isBoundedTimestamp(record.updatedAt)) ||
		!(
			record.reviewer === null ||
			(isReviewUser(record.reviewer) && isBoundedPublicationUser(record.reviewer))
		)
	) {
		return false
	}
	return record.changed
		? record.previousStatusCode !== record.statusCode &&
				record.updatedAt !== null &&
				record.reviewer !== null &&
				record.reviewer.kind === 'human'
		: record.previousStatusCode === record.statusCode &&
				record.updatedAt === null &&
				record.reviewer === null
}

export function isReviewAttachmentResult(value: unknown): value is ReviewAttachmentResult {
	const record = readRecord(value)
	return (
		record !== null &&
		hasOnlyKeys(record, ['contentType', 'fileName', 'id', 'noteId', 'sizeBytes']) &&
		(record.id === null || isPositiveId(record.id)) &&
		isPositiveId(record.noteId) &&
		isNonEmptyString(record.fileName) &&
		isNonEmptyString(record.contentType) &&
		isNonNegativeInteger(record.sizeBytes)
	)
}

export function isReviewPublicationResult(value: unknown): value is ReviewPublicationResult {
	const record = readRecord(value)
	return (
		record !== null &&
		hasOnlyKeys(record, ['attachment', 'links', 'note', 'publicationId', 'status']) &&
		isCanonicalUuid(record.publicationId) &&
		record.status === 'complete' &&
		isBoundedPublicationNote(record.note) &&
		isReviewAttachmentResult(record.attachment) &&
		record.attachment.noteId === record.note.id &&
		record.attachment.contentType === 'image/png' &&
		record.attachment.fileName.length <= MAX_PUBLICATION_DISPLAY_TEXT_LENGTH &&
		isPngBasename(record.attachment.fileName) &&
		record.attachment.sizeBytes > 0 &&
		record.attachment.sizeBytes <= MAX_PUBLICATION_ATTACHMENT_BYTES &&
		isBoundedPublicationLinks(record.links) &&
		record.note.projectId === record.links.project.id &&
		record.note.versionId === record.links.version.id
	)
}

export function isReviewVersion(value: unknown): value is ReviewVersion {
	const record = readRecord(value)
	return (
		record !== null &&
		hasOnlyKeys(record, [
			'createdAt',
			'createdBy',
			'description',
			'entity',
			'id',
			'media',
			'name',
			'playlistId',
			'projectId',
			'statusCode',
			'submittedBy',
			'task',
		]) &&
		isPositiveId(record.id) &&
		isPositiveId(record.projectId) &&
		(record.playlistId === null || isPositiveId(record.playlistId)) &&
		isNonEmptyString(record.name) &&
		isNullableString(record.description) &&
		isNullableString(record.statusCode) &&
		isNonEmptyString(record.createdAt) &&
		(record.createdBy === null || isReviewUser(record.createdBy)) &&
		(record.submittedBy === null || isReviewUser(record.submittedBy)) &&
		(record.entity === null || isReviewEntityLink(record.entity)) &&
		(record.task === null || isReviewTaskLink(record.task)) &&
		(record.media === null ||
			(isReviewMedia(record.media) &&
				isReviewMediaBoundToVersion(record.media, record.playlistId, record.id)))
	)
}

export function isReviewApiErrorCode(value: unknown): value is ReviewApiErrorCode {
	return typeof value === 'string' && reviewApiErrorCodes.has(value)
}

export function isReviewApiErrorEnvelope(value: unknown): value is ReviewApiErrorEnvelope {
	const envelope = readRecord(value)
	if (!envelope || !hasOnlyKeys(envelope, ['error'])) return false

	const error = readRecord(envelope.error)
	if (
		!error ||
		!hasOnlyKeys(error, [
			'code',
			'message',
			'publication',
			'requestId',
			'retryable',
			'upstreamStatus',
		]) ||
		!isReviewApiErrorCode(error.code) ||
		typeof error.message !== 'string' ||
		typeof error.retryable !== 'boolean'
	) {
		return false
	}
	if (
		hasOwn(error, 'publication') &&
		(error.code !== 'PUBLICATION_INDETERMINATE' ||
			!isReviewPublicationErrorContext(error.publication))
	) {
		return false
	}
	if (
		hasOwn(error, 'upstreamStatus') &&
		(!Number.isSafeInteger(error.upstreamStatus) ||
			Number(error.upstreamStatus) < 100 ||
			Number(error.upstreamStatus) > 599)
	) {
		return false
	}
	return !hasOwn(error, 'requestId') || isNonEmptyString(error.requestId)
}

export function isReviewPublicationErrorContext(
	value: unknown
): value is ReviewPublicationErrorContext {
	const record = readRecord(value)
	if (!record || !isCanonicalUuid(record.publicationId)) return false
	if (record.stage === 'note-creation') {
		return hasOnlyKeys(record, ['publicationId', 'stage'])
	}
	if (record.stage === 'note-created') {
		return (
			hasOnlyKeys(record, ['links', 'noteId', 'publicationId', 'stage']) &&
			isPositiveId(record.noteId) &&
			isBoundedPublicationLinks(record.links)
		)
	}
	return (
		record.stage === 'attachment-completion' &&
		hasOnlyKeys(record, ['attachmentId', 'links', 'noteId', 'publicationId', 'stage']) &&
		(!hasOwn(record, 'attachmentId') || isPositiveId(record.attachmentId)) &&
		isPositiveId(record.noteId) &&
		isBoundedPublicationLinks(record.links)
	)
}

function isBoundedPublicationNote(value: unknown): value is ReviewNote {
	return (
		isReviewNote(value) &&
		value.subject.length <= MAX_PUBLICATION_DISPLAY_TEXT_LENGTH &&
		value.content.length <= MAX_PUBLICATION_CONTENT_LENGTH &&
		value.createdAt.length <= MAX_PUBLICATION_TIMESTAMP_LENGTH &&
		Number.isFinite(Date.parse(value.createdAt)) &&
		isBoundedPublicationUser(value.createdBy)
	)
}

function isBoundedPublicationUser(value: ReviewUser) {
	return (
		value.name.length <= MAX_PUBLICATION_DISPLAY_TEXT_LENGTH &&
		(value.login === null || value.login.length <= MAX_PUBLICATION_DISPLAY_TEXT_LENGTH)
	)
}

function isDecisionKey(value: unknown): value is string {
	return typeof value === 'string' && DECISION_KEY_PATTERN.test(value)
}

function isDecisionLabel(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.trim() === value &&
		value.length > 0 &&
		value.length <= MAX_DECISION_LABEL_LENGTH &&
		!/[\p{Bidi_Control}\p{Cc}]/u.test(value)
	)
}

function isDecisionStatusCode(value: unknown): value is string {
	return typeof value === 'string' && DECISION_STATUS_CODE_PATTERN.test(value)
}

function isNullableDecisionStatusCode(value: unknown): value is string | null {
	return value === null || isDecisionStatusCode(value)
}

function isBoundedTimestamp(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= MAX_PUBLICATION_TIMESTAMP_LENGTH &&
		Number.isFinite(Date.parse(value))
	)
}

function isCanonicalIsoTimestamp(value: unknown): value is string {
	if (typeof value !== 'string' || value.length !== 24) return false
	const parsed = new Date(value)
	return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value
}

function isBoundedReviewChangeSourceEventId(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= MAX_REVIEW_CHANGE_SOURCE_EVENT_ID_LENGTH &&
		value.trim() === value &&
		!/[\p{Bidi_Control}\p{Cc}]/u.test(value)
	)
}

function isNullableReviewChangeAttributeName(value: unknown): value is string | null {
	return (
		value === null ||
		(typeof value === 'string' &&
			value.length <= MAX_REVIEW_CHANGE_ATTRIBUTE_NAME_LENGTH &&
			!/[\p{Bidi_Control}\p{Cc}]/u.test(value))
	)
}

function isBoundedPublicationLinks(value: unknown): value is ReviewPublicationLinks {
	return (
		isReviewPublicationLinks(value) &&
		isBoundedPublicationEntityLink(value.project) &&
		isBoundedPublicationEntityLink(value.version) &&
		(value.entity === null || isBoundedPublicationEntityLink(value.entity)) &&
		(value.task === null || value.task.name.length <= MAX_PUBLICATION_DISPLAY_TEXT_LENGTH)
	)
}

function isBoundedPublicationEntityLink(value: ReviewEntityLink) {
	return (
		value.name.length <= MAX_PUBLICATION_DISPLAY_TEXT_LENGTH &&
		SHOTGRID_ENTITY_TYPE_PATTERN.test(value.type)
	)
}

export function isSafeReviewUrl(value: unknown): value is string {
	if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) return false
	if (hasUnsafeUrlCharacter(value)) return false
	if (value.startsWith('/')) return !value.startsWith('//')
	if (!/^https:\/\//i.test(value)) return false

	try {
		const url = new URL(value)
		return url.protocol === 'https:' && url.username === '' && url.password === ''
	} catch {
		return false
	}
}

function isReviewMedia(value: unknown): value is ReviewMedia {
	const record = readRecord(value)
	if (!record) return false
	if (record.kind === 'image') return isReviewImageMedia(record)
	if (record.kind === 'video') return isReviewVideoMedia(record)
	return false
}

function isReviewMediaBoundToVersion(media: ReviewMedia, playlistId: unknown, versionId: unknown) {
	if (media.kind === 'image') return true
	if (!isPositiveId(playlistId) || !isPositiveId(versionId)) return false
	const base = `/review/playlists/${playlistId}/versions/${versionId}/media`
	return (
		media.url === `${base}/video/${media.attachmentId}` &&
		(media.thumbnailUrl === null || media.thumbnailUrl === `${base}/image`)
	)
}

function isReviewImageMedia(value: unknown): value is ReviewImageMedia {
	const record = readRecord(value)
	return (
		record !== null &&
		hasOnlyKeys(record, ['contentType', 'height', 'kind', 'thumbnailUrl', 'url', 'width']) &&
		record.kind === 'image' &&
		isMediaBase(record) &&
		isNullableFiniteNumber(record.width) &&
		isNullableFiniteNumber(record.height)
	)
}

function isReviewVideoMedia(value: unknown): value is ReviewVideoMedia {
	const record = readRecord(value)
	return (
		record !== null &&
		hasOnlyKeys(record, [
			'attachmentId',
			'contentType',
			'durationSeconds',
			'fileName',
			'firstFrame',
			'frameCount',
			'frameRate',
			'frameRateMode',
			'height',
			'kind',
			'lastFrame',
			'thumbnailUrl',
			'url',
			'width',
		]) &&
		record.kind === 'video' &&
		isMediaBase(record) &&
		isPositiveId(record.attachmentId) &&
		isMp4Basename(record.fileName) &&
		record.contentType === 'video/mp4' &&
		isNullablePositiveFiniteNumber(record.width) &&
		isNullablePositiveFiniteNumber(record.height) &&
		isNullablePositiveFiniteNumber(record.durationSeconds) &&
		isNullablePositiveInteger(record.frameCount) &&
		isNullablePositiveFiniteNumber(record.frameRate) &&
		(record.frameRateMode === 'constant' ||
			record.frameRateMode === 'unknown' ||
			record.frameRateMode === 'variable') &&
		isNullableNonNegativeInteger(record.firstFrame) &&
		isNullableNonNegativeInteger(record.lastFrame) &&
		(record.firstFrame === null ||
			record.lastFrame === null ||
			Number(record.lastFrame) >= Number(record.firstFrame))
	)
}

function isMediaBase(record: Record<string, unknown>) {
	return (
		isSafeReviewUrl(record.url) &&
		isNullableSafeReviewUrl(record.thumbnailUrl) &&
		isNonEmptyString(record.contentType)
	)
}

function readRecord(value: unknown): Record<string, unknown> | null {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
	const prototype = Object.getPrototypeOf(value)
	return prototype === Object.prototype || prototype === null
		? (value as Record<string, unknown>)
		: null
}

function hasOnlyKeys(record: Record<string, unknown>, allowedKeys: readonly string[]) {
	return Object.keys(record).every((key) => allowedKeys.includes(key))
}

function hasOwn(record: Record<string, unknown>, key: string) {
	return Object.prototype.hasOwnProperty.call(record, key)
}

function isPositiveId(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) > 0
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim().length > 0
}

function isNullableString(value: unknown): value is string | null {
	return value === null || typeof value === 'string'
}

function isNullableSafeReviewUrl(value: unknown): value is string | null {
	return value === null || isSafeReviewUrl(value)
}

function isNullableFiniteNumber(value: unknown): value is number | null {
	return value === null || (typeof value === 'number' && Number.isFinite(value))
}

function isNullablePositiveFiniteNumber(value: unknown): value is number | null {
	return value === null || (typeof value === 'number' && Number.isFinite(value) && value > 0)
}

function isNullablePositiveInteger(value: unknown): value is number | null {
	return value === null || (Number.isSafeInteger(value) && Number(value) > 0)
}

function isNullableNonNegativeInteger(value: unknown): value is number | null {
	return value === null || isNonNegativeInteger(value)
}

function isTypedReviewEntityLink(value: unknown, expectedType: string) {
	return isReviewEntityLink(value) && value.type === expectedType
}

function isHumanReviewRecipient(value: unknown): value is ReviewUser {
	return isReviewUser(value) && value.kind === 'human' && value.id !== null
}

function isNonNegativeInteger(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) >= 0
}

function isCanonicalUuid(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
	)
}

function isPngBasename(value: string) {
	return (
		value.toLowerCase().endsWith('.png') &&
		value !== '.' &&
		value !== '..' &&
		value === value.replaceAll('\\', '/').split('/').at(-1) &&
		!/[\p{Bidi_Control}\p{Cc}]/u.test(value)
	)
}

function isMp4Basename(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= MAX_MEDIA_FILE_NAME_LENGTH &&
		value.trim() === value &&
		value.toLowerCase().endsWith('.mp4') &&
		value !== '.' &&
		value !== '..' &&
		value === value.replaceAll('\\', '/').split('/').at(-1) &&
		!/[\p{Bidi_Control}\p{Cc}]/u.test(value)
	)
}

function hasUnsafeUrlCharacter(value: string) {
	for (const character of value) {
		const codePoint = character.codePointAt(0)
		if (character === '\\' || codePoint === undefined || codePoint <= 0x1f || codePoint === 0x7f) {
			return true
		}
	}
	return false
}
