import { statfsSync } from 'node:fs'
import type { ReviewCollaborationService } from '../collaboration/ReviewCollaborationService'
import type {
	ShotGridEventSyncService,
	ShotGridEventSyncStatus,
} from '../webhooks/ShotGridEventSyncService'

export interface ReviewErrorLogContext {
	code: string
	requestId: string
	status: number
}

export interface ReviewRequestLogContext {
	durationMs: number
	method: string
	requestId: string
	route: ReviewRouteName
	status: number
}

export interface ReviewLogger {
	error(message: string, context: ReviewErrorLogContext): void
	info?(message: string, context: ReviewRequestLogContext): void
}

interface JsonLogWriter {
	stderr(line: string): void
	stdout(line: string): void
}

export class JsonReviewLogger implements ReviewLogger {
	constructor(
		private readonly writer: JsonLogWriter = {
			stderr: (line) => process.stderr.write(line),
			stdout: (line) => process.stdout.write(line),
		},
		private readonly now: () => number = Date.now
	) {}

	error(message: string, context: ReviewErrorLogContext) {
		this.write('stderr', {
			code: context.code,
			event: message,
			level: 'error',
			requestId: context.requestId,
			status: context.status,
		})
	}

	info(message: string, context: ReviewRequestLogContext) {
		this.write('stdout', {
			durationMs: context.durationMs,
			event: message,
			level: 'info',
			method: context.method,
			requestId: context.requestId,
			route: context.route,
			status: context.status,
		})
	}

	lifecycle(
		event: 'server_listening' | 'shutdown_complete' | 'shutdown_failed' | 'shutdown_requested',
		context: { mode: 'mock' | 'shotgrid'; port: number; signal?: 'SIGINT' | 'SIGTERM' }
	) {
		this.write(event === 'shutdown_failed' ? 'stderr' : 'stdout', {
			event,
			level: event === 'shutdown_failed' ? 'error' : 'info',
			mode: context.mode,
			port: context.port,
			...(context.signal === undefined ? undefined : { signal: context.signal }),
		})
	}

	private write(stream: keyof JsonLogWriter, fields: Record<string, unknown>) {
		this.writer[stream](
			`${JSON.stringify({ timestamp: new Date(this.now()).toISOString(), ...fields })}\n`
		)
	}
}

export type ReviewRouteName =
	| 'collaboration_session'
	| 'decision'
	| 'decision_context'
	| 'event_changes'
	| 'event_sync_status'
	| 'health'
	| 'media_image'
	| 'media_video'
	| 'metrics'
	| 'note_options'
	| 'playlist_versions'
	| 'project_playlists'
	| 'projects'
	| 'publication'
	| 'reviewer'
	| 'unknown'
	| 'version'
	| 'webhook'

export function classifyReviewRoute(pathname: string): ReviewRouteName {
	if (pathname === '/internal/metrics') return 'metrics'
	if (pathname === '/api/health') return 'health'
	if (pathname === '/api/webhooks/shotgrid') return 'webhook'
	if (pathname === '/api/review/event-sync-status') return 'event_sync_status'
	if (pathname === '/api/review/changes') return 'event_changes'
	if (pathname === '/api/review/me') return 'reviewer'
	if (pathname === '/api/review/projects') return 'projects'
	if (/^\/api\/review\/projects\/[^/]+\/playlists$/.test(pathname)) {
		return 'project_playlists'
	}
	if (/^\/api\/review\/playlists\/[^/]+\/versions$/.test(pathname)) {
		return 'playlist_versions'
	}
	if (/^\/api\/review\/playlists\/[^/]+\/versions\/[^/]+\/collaboration-session$/.test(pathname)) {
		return 'collaboration_session'
	}
	if (/^\/api\/review\/playlists\/[^/]+\/versions\/[^/]+\/media\/image$/.test(pathname)) {
		return 'media_image'
	}
	if (/^\/api\/review\/playlists\/[^/]+\/versions\/[^/]+\/media\/video\/[^/]+$/.test(pathname)) {
		return 'media_video'
	}
	if (/^\/api\/review\/playlists\/[^/]+\/versions\/[^/]+\/note-options$/.test(pathname)) {
		return 'note_options'
	}
	if (/^\/api\/review\/playlists\/[^/]+\/versions\/[^/]+\/decision-context$/.test(pathname)) {
		return 'decision_context'
	}
	if (/^\/api\/review\/playlists\/[^/]+\/versions\/[^/]+\/decision$/.test(pathname)) {
		return 'decision'
	}
	if (/^\/api\/review\/playlists\/[^/]+\/versions\/[^/]+\/publications\/[^/]+$/.test(pathname)) {
		return 'publication'
	}
	if (/^\/api\/review\/playlists\/[^/]+\/versions\/[^/]+$/.test(pathname)) {
		return 'version'
	}
	return 'unknown'
}

interface RequestMetric {
	durationMs: number
	method: string
	route: ReviewRouteName
	status: number
	total: number
}

interface ReviewMetricsDependencies {
	collaboration?: ReviewCollaborationService
	eventSync?: ShotGridEventSyncService
	storeDirectories?: ReviewStoreDirectories
}

export type ReviewStoreName = 'audit' | 'events' | 'publications' | 'sync'
export type ReviewStoreDirectories = Partial<Record<ReviewStoreName, string>>

export class ReviewMetrics {
	private inFlightRequests = 0
	private readonly requestMetrics = new Map<string, RequestMetric>()
	private readonly startedAtMs: number

	constructor(private readonly now: () => number = Date.now) {
		this.startedAtMs = now()
	}

	beginRequest(method: string, route: () => ReviewRouteName) {
		const safeMethod = normalizeMethod(method)
		const startedAtMs = this.now()
		let finished = false
		this.inFlightRequests += 1
		return (status: number) => {
			if (finished) return
			finished = true
			this.inFlightRequests = Math.max(0, this.inFlightRequests - 1)
			const safeStatus = normalizeStatus(status)
			const safeRoute = route()
			const key = `${safeMethod}\0${safeRoute}\0${safeStatus}`
			const existing = this.requestMetrics.get(key)
			const durationMs = Math.max(0, this.now() - startedAtMs)
			if (existing) {
				existing.durationMs += durationMs
				existing.total += 1
				return
			}
			this.requestMetrics.set(key, {
				durationMs,
				method: safeMethod,
				route: safeRoute,
				status: safeStatus,
				total: 1,
			})
		}
	}

	render({ collaboration, eventSync, storeDirectories }: ReviewMetricsDependencies = {}) {
		const lines = [
			'# HELP shotgrid_review_api_process_uptime_seconds Process uptime in seconds.',
			'# TYPE shotgrid_review_api_process_uptime_seconds gauge',
			metric('shotgrid_review_api_process_uptime_seconds', (this.now() - this.startedAtMs) / 1_000),
			'# HELP shotgrid_review_api_process_resident_memory_bytes Resident memory in bytes.',
			'# TYPE shotgrid_review_api_process_resident_memory_bytes gauge',
			metric('shotgrid_review_api_process_resident_memory_bytes', process.memoryUsage().rss),
			'# HELP shotgrid_review_api_http_requests_in_flight Current HTTP requests.',
			'# TYPE shotgrid_review_api_http_requests_in_flight gauge',
			metric('shotgrid_review_api_http_requests_in_flight', this.inFlightRequests),
			'# HELP shotgrid_review_api_http_requests_total Completed HTTP requests.',
			'# TYPE shotgrid_review_api_http_requests_total counter',
			'# HELP shotgrid_review_api_http_request_duration_seconds_total Cumulative HTTP request time.',
			'# TYPE shotgrid_review_api_http_request_duration_seconds_total counter',
		]
		const requestMetrics = [...this.requestMetrics.values()].sort((left, right) =>
			`${left.method}\0${left.route}\0${left.status}`.localeCompare(
				`${right.method}\0${right.route}\0${right.status}`
			)
		)
		for (const request of requestMetrics) {
			const labels = {
				method: request.method,
				route: request.route,
				status: String(request.status),
			}
			lines.push(metric('shotgrid_review_api_http_requests_total', request.total, labels))
			lines.push(
				metric(
					'shotgrid_review_api_http_request_duration_seconds_total',
					request.durationMs / 1_000,
					labels
				)
			)
		}
		lines.push(
			'# HELP shotgrid_review_api_collaboration_active_rooms Current open collaboration rooms.',
			'# TYPE shotgrid_review_api_collaboration_active_rooms gauge',
			metric(
				'shotgrid_review_api_collaboration_active_rooms',
				collaboration?.getActiveRoomCount() ?? 0
			)
		)
		if (eventSync) appendEventSyncMetrics(lines, eventSync.getStatus(), eventSync.isReady())
		if (storeDirectories) appendStoreFilesystemMetrics(lines, storeDirectories)
		return `${lines.join('\n')}\n`
	}
}

function appendStoreFilesystemMetrics(lines: string[], directories: ReviewStoreDirectories) {
	lines.push(
		'# HELP shotgrid_review_api_store_filesystem_available_bytes Bytes available to the service account.',
		'# TYPE shotgrid_review_api_store_filesystem_available_bytes gauge',
		'# HELP shotgrid_review_api_store_filesystem_free_inodes Free filesystem inodes.',
		'# TYPE shotgrid_review_api_store_filesystem_free_inodes gauge',
		'# HELP shotgrid_review_api_store_filesystem_stat_error Whether filesystem capacity inspection failed.',
		'# TYPE shotgrid_review_api_store_filesystem_stat_error gauge'
	)
	for (const store of ['audit', 'events', 'publications', 'sync'] as const) {
		const directory = directories[store]
		if (directory === undefined) continue
		try {
			const status = statfsSync(directory, { bigint: true })
			lines.push(
				metric(
					'shotgrid_review_api_store_filesystem_available_bytes',
					Number(status.bavail * status.bsize),
					{ store }
				),
				metric('shotgrid_review_api_store_filesystem_free_inodes', Number(status.ffree), {
					store,
				}),
				metric('shotgrid_review_api_store_filesystem_stat_error', 0, { store })
			)
		} catch {
			lines.push(metric('shotgrid_review_api_store_filesystem_stat_error', 1, { store }))
		}
	}
}

function appendEventSyncMetrics(lines: string[], status: ShotGridEventSyncStatus, ready: boolean) {
	lines.push(
		'# HELP shotgrid_review_api_event_sync_ready Whether webhook processing can accept work.',
		'# TYPE shotgrid_review_api_event_sync_ready gauge',
		metric('shotgrid_review_api_event_sync_ready', ready ? 1 : 0),
		metric('shotgrid_review_api_event_sync_queue_depth', status.queue.depth),
		metric('shotgrid_review_api_event_sync_queue_bytes', status.queue.bytes),
		metric(
			'shotgrid_review_api_event_sync_queue_oldest_age_seconds',
			status.queue.oldestAgeMs / 1_000
		),
		metric('shotgrid_review_api_event_sync_connected_clients', status.connectedClients),
		metric('shotgrid_review_api_event_sync_latest_sequence', status.latestSequence),
		metric('shotgrid_review_api_event_sync_state', 1, { state: status.state })
	)
	const counters: Array<[string, number]> = [
		['accepted_events', status.counters.acceptedEvents],
		['conflicting_deliveries', status.counters.conflictingDeliveries],
		['conflicting_events', status.counters.conflictingEvents],
		['duplicate_deliveries', status.counters.duplicateDeliveries],
		['duplicate_events', status.counters.duplicateEvents],
		['failed_events', status.counters.failedEvents],
		['ignored_events', status.counters.ignoredEvents],
		['processed_events', status.counters.processedEvents],
		['received_deliveries', status.counters.receivedDeliveries],
		['retry_attempts', status.counters.retryAttempts],
		['signature_failures', status.counters.signatureFailures],
	]
	for (const [name, value] of counters) {
		lines.push(metric(`shotgrid_review_api_event_sync_${name}_total`, value))
	}
}

function metric(name: string, value: number, labels?: Readonly<Record<string, string>>) {
	const labelText = labels
		? `{${Object.entries(labels)
				.map(([key, label]) => `${key}="${escapeLabel(label)}"`)
				.join(',')}}`
		: ''
	return `${name}${labelText} ${Number.isFinite(value) ? value : 0}`
}

function escapeLabel(value: string) {
	return value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"')
}

function normalizeMethod(method: string) {
	const normalized = method.toUpperCase()
	return ['GET', 'OPTIONS', 'POST', 'PUT'].includes(normalized) ? normalized : 'OTHER'
}

function normalizeStatus(status: number) {
	return Number.isInteger(status) && status >= 100 && status <= 599 ? status : 500
}
