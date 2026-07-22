import type { ReviewImageMedia } from '@tldraw/shotgrid-review-contracts'
import ReactDOM from 'react-dom/client'
import type { Editor } from 'tldraw'
import 'tldraw/tldraw.css'
import type { ReviewApiClient } from '../src/reviewApiClient'
import { ReviewImageCanvas } from '../src/ReviewImageCanvas'
import '../src/index.css'

declare global {
	interface Window {
		reviewEditor?: Editor
	}
}

const media: ReviewImageMedia = {
	contentType: 'image/png',
	height: 1080,
	kind: 'image',
	thumbnailUrl: '/mock-media/shot-comp.png',
	url: '/mock-media/shot-comp.png',
	width: 1920,
}

const api = {} as ReviewApiClient

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
	<ReviewImageCanvas
		allowSnapshotImport
		api={api}
		documentKey="e2e-image-review"
		media={media}
		onEditorMount={(editor) => {
			window.reviewEditor = editor
			editor.user.updateUserPreferences({ animationSpeed: 0 })
		}}
		playlistId={201}
		projectId={101}
		publicationAccess={{
			message: 'Publishing is outside this image export gate.',
			status: 'disabled',
		}}
		reviewScope="e2e:mock"
		versionId={301}
		versionName="shot_020_comp_v008"
	/>
)
