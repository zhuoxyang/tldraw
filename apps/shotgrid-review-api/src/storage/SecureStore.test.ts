import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	prepareSecureSqliteDatabase,
	prepareSecureStoreDirectory,
	type SecureStoreError,
} from './SecureStore'

const temporaryRoots = new Set<string>()

afterEach(() => {
	for (const root of temporaryRoots) rmSync(root, { force: true, recursive: true })
	temporaryRoots.clear()
	vi.restoreAllMocks()
})

describe('SecureStore', () => {
	it('creates a private absolute store directory', () => {
		const storePath = join(createTemporaryRoot(), 'nested', 'store')
		const canonicalPath = prepareSecureStoreDirectory(storePath)
		const info = lstatSync(canonicalPath)

		expect(info.isDirectory()).toBe(true)
		expect(info.isSymbolicLink()).toBe(false)
		if (process.platform !== 'win32') {
			expect(Number(info.mode) & 0o777).toBe(0o700)
			expect(Number(info.uid)).toBe(process.getuid?.())
		}
	})

	it.each(['relative/store', '\\\\server\\share\\review-store'])(
		'rejects a non-local store path: %s',
		(storePath) => {
			expectSecureStoreError(() => prepareSecureStoreDirectory(storePath), 'INVALID_PATH')
		}
	)

	it('rejects a filesystem root', () => {
		const root = process.platform === 'win32' ? `${process.cwd().slice(0, 2)}\\` : '/'
		expectSecureStoreError(() => prepareSecureStoreDirectory(root), 'INVALID_PATH')
	})

	it('rejects a store target that is not a physical directory', () => {
		const root = createTemporaryRoot()
		const filePath = join(root, 'store')
		writeFileSync(filePath, 'not a directory')
		expectSecureStoreError(() => prepareSecureStoreDirectory(filePath), 'UNSAFE_ENTRY')

		const targetPath = join(root, 'target')
		const linkPath = join(root, 'linked-store')
		mkdirSync(targetPath)
		symlinkSync(targetPath, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
		expectSecureStoreError(() => prepareSecureStoreDirectory(linkPath), 'UNSAFE_ENTRY')
	})

	it.skipIf(process.platform === 'win32')('rejects group or world directory permissions', () => {
		const storePath = join(createTemporaryRoot(), 'store')
		mkdirSync(storePath, { mode: 0o750 })
		chmodSync(storePath, 0o750)

		expectSecureStoreError(() => prepareSecureStoreDirectory(storePath), 'UNSAFE_ENTRY')
	})

	it.skipIf(process.platform === 'win32' || process.getuid === undefined)(
		'rejects a directory not owned by the current POSIX user',
		() => {
			const storePath = join(createTemporaryRoot(), 'store')
			mkdirSync(storePath, { mode: 0o700 })
			const actualUid = Number(lstatSync(storePath).uid)
			vi.spyOn(process, 'getuid').mockReturnValue(actualUid + 1)

			expectSecureStoreError(() => prepareSecureStoreDirectory(storePath), 'UNSAFE_ENTRY')
		}
	)

	it('accepts only a simple SQLite file name beneath the secure directory', () => {
		const storePath = prepareSecureStoreDirectory(join(createTemporaryRoot(), 'store'))

		for (const fileName of [
			'../outside.sqlite',
			'..\\outside.sqlite',
			'review.db',
			'review.sqlite:payload.sqlite',
		]) {
			expectSecureStoreError(() => prepareSecureSqliteDatabase(storePath, fileName), 'INVALID_PATH')
		}
	})

	it('hardens the SQLite main file and existing WAL/SHM sidecars', () => {
		const storePath = prepareSecureStoreDirectory(join(createTemporaryRoot(), 'store'))
		for (const suffix of ['', '-wal', '-shm']) {
			const path = join(storePath, `review.sqlite${suffix}`)
			writeFileSync(path, suffix || 'main')
			if (process.platform !== 'win32') chmodSync(path, 0o666)
		}

		const database = prepareSecureSqliteDatabase(storePath, 'review.sqlite')
		database.hardenFiles()

		expect(database.path).toBe(join(storePath, 'review.sqlite'))
		for (const suffix of ['', '-wal', '-shm']) {
			const info = lstatSync(`${database.path}${suffix}`)
			expect(info.isFile()).toBe(true)
			expect(info.isSymbolicLink()).toBe(false)
			if (process.platform !== 'win32') {
				expect(Number(info.mode) & 0o777).toBe(0o600)
				expect(Number(info.uid)).toBe(process.getuid?.())
			}
		}
	})

	it('rejects a non-regular SQLite entry', () => {
		const storePath = prepareSecureStoreDirectory(join(createTemporaryRoot(), 'store'))
		mkdirSync(join(storePath, 'review.sqlite'))

		expectSecureStoreError(
			() => prepareSecureSqliteDatabase(storePath, 'review.sqlite'),
			'UNSAFE_ENTRY'
		)
	})

	it.skipIf(process.platform === 'win32')('rejects a symbolic-link SQLite sidecar', () => {
		const root = createTemporaryRoot()
		const storePath = prepareSecureStoreDirectory(join(root, 'store'))
		const outsidePath = join(root, 'outside')
		writeFileSync(outsidePath, 'outside')
		symlinkSync(outsidePath, join(storePath, 'review.sqlite-wal'), 'file')

		expectSecureStoreError(
			() => prepareSecureSqliteDatabase(storePath, 'review.sqlite'),
			'UNSAFE_ENTRY'
		)
	})
})

function createTemporaryRoot() {
	const root = mkdtempSync(join(tmpdir(), 'shotgrid-secure-store-'))
	temporaryRoots.add(root)
	return root
}

function expectSecureStoreError(action: () => unknown, code: SecureStoreError['code']) {
	expect(action).toThrow(expect.objectContaining({ code }))
}
