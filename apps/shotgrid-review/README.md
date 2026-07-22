# ShotGrid review app

This browser application loads review data exclusively through the server-side ShotGrid review
gateway. The gateway chooses mock or live ShotGrid mode; browser code never receives ShotGrid
credentials, the trusted proxy token, or the proxy-authenticated subject.

## Local development

Start the mock gateway and the app in separate terminals from the repository root:

```bash
yarn dev-shotgrid-review-api
yarn dev-shotgrid-review
```

Vite proxies `/api`, including collaboration WebSocket upgrades, to
`http://127.0.0.1:5431` by default. Set the server-only
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
identifier (for example `studio-sandbox`). Browser-local publication retry keys also include the API
scope, gateway mode, and reviewer identity. The shared annotation document is instead restored from
the API's Version-specific SQLite room; it is not loaded from another reviewer's browser storage.
If the gateway exposes only a shared ShotGrid service identity, the app does not initialize human
publication state for that identity.

Only `VITE_REVIEW_API_BASE_URL`, `VITE_REVIEW_DATA_MODE`, `VITE_REVIEW_STORAGE_NAMESPACE`, and
`VITE_TLDRAW_LICENSE_KEY` are permitted public build variables. The build and runtime parser reject
every other `VITE_*` key, even when empty. In ShotGrid mode `VITE_REVIEW_API_BASE_URL` must be a
same-origin root-relative path such as `/api`; absolute or protocol-relative API URLs are rejected.
Do not put a ShotGrid URL, login, script key, OAuth token, proxy/webhook secret, or authenticated
subject in any `VITE_*` value.

Shared annotation editing also requires a human reviewer identity. The collaboration session binds
the canvas to one Version-specific room, keeps media sources browser-local, and synchronizes only
the annotation document. A ShotGrid service identity joins as a viewer: it can inspect live shared
annotations but cannot create, change, or delete them.

Browser publication requires a human reviewer identity. In live ShotGrid mode, configure
`SHOTGRID_SUDO_AS_LOGIN` so the gateway resolves the authenticated request to that human reviewer.
When `/api/review/me` returns a service identity, the app deliberately disables publication: it
does not open publication IndexedDB state, load Note options, or send publication requests. The
service identity may still browse, inspect synchronized annotations, save an editable snapshot, and
export PNGs. Do not replace this boundary with a session nonce or an in-memory publication fallback.

The current live boundary accepts exactly one proxy subject configured by
`REVIEW_FIXED_ACTOR_SUBJECT` and, when mutations are enabled, one effective reviewer configured by
`SHOTGRID_SUDO_AS_LOGIN`. It is a fixed-principal pilot, not multi-user SSO or per-person
attribution. Do not route multiple people through that identity. Organization SSO, subject-to-user
mapping, project entitlements, offboarding/revocation, retention, and multi-instance operation
remain production gates. See the API README for the required header stripping/injection,
same-origin SSE/WebSocket proxy, Project allowlist, audit store, single-process SQLite topology,
capacity limits, and recovery tests.

Live change notifications contain only an opaque monotonic sequence. The client rereads
authoritative Project → Playlist → Version state and clears the previously loaded review, media,
and canvas when that refresh reports permission denied or not found. SSE and collaboration sockets
have five-minute authorization leases, so normal reconnection passes through the trusted proxy and
server authorization again. The API does not send upstream Project image or HumanUser avatar URLs;
the app renders those fields without remote images.

The header's **Clear local data** action requires confirmation, removes every browser-persisted
publication record across review namespaces, releases review-owned download Blob URLs, and remounts
the active workspace so its media, canvas, and collaboration context are discarded. Pending or
indeterminate publication retry payloads are intentionally included and cannot be recovered by the
browser after clearing; authoritative server annotations and ShotGrid records are not deleted.

The single-replica pilot container bundle is under [`deploy`](./deploy). A ShotGrid build refuses to
complete without an explicit `VITE_TLDRAW_LICENSE_KEY` and stable
`VITE_REVIEW_STORAGE_NAMESPACE`. The bundle keeps server secrets out of build arguments, serves the
browser and `/api` from one origin, requires forward-auth for the app and review API, and leaves the
signed ShotGrid webhook as a separate public boundary. See the API README for startup, metrics,
backup, restore, and production-gate procedures.

Run the real-browser image-review gate from the repository root with:

```sh
yarn e2e-shotgrid-review
```

Chromium drives the actual tldraw toolbar and Editor to create an annotation, downloads an editable
snapshot, closes that browser context, imports the snapshot into a new Editor, moves the reopened
shape to prove it remains editable, then downloads and parses a PNG at the exact 1920×1080 source
resolution. A deterministic white source also lets the test assert that non-white annotation pixels
were actually flattened into the exported PNG. The path is registered as a pull-request gate. It
validates the browser asset workflow, not organization SSO, real ShotGrid credentials, webhook
reachability, or a human pilot; those still require the approved sandbox and reviewers.

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
