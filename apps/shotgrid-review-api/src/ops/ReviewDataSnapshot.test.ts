import { createHash } from 'node:crypto'
import {
	chmodSync,
	existsSync,
	linkSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, dirname, join, parse, relative } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
	backupReviewData,
	isIgnorableReviewDataDirectorySyncError,
	REVIEW_DATA_STORE_NAMES,
	ReviewDataSnapshotCommitError,
	type ReviewDataSnapshotDurability,
	restoreReviewData,
	verifyReviewDataSnapshot,
} from './ReviewDataSnapshot'

const temporaryRoots = new Set<string>()
const FIXED_TIME = new Date('2026-07-22T04:05:06.789Z')

afterEach(() => {
	for (const root of temporaryRoots) {
		makeTreeWritable(root)
		rmSync(root, { force: true, recursive: true })
	}
	temporaryRoots.clear()
	vi.restoreAllMocks()
})

describe('directory fsync error policy', () => {
	it('fails every POSIX directory fsync error and degrades only known Windows limitations', () => {
		for (const code of ['EINVAL', 'EISDIR', 'EPERM', 'EIO']) {
			const error = Object.assign(new Error(code), { code })
			expect(isIgnorableReviewDataDirectorySyncError(error, 'linux')).toBe(false)
			expect(isIgnorableReviewDataDirectorySyncError(error, 'darwin')).toBe(false)
			expect(isIgnorableReviewDataDirectorySyncError(error, 'win32')).toBe(code !== 'EIO')
		}
	})
})

describe('backupReviewData', () => {
	it('creates a versioned read-only snapshot with all four fixed stores', async () => {
		const fixture = createSourceFixture()
		const snapshot = join(fixture.root, 'daily-snapshot')

		const summary = await backupReviewData(fixture.source, snapshot, {
			apiStopped: true,
			now: () => FIXED_TIME,
		})

		expect(summary).toEqual({
			bytes: fixture.expectedBytes,
			createdAt: FIXED_TIME.toISOString(),
			files: 5,
			path: canonicalNewPath(snapshot),
		})
		expect(readdirSync(snapshot).sort()).toEqual([
			'audit',
			'events',
			'manifest.json',
			'publications',
			'sync',
		])
		const manifest = readJson(join(snapshot, 'manifest.json'))
		expect(manifest).toMatchObject({
			createdAt: FIXED_TIME.toISOString(),
			format: 'shotgrid-review-offline-snapshot',
			rootMode: '0700',
			version: 1,
		})
		expect(readStoreNames(manifest)).toEqual(REVIEW_DATA_STORE_NAMES)
		expect(findManifestFile(manifest, 'audit', 'review-audit.sqlite')).toEqual({
			kind: 'file',
			mode: '0600',
			path: 'review-audit.sqlite',
			sha256: sha256('audit-state'),
			size: Buffer.byteLength('audit-state'),
		})
		expect(findManifestEntry(manifest, 'publications', 'archive')).toEqual({
			kind: 'directory',
			mode: '0700',
			path: 'archive',
		})
		if (process.platform !== 'win32') {
			expect(lstatSync(snapshot).mode & 0o777).toBe(0o500)
			expect(lstatSync(join(snapshot, 'manifest.json')).mode & 0o777).toBe(0o400)
			expect(lstatSync(join(snapshot, 'audit')).mode & 0o777).toBe(0o500)
			expect(lstatSync(join(snapshot, 'audit', 'review-audit.sqlite')).mode & 0o777).toBe(0o400)
		}

		await expect(verifyReviewDataSnapshot(snapshot)).resolves.toEqual(summary)
	})

	it('requires an explicit offline acknowledgement before touching a target', async () => {
		const fixture = createSourceFixture()
		const snapshot = join(fixture.root, 'snapshot')

		await expect(
			backupReviewData(fixture.source, snapshot, { apiStopped: false })
		).rejects.toMatchObject({ code: 'OFFLINE_CONFIRMATION_REQUIRED' })
		expect(() => lstatSync(snapshot)).toThrow()
	})

	it('rejects existing, root, network, relative, and nested targets', async () => {
		const fixture = createSourceFixture()
		const existing = join(fixture.root, 'existing')
		mkdirPrivate(existing)

		await expect(backup(fixture.source, existing)).rejects.toMatchObject({
			code: 'TARGET_EXISTS',
		})
		await expect(backup(fixture.source, 'relative-snapshot')).rejects.toMatchObject({
			code: 'INVALID_PATH',
		})
		await expect(backup(fixture.source, String.raw`\\server\share\snapshot`)).rejects.toMatchObject(
			{
				code: 'INVALID_PATH',
			}
		)
		await expect(backup(fixture.source, parse(fixture.source).root)).rejects.toMatchObject({
			code: 'INVALID_PATH',
		})
		await expect(
			backup(fixture.source, join(fixture.source, 'nested-snapshot'))
		).rejects.toMatchObject({ code: 'INVALID_PATH' })
	})

	it('requires exactly the fixed store layout', async () => {
		const missing = createSourceFixture()
		rmSync(join(missing.source, 'events'), { recursive: true })
		await expect(
			backup(missing.source, join(missing.root, 'missing-snapshot'))
		).rejects.toMatchObject({ code: 'SOURCE_LAYOUT_INVALID' })

		const extra = createSourceFixture()
		mkdirPrivate(join(extra.source, 'cache'))
		await expect(backup(extra.source, join(extra.root, 'extra-snapshot'))).rejects.toMatchObject({
			code: 'SOURCE_LAYOUT_INVALID',
		})
	})

	it('rejects symbolic links and hard-linked files', async () => {
		const linked = createSourceFixture()
		const outside = join(linked.root, 'outside.txt')
		writePrivateFile(outside, 'outside')
		const linkPath = join(linked.source, 'audit', 'linked.sqlite')
		symlinkSync(outside, linkPath, 'file')
		await expect(backup(linked.source, join(linked.root, 'linked-snapshot'))).rejects.toMatchObject(
			{ code: 'UNSAFE_ENTRY' }
		)

		const hardLinked = createSourceFixture()
		linkSync(
			join(hardLinked.source, 'audit', 'review-audit.sqlite'),
			join(hardLinked.source, 'audit', 'duplicate.sqlite')
		)
		await expect(
			backup(hardLinked.source, join(hardLinked.root, 'hardlink-snapshot'))
		).rejects.toMatchObject({ code: 'UNSAFE_ENTRY' })
	})

	it.skipIf(process.platform === 'win32')(
		'rejects socket and unsafe-mode store entries',
		async () => {
			const socketFixture = createSourceFixture()
			const socketPath = join(socketFixture.source, 'events', 'operator.sock')
			const server = createServer()
			await new Promise<void>((resolveListen, reject) => {
				server.once('error', reject)
				server.listen(socketPath, resolveListen)
			})
			try {
				await expect(
					backup(socketFixture.source, join(socketFixture.root, 'socket-snapshot'))
				).rejects.toMatchObject({ code: 'UNSAFE_ENTRY' })
			} finally {
				await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
			}

			const modeFixture = createSourceFixture()
			chmodSync(join(modeFixture.source, 'sync', 'room.sqlite'), 0o640)
			await expect(
				backup(modeFixture.source, join(modeFixture.root, 'mode-snapshot'))
			).rejects.toMatchObject({ code: 'UNSAFE_ENTRY' })
		}
	)

	it('rejects a symlink in the configured root path', async () => {
		const fixture = createSourceFixture()
		const linkedSource = join(fixture.root, 'linked-source')
		symlinkSync(fixture.source, linkedSource, process.platform === 'win32' ? 'junction' : 'dir')

		await expect(backup(linkedSource, join(fixture.root, 'snapshot'))).rejects.toMatchObject({
			code: 'UNSAFE_ENTRY',
		})
	})

	it('serializes cooperating publishers without silently replacing their target', async () => {
		const fixture = createSourceFixture()
		const snapshot = join(fixture.root, 'shared-target')
		const reservationEntered = deferred<void>()
		const releaseReservation = deferred<void>()
		const durability: ReviewDataSnapshotDurability = {
			syncDirectory: async (path) => {
				if (path.endsWith('.lock')) {
					reservationEntered.resolve()
					await releaseReservation.promise
				}
			},
			syncFile: async () => undefined,
		}
		const first = backupReviewData(fixture.source, snapshot, {
			apiStopped: true,
			durability,
			now: () => FIXED_TIME,
		})
		await reservationEntered.promise

		await expect(backup(fixture.source, snapshot)).rejects.toMatchObject({
			code: 'TARGET_EXISTS',
		})
		expect(existsSync(snapshot)).toBe(false)

		releaseReservation.resolve()
		await expect(first).resolves.toMatchObject({ path: canonicalNewPath(snapshot) })
		expect(
			readdirSync(fixture.root).some((name) => /^\.review-data-[0-9a-f]{64}\.lock$/.test(name))
		).toBe(false)
	})

	it.skipIf(process.platform === 'win32')(
		'requires the target parent to be owner-only and owned by the current user',
		async () => {
			const broad = createSourceFixture()
			const broadParent = join(broad.root, 'broad-parent')
			mkdirSync(broadParent, { mode: 0o755 })
			chmodSync(broadParent, 0o755)
			await expect(backup(broad.source, join(broadParent, 'snapshot'))).rejects.toMatchObject({
				code: 'UNSAFE_ENTRY',
			})

			const foreign = createSourceFixture()
			const actualUid = Number(lstatSync(foreign.root).uid)
			vi.spyOn(process, 'getuid').mockReturnValue(actualUid + 1)
			await expect(backup(foreign.source, join(foreign.root, 'snapshot'))).rejects.toMatchObject({
				code: 'UNSAFE_ENTRY',
			})
		}
	)

	it('flushes final file modes and directories bottom-up before publishing', async () => {
		const fixture = createSourceFixture()
		const snapshot = join(fixture.root, 'durable-snapshot')
		const events: string[] = []
		const durability: ReviewDataSnapshotDurability = {
			syncDirectory: async (path) => {
				events.push(`directory:${portableRelative(fixture.root, path)}:${existsSync(snapshot)}`)
			},
			syncFile: async (path) => {
				events.push(`file:${portableRelative(fixture.root, path)}:${existsSync(snapshot)}`)
			},
		}

		await backupReviewData(fixture.source, snapshot, {
			apiStopped: true,
			durability,
			now: () => FIXED_TIME,
		})

		const finalArchiveFile = findLastEvent(events, '/publications/archive/older.jsonl:false')
		const archiveDirectory = findEvent(events, '/publications/archive:false', 'directory:')
		const publicationDirectory = findEvent(events, '/publications:false', 'directory:')
		const manifestFile = findLastEvent(events, '/manifest.json:false')
		const publishedParent = events.findIndex(
			(event) => event.startsWith('directory:') && event.endsWith(':true')
		)
		const stagingRoot = events.findLastIndex(
			(event, index) =>
				index < publishedParent && event.startsWith('directory:') && event.endsWith(':false')
		)
		expect(finalArchiveFile).toBeGreaterThanOrEqual(0)
		expect(archiveDirectory).toBeGreaterThan(finalArchiveFile)
		expect(publicationDirectory).toBeGreaterThan(archiveDirectory)
		expect(stagingRoot).toBeGreaterThan(publicationDirectory)
		expect(stagingRoot).toBeGreaterThan(manifestFile)
		expect(publishedParent).toBeGreaterThan(stagingRoot)
	})

	it('reports committed-indeterminate when parent fsync fails after rename', async () => {
		const fixture = createSourceFixture()
		const snapshot = join(fixture.root, 'committed-snapshot')
		const durability: ReviewDataSnapshotDurability = {
			syncDirectory: async (path) => {
				if (canonicalNewPath(path) === canonicalNewPath(fixture.root) && existsSync(snapshot)) {
					throw new Error('injected parent fsync failure')
				}
			},
			syncFile: async () => undefined,
		}

		let failure: unknown
		try {
			await backupReviewData(fixture.source, snapshot, {
				apiStopped: true,
				durability,
				now: () => FIXED_TIME,
			})
		} catch (error) {
			failure = error
		}

		expect(failure).toBeInstanceOf(ReviewDataSnapshotCommitError)
		expect(failure).toMatchObject({
			code: 'COMMITTED_INDETERMINATE',
			committed: true,
			durability: 'indeterminate',
			path: canonicalNewPath(snapshot),
		})
		expect(existsSync(snapshot)).toBe(true)
		await expect(verifyReviewDataSnapshot(snapshot)).resolves.toMatchObject({
			path: canonicalNewPath(snapshot),
		})
		expect(
			readdirSync(fixture.root).some((name) => /^\.review-data-[0-9a-f]{64}\.lock$/.test(name))
		).toBe(true)
	})
})

describe('verifyReviewDataSnapshot', () => {
	it('detects modified, missing, and additional files', async () => {
		const modified = await createSnapshotFixture()
		unlockSnapshot(modified.snapshot)
		writePrivateFile(join(modified.snapshot, 'audit', 'review-audit.sqlite'), 'tampered')
		lockSnapshot(modified.snapshot)
		await expect(verifyReviewDataSnapshot(modified.snapshot)).rejects.toMatchObject({
			code: 'INTEGRITY_MISMATCH',
		})

		const missing = await createSnapshotFixture()
		unlockSnapshot(missing.snapshot)
		rmSync(join(missing.snapshot, 'sync', 'room.sqlite'))
		lockSnapshot(missing.snapshot)
		await expect(verifyReviewDataSnapshot(missing.snapshot)).rejects.toMatchObject({
			code: 'INTEGRITY_MISMATCH',
		})

		const additional = await createSnapshotFixture()
		unlockSnapshot(additional.snapshot)
		writePrivateFile(join(additional.snapshot, 'events', 'extra.sqlite'), 'extra')
		lockSnapshot(additional.snapshot)
		await expect(verifyReviewDataSnapshot(additional.snapshot)).rejects.toMatchObject({
			code: 'INTEGRITY_MISMATCH',
		})
	})

	it('strictly rejects altered manifest schemas and traversal paths', async () => {
		const fixture = await createSnapshotFixture()
		unlockSnapshot(fixture.snapshot)
		const manifestPath = join(fixture.snapshot, 'manifest.json')
		const manifest = readJson(manifestPath)
		manifest.unexpected = true
		writePrivateFile(manifestPath, `${JSON.stringify(manifest)}\n`)
		lockSnapshot(fixture.snapshot)
		await expect(verifyReviewDataSnapshot(fixture.snapshot)).rejects.toMatchObject({
			code: 'SNAPSHOT_INVALID',
		})

		const traversal = await createSnapshotFixture()
		unlockSnapshot(traversal.snapshot)
		const traversalPath = join(traversal.snapshot, 'manifest.json')
		const traversalManifest = readJson(traversalPath)
		const audit = readStores(traversalManifest)[0]
		const entries = readEntries(audit)
		entries[0] = { ...entries[0], path: '../outside' }
		writePrivateFile(traversalPath, `${JSON.stringify(traversalManifest)}\n`)
		lockSnapshot(traversal.snapshot)
		await expect(verifyReviewDataSnapshot(traversal.snapshot)).rejects.toMatchObject({
			code: 'SNAPSHOT_INVALID',
		})
	})

	it.skipIf(process.platform === 'win32')('detects writable snapshot permissions', async () => {
		const fixture = await createSnapshotFixture()
		chmodSync(fixture.snapshot, 0o700)

		await expect(verifyReviewDataSnapshot(fixture.snapshot)).rejects.toMatchObject({
			code: 'INTEGRITY_MISMATCH',
		})
	})
})

describe('restoreReviewData', () => {
	it('restores verified data through an unpublished sibling and preserves private modes', async () => {
		const fixture = await createSnapshotFixture()
		const target = join(fixture.root, 'restored')

		const summary = await restoreReviewData(fixture.snapshot, target, { apiStopped: true })

		expect(summary).toMatchObject({
			bytes: fixture.expectedBytes,
			createdAt: FIXED_TIME.toISOString(),
			files: 5,
			path: canonicalNewPath(target),
		})
		expect(readdirSync(target).sort()).toEqual([...REVIEW_DATA_STORE_NAMES].sort())
		expect(readFileSync(join(target, 'audit', 'review-audit.sqlite'), 'utf8')).toBe('audit-state')
		expect(readFileSync(join(target, 'publications', 'archive', 'older.jsonl'), 'utf8')).toBe(
			'publication-archive'
		)
		if (process.platform !== 'win32') {
			expect(lstatSync(target).mode & 0o777).toBe(0o700)
			expect(lstatSync(join(target, 'events')).mode & 0o777).toBe(0o700)
			expect(lstatSync(join(target, 'events', 'shotgrid-event-sync.sqlite')).mode & 0o777).toBe(
				0o600
			)
		}
	})

	it('durably syncs restored files and directories bottom-up before rename', async () => {
		const fixture = await createSnapshotFixture()
		const target = join(fixture.root, 'durable-restored')
		const events: string[] = []
		const durability: ReviewDataSnapshotDurability = {
			syncDirectory: async (path) => {
				events.push(`directory:${portableRelative(fixture.root, path)}:${existsSync(target)}`)
			},
			syncFile: async (path) => {
				events.push(`file:${portableRelative(fixture.root, path)}:${existsSync(target)}`)
			},
		}

		await restoreReviewData(fixture.snapshot, target, { apiStopped: true, durability })

		const archiveFile = findLastEvent(events, '/publications/archive/older.jsonl:false')
		const archiveDirectory = findEvent(events, '/publications/archive:false', 'directory:')
		const publicationsDirectory = findEvent(events, '/publications:false', 'directory:')
		const publishedParent = events.findIndex(
			(event) => event.startsWith('directory:') && event.endsWith(':true')
		)
		const stagingRoot = events.findLastIndex(
			(event, index) =>
				index < publishedParent && event.startsWith('directory:') && event.endsWith(':false')
		)
		expect(archiveFile).toBeGreaterThanOrEqual(0)
		expect(archiveDirectory).toBeGreaterThan(archiveFile)
		expect(publicationsDirectory).toBeGreaterThan(archiveDirectory)
		expect(stagingRoot).toBeGreaterThan(publicationsDirectory)
		expect(publishedParent).toBeGreaterThan(stagingRoot)
	})

	it('requires confirmation and refuses even an empty existing target', async () => {
		const fixture = await createSnapshotFixture()
		const target = join(fixture.root, 'existing-empty')
		mkdirPrivate(target)

		await expect(
			restoreReviewData(fixture.snapshot, join(fixture.root, 'unconfirmed'), {
				apiStopped: false,
			})
		).rejects.toMatchObject({ code: 'OFFLINE_CONFIRMATION_REQUIRED' })
		await expect(
			restoreReviewData(fixture.snapshot, target, { apiStopped: true })
		).rejects.toMatchObject({ code: 'TARGET_EXISTS' })
	})

	it('fully verifies before publishing the target and removes failed staging state', async () => {
		const fixture = await createSnapshotFixture()
		unlockSnapshot(fixture.snapshot)
		writePrivateFile(join(fixture.snapshot, 'sync', 'room.sqlite'), 'corrupt')
		lockSnapshot(fixture.snapshot)
		const target = join(fixture.root, 'must-not-exist')

		await expect(
			restoreReviewData(fixture.snapshot, target, { apiStopped: true })
		).rejects.toMatchObject({ code: 'INTEGRITY_MISMATCH' })
		expect(() => lstatSync(target)).toThrow()
		expect(readdirSync(fixture.root).some((name) => name.includes('.restore-'))).toBe(false)
	})

	it('rejects a restore target nested in its snapshot', async () => {
		const fixture = await createSnapshotFixture()

		await expect(
			restoreReviewData(fixture.snapshot, join(fixture.snapshot, 'restored'), {
				apiStopped: true,
			})
		).rejects.toMatchObject({ code: 'INVALID_PATH' })
	})
})

async function backup(source: string, snapshot: string) {
	return backupReviewData(source, snapshot, { apiStopped: true, now: () => FIXED_TIME })
}

function createSourceFixture() {
	const root = createTemporaryRoot()
	const source = join(root, 'stores')
	mkdirPrivate(source)
	for (const storeName of REVIEW_DATA_STORE_NAMES) mkdirPrivate(join(source, storeName))
	writePrivateFile(join(source, 'audit', 'review-audit.sqlite'), 'audit-state')
	writePrivateFile(join(source, 'events', 'shotgrid-event-sync.sqlite'), 'event-state')
	writePrivateFile(join(source, 'publications', 'current.jsonl'), 'publication-current')
	mkdirPrivate(join(source, 'publications', 'archive'))
	writePrivateFile(join(source, 'publications', 'archive', 'older.jsonl'), 'publication-archive')
	writePrivateFile(join(source, 'sync', 'room.sqlite'), 'sync-state')
	const expectedBytes = [
		'audit-state',
		'event-state',
		'publication-current',
		'publication-archive',
		'sync-state',
	].reduce((total, value) => total + Buffer.byteLength(value), 0)
	return { expectedBytes, root, source }
}

async function createSnapshotFixture() {
	const fixture = createSourceFixture()
	const snapshot = join(fixture.root, 'snapshot')
	await backup(fixture.source, snapshot)
	return { ...fixture, snapshot }
}

function createTemporaryRoot() {
	const root = mkdtempSync(join(tmpdir(), 'shotgrid-review-data-snapshot-'))
	temporaryRoots.add(root)
	return root
}

function mkdirPrivate(path: string) {
	mkdirSync(path, { mode: 0o700 })
	if (process.platform !== 'win32') chmodSync(path, 0o700)
}

function writePrivateFile(path: string, contents: string) {
	writeFileSync(path, contents, { mode: 0o600 })
	if (process.platform !== 'win32') chmodSync(path, 0o600)
}

function sha256(value: string) {
	return createHash('sha256').update(value).digest('hex')
}

function canonicalNewPath(path: string) {
	return join(realpathSync.native(dirname(path)), basename(path))
}

function portableRelative(root: string, path: string) {
	return relative(root, path).replaceAll('\\', '/') || '.'
}

function findEvent(events: string[], suffix: string, prefix = '') {
	return events.findIndex((event) => event.startsWith(prefix) && event.endsWith(suffix))
}

function findLastEvent(events: string[], suffix: string) {
	return events.findLastIndex((event) => event.endsWith(suffix))
}

function deferred<T>() {
	let resolvePromise!: (value: T | PromiseLike<T>) => void
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve
	})
	return { promise, resolve: (value?: T) => resolvePromise(value as T) }
}

function readJson(path: string): Record<string, unknown> {
	return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

function readStores(manifest: Record<string, unknown>) {
	if (!Array.isArray(manifest.stores)) throw new Error('Expected manifest stores')
	return manifest.stores as Record<string, unknown>[]
}

function readStoreNames(manifest: Record<string, unknown>) {
	return readStores(manifest).map((store) => store.name)
}

function readEntries(store: Record<string, unknown>) {
	if (!Array.isArray(store.entries)) throw new Error('Expected store entries')
	return store.entries as Record<string, unknown>[]
}

function findManifestEntry(manifest: Record<string, unknown>, storeName: string, path: string) {
	const store = readStores(manifest).find((candidate) => candidate.name === storeName)
	if (!store) throw new Error(`Expected ${storeName} store`)
	return readEntries(store).find((entry) => entry.path === path)
}

function findManifestFile(manifest: Record<string, unknown>, storeName: string, path: string) {
	const entry = findManifestEntry(manifest, storeName, path)
	if (!entry || entry.kind !== 'file') throw new Error(`Expected ${storeName}/${path} file`)
	return entry
}

function unlockSnapshot(root: string) {
	if (process.platform === 'win32') return
	makeTreeWritable(root)
}

function lockSnapshot(root: string) {
	if (process.platform === 'win32') return
	const lock = (path: string) => {
		for (const entry of readdirSync(path, { withFileTypes: true })) {
			const child = join(path, entry.name)
			if (entry.isDirectory()) {
				lock(child)
				chmodSync(child, 0o500)
			} else if (entry.isFile()) {
				chmodSync(child, 0o400)
			}
		}
	}
	lock(root)
	chmodSync(root, 0o500)
}

function makeTreeWritable(root: string) {
	let info: ReturnType<typeof lstatSync>
	try {
		info = lstatSync(root)
	} catch {
		return
	}
	if (!info.isDirectory() || info.isSymbolicLink()) return
	try {
		chmodSync(root, 0o700)
	} catch {
		return
	}
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const child = join(root, entry.name)
		if (entry.isDirectory() && !entry.isSymbolicLink()) makeTreeWritable(child)
		else if (entry.isFile()) chmodSync(child, 0o600)
	}
}
