import {
	REVIEW_API_ERROR_CODES,
	type ReviewApiDataEnvelope,
	type ReviewApiErrorCode,
	type ReviewApiErrorEnvelope,
	type ReviewEntityLink,
	type ReviewHealth,
	type ReviewImageMedia,
	type ReviewMedia,
	type ReviewPlaylist,
	type ReviewProject,
	type ReviewTaskLink,
	type ReviewUser,
	type ReviewVersion,
	type ReviewVideoMedia,
} from './contracts'

export type ReviewRuntimeGuard<T> = (value: unknown) => value is T

const reviewApiErrorCodes = new Set<string>(REVIEW_API_ERROR_CODES)

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
		(record.media === null || isReviewMedia(record.media))
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
		!hasOnlyKeys(error, ['code', 'message', 'requestId', 'retryable', 'upstreamStatus']) ||
		!isReviewApiErrorCode(error.code) ||
		typeof error.message !== 'string' ||
		typeof error.retryable !== 'boolean'
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
			'contentType',
			'durationSeconds',
			'firstFrame',
			'frameCount',
			'frameRate',
			'height',
			'kind',
			'lastFrame',
			'thumbnailUrl',
			'url',
			'width',
		]) &&
		record.kind === 'video' &&
		isMediaBase(record) &&
		isNullableFiniteNumber(record.width) &&
		isNullableFiniteNumber(record.height) &&
		isNullableFiniteNumber(record.durationSeconds) &&
		isNullableFiniteNumber(record.frameCount) &&
		isNullableFiniteNumber(record.frameRate) &&
		isNullableFiniteNumber(record.firstFrame) &&
		isNullableFiniteNumber(record.lastFrame)
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

function hasUnsafeUrlCharacter(value: string) {
	for (const character of value) {
		const codePoint = character.codePointAt(0)
		if (character === '\\' || codePoint === undefined || codePoint <= 0x1f || codePoint === 0x7f) {
			return true
		}
	}
	return false
}
