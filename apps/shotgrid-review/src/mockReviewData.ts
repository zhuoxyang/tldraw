export interface MockReviewVersion {
	artist: string
	code: string
	id: string
	status: 'Pending review' | 'Needs changes' | 'Approved'
	task: string
}

export const mockReviewPlaylist = {
	code: 'Lighting dailies',
	id: 'playlist-101',
	project: 'Project Northstar',
	projectId: 'project-001',
	versions: [
		{
			artist: 'Mei Chen',
			code: 'shot_010_lgt_v014',
			id: 'version-201',
			status: 'Pending review',
			task: 'Lighting',
		},
		{
			artist: 'Alex Kim',
			code: 'shot_020_comp_v008',
			id: 'version-202',
			status: 'Needs changes',
			task: 'Compositing',
		},
		{
			artist: 'Sam Rivera',
			code: 'asset_drone_srf_v021',
			id: 'version-203',
			status: 'Approved',
			task: 'Surfacing',
		},
	] satisfies MockReviewVersion[],
}
