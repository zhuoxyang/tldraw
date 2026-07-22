import type { ReviewChangeEvent } from '@tldraw/shotgrid-review-contracts'
import { describe, expect, it, vi } from 'vitest'
import {
	createReviewApiClient,
	type ReviewChangeObserver,
	type ReviewEventSource,
} from './reviewApiClient'

const changeEvent: ReviewChangeEvent = {
	attributeName: 'sg_status_list',
	entity: { id: 301, type: 'Version' },
	eventLogEntryId: 545175,
	observedAt: '2026-07-22T08:30:00.000Z',
	operation: 'update',
	projectId: 101,
	sequence: 42,
	sourceEventId: '11777.3065.0',
}

describe('ReviewApiClient change stream', () => {
	it('opens the protected feed and emits only strictly increasing valid events', () => {
		const source = new FakeReviewEventSource()
		const eventSourceFactory = vi.fn(() => source)
		const observer = createObserver()
		const client = createReviewApiClient({ baseUrl: '/api/', eventSourceFactory })

		const unsubscribe = client.watchChanges(observer)
		expect(eventSourceFactory).toHaveBeenCalledWith('/api/review/changes')
		expect(observer.onStatusChange).toHaveBeenCalledWith('connecting')

		source.emit('open')
		source.emitMessage(changeEvent)
		source.emitMessage(changeEvent)
		source.emitMessage({ ...changeEvent, sequence: 41 })
		source.emitMessage({ ...changeEvent, sequence: 43 })

		expect(observer.onStatusChange).toHaveBeenLastCalledWith('live')
		expect(observer.onChange.mock.calls.map(([event]) => event.sequence)).toEqual([42, 43])

		unsubscribe()
		unsubscribe()
		expect(source.close).toHaveBeenCalledOnce()
		source.emitMessage({ ...changeEvent, sequence: 44 })
		expect(observer.onChange).toHaveBeenCalledTimes(2)
	})

	it('rejects malformed payloads and last-event-id mismatches without exposing data', () => {
		const source = new FakeReviewEventSource()
		const observer = createObserver()
		const client = createReviewApiClient({
			baseUrl: 'https://review.example.test/api',
			eventSourceFactory: () => source,
		})
		client.watchChanges(observer)

		source.emitRawMessage('{"secret":"signed-payload-value"', '42')
		source.emitRawMessage(JSON.stringify(changeEvent), '41')
		source.emitMessage({ ...changeEvent, unexpected: 'signed-payload-value' })

		expect(observer.onChange).not.toHaveBeenCalled()
		expect(observer.onError).toHaveBeenCalledTimes(3)
		expect(observer.onError).toHaveBeenCalledWith({
			code: 'INVALID_EVENT',
			message: 'The review change stream returned an invalid event.',
		})
		expect(JSON.stringify(observer.onError.mock.calls)).not.toContain('signed-payload-value')
	})

	it('reports transport loss as offline and returns to live after EventSource reconnects', () => {
		const source = new FakeReviewEventSource()
		const observer = createObserver()
		const client = createReviewApiClient({ baseUrl: '/api', eventSourceFactory: () => source })
		client.watchChanges(observer)

		source.emit('open')
		source.emit('error')
		source.emit('error')
		source.emit('open')

		expect(observer.onStatusChange.mock.calls.map(([status]) => status)).toEqual([
			'connecting',
			'live',
			'offline',
			'live',
		])
		expect(observer.onError).toHaveBeenCalledTimes(2)
		expect(observer.onError).toHaveBeenLastCalledWith({
			code: 'CONNECTION_ERROR',
			message: 'The review change stream connection was interrupted.',
		})
	})

	it('fails closed with a generic offline status when EventSource cannot be created', () => {
		const observer = createObserver()
		const client = createReviewApiClient({
			baseUrl: '/api',
			eventSourceFactory: () => {
				throw new Error('private constructor failure')
			},
		})

		const unsubscribe = client.watchChanges(observer)
		expect(observer.onStatusChange.mock.calls.map(([status]) => status)).toEqual([
			'connecting',
			'offline',
		])
		expect(observer.onError).toHaveBeenCalledWith({
			code: 'CONNECTION_ERROR',
			message: 'The review change stream could not be opened.',
		})
		expect(JSON.stringify(observer.onError.mock.calls)).not.toContain('private constructor failure')
		expect(unsubscribe).not.toThrow()
	})
})

function createObserver() {
	return {
		onChange: vi.fn<ReviewChangeObserver['onChange']>(),
		onError: vi.fn<NonNullable<ReviewChangeObserver['onError']>>(),
		onStatusChange: vi.fn<ReviewChangeObserver['onStatusChange']>(),
	}
}

class FakeReviewEventSource implements ReviewEventSource {
	private readonly listeners = new Map<string, Set<EventListener>>()
	readonly close = vi.fn()

	addEventListener(type: string, listener: EventListener) {
		const listeners = this.listeners.get(type) ?? new Set<EventListener>()
		listeners.add(listener)
		this.listeners.set(type, listeners)
	}

	removeEventListener(type: string, listener: EventListener) {
		this.listeners.get(type)?.delete(listener)
	}

	emit(type: string) {
		this.dispatch(type, { type } as Event)
	}

	emitMessage(event: unknown) {
		const sequence =
			event !== null && typeof event === 'object' && 'sequence' in event
				? String(event.sequence)
				: ''
		this.emitRawMessage(JSON.stringify(event), sequence)
	}

	emitRawMessage(data: string, lastEventId: string) {
		this.dispatch('message', { data, lastEventId, type: 'message' } as MessageEvent<string>)
	}

	private dispatch(type: string, event: Event) {
		for (const listener of this.listeners.get(type) ?? []) listener(event)
	}
}
