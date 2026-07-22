import { createHash, randomBytes } from 'node:crypto'
import { constants, type Dirent } from 'node:fs'
import {
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readdir,
	realpath,
	rename,
	rm,
	rmdir,
	type FileHandle,
} from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'

const MANIFEST_FILE_NAME = 'manifest.json'
const MANIFEST_FORMAT = 'shotgrid-review-offline-snapshot'
const MANIFEST_VERSION = 1
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024
const MAX_SNAPSHOT_ENTRIES = 100_000
const MAX_RELATIVE_PATH_LENGTH = 2_048
const COPY_BUFFER_BYTES = 256 * 1024
const PRIVATE_DIRECTORY_MODE = 0o700
const PRIVATE_FILE_MODE = 0o600
const READ_ONLY_DIRECTORY_MODE = 0o500
const READ_ONLY_FILE_MODE = 0o400
const MODE_DIRECTORY = '0700'
const MODE_FILE = '0600'

export const REVIEW_DATA_STORE_NAMES = ['audit', 'events', 'publications', 'sync'] as const

export type ReviewDataStoreName = (typeof REVIEW_DATA_STORE_NAMES)[number]

export type ReviewDataSnapshotErrorCode =
	| 'COMMITTED_INDETERMINATE'
	| 'INTEGRITY_MISMATCH'
	| 'INVALID_ARGUMENT'
	| 'INVALID_PATH'
	| 'IO_ERROR'
	| 'OFFLINE_CONFIRMATION_REQUIRED'
	| 'SNAPSHOT_INVALID'
	| 'SOURCE_LAYOUT_INVALID'
	| 'TARGET_EXISTS'
	| 'UNSAFE_ENTRY'

export class ReviewDataSnapshotError extends Error {
	constructor(
		readonly code: ReviewDataSnapshotErrorCode,
		message: string,
		options?: ErrorOptions
	) {
		super(message, options)
		this.name = 'ReviewDataSnapshotError'
	}
}

/**
 * The target path has been published, but a subsequent durability or reservation-cleanup step
 * failed. Operators must inspect and verify this target instead of retrying the command blindly.
 */
export class ReviewDataSnapshotCommitError extends ReviewDataSnapshotError {
	readonly committed = true
	readonly durability = 'indeterminate' as const

	constructor(
		readonly path: string,
		message: string,
		options?: ErrorOptions
	) {
		super('COMMITTED_INDETERMINATE', message, options)
		this.name = 'ReviewDataSnapshotCommitError'
	}
}

export interface ReviewDataSnapshotDurability {
	/** Test seam for the fsync that makes directory entries and directory modes durable. */
	syncDirectory(path: string): Promise<void>
	/** Test seam for the fsync performed on an already-open handle after the final file chmod. */
	syncFile(path: string, handle: FileHandle): Promise<void>
}

export interface ReviewDataSnapshotOptions {
	/** Explicit acknowledgement that every API process using these stores has been stopped. */
	apiStopped: boolean
	/** Injectable durability boundary used by fault-injection tests. Production omits this. */
	durability?: ReviewDataSnapshotDurability
	now?(): Date
}

export interface ReviewDataSnapshotSummary {
	bytes: number
	createdAt: string
	files: number
	path: string
}

interface SnapshotDirectoryEntry {
	kind: 'directory'
	mode: typeof MODE_DIRECTORY
	path: string
}

interface SnapshotFileEntry {
	kind: 'file'
	mode: typeof MODE_FILE
	path: string
	sha256: string
	size: number
}

type SnapshotEntry = SnapshotDirectoryEntry | SnapshotFileEntry

interface SnapshotStoreManifest {
	entries: SnapshotEntry[]
	mode: typeof MODE_DIRECTORY
	name: ReviewDataStoreName
}

interface ReviewDataSnapshotManifest {
	createdAt: string
	format: typeof MANIFEST_FORMAT
	rootMode: typeof MODE_DIRECTORY
	stores: SnapshotStoreManifest[]
	version: typeof MANIFEST_VERSION
}

interface PhysicalEntry {
	absolutePath: string
	kind: SnapshotEntry['kind']
	path: string
	stats: Awaited<ReturnType<typeof lstat>>
}

interface TargetReservation {
	dev: string
	ino: string
	parent: string
	path: string
}

/**
 * Creates a new, read-only snapshot directory from an offline shared store root.
 *
 * The caller must stop every API process first. The acknowledgement deliberately is not a live
 * process detector: deployment orchestration remains responsible for enforcing exclusive access.
 */
export async function backupReviewData(
	sourceRoot: string,
	snapshotTarget: string,
	options: ReviewDataSnapshotOptions
): Promise<ReviewDataSnapshotSummary> {
	requireOfflineAcknowledgement(options)
	const durability = resolveDurability(options.durability)
	const source = await requireExistingPhysicalDirectory(sourceRoot, 'source store root')
	const target = await requireNewTargetPath(snapshotTarget, 'snapshot target')
	assertSeparateTrees(source, target, 'source store root', 'snapshot target')
	await assertExactRootEntries(source, [...REVIEW_DATA_STORE_NAMES], 'source store root')
	await assertPrivateDirectory(source, 'source store root')

	const createdAt = readSnapshotTime(options.now)
	let reservation: TargetReservation | undefined
	let stagingPath: string | undefined
	try {
		reservation = await acquireTargetReservation(target, durability)
		stagingPath = await createSiblingStagingDirectory(target, 'snapshot')
		const stores: SnapshotStoreManifest[] = []

		for (const storeName of REVIEW_DATA_STORE_NAMES) {
			const sourceStore = join(source, storeName)
			await assertPrivateDirectory(sourceStore, `${storeName} store`)
			const targetStore = join(stagingPath, storeName)
			await mkdir(targetStore, { mode: PRIVATE_DIRECTORY_MODE })
			const entries = await copyStoreIntoSnapshot(sourceStore, targetStore, durability)
			stores.push({ entries, mode: MODE_DIRECTORY, name: storeName })
		}

		const manifest: ReviewDataSnapshotManifest = {
			createdAt,
			format: MANIFEST_FORMAT,
			rootMode: MODE_DIRECTORY,
			stores,
			version: MANIFEST_VERSION,
		}
		await writeManifest(stagingPath, manifest, durability)
		await verifySnapshotAtPath(stagingPath, { requireReadOnly: false })
		await makeSnapshotReadOnly(stagingPath, manifest, durability)
		await verifySnapshotAtPath(stagingPath, { requireReadOnly: true })
		await publishStagingDirectory(stagingPath, target, reservation, durability)
		stagingPath = undefined
		reservation = undefined
		return summarizeManifest(manifest, target)
	} catch (error) {
		if (stagingPath) await removeStagingDirectory(stagingPath)
		if (reservation && !(error instanceof ReviewDataSnapshotCommitError)) {
			await releaseReservationBestEffort(reservation, durability)
		}
		throw wrapSnapshotError(error, 'Could not create the review data snapshot.')
	}
}

/** Verifies schema, fixed layout, modes, file sizes, and SHA-256 digests for a snapshot. */
export async function verifyReviewDataSnapshot(
	snapshotRoot: string
): Promise<ReviewDataSnapshotSummary> {
	const snapshot = await requireExistingPhysicalDirectory(snapshotRoot, 'snapshot root')
	try {
		const manifest = await verifySnapshotAtPath(snapshot, { requireReadOnly: true })
		return summarizeManifest(manifest, snapshot)
	} catch (error) {
		throw wrapSnapshotError(error, 'The review data snapshot is invalid.')
	}
}

/**
 * Restores a fully verified snapshot to a target that does not exist.
 *
 * A private sibling directory is populated and verified before an atomic rename exposes the
 * restored root. Pre-commit failures never publish the target; failures after rename use an
 * explicit committed/indeterminate error and must not be retried blindly.
 */
export async function restoreReviewData(
	snapshotRoot: string,
	restoreTarget: string,
	options: ReviewDataSnapshotOptions
): Promise<ReviewDataSnapshotSummary> {
	requireOfflineAcknowledgement(options)
	const durability = resolveDurability(options.durability)
	const snapshot = await requireExistingPhysicalDirectory(snapshotRoot, 'snapshot root')
	const target = await requireNewTargetPath(restoreTarget, 'restore target')
	assertSeparateTrees(snapshot, target, 'snapshot root', 'restore target')

	let reservation: TargetReservation | undefined
	let stagingPath: string | undefined
	try {
		const manifest = await verifySnapshotAtPath(snapshot, { requireReadOnly: true })
		reservation = await acquireTargetReservation(target, durability)
		stagingPath = await createSiblingStagingDirectory(target, 'restore')
		for (const store of manifest.stores) {
			await restoreStore(snapshot, stagingPath, store, durability)
		}
		await makeRestoredTreeDurable(stagingPath, manifest, durability)
		await verifyRestoredRoot(stagingPath, manifest)
		// Re-verify the source after copying so a concurrent change cannot silently enter a restore.
		await verifySnapshotAtPath(snapshot, { requireReadOnly: true })
		await publishStagingDirectory(stagingPath, target, reservation, durability)
		stagingPath = undefined
		reservation = undefined
		return summarizeManifest(manifest, target)
	} catch (error) {
		if (stagingPath) await removeStagingDirectory(stagingPath)
		if (reservation && !(error instanceof ReviewDataSnapshotCommitError)) {
			await releaseReservationBestEffort(reservation, durability)
		}
		throw wrapSnapshotError(error, 'Could not restore the review data snapshot.')
	}
}

async function copyStoreIntoSnapshot(
	sourceStore: string,
	targetStore: string,
	durability: ReviewDataSnapshotDurability
) {
	const physicalEntries = await walkPhysicalStore(sourceStore)
	const manifestEntries: SnapshotEntry[] = []
	for (const entry of physicalEntries) {
		const destination = resolveManifestPath(targetStore, entry.path)
		if (entry.kind === 'directory') {
			await mkdir(destination, { mode: PRIVATE_DIRECTORY_MODE })
			manifestEntries.push({ kind: 'directory', mode: MODE_DIRECTORY, path: entry.path })
			continue
		}
		const copied = await copyAndHashFile(entry.absolutePath, destination, entry.stats, durability)
		manifestEntries.push({
			kind: 'file',
			mode: MODE_FILE,
			path: entry.path,
			sha256: copied.sha256,
			size: copied.size,
		})
	}
	return manifestEntries
}

async function walkPhysicalStore(storeRoot: string) {
	const found: PhysicalEntry[] = []
	await walkPhysicalDirectory(storeRoot, '', found)
	if (found.length > MAX_SNAPSHOT_ENTRIES) {
		throw snapshotError(
			'SOURCE_LAYOUT_INVALID',
			`A snapshot may contain at most ${MAX_SNAPSHOT_ENTRIES} entries.`
		)
	}
	return found.sort(comparePhysicalEntries)
}

async function walkPhysicalDirectory(
	absoluteDirectory: string,
	relativeDirectory: string,
	found: PhysicalEntry[]
) {
	const before = await lstat(absoluteDirectory)
	assertPhysicalDirectory(before, relativeDirectory || 'store root')
	await assertPrivateDirectoryMode(before, relativeDirectory || 'store root')
	let children: Dirent[]
	try {
		children = await readdir(absoluteDirectory, { withFileTypes: true })
	} catch (error) {
		throw snapshotError('IO_ERROR', 'Could not enumerate a review data store.', error)
	}
	children.sort((left, right) => left.name.localeCompare(right.name, 'en'))

	for (const child of children) {
		assertSafePathSegment(child.name)
		const childRelativePath = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name
		assertSafeManifestPath(childRelativePath)
		const childAbsolutePath = join(absoluteDirectory, child.name)
		const info = await lstat(childAbsolutePath)
		if (info.isSymbolicLink()) {
			throw snapshotError('UNSAFE_ENTRY', `Symbolic links are not allowed: ${childRelativePath}`)
		}
		if (info.isDirectory()) {
			await assertPrivateDirectoryMode(info, childRelativePath)
			found.push({
				absolutePath: childAbsolutePath,
				kind: 'directory',
				path: childRelativePath,
				stats: info,
			})
			if (found.length > MAX_SNAPSHOT_ENTRIES) break
			await walkPhysicalDirectory(childAbsolutePath, childRelativePath, found)
			continue
		}
		if (!info.isFile() || Number(info.nlink) !== 1) {
			throw snapshotError(
				'UNSAFE_ENTRY',
				`Only unlinked regular files are allowed: ${childRelativePath}`
			)
		}
		await assertPrivateFileMode(info, childRelativePath)
		found.push({
			absolutePath: childAbsolutePath,
			kind: 'file',
			path: childRelativePath,
			stats: info,
		})
		if (found.length > MAX_SNAPSHOT_ENTRIES) break
	}

	const after = await lstat(absoluteDirectory)
	if (!sameEntry(before, after) || before.mtimeMs !== after.mtimeMs) {
		throw snapshotError(
			'SOURCE_LAYOUT_INVALID',
			`The store changed while it was being scanned: ${relativeDirectory || 'store root'}`
		)
	}
}

function comparePhysicalEntries(left: PhysicalEntry, right: PhysicalEntry) {
	const depthDifference = left.path.split('/').length - right.path.split('/').length
	return depthDifference || left.path.localeCompare(right.path, 'en')
}

async function copyAndHashFile(
	sourcePath: string,
	destinationPath: string,
	expectedSource: Awaited<ReturnType<typeof lstat>>,
	durability: ReviewDataSnapshotDurability,
	expected?: SnapshotFileEntry
) {
	let sourceHandle: Awaited<ReturnType<typeof open>> | undefined
	let destinationHandle: Awaited<ReturnType<typeof open>> | undefined
	try {
		sourceHandle = await open(sourcePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
		const before = await sourceHandle.stat()
		if (
			!before.isFile() ||
			Number(before.nlink) !== 1 ||
			!sameEntry(expectedSource, before) ||
			before.size !== expectedSource.size ||
			!Number.isSafeInteger(before.size) ||
			before.size < 0
		) {
			throw snapshotError('UNSAFE_ENTRY', 'A source file changed before it could be copied.')
		}
		destinationHandle = await open(
			destinationPath,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
			PRIVATE_FILE_MODE
		)
		const hash = createHash('sha256')
		const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES)
		let offset = 0
		for (;;) {
			const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.byteLength, offset)
			if (bytesRead === 0) break
			const chunk = buffer.subarray(0, bytesRead)
			hash.update(chunk)
			await writeComplete(destinationHandle, chunk, offset)
			offset += bytesRead
		}
		await destinationHandle.sync()
		const after = await sourceHandle.stat()
		if (
			!sameEntry(before, after) ||
			before.size !== after.size ||
			before.mtimeMs !== after.mtimeMs ||
			offset !== before.size
		) {
			throw snapshotError('INTEGRITY_MISMATCH', 'A source file changed while it was copied.')
		}
		const sha256 = hash.digest('hex')
		if (expected && (expected.size !== offset || expected.sha256 !== sha256)) {
			throw snapshotError('INTEGRITY_MISMATCH', `Snapshot file integrity failed: ${expected.path}`)
		}
		await destinationHandle.chmod(PRIVATE_FILE_MODE)
		await durability.syncFile(destinationPath, destinationHandle)
		return { sha256, size: offset }
	} catch (error) {
		throw wrapSnapshotError(error, `Could not copy ${basename(sourcePath)}.`)
	} finally {
		await destinationHandle?.close().catch(() => undefined)
		await sourceHandle?.close().catch(() => undefined)
	}
}

async function writeComplete(
	handle: Awaited<ReturnType<typeof open>>,
	buffer: Buffer,
	startOffset: number
) {
	let written = 0
	while (written < buffer.byteLength) {
		const result = await handle.write(
			buffer,
			written,
			buffer.byteLength - written,
			startOffset + written
		)
		if (result.bytesWritten <= 0) {
			throw snapshotError('IO_ERROR', 'A snapshot file write made no progress.')
		}
		written += result.bytesWritten
	}
}

async function writeManifest(
	snapshotRoot: string,
	manifest: ReviewDataSnapshotManifest,
	durability: ReviewDataSnapshotDurability
) {
	const serialized = `${JSON.stringify(manifest, null, 2)}\n`
	if (Buffer.byteLength(serialized) > MAX_MANIFEST_BYTES) {
		throw snapshotError('SOURCE_LAYOUT_INVALID', 'The generated snapshot manifest is too large.')
	}
	const manifestPath = join(snapshotRoot, MANIFEST_FILE_NAME)
	const handle = await open(
		manifestPath,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
		PRIVATE_FILE_MODE
	)
	try {
		await handle.writeFile(serialized, 'utf8')
		await handle.sync()
		await handle.chmod(PRIVATE_FILE_MODE)
		await durability.syncFile(manifestPath, handle)
	} finally {
		await handle.close()
	}
}

async function verifySnapshotAtPath(
	snapshotRoot: string,
	options: { requireReadOnly: boolean }
): Promise<ReviewDataSnapshotManifest> {
	const rootInfo = await lstat(snapshotRoot)
	assertPhysicalDirectory(rootInfo, 'snapshot root')
	if (options.requireReadOnly) await assertSnapshotDirectoryMode(rootInfo, 'snapshot root')

	await assertExactRootEntries(
		snapshotRoot,
		[MANIFEST_FILE_NAME, ...REVIEW_DATA_STORE_NAMES],
		'snapshot root'
	)
	const manifestPath = join(snapshotRoot, MANIFEST_FILE_NAME)
	const manifestInfo = await lstat(manifestPath)
	if (!manifestInfo.isFile() || manifestInfo.isSymbolicLink() || Number(manifestInfo.nlink) !== 1) {
		throw snapshotError('SNAPSHOT_INVALID', 'The snapshot manifest is not a regular file.')
	}
	if (manifestInfo.size > MAX_MANIFEST_BYTES) {
		throw snapshotError('SNAPSHOT_INVALID', 'The snapshot manifest exceeds its size limit.')
	}
	if (options.requireReadOnly) await assertSnapshotFileMode(manifestInfo, MANIFEST_FILE_NAME)

	let parsed: unknown
	try {
		parsed = JSON.parse(await readManifestFile(manifestPath, manifestInfo))
	} catch (error) {
		throw snapshotError('SNAPSHOT_INVALID', 'The snapshot manifest is not valid JSON.', error)
	}
	const manifest = parseManifest(parsed)
	for (const store of manifest.stores) {
		await verifySnapshotStore(snapshotRoot, store, options)
	}
	return manifest
}

async function readManifestFile(
	manifestPath: string,
	expectedInfo: Awaited<ReturnType<typeof lstat>>
) {
	const handle = await open(manifestPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
	try {
		const before = await handle.stat()
		if (
			!before.isFile() ||
			Number(before.nlink) !== 1 ||
			!sameEntry(expectedInfo, before) ||
			before.size !== expectedInfo.size ||
			!Number.isSafeInteger(before.size) ||
			before.size < 0 ||
			before.size > MAX_MANIFEST_BYTES
		) {
			throw snapshotError('SNAPSHOT_INVALID', 'The snapshot manifest changed before it was read.')
		}
		const contents = Buffer.alloc(before.size)
		let offset = 0
		while (offset < contents.byteLength) {
			const { bytesRead } = await handle.read(
				contents,
				offset,
				contents.byteLength - offset,
				offset
			)
			if (bytesRead === 0) {
				throw snapshotError('INTEGRITY_MISMATCH', 'The snapshot manifest was truncated.')
			}
			offset += bytesRead
		}
		const extra = Buffer.allocUnsafe(1)
		const { bytesRead: extraBytes } = await handle.read(extra, 0, 1, offset)
		const after = await handle.stat()
		if (
			extraBytes !== 0 ||
			!sameEntry(before, after) ||
			before.size !== after.size ||
			before.mtimeMs !== after.mtimeMs
		) {
			throw snapshotError('INTEGRITY_MISMATCH', 'The snapshot manifest changed while it was read.')
		}
		return contents.toString('utf8')
	} finally {
		await handle.close()
	}
}

async function verifySnapshotStore(
	snapshotRoot: string,
	store: SnapshotStoreManifest,
	options: { requireReadOnly: boolean }
) {
	const storeRoot = join(snapshotRoot, store.name)
	const storeInfo = await lstat(storeRoot)
	assertPhysicalDirectory(storeInfo, `${store.name} snapshot store`)
	if (options.requireReadOnly) {
		await assertSnapshotDirectoryMode(storeInfo, `${store.name} snapshot store`)
	}
	const physicalEntries = await walkSnapshotDirectory(storeRoot, options)
	const expectedByPath = new Map(store.entries.map((entry) => [entry.path, entry]))
	if (physicalEntries.size !== expectedByPath.size) {
		throw snapshotError(
			'INTEGRITY_MISMATCH',
			`The ${store.name} snapshot has missing or additional entries.`
		)
	}
	for (const [path, physical] of physicalEntries) {
		const expected = expectedByPath.get(path)
		if (!expected || expected.kind !== physical.kind) {
			throw snapshotError(
				'INTEGRITY_MISMATCH',
				`The ${store.name} snapshot entry does not match its manifest: ${path}`
			)
		}
		if (expected.kind === 'file') {
			const digest = await hashPhysicalFile(physical.absolutePath, physical.stats)
			if (digest.size !== expected.size || digest.sha256 !== expected.sha256) {
				throw snapshotError('INTEGRITY_MISMATCH', `Snapshot file integrity failed: ${path}`)
			}
		}
	}
}

async function walkSnapshotDirectory(
	storeRoot: string,
	options: { requireReadOnly: boolean }
): Promise<Map<string, PhysicalEntry>> {
	const entries = new Map<string, PhysicalEntry>()
	await walkSnapshotChildren(storeRoot, '', entries, options)
	if (entries.size > MAX_SNAPSHOT_ENTRIES) {
		throw snapshotError('SNAPSHOT_INVALID', 'The snapshot contains too many entries.')
	}
	return entries
}

async function walkSnapshotChildren(
	absoluteDirectory: string,
	relativeDirectory: string,
	entries: Map<string, PhysicalEntry>,
	options: { requireReadOnly: boolean }
) {
	for (const child of await readdir(absoluteDirectory, { withFileTypes: true })) {
		assertSafePathSegment(child.name)
		const childPath = relativeDirectory ? `${relativeDirectory}/${child.name}` : child.name
		assertSafeManifestPath(childPath)
		const absolutePath = join(absoluteDirectory, child.name)
		const info = await lstat(absolutePath)
		if (info.isSymbolicLink()) {
			throw snapshotError('UNSAFE_ENTRY', `Symbolic links are not allowed: ${childPath}`)
		}
		if (info.isDirectory()) {
			if (options.requireReadOnly) await assertSnapshotDirectoryMode(info, childPath)
			entries.set(childPath, {
				absolutePath,
				kind: 'directory',
				path: childPath,
				stats: info,
			})
			if (entries.size > MAX_SNAPSHOT_ENTRIES) return
			await walkSnapshotChildren(absolutePath, childPath, entries, options)
			continue
		}
		if (!info.isFile() || Number(info.nlink) !== 1) {
			throw snapshotError('UNSAFE_ENTRY', `Only unlinked regular files are allowed: ${childPath}`)
		}
		if (options.requireReadOnly) await assertSnapshotFileMode(info, childPath)
		entries.set(childPath, { absolutePath, kind: 'file', path: childPath, stats: info })
		if (entries.size > MAX_SNAPSHOT_ENTRIES) return
	}
}

async function hashPhysicalFile(path: string, expectedInfo: Awaited<ReturnType<typeof lstat>>) {
	const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
	try {
		const before = await handle.stat()
		if (
			!before.isFile() ||
			Number(before.nlink) !== 1 ||
			!sameEntry(expectedInfo, before) ||
			before.size !== expectedInfo.size ||
			!Number.isSafeInteger(before.size) ||
			before.size < 0
		) {
			throw snapshotError('INTEGRITY_MISMATCH', 'A snapshot file changed before verification.')
		}
		const hash = createHash('sha256')
		const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES)
		let offset = 0
		for (;;) {
			const { bytesRead } = await handle.read(buffer, 0, buffer.byteLength, offset)
			if (bytesRead === 0) break
			hash.update(buffer.subarray(0, bytesRead))
			offset += bytesRead
		}
		const after = await handle.stat()
		if (
			!sameEntry(before, after) ||
			before.size !== after.size ||
			before.mtimeMs !== after.mtimeMs ||
			offset !== before.size
		) {
			throw snapshotError('INTEGRITY_MISMATCH', 'A snapshot file changed during verification.')
		}
		return { sha256: hash.digest('hex'), size: offset }
	} finally {
		await handle.close()
	}
}

async function makeSnapshotReadOnly(
	snapshotRoot: string,
	manifest: ReviewDataSnapshotManifest,
	durability: ReviewDataSnapshotDurability
) {
	for (const store of manifest.stores) {
		const storeRoot = join(snapshotRoot, store.name)
		const directories = store.entries
			.filter((entry): entry is SnapshotDirectoryEntry => entry.kind === 'directory')
			.sort((left, right) => right.path.split('/').length - left.path.split('/').length)
		for (const entry of store.entries) {
			if (entry.kind === 'file') {
				const filePath = resolveManifestPath(storeRoot, entry.path)
				await durablySetFileMode(filePath, READ_ONLY_FILE_MODE, durability)
			}
		}
		for (const entry of directories) {
			const directoryPath = resolveManifestPath(storeRoot, entry.path)
			if (process.platform !== 'win32') await chmod(directoryPath, READ_ONLY_DIRECTORY_MODE)
			await durability.syncDirectory(directoryPath)
		}
		if (process.platform !== 'win32') await chmod(storeRoot, READ_ONLY_DIRECTORY_MODE)
		await durability.syncDirectory(storeRoot)
	}
	const manifestPath = join(snapshotRoot, MANIFEST_FILE_NAME)
	await durablySetFileMode(manifestPath, READ_ONLY_FILE_MODE, durability)
	if (process.platform !== 'win32') await chmod(snapshotRoot, READ_ONLY_DIRECTORY_MODE)
	await durability.syncDirectory(snapshotRoot)
}

async function durablySetFileMode(
	path: string,
	mode: number,
	durability: ReviewDataSnapshotDurability
) {
	const handle = await open(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0))
	try {
		const info = await handle.stat()
		if (!info.isFile() || Number(info.nlink) !== 1) {
			throw snapshotError('UNSAFE_ENTRY', 'A snapshot file changed before finalization.')
		}
		if (process.platform !== 'win32') await handle.chmod(mode)
		await durability.syncFile(path, handle)
	} finally {
		await handle.close()
	}
}

async function restoreStore(
	snapshotRoot: string,
	stagingRoot: string,
	store: SnapshotStoreManifest,
	durability: ReviewDataSnapshotDurability
) {
	const sourceStore = join(snapshotRoot, store.name)
	const targetStore = join(stagingRoot, store.name)
	await mkdir(targetStore, { mode: PRIVATE_DIRECTORY_MODE })
	for (const entry of store.entries) {
		const destination = resolveManifestPath(targetStore, entry.path)
		if (entry.kind === 'directory') {
			await mkdir(destination, { mode: PRIVATE_DIRECTORY_MODE })
			continue
		}
		const source = resolveManifestPath(sourceStore, entry.path)
		const sourceInfo = await lstat(source)
		await copyAndHashFile(source, destination, sourceInfo, durability, entry)
	}
}

async function makeRestoredTreeDurable(
	stagingRoot: string,
	manifest: ReviewDataSnapshotManifest,
	durability: ReviewDataSnapshotDurability
) {
	for (const store of manifest.stores) {
		const storeRoot = join(stagingRoot, store.name)
		const directories = store.entries
			.filter((entry): entry is SnapshotDirectoryEntry => entry.kind === 'directory')
			.sort((left, right) => right.path.split('/').length - left.path.split('/').length)
		for (const entry of directories) {
			const directoryPath = resolveManifestPath(storeRoot, entry.path)
			await chmod(directoryPath, PRIVATE_DIRECTORY_MODE)
			await durability.syncDirectory(directoryPath)
		}
		await chmodPrivateDirectory(storeRoot)
		await durability.syncDirectory(storeRoot)
	}
	await chmodPrivateDirectory(stagingRoot)
	await durability.syncDirectory(stagingRoot)
}

async function verifyRestoredRoot(stagingRoot: string, manifest: ReviewDataSnapshotManifest) {
	await assertExactRootEntries(stagingRoot, [...REVIEW_DATA_STORE_NAMES], 'restored store root')
	await assertPrivateDirectory(stagingRoot, 'restored store root')
	for (const store of manifest.stores) {
		const storeRoot = join(stagingRoot, store.name)
		await assertPrivateDirectory(storeRoot, `${store.name} restored store`)
		const physical = await walkPhysicalStore(storeRoot)
		const expected = new Map(store.entries.map((entry) => [entry.path, entry]))
		if (physical.length !== expected.size) {
			throw snapshotError('INTEGRITY_MISMATCH', `The restored ${store.name} layout is incomplete.`)
		}
		for (const entry of physical) {
			const expectedEntry = expected.get(entry.path)
			if (!expectedEntry || entry.kind !== expectedEntry.kind) {
				throw snapshotError(
					'INTEGRITY_MISMATCH',
					`The restored ${store.name} entry is unexpected: ${entry.path}`
				)
			}
			if (expectedEntry.kind === 'file') {
				const digest = await hashPhysicalFile(entry.absolutePath, entry.stats)
				if (digest.size !== expectedEntry.size || digest.sha256 !== expectedEntry.sha256) {
					throw snapshotError(
						'INTEGRITY_MISMATCH',
						`The restored ${store.name} file failed verification: ${entry.path}`
					)
				}
			}
		}
	}
}

function parseManifest(value: unknown): ReviewDataSnapshotManifest {
	if (
		!isPlainObject(value) ||
		!hasExactKeys(value, ['createdAt', 'format', 'rootMode', 'stores', 'version'])
	) {
		throw snapshotError('SNAPSHOT_INVALID', 'The snapshot manifest schema is invalid.')
	}
	if (
		value.format !== MANIFEST_FORMAT ||
		value.version !== MANIFEST_VERSION ||
		value.rootMode !== MODE_DIRECTORY ||
		typeof value.createdAt !== 'string' ||
		!isCanonicalIsoTime(value.createdAt) ||
		!Array.isArray(value.stores) ||
		value.stores.length !== REVIEW_DATA_STORE_NAMES.length
	) {
		throw snapshotError('SNAPSHOT_INVALID', 'The snapshot manifest header is invalid.')
	}

	let totalEntries = 0
	const stores: SnapshotStoreManifest[] = value.stores.map((candidate, index) => {
		const expectedName = REVIEW_DATA_STORE_NAMES[index]
		if (
			!isPlainObject(candidate) ||
			!hasExactKeys(candidate, ['entries', 'mode', 'name']) ||
			candidate.name !== expectedName ||
			candidate.mode !== MODE_DIRECTORY ||
			!Array.isArray(candidate.entries)
		) {
			throw snapshotError('SNAPSHOT_INVALID', `The ${expectedName} store manifest is invalid.`)
		}
		const paths = new Set<string>()
		const entries = candidate.entries.map((entry) => {
			const parsedEntry = parseManifestEntry(entry)
			if (paths.has(parsedEntry.path)) {
				throw snapshotError('SNAPSHOT_INVALID', 'The snapshot manifest contains duplicate paths.')
			}
			paths.add(parsedEntry.path)
			return parsedEntry
		})
		if (!isCanonicalEntryOrder(entries)) {
			throw snapshotError('SNAPSHOT_INVALID', 'Snapshot manifest entries are not canonical.')
		}
		totalEntries += entries.length
		return { entries, mode: MODE_DIRECTORY, name: expectedName }
	})
	if (totalEntries > MAX_SNAPSHOT_ENTRIES) {
		throw snapshotError('SNAPSHOT_INVALID', 'The snapshot manifest contains too many entries.')
	}
	return {
		createdAt: value.createdAt,
		format: MANIFEST_FORMAT,
		rootMode: MODE_DIRECTORY,
		stores,
		version: MANIFEST_VERSION,
	}
}

function parseManifestEntry(value: unknown): SnapshotEntry {
	if (!isPlainObject(value) || typeof value.kind !== 'string') {
		throw snapshotError('SNAPSHOT_INVALID', 'A snapshot manifest entry is invalid.')
	}
	if (value.kind === 'directory') {
		if (
			!hasExactKeys(value, ['kind', 'mode', 'path']) ||
			value.mode !== MODE_DIRECTORY ||
			typeof value.path !== 'string'
		) {
			throw snapshotError('SNAPSHOT_INVALID', 'A snapshot directory entry is invalid.')
		}
		assertSafeManifestPath(value.path)
		return { kind: 'directory', mode: MODE_DIRECTORY, path: value.path }
	}
	if (value.kind === 'file') {
		if (
			!hasExactKeys(value, ['kind', 'mode', 'path', 'sha256', 'size']) ||
			value.mode !== MODE_FILE ||
			typeof value.path !== 'string' ||
			typeof value.sha256 !== 'string' ||
			!/^[0-9a-f]{64}$/.test(value.sha256) ||
			typeof value.size !== 'number' ||
			!Number.isSafeInteger(value.size) ||
			value.size < 0
		) {
			throw snapshotError('SNAPSHOT_INVALID', 'A snapshot file entry is invalid.')
		}
		assertSafeManifestPath(value.path)
		return {
			kind: 'file',
			mode: MODE_FILE,
			path: value.path,
			sha256: value.sha256,
			size: value.size,
		}
	}
	throw snapshotError('SNAPSHOT_INVALID', 'A snapshot manifest entry kind is invalid.')
}

function isCanonicalEntryOrder(entries: SnapshotEntry[]) {
	for (let index = 1; index < entries.length; index++) {
		const previous = entries[index - 1]
		const current = entries[index]
		const previousDepth = previous.path.split('/').length
		const currentDepth = current.path.split('/').length
		if (
			previousDepth > currentDepth ||
			(previousDepth === currentDepth && previous.path.localeCompare(current.path, 'en') >= 0)
		) {
			return false
		}
	}
	return true
}

async function requireExistingPhysicalDirectory(configuredPath: string, label: string) {
	const validated = validateAbsoluteLocalPath(configuredPath, label)
	await assertPhysicalAncestors(validated, true, label)
	let canonical: string
	try {
		canonical = await realpath(validated)
	} catch (error) {
		throw snapshotError('INVALID_PATH', `The ${label} does not exist.`, error)
	}
	const info = await lstat(canonical)
	assertPhysicalDirectory(info, label)
	return resolve(canonical)
}

async function requireNewTargetPath(configuredPath: string, label: string) {
	const target = validateAbsoluteLocalPath(configuredPath, label)
	const parent = dirname(target)
	await assertPhysicalAncestors(parent, true, `${label} parent`)
	let canonicalParent: string
	try {
		canonicalParent = await realpath(parent)
	} catch (error) {
		throw snapshotError('INVALID_PATH', `The ${label} parent must already exist.`, error)
	}
	await assertPrivateDirectory(canonicalParent, `${label} parent`)
	const canonicalTarget = join(canonicalParent, basename(target))
	await assertTargetDoesNotExist(canonicalTarget, label)
	return canonicalTarget
}

function validateAbsoluteLocalPath(configuredPath: string, label: string) {
	if (
		typeof configuredPath !== 'string' ||
		configuredPath.length === 0 ||
		configuredPath.trim() !== configuredPath ||
		configuredPath.includes('\0') ||
		!isAbsolute(configuredPath) ||
		isNetworkPath(configuredPath)
	) {
		throw snapshotError('INVALID_PATH', `The ${label} must be an absolute local path.`)
	}
	const normalized = resolve(configuredPath)
	if (normalized === parse(normalized).root) {
		throw snapshotError('INVALID_PATH', `A filesystem root cannot be used as the ${label}.`)
	}
	return normalized
}

async function assertPhysicalAncestors(path: string, includeLeaf: boolean, label: string) {
	const normalized = resolve(path)
	const parsed = parse(normalized)
	const segments = normalized.slice(parsed.root.length).split(sep).filter(Boolean)
	let current = parsed.root
	const limit = includeLeaf ? segments.length : Math.max(0, segments.length - 1)
	for (let index = 0; index < limit; index++) {
		current = join(current, segments[index])
		let info: Awaited<ReturnType<typeof lstat>>
		try {
			info = await lstat(current)
		} catch (error) {
			throw snapshotError('INVALID_PATH', `The ${label} contains a missing path component.`, error)
		}
		if (info.isSymbolicLink() || !info.isDirectory()) {
			throw snapshotError(
				'UNSAFE_ENTRY',
				`The ${label} must not contain symbolic links or non-directory ancestors.`
			)
		}
	}
}

function assertSeparateTrees(
	first: string,
	second: string,
	firstLabel: string,
	secondLabel: string
) {
	if (containsPath(first, second) || containsPath(second, first)) {
		throw snapshotError(
			'INVALID_PATH',
			`The ${firstLabel} and ${secondLabel} must not be equal or nested.`
		)
	}
}

function containsPath(parent: string, child: string) {
	const relation = relative(normalizeComparisonPath(parent), normalizeComparisonPath(child))
	return (
		relation === '' ||
		(!relation.startsWith(`..${sep}`) && relation !== '..' && !isAbsolute(relation))
	)
}

function normalizeComparisonPath(path: string) {
	const normalized = resolve(path)
	return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

async function assertExactRootEntries(root: string, expected: string[], label: string) {
	let entries: Dirent[]
	try {
		entries = await readdir(root, { withFileTypes: true })
	} catch (error) {
		throw snapshotError('IO_ERROR', `Could not inspect the ${label}.`, error)
	}
	const actualNames = entries.map((entry) => entry.name).sort((a, b) => a.localeCompare(b, 'en'))
	const expectedNames = [...expected].sort((a, b) => a.localeCompare(b, 'en'))
	if (
		actualNames.length !== expectedNames.length ||
		actualNames.some((name, index) => name !== expectedNames[index])
	) {
		throw snapshotError(
			label === 'source store root' ? 'SOURCE_LAYOUT_INVALID' : 'INTEGRITY_MISMATCH',
			`The ${label} must contain exactly: ${expectedNames.join(', ')}.`
		)
	}
}

async function createSiblingStagingDirectory(target: string, operation: 'restore' | 'snapshot') {
	const parent = dirname(target)
	const safeBaseName =
		basename(target)
			.replace(/[^A-Za-z0-9._-]/g, '_')
			.slice(0, 80) || 'review-data'
	const prefix = join(parent, `.${safeBaseName}.${operation}-${randomBytes(6).toString('hex')}-`)
	const stagingPath = await mkdtemp(prefix)
	await chmodPrivateDirectory(stagingPath)
	return stagingPath
}

/**
 * Node does not expose renameat2(RENAME_NOREPLACE), so publication uses a deterministic mkdir
 * reservation beneath an owner-only 0700 parent. This prevents two cooperating tool processes
 * from targeting the same path. A non-cooperating process running as the same OS account (or root)
 * can remove the reservation or race the final absence check and is outside this protocol's trust
 * boundary.
 */
async function acquireTargetReservation(
	target: string,
	durability: ReviewDataSnapshotDurability
): Promise<TargetReservation> {
	const parent = dirname(target)
	const reservationHash = createHash('sha256')
		.update('shotgrid-review-data-target-reservation-v1\0')
		.update(normalizeComparisonPath(target))
		.digest('hex')
	const reservationPath = join(parent, `.review-data-${reservationHash}.lock`)
	let created = false
	let reservation: TargetReservation | undefined
	try {
		await mkdir(reservationPath, { mode: PRIVATE_DIRECTORY_MODE })
		created = true
		const info = await lstat(reservationPath)
		assertPhysicalDirectory(info, 'target reservation')
		await assertPrivateDirectoryMode(info, 'target reservation')
		reservation = {
			dev: String(info.dev),
			ino: String(info.ino),
			parent,
			path: reservationPath,
		}
		await durability.syncDirectory(reservationPath)
		await durability.syncDirectory(parent)
		await assertTargetDoesNotExist(target, 'requested target')
		return reservation
	} catch (error) {
		if (reservation) {
			await releaseReservationBestEffort(reservation, durability)
		} else if (created) {
			await releaseReservationPathBestEffort(reservationPath, parent, durability)
		}
		if (hasErrorCode(error, 'EEXIST')) {
			throw snapshotError(
				'TARGET_EXISTS',
				'The requested target is reserved by another operation; inspect the private parent before retrying.',
				error
			)
		}
		throw wrapSnapshotError(error, 'Could not reserve the requested target.')
	}
}

async function publishStagingDirectory(
	stagingPath: string,
	target: string,
	reservation: TargetReservation,
	durability: ReviewDataSnapshotDurability
) {
	await assertTargetDoesNotExist(target, 'requested target')
	const stagingInfo = await lstat(stagingPath)
	assertPhysicalDirectory(stagingInfo, 'staging directory')
	try {
		await rename(stagingPath, target)
	} catch (error) {
		if (await wasDirectoryPublished(stagingPath, target, stagingInfo)) {
			throw committedIndeterminateError(target, error)
		}
		if (hasErrorCode(error, 'EEXIST') || hasErrorCode(error, 'ENOTEMPTY')) {
			throw snapshotError('TARGET_EXISTS', 'The requested target was created concurrently.', error)
		}
		throw error
	}

	try {
		await durability.syncDirectory(reservation.parent)
		await releaseReservation(reservation, durability)
	} catch (error) {
		throw committedIndeterminateError(target, error)
	}
}

async function wasDirectoryPublished(
	stagingPath: string,
	target: string,
	stagingInfo: Awaited<ReturnType<typeof lstat>>
) {
	try {
		const targetInfo = await lstat(target)
		if (!sameEntry(stagingInfo, targetInfo) || !targetInfo.isDirectory()) return false
		try {
			await lstat(stagingPath)
			return false
		} catch (error) {
			return hasErrorCode(error, 'ENOENT')
		}
	} catch {
		return false
	}
}

async function releaseReservation(
	reservation: TargetReservation,
	durability: ReviewDataSnapshotDurability
) {
	const info = await lstat(reservation.path)
	assertPhysicalDirectory(info, 'target reservation')
	if (String(info.dev) !== reservation.dev || String(info.ino) !== reservation.ino) {
		throw snapshotError('UNSAFE_ENTRY', 'The target reservation changed during publication.')
	}
	if ((await readdir(reservation.path)).length !== 0) {
		throw snapshotError('UNSAFE_ENTRY', 'The target reservation was modified during publication.')
	}
	await rmdir(reservation.path)
	await durability.syncDirectory(reservation.parent)
}

async function releaseReservationBestEffort(
	reservation: TargetReservation,
	durability: ReviewDataSnapshotDurability
) {
	try {
		await releaseReservation(reservation, durability)
	} catch {
		// Never remove an entry that no longer matches the reservation we created.
	}
}

async function releaseReservationPathBestEffort(
	reservationPath: string,
	parent: string,
	durability: ReviewDataSnapshotDurability
) {
	try {
		if ((await readdir(reservationPath)).length !== 0) return
		await rmdir(reservationPath)
		await durability.syncDirectory(parent)
	} catch {
		// Acquisition failed before a reservation handle could be returned.
	}
}

async function assertTargetDoesNotExist(target: string, label: string) {
	try {
		await lstat(target)
		throw snapshotError('TARGET_EXISTS', `The ${label} must not already exist.`)
	} catch (error) {
		if (error instanceof ReviewDataSnapshotError) throw error
		if (!hasErrorCode(error, 'ENOENT')) {
			throw snapshotError('IO_ERROR', `Could not inspect the ${label}.`, error)
		}
	}
}

async function removeStagingDirectory(path: string) {
	try {
		await makeTreeWritable(path)
		await rm(path, { force: true, recursive: true })
	} catch {
		// A hidden staging path is never promoted to the requested target. Cleanup is best effort.
	}
}

async function makeTreeWritable(path: string) {
	let info: Awaited<ReturnType<typeof lstat>>
	try {
		info = await lstat(path)
	} catch {
		return
	}
	if (!info.isDirectory() || info.isSymbolicLink()) return
	await chmod(path, PRIVATE_DIRECTORY_MODE).catch(() => undefined)
	for (const child of await readdir(path, { withFileTypes: true }).catch(() => [])) {
		const childPath = join(path, child.name)
		if (child.isDirectory() && !child.isSymbolicLink()) await makeTreeWritable(childPath)
		else if (child.isFile()) await chmod(childPath, PRIVATE_FILE_MODE).catch(() => undefined)
	}
}

async function chmodPrivateDirectory(path: string) {
	await chmod(path, PRIVATE_DIRECTORY_MODE)
}

async function assertPrivateDirectory(path: string, label: string) {
	const info = await lstat(path)
	assertPhysicalDirectory(info, label)
	await assertPrivateDirectoryMode(info, label)
}

async function assertPrivateDirectoryMode(info: Awaited<ReturnType<typeof lstat>>, label: string) {
	if (process.platform !== 'win32' && (Number(info.mode) & 0o777) !== PRIVATE_DIRECTORY_MODE) {
		throw snapshotError('UNSAFE_ENTRY', `The ${label} must have mode 0700.`)
	}
	assertCurrentOwner(info, label)
}

async function assertPrivateFileMode(info: Awaited<ReturnType<typeof lstat>>, label: string) {
	if (process.platform !== 'win32' && (Number(info.mode) & 0o777) !== PRIVATE_FILE_MODE) {
		throw snapshotError('UNSAFE_ENTRY', `The ${label} must have mode 0600.`)
	}
	assertCurrentOwner(info, label)
}

async function assertSnapshotDirectoryMode(info: Awaited<ReturnType<typeof lstat>>, label: string) {
	if (process.platform !== 'win32' && (Number(info.mode) & 0o777) !== READ_ONLY_DIRECTORY_MODE) {
		throw snapshotError('INTEGRITY_MISMATCH', `The ${label} must have snapshot mode 0500.`)
	}
	assertCurrentOwner(info, label)
}

async function assertSnapshotFileMode(info: Awaited<ReturnType<typeof lstat>>, label: string) {
	if (process.platform !== 'win32' && (Number(info.mode) & 0o777) !== READ_ONLY_FILE_MODE) {
		throw snapshotError('INTEGRITY_MISMATCH', `The ${label} must have snapshot mode 0400.`)
	}
	assertCurrentOwner(info, label)
}

function assertCurrentOwner(info: Awaited<ReturnType<typeof lstat>>, label: string) {
	if (process.platform === 'win32') return
	const uid = process.getuid?.()
	if (uid === undefined || Number(info.uid) !== uid) {
		throw snapshotError('UNSAFE_ENTRY', `The ${label} is not owned by the current user.`)
	}
}

function assertPhysicalDirectory(info: Awaited<ReturnType<typeof lstat>>, label: string) {
	if (info.isSymbolicLink() || !info.isDirectory()) {
		throw snapshotError('UNSAFE_ENTRY', `The ${label} is not a physical directory.`)
	}
}

function assertSafePathSegment(segment: string) {
	if (
		segment.length === 0 ||
		segment === '.' ||
		segment === '..' ||
		segment.includes('/') ||
		segment.includes('\\') ||
		segment.includes('\0')
	) {
		throw snapshotError('UNSAFE_ENTRY', 'A store entry has an unsafe file name.')
	}
}

function assertSafeManifestPath(path: string) {
	if (
		typeof path !== 'string' ||
		path.length === 0 ||
		path.length > MAX_RELATIVE_PATH_LENGTH ||
		path.startsWith('/') ||
		path.includes('\\') ||
		path.includes('\0')
	) {
		throw snapshotError('SNAPSHOT_INVALID', 'A snapshot manifest path is unsafe.')
	}
	for (const segment of path.split('/')) {
		if (
			segment.length === 0 ||
			segment === '.' ||
			segment === '..' ||
			segment.includes('/') ||
			segment.includes('\\') ||
			segment.includes('\0')
		) {
			throw snapshotError('SNAPSHOT_INVALID', 'A snapshot manifest path is unsafe.')
		}
	}
}

function resolveManifestPath(root: string, manifestPath: string) {
	assertSafeManifestPath(manifestPath)
	const resolved = resolve(root, ...manifestPath.split('/'))
	if (!containsPath(root, resolved) || resolved === root) {
		throw snapshotError('SNAPSHOT_INVALID', 'A snapshot manifest path escapes its store.')
	}
	return resolved
}

function sameEntry(
	left: Awaited<ReturnType<typeof lstat>>,
	right: Awaited<ReturnType<typeof lstat>>
) {
	return String(left.dev) === String(right.dev) && String(left.ino) === String(right.ino)
}

function requireOfflineAcknowledgement(options: ReviewDataSnapshotOptions) {
	if (!options || options.apiStopped !== true) {
		throw snapshotError(
			'OFFLINE_CONFIRMATION_REQUIRED',
			'Every ShotGrid review API process must be stopped; pass the explicit offline confirmation.'
		)
	}
}

function readSnapshotTime(now: ReviewDataSnapshotOptions['now']) {
	const value = (now ?? (() => new Date()))()
	if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
		throw snapshotError('INVALID_ARGUMENT', 'The snapshot clock returned an invalid date.')
	}
	return value.toISOString()
}

function summarizeManifest(
	manifest: ReviewDataSnapshotManifest,
	path: string
): ReviewDataSnapshotSummary {
	let bytes = 0
	let files = 0
	for (const store of manifest.stores) {
		for (const entry of store.entries) {
			if (entry.kind === 'file') {
				bytes += entry.size
				files++
			}
		}
	}
	return { bytes, createdAt: manifest.createdAt, files, path }
}

function isCanonicalIsoTime(value: string) {
	const milliseconds = Date.parse(value)
	return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
	const prototype = Object.getPrototypeOf(value)
	return prototype === Object.prototype || prototype === null
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]) {
	const actual = Object.keys(value).sort()
	const sortedExpected = [...expected].sort()
	return (
		actual.length === sortedExpected.length &&
		actual.every((key, index) => key === sortedExpected[index])
	)
}

function isNetworkPath(path: string) {
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

function resolveDurability(
	durability: ReviewDataSnapshotOptions['durability']
): ReviewDataSnapshotDurability {
	if (durability === undefined) return DEFAULT_DURABILITY
	if (
		typeof durability !== 'object' ||
		durability === null ||
		typeof durability.syncDirectory !== 'function' ||
		typeof durability.syncFile !== 'function'
	) {
		throw snapshotError('INVALID_ARGUMENT', 'The snapshot durability adapter is invalid.')
	}
	return durability
}

const DEFAULT_DURABILITY: ReviewDataSnapshotDurability = {
	syncDirectory: syncPhysicalDirectory,
	syncFile: syncPhysicalFile,
}

async function syncPhysicalFile(_path: string, handle: FileHandle) {
	await handle.sync()
}

async function syncPhysicalDirectory(path: string) {
	let handle: Awaited<ReturnType<typeof open>> | undefined
	try {
		handle = await open(path, constants.O_RDONLY)
		await handle.sync()
	} catch (error) {
		if (!isIgnorableReviewDataDirectorySyncError(error)) throw error
	} finally {
		await handle?.close().catch(() => undefined)
	}
}

/** @internal Exported only so the platform-specific durability boundary can be regression tested. */
export function isIgnorableReviewDataDirectorySyncError(
	error: unknown,
	platform: NodeJS.Platform = process.platform
) {
	return (
		platform === 'win32' &&
		(hasErrorCode(error, 'EINVAL') || hasErrorCode(error, 'EISDIR') || hasErrorCode(error, 'EPERM'))
	)
}

function committedIndeterminateError(target: string, cause: unknown) {
	return new ReviewDataSnapshotCommitError(
		target,
		`The target was published at ${target}, but final filesystem durability or reservation cleanup could not be confirmed. Verify that target and do not retry blindly.`,
		{ cause }
	)
}

function wrapSnapshotError(error: unknown, message: string) {
	if (error instanceof ReviewDataSnapshotError) return error
	return snapshotError('IO_ERROR', message, error)
}

function snapshotError(code: ReviewDataSnapshotErrorCode, message: string, cause?: unknown) {
	return new ReviewDataSnapshotError(code, message, cause === undefined ? undefined : { cause })
}
