// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'vitest'
import { TestEditor } from '../../../packages/tldraw/src/test/TestEditor'
import {
	getReviewImageIds,
	installReviewImage,
	type LoadedReviewImage,
} from './reviewAnnotationEditor'
import {
	ReviewVideoShapeUtil,
	getReviewVideoShapeId,
	installReviewVideo,
	type ReviewVideoSource,
} from './reviewVideoShape'

const editors: TestEditor[] = []

afterEach(() => {
	for (const editor of editors.splice(0)) editor.dispose()
})

describe('trusted review source mutations', () => {
	it('installs a local-only image source while the collaborative editor is readonly', async () => {
		const editor = createEditor()
		const image: LoadedReviewImage = {
			blob: new Blob(['review-image'], { type: 'image/png' }),
			contentType: 'image/png',
			height: 1080,
			name: 'shot_010_lgt_v014',
			sha256: 'a'.repeat(64),
			versionId: 301,
			width: 1920,
		}
		const sources: string[] = []
		const stopListening = editor.store.listen((entry) => sources.push(entry.source), {
			scope: 'document',
		})
		editor.updateInstanceState({ isReadonly: true })

		await installReviewImage(editor, image, undefined, { localOnly: true })

		const ids = getReviewImageIds(image.versionId)
		expect(editor.getAsset(ids.assetId)).toBeDefined()
		expect(editor.getShape(ids.shapeId)).toBeDefined()
		expect(editor.getIsReadonly()).toBe(true)
		expect(sources).toEqual(['remote'])
		stopListening()
	})

	it('installs a local-only video source while the collaborative editor is readonly', () => {
		const editor = createEditor([ReviewVideoShapeUtil])
		const source: ReviewVideoSource = {
			attachmentId: 901,
			contentType: 'video/mp4',
			height: 1080,
			name: 'shot_010_comp_v014',
			url: '/api/review/playlists/201/versions/301/media/video/901',
			versionId: 301,
			width: 1920,
		}
		const sources: string[] = []
		const stopListening = editor.store.listen((entry) => sources.push(entry.source), {
			scope: 'document',
		})
		editor.updateInstanceState({ isReadonly: true })

		installReviewVideo(editor, source, { localOnly: true })

		const shape = editor.getShape(getReviewVideoShapeId(source.versionId))
		expect(shape?.type).toBe('review-video')
		expect(JSON.stringify(shape)).not.toContain(source.url)
		expect(editor.getIsReadonly()).toBe(true)
		expect(sources).toEqual(['remote'])
		stopListening()
	})
})

function createEditor(shapeUtils: [typeof ReviewVideoShapeUtil] | [] = []) {
	const editor = new TestEditor(
		{ shapeUtils },
		{
			assets: {
				resolve: () => null,
				upload: async () => ({ src: 'https://review.local/source' }),
			},
		}
	)
	editors.push(editor)
	return editor
}
