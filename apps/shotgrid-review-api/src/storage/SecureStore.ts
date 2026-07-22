import { chmodSync, lstatSync, mkdirSync, realpathSync, type Stats } from 'node:fs'
import { basename, isAbsolute, join, parse, resolve } from 'node:path'

const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const SQLITE_FILE_SUFFIXES = ['', '-wal', '-shm'] as const
const SQLITE_FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}\.sqlite$/

export type SecureStoreErrorCode = 'INVALID_PATH' | 'IO_ERROR' | 'UNSAFE_ENTRY'

export class SecureStoreError extends Error {
	constructor(
		readonly code: SecureStoreErrorCode,
		message: string,
		options?: ErrorOptions
	) {
		super(message, options)
		this.name = 'SecureStoreError'
	}
}

export interface SecureSqliteDatabase {
	/** Re-check and harden the main database plus any SQLite WAL/SHM sidecars that exist. */
	hardenFiles(): void
	readonly path: string
}

/**
 * Creates and validates a private, local directory for durable API state.
 *
 * POSIX ownership and mode bits are authoritative there. Windows mode bits are deliberately not
 * treated as an ACL check; deployments must grant the service account exclusive NTFS access.
 */
export function prepareSecureStoreDirectory(configuredPath: string): string {
	if (
		typeof configuredPath !== 'string' ||
		configuredPath.length === 0 ||
		configuredPath.trim() !== configuredPath ||
		configuredPath.includes('\0') ||
		!isAbsolute(configuredPath) ||
		isNetworkSharePath(configuredPath)
	) {
		throw secureStoreError(
			'INVALID_PATH',
			'The secure store directory must be an absolute local path.'
		)
	}

	const resolvedPath = resolve(configuredPath)
	if (resolvedPath === parse(resolvedPath).root) {
		throw secureStoreError('INVALID_PATH', 'A filesystem root cannot be used as a secure store.')
	}

	try {
		try {
			mkdirSync(resolvedPath, { mode: PRIVATE_DIRECTORY_MODE, recursive: true })
		} catch (error) {
			if (!hasErrorCode(error, 'EEXIST')) throw error
			assertDirectory(lstatSync(resolvedPath))
		}
		const configuredInfo = lstatSync(resolvedPath)
		assertDirectory(configuredInfo)

		const canonicalPath = realpathSync.native(resolvedPath)
		if (isNetworkSharePath(canonicalPath)) {
			throw secureStoreError('INVALID_PATH', 'A network share cannot be used as a secure store.')
		}
		assertSecureDirectory(canonicalPath)
		return canonicalPath
	} catch (error) {
		throw wrapSecureStoreError(error, 'Could not prepare the secure store directory.')
	}
}

/**
 * Resolves one SQLite database beneath a prepared secure directory and validates existing files.
 * Call `hardenFiles` immediately after opening SQLite and again after enabling WAL mode, because
 * either operation may create a new main file or sidecar.
 */
export function prepareSecureSqliteDatabase(
	secureDirectory: string,
	fileName: string
): SecureSqliteDatabase {
	if (
		typeof fileName !== 'string' ||
		fileName.length === 0 ||
		fileName !== basename(fileName) ||
		!SQLITE_FILE_NAME_PATTERN.test(fileName) ||
		fileName.includes('\0')
	) {
		throw secureStoreError('INVALID_PATH', 'The SQLite database file name is invalid.')
	}

	const directory = requirePreparedDirectory(secureDirectory)
	const databasePath = join(directory, fileName)
	const hardenFiles = () => {
		try {
			assertSecureDirectory(directory)
			for (const suffix of SQLITE_FILE_SUFFIXES) {
				hardenOptionalSqliteFile(`${databasePath}${suffix}`)
			}
		} catch (error) {
			throw wrapSecureStoreError(error, 'Could not secure the SQLite database files.')
		}
	}

	hardenFiles()
	return { hardenFiles, path: databasePath }
}

function requirePreparedDirectory(directory: string) {
	if (
		typeof directory !== 'string' ||
		directory.length === 0 ||
		!isAbsolute(directory) ||
		isNetworkSharePath(directory)
	) {
		throw secureStoreError('INVALID_PATH', 'The SQLite store directory is invalid.')
	}
	try {
		assertSecureDirectory(directory)
		const canonicalPath = realpathSync.native(directory)
		assertSecureDirectory(canonicalPath)
		return canonicalPath
	} catch (error) {
		throw wrapSecureStoreError(error, 'Could not validate the SQLite store directory.')
	}
}

function assertSecureDirectory(path: string) {
	const info = lstatSync(path)
	assertDirectory(info)
	validatePosixOwner(info, 'directory')
	if (process.platform !== 'win32' && (Number(info.mode) & 0o077) !== 0) {
		throw secureStoreError(
			'UNSAFE_ENTRY',
			'The secure store directory grants group or world access.'
		)
	}
}

function assertDirectory(info: Stats) {
	if (info.isSymbolicLink() || !info.isDirectory()) {
		throw secureStoreError('UNSAFE_ENTRY', 'The secure store path is not a physical directory.')
	}
}

function hardenOptionalSqliteFile(path: string) {
	let before: Stats
	try {
		before = lstatSync(path)
	} catch (error) {
		if (hasErrorCode(error, 'ENOENT')) return
		throw error
	}

	assertRegularFile(before)
	validatePosixOwner(before, 'file')
	if (process.platform !== 'win32') chmodSync(path, PRIVATE_FILE_MODE)

	const after = lstatSync(path)
	assertRegularFile(after)
	validatePosixOwner(after, 'file')
	if (String(before.dev) !== String(after.dev) || String(before.ino) !== String(after.ino)) {
		throw secureStoreError('UNSAFE_ENTRY', 'A SQLite database file changed during validation.')
	}
	if (process.platform !== 'win32' && (Number(after.mode) & 0o777) !== PRIVATE_FILE_MODE) {
		throw secureStoreError('UNSAFE_ENTRY', 'A SQLite database file is not private.')
	}
}

function assertRegularFile(info: Stats) {
	if (info.isSymbolicLink() || !info.isFile()) {
		throw secureStoreError('UNSAFE_ENTRY', 'A SQLite database entry is not a regular file.')
	}
}

function validatePosixOwner(info: Stats, kind: 'directory' | 'file') {
	if (process.platform === 'win32') return
	const currentUid = process.getuid?.()
	if (currentUid === undefined || Number(info.uid) !== currentUid) {
		throw secureStoreError('UNSAFE_ENTRY', `The secure store ${kind} has an unsafe owner.`)
	}
}

function isNetworkSharePath(path: string) {
	return /^[\\/]{2}/.test(path)
}

function hasErrorCode(error: unknown, code: string) {
	return (
		typeof error === 'object' &&
		error !== null &&
		'code' in error &&
		(error as { code?: unknown }).code === code
	)
}

function wrapSecureStoreError(error: unknown, message: string) {
	if (error instanceof SecureStoreError) return error
	return secureStoreError('IO_ERROR', message, error)
}

function secureStoreError(code: SecureStoreErrorCode, message: string, cause?: unknown) {
	return new SecureStoreError(code, message, cause === undefined ? undefined : { cause })
}
