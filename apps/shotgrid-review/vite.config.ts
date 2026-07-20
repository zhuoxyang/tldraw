import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'
import { validateViteEnvironment } from './src/publicEnvPolicy'

const DEFAULT_REVIEW_API_DEV_TARGET = 'http://127.0.0.1:5431'

export function parseReviewApiDevTarget(rawValue: string | undefined) {
	const value = rawValue?.trim() || DEFAULT_REVIEW_API_DEV_TARGET
	let url: URL
	try {
		url = new URL(value)
	} catch {
		throw new Error('REVIEW_API_DEV_TARGET must be an absolute HTTP or HTTPS origin')
	}

	if (
		(url.protocol !== 'http:' && url.protocol !== 'https:') ||
		(url.protocol === 'http:' && !isLoopbackHostname(url.hostname)) ||
		url.username !== '' ||
		url.password !== '' ||
		(url.pathname !== '' && url.pathname !== '/') ||
		url.search !== '' ||
		url.hash !== ''
	) {
		throw new Error('REVIEW_API_DEV_TARGET must contain only an HTTP or HTTPS origin')
	}

	return url.origin
}

function isLoopbackHostname(hostname: string) {
	return hostname === '127.0.0.1' || hostname === '[::1]' || hostname === 'localhost'
}

export default defineConfig(({ command, mode }) => {
	const environment = {
		...loadEnv(mode, process.cwd(), ''),
		...process.env,
	}
	validateViteEnvironment(environment, command)

	return {
		plugins: [react()],
		...(command === 'serve'
			? {
					server: {
						proxy: {
							'/api': {
								changeOrigin: true,
								target: parseReviewApiDevTarget(environment.REVIEW_API_DEV_TARGET),
							},
						},
					},
				}
			: undefined),
	}
})
