import { parseGatewayConfig } from './config'
import { MockReviewGateway } from './gateway/MockReviewGateway'
import type { ReviewGateway } from './gateway/ReviewGateway'
import { ShotGridReviewGateway } from './gateway/ShotGridReviewGateway'
import { createReviewApiServer } from './http/createReviewApiServer'
import { ShotGridClient } from './shotgrid/ShotGridClient'

const config = parseGatewayConfig()
let gateway: ReviewGateway

if (config.mode === 'shotgrid') {
	if (!config.shotgrid) throw new Error('ShotGrid configuration is unavailable')
	const client = new ShotGridClient(config.shotgrid)
	gateway = new ShotGridReviewGateway(client, config.shotgrid)
} else {
	gateway = new MockReviewGateway()
}

const server = createReviewApiServer({
	allowedOrigin: config.allowedOrigin,
	gateway,
	mode: config.mode,
	...(config.mode === 'shotgrid'
		? {
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
