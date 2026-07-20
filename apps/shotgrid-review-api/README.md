# ShotGrid review API

This private Node service is the only component allowed to authenticate to Autodesk Flow Production Tracking (ShotGrid). The browser application talks to the purpose-built `/api/review/*` routes and never receives a script key or OAuth token.

The gateway starts in deterministic `mock` mode by default:

```sh
yarn dev-shotgrid-review-api
```

To use a ShotGrid sandbox, set these server-only environment variables outside the repository:

```text
SHOTGRID_GATEWAY_MODE=shotgrid
SHOTGRID_SITE_URL=https://studio.shotgrid.autodesk.com
SHOTGRID_SCRIPT_NAME=review_gateway
SHOTGRID_SCRIPT_KEY=...
REVIEW_API_TRUSTED_PROXY_TOKEN=... # at least 32 random characters
SHOTGRID_REVIEW_PUBLICATION_STORE_DIR=/var/lib/shotgrid-review-publications
SHOTGRID_REVIEW_PUBLICATION_MAX_JOURNALS=10000 # optional
SHOTGRID_REVIEW_PUBLICATION_MAX_JOURNAL_BYTES=4194304 # optional; minimum 1048576
SHOTGRID_SUDO_AS_LOGIN=reviewer@example.com # optional
SHOTGRID_REVIEW_DECISIONS_JSON=[{"key":"approve","label":"Approve","statusCode":"apr"},{"key":"needs-changes","label":"Needs changes","statusCode":"chg"}]
SHOTGRID_REVIEW_VIDEO_FRAME_RATE_MODE=unknown # constant, variable, or unknown
```

Optional service settings are `REVIEW_API_HOST`, `REVIEW_API_PORT`, `REVIEW_APP_ORIGIN`, `SHOTGRID_TIMEOUT_MS`, and `SHOTGRID_MAX_RETRIES`. The timeout applies to each upstream attempt. Only idempotent reads retry transient failures; review mutations do not retry automatically.

Video frame numbers are enabled only when `SHOTGRID_REVIEW_VIDEO_FRAME_RATE_MODE=constant`. Set
that value only when the deployment's upload or transcode pipeline guarantees constant-frame-rate
MP4 media. The default `unknown`, and explicit `variable`, force the browser onto its decoded
millisecond timeline even when ShotGrid's frame count and nominal rate happen to agree; browsers do
not expose enough container timing information to prove that a movie is CFR. This is a deployment
assertion for all review movies, so mixed CFR/VFR sources must remain `unknown` until the pipeline
can provide a trustworthy per-Version classification.

Never prefix ShotGrid credentials with `VITE_`. Vite variables are public browser configuration and the review application rejects `VITE_SHOTGRID_*` values at build time.

In ShotGrid mode, deploy this service behind a trusted reverse proxy. The proxy must authenticate and authorize every user and action, strip any browser-supplied `X-Review-Proxy-Token` and `X-Review-Authenticated-Login` headers, then inject the server-only proxy token. When `SHOTGRID_SUDO_AS_LOGIN` is configured, the proxy must also inject that exact login so the authenticated identity is bound to ShotGrid impersonation. The proxy token must never be sent to browser code or exposed through CORS.

Live note-option lookup, publication, decision context, and decision updates require
`SHOTGRID_SUDO_AS_LOGIN`. A ShotGrid script identity may browse review data, but the API rejects
these human-review actions with `403 PERMISSION_DENIED` even when the request presents a valid
trusted-proxy token.

Decision mappings are deployment configuration, not browser input. The JSON value must contain at
most 32 exact `key`, `label`, and unique ShotGrid `statusCode` mappings. Live mode may start
without mappings so a script identity can remain browse-only; decision routes then fail closed with
`CONFIGURATION_ERROR`. For every selected Version's Project, the API reads the project-specific
`Version.sg_status_list` schema and requires the field to be a visible, editable status list. Every
configured code must be valid and not hidden for that Project.

Project and entity authorization remains the reverse proxy's responsibility until the permission hardening work in issue #12 is complete.

The publication store directory is required in ShotGrid mode. It contains no annotation image
bytes or credentials; it persists publication fingerprints, Note subjects and content, derived
production links, and ShotGrid result identifiers. Treat it as review metadata under the same
access-control, backup, and retention policy as the ShotGrid Notes it represents. Every API
instance that can serve the same reviewer scope must mount
the same durable directory with exclusive read/write access. Do not use per-pod ephemeral storage:
the journal and cross-process locks prevent retries, restarts, and concurrent instances from
creating duplicate Notes or Attachments. Back up this directory with the service's operational
state, and restrict filesystem access to the API account. On POSIX systems the API refuses a store
directory not owned by its effective user or writable by group/other users; journals must also not
be group/world readable or writable.

The file store fails closed after 10,000 journals by default and caps each append-only journal at
4 MiB (the configurable minimum is 1 MiB). Before creating a Note or uploading an Attachment, it
atomically reserves enough journal capacity for the mutation-boundary record and one subsequent
maximum 256 KiB record. Configurations that cannot hold two maximum record envelopes are rejected at
startup. Existing publication IDs remain readable at capacity, while a side effect is never started
when its next durable outcome cannot fit. A safe pre-mutation rejection removes its new journal
durably. Monitor inode and disk usage. Archive only completed journals during a maintenance window,
under the same retention policy and with the API stopped; never remove creating, note-created,
uploading, or indeterminate records. All instances sharing a store must use the same limits.

Publication PNG validation performs bounded asynchronous decompression, and each API process admits
only one publication at a time. The trusted proxy must additionally enforce continuous per-user and
per-IP request-rate, concurrent-request, and body-size limits before traffic reaches this service.

## Review browsing routes

- `GET /api/review/me`
- `GET /api/review/projects`
- `GET /api/review/projects/:projectId/playlists`
- `GET /api/review/playlists/:playlistId/versions`
- `GET /api/review/playlists/:playlistId/versions/:versionId`
- `GET /api/review/playlists/:playlistId/versions/:versionId/media/image`
- `GET /api/review/playlists/:playlistId/versions/:versionId/media/video/:attachmentId`
- `GET /api/review/playlists/:playlistId/versions/:versionId/note-options`
- `GET /api/review/playlists/:playlistId/versions/:versionId/decision-context`
- `PUT /api/review/playlists/:playlistId/versions/:versionId/decision`
- `PUT /api/review/playlists/:playlistId/versions/:versionId/publications/:publicationId`

The single-Version route verifies Playlist membership and rereads the standard ShotGrid media fields.
Clients use it when a Version opens or refreshes so expiring ShotGrid media references are renewed.

Live Version JSON never exposes the ShotGrid movie download URL. It contains a same-origin URL bound
to the selected Playlist, Version, and Attachment. The video route rereads those relationships for
every request, accepts at most one canonical `bytes` range, and streams only a strictly validated
MP4 `200` or `206` response. It forwards no browser, ShotGrid, cookie, or authorization credentials
to media storage, follows only bounded validated redirects, and cancels upstream work when the
client disconnects. A response is capped at 2 GiB, an upstream transfer at 30 minutes, and a
downstream backpressure stall at 10 seconds; timed-out resources are cancelled before their
concurrency slot is released. Unsatisfied upstream ranges preserve a validated `bytes */length`
response for standards-compliant media recovery. Video thumbnails use the same validated image
proxy route.

The decision request body is
`{"decisionKey":"approve","expectedStatusCode":"rev"}`; `expectedStatusCode` may be
`null`. The API verifies Playlist membership, compares the current status, and serializes updates
to the same Version within one process. The old unscoped
`PATCH /api/review/versions/:versionId/status` route is not available.

ShotGrid does not expose a conditional update primitive for this field, so the expected-value check
cannot prevent a concurrent update from the ShotGrid UI or another API instance between the read
and write. Keep one decision-writer process until distributed serialization is deployed. A
successful response is returned only when ShotGrid echoes the exact Version id, resulting status,
and upstream update time. A timeout, disconnect, 5xx, or malformed success after dispatch returns
`DECISION_INDETERMINATE`; clients must refresh and must not automatically replay the mutation.

Decision history comes from the Version activity stream and exposes only validated
`sg_status_list` attribute changes. The API requests the official maximum of 500 recent activity
items; unrelated activity also consumes that window. `historyTruncated: true` therefore means the
response is recent history, not a complete audit export. Missing activity authors remain `null`
instead of being attributed to the current reviewer.
