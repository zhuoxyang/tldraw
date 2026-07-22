type Environment = Record<string, boolean | string | undefined>

const ALLOWED_PUBLIC_ENVIRONMENT_NAMES = new Set([
	'VITE_REVIEW_API_BASE_URL',
	'VITE_REVIEW_DATA_MODE',
	'VITE_REVIEW_STORAGE_NAMESPACE',
	'VITE_TLDRAW_LICENSE_KEY',
])

const SHOTGRID_API_BASE_URL_ERROR =
	'ShotGrid mode requires VITE_REVIEW_API_BASE_URL to be a same-origin root-relative path (for example /api)'

function hasValue(value: Environment[string]) {
	return typeof value === 'string' ? value.trim().length > 0 : value === true
}

function readString(environment: Environment, key: string) {
	const value = environment[key]
	return typeof value === 'string' ? value.trim() : ''
}

export function assertAllowedPublicEnvironment(environment: Environment) {
	const exposedName = Object.keys(environment).find(
		(name) => name.startsWith('VITE_') && !ALLOWED_PUBLIC_ENVIRONMENT_NAMES.has(name)
	)
	if (exposedName) {
		throw new Error(
			`${exposedName} uses Vite's public environment prefix but is not in the review application's public environment allowlist`
		)
	}
}

export function assertNoPublicShotGridEnvironment(environment: Environment) {
	assertAllowedPublicEnvironment(environment)
}

export function assertShotGridApiBaseUrl(value: string) {
	if (
		!value.startsWith('/') ||
		value.startsWith('//') ||
		value.includes('//') ||
		value.includes('\\') ||
		value.includes('?') ||
		value.includes('#') ||
		/\p{Cc}/u.test(value)
	) {
		throw new Error(SHOTGRID_API_BASE_URL_ERROR)
	}

	try {
		const baseUrl = new URL('https://shotgrid-review.invalid')
		const resolvedUrl = new URL(value, baseUrl)
		if (
			resolvedUrl.origin !== baseUrl.origin ||
			resolvedUrl.username !== '' ||
			resolvedUrl.password !== '' ||
			resolvedUrl.pathname !== value ||
			resolvedUrl.search !== '' ||
			resolvedUrl.hash !== ''
		) {
			throw new Error(SHOTGRID_API_BASE_URL_ERROR)
		}
	} catch {
		throw new Error(SHOTGRID_API_BASE_URL_ERROR)
	}
}

export function validateViteEnvironment(environment: Environment, command: 'build' | 'serve') {
	assertAllowedPublicEnvironment(environment)

	const dataMode = readString(environment, 'VITE_REVIEW_DATA_MODE') || 'mock'
	const licenseKey = environment.VITE_TLDRAW_LICENSE_KEY
	if (dataMode === 'shotgrid') {
		assertShotGridApiBaseUrl(readString(environment, 'VITE_REVIEW_API_BASE_URL') || '/api')
	}
	if (command === 'build' && dataMode === 'shotgrid' && !hasValue(licenseKey)) {
		throw new Error('ShotGrid production builds require VITE_TLDRAW_LICENSE_KEY')
	}
	if (
		command === 'build' &&
		dataMode === 'shotgrid' &&
		!hasValue(environment.VITE_REVIEW_STORAGE_NAMESPACE)
	) {
		throw new Error('ShotGrid production builds require VITE_REVIEW_STORAGE_NAMESPACE')
	}
}
