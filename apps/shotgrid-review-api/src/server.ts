import { InMemoryReviewAuditStore, SqliteReviewAuditStore } from './audit/ReviewAuditStore'
import { ReviewCollaborationService } from './collaboration/ReviewCollaborationService'
import { parseGatewayConfig } from './config'
import { MockReviewGateway } from './gateway/MockReviewGateway'
import type { ReviewGateway } from './gateway/ReviewGateway'
import { ShotGridReviewGateway } from './gateway/ShotGridReviewGateway'
import { createReviewApiServer } from './http/createReviewApiServer'
import {
	FileReviewPublicationStore,
	InMemoryReviewPublicationStore,
} from './http/ReviewPublicationStore'
import { JsonReviewLogger } from './observability/ReviewObservability'
import { ShotGridClient } from './shotgrid/ShotGridClient'
import { ShotGridEventSyncService } from './webhooks/ShotGridEventSyncService'

const config = parseGatewayConfig()
const logger = new JsonReviewLogger()
let gateway: ReviewGateway
const auditStore =
	config.mode === 'shotgrid'
		? new SqliteReviewAuditStore(config.auditStoreDir, { maxEntries: config.auditMaxEntries })
		: new InMemoryReviewAuditStore()
const publicationStore =
	config.mode === 'shotgrid'
		? new FileReviewPublicationStore(config.publicationStoreDir, {
				maxJournalBytes: config.publicationMaxJournalBytes,
				maxJournalCount: config.publicationMaxJournalCount,
			})
		: new InMemoryReviewPublicationStore()
await publicationStore.initialize()

if (config.mode === 'shotgrid') {
	if (!config.shotgrid) throw new Error('ShotGrid configuration is unavailable')
	const client = new ShotGridClient(config.shotgrid)
	gateway = new ShotGridReviewGateway(client, config.shotgrid, {
		allowedProjectIds: config.allowedProjectIds,
	})
} else {
	gateway = new MockReviewGateway()
}

const collaboration = new ReviewCollaborationService({
	deploymentScope:
		config.mode === 'shotgrid' ? config.shotgrid.siteUrl : `mock:${config.allowedOrigin}`,
	gateway,
	maxRooms: config.collaborationMaxRooms,
	maxSessionsPerRoom: config.collaborationMaxSessionsPerRoom,
	secret: config.collaborationSecret,
	storeDir: config.collaborationStoreDir,
})
const eventSync = new ShotGridEventSyncService(config.eventSync)

const server = createReviewApiServer({
	allowedOrigin: config.allowedOrigin,
	auditStore,
	collaboration,
	decisions: config.decisions,
	eventSync,
	gateway,
	logger,
	metricsToken: config.metricsToken,
	mode: config.mode,
	publicationStore,
	...(config.mode === 'shotgrid'
		? {
				storeDirectories: {
					audit: config.auditStoreDir,
					events: config.eventSync.storeDir,
					publications: config.publicationStoreDir,
					sync: config.collaborationStoreDir,
				},
			}
		: undefined),
	...(config.mode === 'shotgrid'
		? {
				fixedActorSubject: config.fixedActorSubject,
				publicationDeploymentScope: config.shotgrid.siteUrl,
				serviceActorName: config.shotgrid.scriptName,
				...(config.shotgrid?.sudoAsLogin === undefined
					? undefined
					: { sudoAsLogin: config.shotgrid.sudoAsLogin }),
				trustedProxyToken: config.trustedProxyToken,
			}
		: undefined),
})

server.listen(config.port, config.host, () => {
	logger.lifecycle('server_listening', { mode: config.mode, port: config.port })
})

function requestShutdown(signal: 'SIGINT' | 'SIGTERM') {
	logger.lifecycle('shutdown_requested', { mode: config.mode, port: config.port, signal })
	server.close((error) => {
		if (!error) {
			if (auditStore instanceof SqliteReviewAuditStore) auditStore.close()
			logger.lifecycle('shutdown_complete', { mode: config.mode, port: config.port, signal })
			return
		}
		logger.lifecycle('shutdown_failed', { mode: config.mode, port: config.port, signal })
		process.exitCode = 1
	})
}

process.once('SIGINT', () => requestShutdown('SIGINT'))
process.once('SIGTERM', () => requestShutdown('SIGTERM'))
