import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
	REVIEW_DATA_STORE_NAMES,
	restoreReviewData,
	ReviewDataSnapshotCommitError,
	verifyReviewDataSnapshot,
} from './ReviewDataSnapshot'
import { runReviewDataSnapshotCli } from './reviewDataSnapshotCli'

const temporaryRoots = new Set<string>()

afterEach(() => {
	for (const root of temporaryRoots) {
		makeTreeWritable(root)
		rmSync(root, { force: true, recursive: true })
	}
	temporaryRoots.clear()
})

describe('review data snapshot CLI', () => {
	it('prints offline usage and exits successfully for help', async () => {
		const output = captureIo()

		await expect(runReviewDataSnapshotCli(['--help'], output.io)).resolves.toBe(0)
		expect(output.stdout.join('')).toContain('does not support hot backup')
		expect(output.stdout.join('')).toContain('--confirm-api-stopped')
		expect(output.stdout.join('')).toContain('bind mounts, junctions')
		expect(output.stdout.join('')).toContain('test -ef')
		expect(output.stderr).toEqual([])
	})

	it('requires the explicit API-stopped flag and emits a stable JSON error', async () => {
		const root = createTemporaryRoot()
		const output = captureIo()

		await expect(
			runReviewDataSnapshotCli(
				['backup', '--source', join(root, 'stores'), '--snapshot', join(root, 'snapshot')],
				output.io
			)
		).resolves.toBe(1)
		expect(JSON.parse(output.stderr.join(''))).toMatchObject({
			error: { code: 'OFFLINE_CONFIRMATION_REQUIRED' },
		})
		expect(output.stdout).toEqual([])
	})

	it('runs backup, verify, and restore with machine-readable summaries', async () => {
		const root = createTemporaryRoot()
		const stores = createStores(root)
		const snapshot = join(root, 'snapshot')
		const restored = join(root, 'restored')

		const backupOutput = captureIo()
		expect(
			await runReviewDataSnapshotCli(
				['backup', '--source', stores, '--snapshot', snapshot, '--confirm-api-stopped'],
				backupOutput.io
			)
		).toBe(0)
		expect(JSON.parse(backupOutput.stdout.join(''))).toMatchObject({
			bytes: 11,
			files: 1,
			operation: 'backup',
			path: canonicalNewPath(snapshot),
		})
		expect(backupOutput.stderr).toEqual([])

		const verifyOutput = captureIo()
		expect(
			await runReviewDataSnapshotCli(['verify', '--snapshot', snapshot], verifyOutput.io)
		).toBe(0)
		expect(JSON.parse(verifyOutput.stdout.join(''))).toMatchObject({
			bytes: 11,
			files: 1,
			operation: 'verify',
			path: canonicalNewPath(snapshot),
		})

		const restoreOutput = captureIo()
		expect(
			await runReviewDataSnapshotCli(
				['restore', '--snapshot', snapshot, '--target', restored, '--confirm-api-stopped'],
				restoreOutput.io
			)
		).toBe(0)
		expect(JSON.parse(restoreOutput.stdout.join(''))).toMatchObject({
			bytes: 11,
			files: 1,
			operation: 'restore',
			path: canonicalNewPath(restored),
		})
		expect(readdirSync(restored).sort()).toEqual([...REVIEW_DATA_STORE_NAMES].sort())
	})

	it('rejects duplicate, unknown, and operation-inapplicable options', async () => {
		for (const argv of [
			['verify', '--snapshot', 'one', '--snapshot', 'two'],
			['verify', '--unknown'],
			['verify', '--snapshot', 'one', '--confirm-api-stopped'],
		]) {
			const output = captureIo()
			expect(await runReviewDataSnapshotCli(argv, output.io)).toBe(2)
			expect(JSON.parse(output.stderr.join(''))).toMatchObject({
				error: { code: 'INVALID_ARGUMENT' },
			})
		}
	})

	it('reports a published indeterminate target distinctly and forbids blind retry semantics', async () => {
		const root = createTemporaryRoot()
		const target = join(root, 'published-target')
		const output = captureIo()

		expect(
			await runReviewDataSnapshotCli(
				['backup', '--source', join(root, 'stores'), '--snapshot', target, '--confirm-api-stopped'],
				output.io,
				{
					backupReviewData: async () => {
						throw new ReviewDataSnapshotCommitError(
							target,
							'Target is published; verify it and do not retry blindly.'
						)
					},
					restoreReviewData,
					verifyReviewDataSnapshot,
				}
			)
		).toBe(3)
		expect(JSON.parse(output.stderr.join(''))).toEqual({
			error: {
				code: 'COMMITTED_INDETERMINATE',
				committed: true,
				durability: 'indeterminate',
				message: 'Target is published; verify it and do not retry blindly.',
				path: target,
			},
		})
		expect(output.stdout).toEqual([])
	})
})

function captureIo() {
	const stdout: string[] = []
	const stderr: string[] = []
	return {
		io: {
			stderr: (message: string) => stderr.push(message),
			stdout: (message: string) => stdout.push(message),
		},
		stderr,
		stdout,
	}
}

function createTemporaryRoot() {
	const root = mkdtempSync(join(tmpdir(), 'shotgrid-review-data-cli-'))
	temporaryRoots.add(root)
	return root
}

function createStores(root: string) {
	const stores = join(root, 'stores')
	mkdirPrivate(stores)
	for (const store of REVIEW_DATA_STORE_NAMES) mkdirPrivate(join(stores, store))
	writePrivateFile(join(stores, 'audit', 'review-audit.sqlite'), 'audit-data!')
	return stores
}

function mkdirPrivate(path: string) {
	mkdirSync(path, { mode: 0o700 })
	if (process.platform !== 'win32') chmodSync(path, 0o700)
}

function writePrivateFile(path: string, contents: string) {
	writeFileSync(path, contents, { mode: 0o600 })
	if (process.platform !== 'win32') chmodSync(path, 0o600)
}

function canonicalNewPath(path: string) {
	return join(realpathSync.native(dirname(path)), basename(path))
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
