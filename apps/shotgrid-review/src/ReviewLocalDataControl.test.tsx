// @vitest-environment jsdom

import { act, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReviewLocalDataControl } from './ReviewLocalDataControl'

let cleanup: (() => void) | undefined

afterEach(() => {
	cleanup?.()
	cleanup = undefined
})

describe('ReviewLocalDataControl', () => {
	it('requires an explicit warning before clearing and remounting review state', async () => {
		const clearLocalData = vi.fn(async () => {})
		const confirmClear = vi.fn(() => true)
		const onCleared = vi.fn()
		const container = renderControl({ clearLocalData, confirmClear, onCleared })

		await act(async () => container.querySelector('button')?.click())

		expect(confirmClear).toHaveBeenCalledWith(expect.stringMatching(/Pending or indeterminate/))
		expect(clearLocalData).toHaveBeenCalledOnce()
		expect(onCleared).toHaveBeenCalledOnce()
		expect(container.textContent).toContain('Local data cleared')
	})

	it('does not clear anything when the warning is cancelled', async () => {
		const clearLocalData = vi.fn(async () => {})
		const onCleared = vi.fn()
		const container = renderControl({
			clearLocalData,
			confirmClear: () => false,
			onCleared,
		})

		await act(async () => container.querySelector('button')?.click())

		expect(clearLocalData).not.toHaveBeenCalled()
		expect(onCleared).not.toHaveBeenCalled()
	})

	it('keeps the current workspace mounted if IndexedDB cannot be cleared', async () => {
		const onCleared = vi.fn()
		const container = renderControl({
			clearLocalData: async () => {
				throw new Error('IndexedDB failed')
			},
			confirmClear: () => true,
			onCleared,
		})

		await act(async () => container.querySelector('button')?.click())

		expect(onCleared).not.toHaveBeenCalled()
		expect(container.querySelector('[role="alert"]')?.textContent).toBe('Clear failed')
	})
})

function renderControl(props: ComponentProps<typeof ReviewLocalDataControl>): HTMLElement {
	const container = document.createElement('div')
	document.body.appendChild(container)
	const root = createRoot(container)
	act(() => root.render(<ReviewLocalDataControl {...props} />))
	cleanup = () =>
		act(() => {
			root.unmount()
			container.remove()
		})
	return container
}
