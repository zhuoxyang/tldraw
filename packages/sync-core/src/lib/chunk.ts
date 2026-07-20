// quarter of a megabyte, max possible utf-8 string size

// cloudflare workers only accept messages of max 1mb
const MAX_CLIENT_SENT_MESSAGE_SIZE_BYTES = 1024 * 1024
// utf-8 is max 4 bytes per char
const MAX_BYTES_PER_CHAR = 4

// in the (admittedly impossible) worst case, the max size is 1/4 of a megabyte
const MAX_SAFE_MESSAGE_SIZE = MAX_CLIENT_SENT_MESSAGE_SIZE_BYTES / MAX_BYTES_PER_CHAR

const DEFAULT_MAX_ASSEMBLED_MESSAGE_SIZE_BYTES = 16 * 1024 * 1024
const DEFAULT_MAX_ASSEMBLED_MESSAGE_CHUNKS = 32 * 1024

function normalizePositiveSafeInteger(value: number | undefined, fallback: number, name: string) {
	const normalized = value ?? fallback
	if (!Number.isSafeInteger(normalized) || normalized <= 0) {
		throw new RangeError(`${name} must be a positive safe integer`)
	}
	return normalized
}

function utf8ByteLength(value: string) {
	let bytes = 0
	for (let index = 0; index < value.length; index++) {
		const codePoint = value.codePointAt(index)!
		if (codePoint <= 0x7f) {
			bytes += 1
		} else if (codePoint <= 0x7ff) {
			bytes += 2
		} else if (codePoint <= 0xffff) {
			bytes += 3
		} else {
			bytes += 4
			index++
		}
	}
	return bytes
}

function startsWithLowSurrogate(value: string) {
	if (value.length === 0) return false
	const first = value.charCodeAt(0)
	return first >= 0xdc00 && first <= 0xdfff
}

function endsWithHighSurrogate(value: string) {
	if (value.length === 0) return false
	const last = value.charCodeAt(value.length - 1)
	return last >= 0xd800 && last <= 0xdbff
}

/**
 * Splits a string into smaller chunks suitable for transmission over WebSockets.
 * This function ensures messages don't exceed size limits imposed by platforms like Cloudflare Workers (1MB max).
 * Each chunk is prefixed with a number indicating how many more chunks follow.
 *
 * @param msg - The string to split into chunks
 * @param maxSafeMessageSize - Maximum safe size for each chunk in characters. Defaults to quarter megabyte to account for UTF-8 encoding
 * @returns Array of chunked strings, each prefixed with "\{number\}_" where number indicates remaining chunks
 *
 * @example
 * ```ts
 * // Small message - returns as single chunk
 * chunk('hello world') // ['hello world']
 *
 * // Large message - splits into multiple chunks
 * chunk('very long message...', 10)
 * // ['2_very long', '1_ message', '0_...']
 * ```
 *
 * @internal
 */
export function chunk(msg: string, maxSafeMessageSize = MAX_SAFE_MESSAGE_SIZE) {
	if (msg.length < maxSafeMessageSize) {
		return [msg]
	} else {
		const chunks = []
		let chunkNumber = 0
		let offset = msg.length
		while (offset > 0) {
			const prefix = `${chunkNumber}_`
			const chunkSize = Math.max(Math.min(maxSafeMessageSize - prefix.length, offset), 1)
			chunks.unshift(prefix + msg.slice(offset - chunkSize, offset))
			offset -= chunkSize
			chunkNumber++
		}
		return chunks
	}
}

// The 's' flag (dotAll) makes '.' match any character including line terminators
// like U+2028 and U+2029, which are commonly introduced via copy/paste from Word
const chunkRe = /^(\d+)_(.*)$/s

/**
 * Assembles chunked JSON messages back into complete objects.
 * Handles both regular JSON messages and chunked messages created by the chunk() function.
 * Maintains internal state to track partially received chunked messages.
 *
 * @example
 * ```ts
 * const assembler = new JsonChunkAssembler()
 *
 * // Handle regular JSON message
 * const result1 = assembler.handleMessage('{"hello": "world"}')
 * // Returns: { data: { hello: "world" }, stringified: '{"hello": "world"}' }
 *
 * // Handle chunked message
 * assembler.handleMessage('1_hello') // Returns: null (partial)
 * const result2 = assembler.handleMessage('0_ world')
 * // Returns: { data: "hello world", stringified: "hello world" }
 * ```
 *
 * @public
 */
export class JsonChunkAssembler {
	private bytesReceived = 0
	private lastChunkEndsWithHighSurrogate = false
	private readonly maxMessageSizeBytes: number
	private readonly maxMessageChunks: number

	/**
	 * Current assembly state - either 'idle' or tracking chunks being received
	 */
	state:
		| 'idle'
		| {
				chunksReceived: string[]
				totalChunks: number
		  } = 'idle'

	constructor(
		options: {
			/** Maximum UTF-8 byte size of one complete message, before JSON parsing. */
			maxMessageSizeBytes?: number
			/** Maximum number of chunks allowed for one complete message. */
			maxMessageChunks?: number
		} = {}
	) {
		this.maxMessageSizeBytes = normalizePositiveSafeInteger(
			options.maxMessageSizeBytes,
			DEFAULT_MAX_ASSEMBLED_MESSAGE_SIZE_BYTES,
			'maxMessageSizeBytes'
		)
		this.maxMessageChunks = normalizePositiveSafeInteger(
			options.maxMessageChunks,
			DEFAULT_MAX_ASSEMBLED_MESSAGE_CHUNKS,
			'maxMessageChunks'
		)
	}

	private resetWithError(message: string) {
		this.reset()
		return { error: new Error(message) }
	}

	private reset() {
		this.state = 'idle'
		this.bytesReceived = 0
		this.lastChunkEndsWithHighSurrogate = false
	}

	/**
	 * Processes a single message, which can be either a complete JSON object or a chunk.
	 * For complete JSON objects (starting with '\{'), parses immediately.
	 * For chunks (prefixed with "\{number\}_"), accumulates until all chunks received.
	 *
	 * @param msg - The message to process, either JSON or chunk format
	 * @returns Result object with data/stringified on success, error object on failure, or null for incomplete chunks
	 * 	- `\{ data: object, stringified: string \}` - Successfully parsed complete message
	 * 	- `\{ error: Error \}` - Parse error or invalid chunk sequence
	 * 	- `null` - Chunk received but more chunks expected
	 *
	 * @example
	 * ```ts
	 * const assembler = new JsonChunkAssembler()
	 *
	 * // Complete JSON message
	 * const result = assembler.handleMessage('{"key": "value"}')
	 * if (result && 'data' in result) {
	 *   console.log(result.data) // { key: "value" }
	 * }
	 *
	 * // Chunked message sequence
	 * assembler.handleMessage('2_hel') // null - more chunks expected
	 * assembler.handleMessage('1_lo ') // null - more chunks expected
	 * assembler.handleMessage('0_wor') // { data: "hello wor", stringified: "hello wor" }
	 * ```
	 */
	handleMessage(msg: string): { error: Error } | { stringified: string; data: object } | null {
		if (msg.startsWith('{')) {
			const error = this.state === 'idle' ? undefined : new Error('Unexpected non-chunk message')
			if (error) return this.resetWithError(error.message)
			if (utf8ByteLength(msg) > this.maxMessageSizeBytes) {
				return this.resetWithError(
					`Message exceeds maximum size of ${this.maxMessageSizeBytes} bytes`
				)
			}
			return { data: JSON.parse(msg), stringified: msg }
		} else {
			const match = chunkRe.exec(msg)!
			if (!match) {
				return this.resetWithError('Invalid chunk: ' + JSON.stringify(msg.slice(0, 20) + '...'))
			}
			const numChunksRemaining = Number(match[1])
			const data = match[2]
			if (!Number.isFinite(numChunksRemaining) || !Number.isSafeInteger(numChunksRemaining)) {
				return this.resetWithError('Invalid chunk count')
			}
			if (numChunksRemaining < 0) {
				return this.resetWithError('Invalid chunk count')
			}
			if (numChunksRemaining >= this.maxMessageChunks) {
				return this.resetWithError(
					`Message exceeds maximum chunk count of ${this.maxMessageChunks}`
				)
			}

			if (this.state === 'idle') {
				const bytesReceived = utf8ByteLength(data)
				if (bytesReceived > this.maxMessageSizeBytes) {
					return this.resetWithError(
						`Message exceeds maximum size of ${this.maxMessageSizeBytes} bytes`
					)
				}
				this.state = {
					chunksReceived: [data],
					totalChunks: numChunksRemaining + 1,
				}
				this.bytesReceived = bytesReceived
				this.lastChunkEndsWithHighSurrogate = endsWithHighSurrogate(data)
			} else {
				const expectedChunksRemaining =
					this.state.totalChunks - this.state.chunksReceived.length - 1
				if (numChunksRemaining !== expectedChunksRemaining) {
					return this.resetWithError(`Chunks received in wrong order`)
				}

				// Correct the two-byte over-count when a surrogate pair straddles a chunk boundary.
				const boundaryAdjustment =
					this.lastChunkEndsWithHighSurrogate && startsWithLowSurrogate(data) ? 2 : 0
				const bytesReceived = this.bytesReceived + utf8ByteLength(data) - boundaryAdjustment
				if (bytesReceived > this.maxMessageSizeBytes) {
					return this.resetWithError(
						`Message exceeds maximum size of ${this.maxMessageSizeBytes} bytes`
					)
				}

				this.state.chunksReceived.push(data)
				this.bytesReceived = bytesReceived
				if (data.length > 0) {
					this.lastChunkEndsWithHighSurrogate = endsWithHighSurrogate(data)
				}
			}
			if (this.state.chunksReceived.length === this.state.totalChunks) {
				try {
					const stringified = this.state.chunksReceived.join('')
					const data = JSON.parse(stringified)
					return { data, stringified }
				} catch (e) {
					return { error: e as Error }
				} finally {
					this.reset()
				}
			}
			return null
		}
	}
}
