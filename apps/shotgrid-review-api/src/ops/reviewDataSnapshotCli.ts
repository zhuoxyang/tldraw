import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	backupReviewData,
	restoreReviewData,
	ReviewDataSnapshotCommitError,
	ReviewDataSnapshotError,
	verifyReviewDataSnapshot,
} from './ReviewDataSnapshot'

const HELP = `ShotGrid review offline data snapshot tool

The API must be fully stopped before backup or restore. This tool does not support hot backup.

Usage:
  review-data-snapshot backup --source <shared-store-root> --snapshot <new-snapshot-dir> --confirm-api-stopped
  review-data-snapshot verify --snapshot <snapshot-dir>
  review-data-snapshot restore --snapshot <snapshot-dir> --target <new-store-root> --confirm-api-stopped

The shared store root must contain exactly: audit/, events/, publications/, sync/.
Backup and restore targets must be absolute local paths that do not already exist.
Their physical parent must be owned by the current POSIX user with mode 0700. A cooperative
reservation prevents concurrent invocations of this tool from publishing the same target; a
non-cooperating process under the same OS account or root remains outside that trust boundary.
Direct CLI use must not rely on bind mounts, junctions, or other physical aliases to make source
and target appear separate. The supported Compose named-volume workflow additionally checks its
mount roots with test -ef before invoking this CLI.

Exit code 3 means the target was published but final durability is indeterminate. Verify the
reported path and do not retry blindly.
`

export interface ReviewDataSnapshotCliIo {
	stderr(message: string): void
	stdout(message: string): void
}

const defaultIo: ReviewDataSnapshotCliIo = {
	stderr: (message) => process.stderr.write(message),
	stdout: (message) => process.stdout.write(message),
}

export interface ReviewDataSnapshotCliDependencies {
	backupReviewData: typeof backupReviewData
	restoreReviewData: typeof restoreReviewData
	verifyReviewDataSnapshot: typeof verifyReviewDataSnapshot
}

const defaultDependencies: ReviewDataSnapshotCliDependencies = {
	backupReviewData,
	restoreReviewData,
	verifyReviewDataSnapshot,
}

export async function runReviewDataSnapshotCli(
	argv: readonly string[],
	io: ReviewDataSnapshotCliIo = defaultIo,
	dependencies: ReviewDataSnapshotCliDependencies = defaultDependencies
) {
	try {
		const parsed = parseArguments(argv)
		if (parsed.operation === 'help') {
			io.stdout(HELP)
			return 0
		}
		const summary =
			parsed.operation === 'backup'
				? await dependencies.backupReviewData(parsed.source, parsed.snapshot, {
						apiStopped: parsed.confirmApiStopped,
					})
				: parsed.operation === 'verify'
					? await dependencies.verifyReviewDataSnapshot(parsed.snapshot)
					: await dependencies.restoreReviewData(parsed.snapshot, parsed.target, {
							apiStopped: parsed.confirmApiStopped,
						})
		io.stdout(`${JSON.stringify({ operation: parsed.operation, ...summary })}\n`)
		return 0
	} catch (error) {
		const code = error instanceof ReviewDataSnapshotError ? error.code : 'UNEXPECTED_ERROR'
		const message = error instanceof Error ? error.message : 'The snapshot command failed.'
		const details =
			error instanceof ReviewDataSnapshotCommitError
				? {
						code,
						committed: error.committed,
						durability: error.durability,
						message,
						path: error.path,
					}
				: { code, message }
		io.stderr(`${JSON.stringify({ error: details })}\n`)
		if (error instanceof ReviewDataSnapshotCommitError) return 3
		return error instanceof ReviewDataSnapshotError && error.code === 'INVALID_ARGUMENT' ? 2 : 1
	}
}

type ParsedArguments =
	| { operation: 'help' }
	| {
			confirmApiStopped: boolean
			operation: 'backup'
			snapshot: string
			source: string
	  }
	| { operation: 'verify'; snapshot: string }
	| {
			confirmApiStopped: boolean
			operation: 'restore'
			snapshot: string
			target: string
	  }

function parseArguments(argv: readonly string[]): ParsedArguments {
	if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') return { operation: 'help' }
	const operation = argv[0]
	if (operation !== 'backup' && operation !== 'verify' && operation !== 'restore') {
		throw argumentError(`Unknown operation: ${operation}`)
	}
	const values = new Map<string, string | true>()
	for (let index = 1; index < argv.length; index++) {
		const name = argv[index]
		if (!name.startsWith('--')) throw argumentError(`Unexpected argument: ${name}`)
		if (values.has(name)) throw argumentError(`Duplicate option: ${name}`)
		if (name === '--confirm-api-stopped') {
			values.set(name, true)
			continue
		}
		if (!['--snapshot', '--source', '--target'].includes(name)) {
			throw argumentError(`Unknown option: ${name}`)
		}
		const value = argv[++index]
		if (!value || value.startsWith('--')) throw argumentError(`Missing value for ${name}`)
		values.set(name, value)
	}

	const allowed =
		operation === 'backup'
			? new Set(['--confirm-api-stopped', '--snapshot', '--source'])
			: operation === 'restore'
				? new Set(['--confirm-api-stopped', '--snapshot', '--target'])
				: new Set(['--snapshot'])
	for (const name of values.keys()) {
		if (!allowed.has(name)) throw argumentError(`${name} is not valid for ${operation}.`)
	}

	const snapshot = requireValue(values, '--snapshot')
	if (operation === 'verify') return { operation, snapshot }
	const confirmApiStopped = values.get('--confirm-api-stopped') === true
	if (!confirmApiStopped) {
		throw new ReviewDataSnapshotError(
			'OFFLINE_CONFIRMATION_REQUIRED',
			'Stop every ShotGrid review API process, then pass --confirm-api-stopped.'
		)
	}
	if (operation === 'backup') {
		return {
			confirmApiStopped,
			operation,
			snapshot,
			source: requireValue(values, '--source'),
		}
	}
	return {
		confirmApiStopped,
		operation,
		snapshot,
		target: requireValue(values, '--target'),
	}
}

function requireValue(values: Map<string, string | true>, name: string) {
	const value = values.get(name)
	if (typeof value !== 'string') throw argumentError(`Missing required option: ${name}`)
	return value
}

function argumentError(message: string) {
	return new ReviewDataSnapshotError('INVALID_ARGUMENT', message)
}

function isMainModule() {
	if (!process.argv[1]) return false
	try {
		return resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])
	} catch {
		return false
	}
}

if (isMainModule()) {
	process.exitCode = await runReviewDataSnapshotCli(process.argv.slice(2))
}
