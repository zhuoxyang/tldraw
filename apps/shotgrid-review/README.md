# ShotGrid review app

This browser application loads review data exclusively through the server-side ShotGrid review
gateway. The gateway chooses mock or live ShotGrid mode; browser code never receives ShotGrid
credentials or the trusted proxy token.

## Local development

Start the mock gateway and the app in separate terminals from the repository root:

```bash
yarn dev-shotgrid-review-api
yarn dev-shotgrid-review
```

Vite proxies `/api` to `http://127.0.0.1:5431` by default. Set the server-only
`REVIEW_API_DEV_TARGET` environment variable before starting Vite to use another local gateway.
The development proxy deliberately does not inject live authentication headers, so live ShotGrid
mode still requires the trusted reverse proxy described in the API README.

Opening `/` selects the first accessible Project, Playlist, and Version, then replaces the URL with
the canonical deep link:

```text
/review/:projectId/:playlistId/:versionId
```

Legacy `/review/:playlistId/:versionId` links are resolved across permitted projects and replaced
with the canonical form.

Empty selections use explicit partial links so browser history remains truthful:

```text
/review/projects/:projectId
/review/projects/:projectId/playlists/:playlistId
```

ShotGrid builds must set `VITE_REVIEW_STORAGE_NAMESPACE` to a stable, non-secret deployment/site
identifier (for example `studio-sandbox`). Canvas persistence keys also include the API scope,
gateway mode, and reviewer kind. If the gateway exposes only a shared ShotGrid service identity,
the canvas remains session-only to avoid loading another reviewer's local annotations.

Browser publication requires a human reviewer identity. In live ShotGrid mode, configure
`SHOTGRID_SUDO_AS_LOGIN` so the gateway resolves the authenticated request to that human reviewer.
When `/api/review/me` returns a service identity, the app deliberately disables publication: it
does not open publication IndexedDB state, load Note options, or send publication requests. The
service identity may still browse, annotate, save/open editable snapshots, and export PNGs. Do not
replace this boundary with a session nonce or an in-memory publication fallback.

Review decisions use the deployment's server-side decision mapping; the browser never hard-codes
studio status meanings. A human reviewer can open the decision control to see the current ShotGrid
status, configured actions, and recent status history. Each update includes the status observed by
the browser. Because ShotGrid does not provide a compare-and-set status update, this is a
best-effort conflict check rather than a database transaction. The app confirms the PUT response,
then reloads authoritative decision context before showing success. Conflicts and indeterminate
outcomes also reload status and history without automatically retrying the mutation.

When the gateway reaches ShotGrid's activity-page limit, the panel labels the result as recent
history and warns that older changes may exist; it must not be treated as a complete audit export.

Service identities do not initialize or display decision context and never send decision GET or PUT
requests from the browser. Configure `SHOTGRID_SUDO_AS_LOGIN` to expose decisions to a resolved
human reviewer.

## MP4 review

Browser-playable MP4 Versions use a Playlist/Version/Attachment-bound same-origin stream; the
browser never receives ShotGrid's source movie URL. Playback is read-only, while paused frames can
be annotated with an inclusive frame range or millisecond time range. Previous/next navigation uses
frame centers when the gateway explicitly declares CFR media and 100 ms steps otherwise.

Frame numbering and non-drop-frame timecode require the gateway's deployment-level CFR guarantee.
Movies declared `variable`, movies with an `unknown` rate mode, missing frame metadata, or
inconsistent count/rate/duration values fall back to decoded media time and never display invented
frame numbers. See the API README before enabling the CFR setting.

`Export current frame PNG` pauses and seeks the real video element, composites only annotations
visible at the browser-presented media time, and writes a 1:1 PNG at the decoded source dimensions.
Editable video snapshots contain no movie URL or asset bytes and are bound to the Project, Version,
Attachment, dimensions, decoded duration, frame-rate policy, and ShotGrid timing metadata. A stale
or cross-review snapshot is rejected instead of being applied to changed media.
