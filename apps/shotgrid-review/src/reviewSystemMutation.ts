import type { Editor } from 'tldraw'

/** Runs a trusted local media-overlay write without weakening the surrounding editor state. */
export function runReviewSystemMutation<T>(editor: Editor, mutation: () => T): T {
	const wasReadonly = editor.getIsReadonly()
	if (!wasReadonly) return mutation()

	editor.updateInstanceState({ isReadonly: false })
	try {
		return mutation()
	} finally {
		editor.updateInstanceState({ isReadonly: true })
	}
}
