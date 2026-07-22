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
import { ShotGridClient } from './shotgrid/ShotGridClient'
import { ShotGridEventSyncService } from './webhooks/ShotGridEventSyncService'

const config = parseGatewayConfig()
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
	mode: config.mode,
	publicationStore,
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
	process.stdout.write(
		`ShotGrid review API listening on http://${config.host}:${config.port} (${config.mode} mode)\n`
	)
})

function requestShutdown(signal: 'SIGINT' | 'SIGTERM') {
	process.stdout.write(`ShotGrid review API received ${signal}; closing active review rooms\n`)
	server.close((error) => {
		if (!error) {
			if (auditStore instanceof SqliteReviewAuditStore) auditStore.close()
			return
		}
		process.stderr.write('ShotGrid review API could not shut down cleanly\n')
		process.exitCode = 1
	})
}

process.once('SIGINT', () => requestShutdown('SIGINT'))
process.once('SIGTERM', () => requestShutdown('SIGTERM'))
