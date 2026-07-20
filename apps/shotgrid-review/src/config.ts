export type ReviewDataMode = 'mock' | 'shotgrid'

export interface ReviewRuntimeConfig {
	apiBaseUrl: string
	dataMode: ReviewDataMode
	tldrawLicenseKey?: string
}

type ReviewRuntimeEnvironment = Record<string, boolean | string | undefined>

const FORBIDDEN_PUBLIC_SECRET_KEYS = [
	'VITE_SHOTGRID_CLIENT_SECRET',
	'VITE_SHOTGRID_PASSWORD',
	'VITE_SHOTGRID_SCRIPT_KEY',
] as const

function readString(environment: ReviewRuntimeEnvironment, key: string) {
	const value = environment[key]
	return typeof value === 'string' ? value.trim() : ''
}

export function parseReviewConfig(environment: ReviewRuntimeEnvironment): ReviewRuntimeConfig {
	const exposedSecret = FORBIDDEN_PUBLIC_SECRET_KEYS.find((key) => readString(environment, key))
	if (exposedSecret) {
		throw new Error(`${exposedSecret} must never be exposed through browser configuration`)
	}

	const requestedMode = readString(environment, 'VITE_REVIEW_DATA_MODE') || 'mock'
	if (requestedMode !== 'mock' && requestedMode !== 'shotgrid') {
		throw new Error(`Unsupported VITE_REVIEW_DATA_MODE: ${requestedMode}`)
	}

	const tldrawLicenseKey = readString(environment, 'VITE_TLDRAW_LICENSE_KEY') || undefined

	return Object.freeze({
		apiBaseUrl: readString(environment, 'VITE_REVIEW_API_BASE_URL') || '/api',
		dataMode: requestedMode,
		tldrawLicenseKey,
	})
}

export const reviewConfig = parseReviewConfig(import.meta.env)
