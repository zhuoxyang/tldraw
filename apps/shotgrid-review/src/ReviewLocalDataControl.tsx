import { useState } from 'react'
import { releaseAllReviewBlobUrls } from './reviewBlobDownload'
import { reviewPublicationStore } from './reviewPublicationStore'

const CLEAR_LOCAL_REVIEW_DATA_WARNING =
	'Clear all saved publication drafts and cached review media held by this tab? Pending or indeterminate publication retries will be lost. Server annotations are not deleted.'

export function ReviewLocalDataControl({
	clearLocalData = () => reviewPublicationStore.clearAll(),
	confirmClear = (message) => globalThis.confirm(message),
	onCleared,
}: {
	clearLocalData?(): Promise<void>
	confirmClear?(message: string): boolean
	onCleared(): void
}) {
	const [state, setState] = useState<'cleared' | 'clearing' | 'error' | 'idle'>('idle')

	const clear = () => {
		if (state === 'clearing' || !confirmClear(CLEAR_LOCAL_REVIEW_DATA_WARNING)) return
		setState('clearing')
		releaseAllReviewBlobUrls()
		void clearLocalData()
			.then(() => {
				onCleared()
				setState('cleared')
			})
			.catch(() => setState('error'))
	}

	return (
		<div className="review-local-data">
			<button disabled={state === 'clearing'} onClick={clear} type="button">
				{state === 'clearing' ? 'Clearing…' : 'Clear local data'}
			</button>
			{state === 'cleared' ? (
				<span role="status">Local data cleared</span>
			) : state === 'error' ? (
				<span role="alert">Clear failed</span>
			) : null}
		</div>
	)
}
