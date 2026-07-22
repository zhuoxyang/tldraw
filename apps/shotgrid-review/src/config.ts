import { assertAllowedPublicEnvironment, assertShotGridApiBaseUrl } from './publicEnvPolicy'

export type ReviewDataMode = 'mock' | 'shotgrid'

export interface ReviewRuntimeConfig {
	apiBaseUrl: string
	dataMode: ReviewDataMode
	storageNamespace: string
	tldrawLicenseKey?: string
}

type ReviewRuntimeEnvironment = Record<string, boolean | string | undefined>

function readString(environment: ReviewRuntimeEnvironment, key: string) {
	const value = environment[key]
	return typeof value === 'string' ? value.trim() : ''
}

export function parseReviewConfig(environment: ReviewRuntimeEnvironment): ReviewRuntimeConfig {
	assertAllowedPublicEnvironment(environment)

	const requestedMode = readString(environment, 'VITE_REVIEW_DATA_MODE') || 'mock'
	if (requestedMode !== 'mock' && requestedMode !== 'shotgrid') {
		throw new Error(`Unsupported VITE_REVIEW_DATA_MODE: ${requestedMode}`)
	}

	const tldrawLicenseKey = readString(environment, 'VITE_TLDRAW_LICENSE_KEY') || undefined
	const configuredStorageNamespace = readString(environment, 'VITE_REVIEW_STORAGE_NAMESPACE')
	if (requestedMode === 'shotgrid' && !configuredStorageNamespace) {
		throw new Error('ShotGrid mode requires VITE_REVIEW_STORAGE_NAMESPACE')
	}
	const storageNamespace = configuredStorageNamespace || 'local-dev'
	if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(storageNamespace)) {
		throw new Error('VITE_REVIEW_STORAGE_NAMESPACE contains unsupported characters')
	}
	const apiBaseUrl = readString(environment, 'VITE_REVIEW_API_BASE_URL') || '/api'
	if (requestedMode === 'shotgrid') {
		assertShotGridApiBaseUrl(apiBaseUrl)
	}

	return Object.freeze({
		apiBaseUrl,
		dataMode: requestedMode,
		storageNamespace,
		tldrawLicenseKey,
	})
}

export const reviewConfig = parseReviewConfig({
	VITE_REVIEW_API_BASE_URL: import.meta.env.VITE_REVIEW_API_BASE_URL,
	VITE_REVIEW_DATA_MODE: import.meta.env.VITE_REVIEW_DATA_MODE,
	VITE_REVIEW_STORAGE_NAMESPACE: import.meta.env.VITE_REVIEW_STORAGE_NAMESPACE,
	VITE_TLDRAW_LICENSE_KEY: import.meta.env.VITE_TLDRAW_LICENSE_KEY,
})
