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

const config = parseGatewayConfig()
let gateway: ReviewGateway
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
	gateway = new ShotGridReviewGateway(client, config.shotgrid)
} else {
	gateway = new MockReviewGateway()
}

const server = createReviewApiServer({
	allowedOrigin: config.allowedOrigin,
	decisions: config.decisions,
	gateway,
	mode: config.mode,
	publicationStore,
	...(config.mode === 'shotgrid'
		? {
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
