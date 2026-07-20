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
```

Optional service settings are `REVIEW_API_HOST`, `REVIEW_API_PORT`, `REVIEW_APP_ORIGIN`, `SHOTGRID_TIMEOUT_MS`, and `SHOTGRID_MAX_RETRIES`. The timeout applies to each upstream attempt. Only idempotent reads retry transient failures; review mutations do not retry automatically.

Never prefix ShotGrid credentials with `VITE_`. Vite variables are public browser configuration and the review application rejects `VITE_SHOTGRID_*` values at build time.

In ShotGrid mode, deploy this service behind a trusted reverse proxy. The proxy must authenticate and authorize every user and action, strip any browser-supplied `X-Review-Proxy-Token` and `X-Review-Authenticated-Login` headers, then inject the server-only proxy token. When `SHOTGRID_SUDO_AS_LOGIN` is configured, the proxy must also inject that exact login so the authenticated identity is bound to ShotGrid impersonation. The proxy token must never be sent to browser code or exposed through CORS.

Live note-option lookup and publication require `SHOTGRID_SUDO_AS_LOGIN`. A ShotGrid script
identity may browse review data, but the API rejects these human-review actions with `403
PERMISSION_DENIED` even when the request presents a valid trusted-proxy token.

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
- `GET /api/review/playlists/:playlistId/versions/:versionId/note-options`
- `PUT /api/review/playlists/:playlistId/versions/:versionId/publications/:publicationId`

The single-Version route verifies Playlist membership and rereads the standard ShotGrid media fields.
Clients use it when a Version opens or refreshes so expiring ShotGrid media references are renewed.
