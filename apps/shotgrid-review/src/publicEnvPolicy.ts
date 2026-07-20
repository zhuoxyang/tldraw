type Environment = Record<string, boolean | string | undefined>

function hasValue(value: Environment[string]) {
	return typeof value === 'string' ? value.trim().length > 0 : value === true
}

export function assertNoPublicShotGridEnvironment(environment: Environment) {
	const exposedName = Object.keys(environment).find(
		(name) =>
			(name.startsWith('VITE_SHOTGRID_') || name === 'VITE_REVIEW_API_TRUSTED_PROXY_TOKEN') &&
			hasValue(environment[name])
	)
	if (exposedName) {
		throw new Error(
			`${exposedName} uses Vite's public environment prefix; keep all ShotGrid and trusted proxy configuration server-side`
		)
	}
}

export function validateViteEnvironment(environment: Environment, command: 'build' | 'serve') {
	assertNoPublicShotGridEnvironment(environment)

	const dataMode = environment.VITE_REVIEW_DATA_MODE || 'mock'
	const licenseKey = environment.VITE_TLDRAW_LICENSE_KEY
	if (command === 'build' && dataMode === 'shotgrid' && !hasValue(licenseKey)) {
		throw new Error('ShotGrid production builds require VITE_TLDRAW_LICENSE_KEY')
	}
}
