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
REVIEW_FIXED_ACTOR_SUBJECT=oidc:studio:pilot-reviewer # exact subject injected by the trusted proxy
SHOTGRID_REVIEW_PROJECT_IDS=123,456 # explicit review allowlist; no wildcard
SHOTGRID_REVIEW_AUDIT_STORE_DIR=/var/lib/shotgrid-review-audit
SHOTGRID_REVIEW_AUDIT_MAX_ENTRIES=100000 # optional; each completed mutation uses two entries
SHOTGRID_REVIEW_PUBLICATION_STORE_DIR=/var/lib/shotgrid-review-publications
SHOTGRID_REVIEW_PUBLICATION_MAX_JOURNALS=10000 # optional
SHOTGRID_REVIEW_PUBLICATION_MAX_JOURNAL_BYTES=4194304 # optional; minimum 1048576
REVIEW_SYNC_SECRET=... # at least 32 random characters; back up separately and do not rotate casually
SHOTGRID_REVIEW_SYNC_STORE_DIR=/var/lib/shotgrid-review-sync
SHOTGRID_REVIEW_SYNC_MAX_ROOMS=100 # optional; active rooms in this process, maximum 1000
SHOTGRID_REVIEW_SYNC_MAX_SESSIONS_PER_ROOM=16 # optional; maximum 100
SHOTGRID_WEBHOOK_IDS=uuid-for-project,uuid-for-playlist,uuid-for-version,uuid-for-note # allowlist
SHOTGRID_WEBHOOK_SECRET=... # dedicated secret, at least 32 characters
SHOTGRID_WEBHOOK_PROJECT_IDS=123,456 # explicit pilot allowlist; no wildcard
SHOTGRID_REVIEW_EVENT_STORE_DIR=/var/lib/shotgrid-review-events
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

Never prefix ShotGrid credentials with `VITE_`. Vite variables are public browser configuration. The
review application permits only `VITE_REVIEW_API_BASE_URL`, `VITE_REVIEW_DATA_MODE`,
`VITE_REVIEW_STORAGE_NAMESPACE`, and `VITE_TLDRAW_LICENSE_KEY`; it rejects every other `VITE_*`
name, including an empty one. In ShotGrid mode the API base URL must be a same-origin,
root-relative path such as `/api`.

In ShotGrid mode, deploy this service behind a trusted reverse proxy. The current security boundary
deliberately accepts one fixed pilot principal, not arbitrary authenticated users. On every review
HTTP request, SSE connection, and WebSocket Upgrade, the proxy must:

1. authenticate the upstream session;
2. remove any browser-supplied `X-Review-Proxy-Token` and
   `X-Review-Authenticated-Subject` headers; and
3. inject the server-only proxy token plus an `X-Review-Authenticated-Subject` value exactly equal
   to `REVIEW_FIXED_ACTOR_SUBJECT`.

The API requires both values and derives a stable opaque principal id from the subject; it does not
persist or return the raw subject. The token and injected subject must never be sent to browser
code, exposed through CORS, accepted from an untrusted hop, or written to access logs.
`SHOTGRID_SUDO_AS_LOGIN` separately chooses the effective ShotGrid human actor for review
mutations. Operations must ensure that the fixed subject and sudo login belong to the same approved
pilot operator; the service cannot prove that relationship itself.

The same proxy must serve the browser application and `/api` under one origin and forward WebSocket
Upgrade requests for `/api/review/sync/*` to this Node process without rewriting the path or query.
The API rejects a WebSocket whose `Origin` does not exactly match `REVIEW_APP_ORIGIN`, and applies
the same token-plus-subject check used by review HTTP routes. Do not expose the Node port as a
second browser origin, terminate a sync connection as ordinary HTTP, or log its short-lived
one-use ticket query value.

The ShotGrid callback is the separate public `POST /api/webhooks/shotgrid` endpoint. Do not put the
trusted browser-proxy token in ShotGrid. Preserve the request body bytes and the single
`X-SG-SIGNATURE`, `X-SG-WEBHOOK-ID`, `X-SG-DELIVERY-ID`, and `X-SG-WEBHOOK-SITE-URL` headers exactly;
the API authenticates that boundary with the dedicated webhook secret. The reverse proxy should
apply a 1 MiB request-body limit and must not decompress or rewrite JSON before forwarding it.

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

`SHOTGRID_REVIEW_PROJECT_IDS` is the API's mandatory live review boundary. Project listing is
filtered to those ids, and every Project → Playlist → Version read or mutation revalidates the
relationships and allowed Project before returning data or dispatching a ShotGrid side effect.
Out-of-scope or mismatched entities fail as not found. `SHOTGRID_WEBHOOK_PROJECT_IDS` must be a
subset of the review allowlist or the service refuses to start; a correctly signed event outside
the webhook subset is acknowledged as ignored.

Project images and HumanUser avatars remain upstream URLs that may be signed or session-bearing.
The live API therefore returns `null` for Project thumbnail and User avatar URLs. Version media is
the only exception and crosses the browser boundary through the separately authorized same-origin
image/video proxy routes described below.

## ShotGrid change synchronization

The webhook receiver verifies ShotGrid's HMAC-SHA1 over the exact raw JSON bytes, validates the
configured site, webhook UUID allowlist, and project allowlist, and durably commits accepted events to SQLite
before returning `202`. It accepts the official single-event and 1–50 event batch envelopes. The
acknowledgement path never calls ShotGrid or waits for browser notification work. A queue, database,
or durability failure returns a non-2xx response so ShotGrid can redeliver.

`SHOTGRID_REVIEW_EVENT_STORE_DIR` is durable operational state. Run one API process with exclusive
read/write access to it, back it up with the other review stores, and restore it before accepting
callbacks. The inbox deduplicates by ShotGrid EventLogEntry id across delivery retries, keeps a
separate delivery fingerprint, retries processing with bounded exponential backoff, and retains a
dead-letter state for repeated failures. Payload `old_value` and `new_value` are never treated as
current data: every accepted event is only a project-scoped invalidation. This makes duplicate,
late, and out-of-order delivery safe because browsers reread current authoritative ShotGrid state.

The browser consumes the protected `GET /api/review/changes` server-sent event stream. The wire
payload is deliberately only `{"sequence": number}`: Project ids, entity types, entity ids, event
ids, and operation metadata stay server-side. Its local monotonic sequence supports
`Last-Event-ID` replay; bursts are coalesced for 250 ms and then the current Project → Playlist →
Version hierarchy is reread. Decision context and Note recipient options refresh as well, without
remounting an authorized collaborative tldraw canvas. A permission or not-found response clears the
previously loaded review state so revoked media and annotations do not remain displayed. Each SSE
connection has a five-minute authorization lease and then closes; the browser reconnects through
the trusted proxy and is authenticated again. A visible badge shows whether live updates are
connected or reconnecting.

`GET /api/review/event-sync-status`, protected by the same trusted proxy policy as other review
routes, reports bounded queue depth/bytes, oldest lag, duplicate/ignored/failure counters, the
latest stream sequence, and connected clients. The ordinary health endpoint returns `503` if the
durable worker is stopped, faulted, or at capacity.

Create separate ShotGrid webhooks per entity type because the current ShotGrid REST API supports
one entity type per webhook. Put every resulting UUID in `SHOTGRID_WEBHOOK_IDS`; all review hooks
may use the same dedicated `SHOTGRID_WEBHOOK_SECRET`. Unknown UUIDs fail closed. Use lifecycle
operations `create`, `update`, `delete`, and, after
confirming support on the target site, `revive`. Start with this least-privilege update field set:

- Project: `name`, `sg_status`, `image`
- Playlist: `code`, `description`, `project`, `updated_at`, `versions`
- Version: `code`, `description`, `project`, `playlists`, `sg_status_list`, `user`, `entity`,
  `sg_task`, `image`, `sg_uploaded_movie`, `sg_first_frame`, `sg_last_frame`, `frame_count`,
  `frame_rate`
- Note: `project`, `note_links`, `subject`, `content`, `addressings_to`, `tasks`,
  `sg_status_list`, `attachments`
- Attachment, only if pilot testing proves it is needed: `project`, `attachment_links`,
  `description`, `filename`, `this_file`

The durable store is scoped to the canonical ShotGrid site, not to the changeable UUID allowlist.
Adding, replacing, or removing a webhook UUID therefore preserves queued work, deduplication, and
SSE replay history. Update the allowlist and restart the single API owner; never delete the event
store as part of webhook rotation.

The receiver acknowledges valid signed events outside that allowlist as ignored and exposes the
count, preventing a configuration mismatch from causing an endless redelivery loop. It does not
create or mutate ShotGrid webhooks at startup. Enabling the subscription remains an explicit
deployment action requiring the real sandbox/pilot project ids, ShotGrid administrator access, a
dedicated secret in the secret manager, and a publicly reachable HTTPS callback. Test
`Playlist.versions` relationship changes and `revive` on the chosen site before rollout because
the Autodesk documentation does not fully specify those behaviours.

The current application has no Version Notes/activity browser; Note events therefore refresh
review context and make external changes observable but do not display external Note content.
Adding a bounded paginated Notes panel is a separate product capability, not something webhook
delivery alone can provide.

This release is a single-fixed-principal pilot only. `REVIEW_FIXED_ACTOR_SUBJECT` plus one
`SHOTGRID_SUDO_AS_LOGIN` does not provide per-person attribution, organization SSO, group/project
entitlements, or immediate session revocation for a multi-user rollout. The sync service still
binds each connection to the reviewer returned by the gateway: a human reviewer receives editor
access, while a ShotGrid service identity receives viewer access and cannot create, change, or
delete shared annotations. Keep the deployment limited to the one approved pilot operator until
the external identity requirements in **Production gates** are complete.

## Collaborative review storage and deployment

`POST /api/review/playlists/:playlistId/versions/:versionId/collaboration-session` verifies the
Project/Playlist/Version relationship and returns a short-lived, one-use WebSocket ticket bound to
the fixed opaque proxy principal. The browser then connects to the returned `/api/review/sync/*`
path. Before upgrading, the API requires that same principal and rereads the Version, reviewer,
Project allowlist, room, media, and permission state. A ticket presented by another principal is
rejected, and an accepted socket is closed after a five-minute authorization lease so reconnecting
must pass the boundary again. Never cache, replay, persist, or place tickets in application logs.

Each review room is stored as SQLite state below `SHOTGRID_REVIEW_SYNC_STORE_DIR`. The synchronized
records contain tldraw document state and annotations only. ShotGrid media bytes, source asset bytes,
and media URLs remain local to each browser and are not written to the sync database. Apply the same
access control, backup, retention, disk-space, and inode monitoring used for other review metadata.

In live mode, sync, event, and audit SQLite stores require absolute filesystem paths. On POSIX the
final store directory must be a physical directory owned by the service account with mode `0700`;
database files and any journal/WAL/SHM sidecars must be regular files owned by that account with
mode `0600`. Startup and subsequent store access fail closed for a symlink, a non-directory/non-file
entry, the wrong owner, or group/world access. All durable store configuration rejects filesystem
roots, network-share paths, and whitespace-padded paths. On Windows, POSIX mode bits are not an ACL
check: grant only the API service account access through NTFS permissions and use a dedicated local
volume.

The current SQLite room owner is deliberately a single Node process. Run exactly one API process or
replica for a deployment, mount the sync store on a durable persistent volume with exclusive
read/write access, and route every collaboration request and upgraded socket to that process. Do not
share the directory between replicas or use pod-local ephemeral storage. Horizontal scaling,
distributed room ownership, and multi-writer SQLite are not supported by this version.

`REVIEW_SYNC_SECRET` derives stable opaque room identities as well as authorizing temporary tickets.
Store it in the deployment's secret manager and include it in the recovery plan. Restoring the
SQLite directory with a different secret or a different deployment/site scope makes existing rooms
unreachable through their original identities. The mock-mode defaults are for local development
only; live mode requires an absolute store path and a secret containing at least 32 characters.

The default process limits are 100 active rooms and 16 concurrent sessions per room. Lower
`SHOTGRID_REVIEW_SYNC_MAX_ROOMS` or `SHOTGRID_REVIEW_SYNC_MAX_SESSIONS_PER_ROOM` to fit measured CPU,
memory, file-descriptor, and proxy connection budgets. Capacity rejection is fail-closed and is
reported to the browser as collaboration unavailable; raising a limit does not make a multi-replica
deployment safe.

Each client sync message is limited to 1 MiB in total, including messages split across WebSocket
frames, and to at most 1,024 chunks. The WebSocket transport also rejects any individual frame over
1 MiB. Keep reverse-proxy limits compatible with these bounds; malformed, oversized, or unbounded
chunk sequences are disconnected instead of being buffered by the room process.

## Mutation audit log

Live decision and publication mutations use the append-only SQLite database
`SHOTGRID_REVIEW_AUDIT_STORE_DIR/review-audit.sqlite`. Before dispatching an external mutation, the
API rereads the Version and effective reviewer and durably appends an `attempt` (intent) row. If
that append fails or the store has no reserved capacity, the ShotGrid mutation is not started.
After the call, a second `outcome` row records `succeeded`, `failed`, or `indeterminate`. A safe
idempotent no-op is `succeeded`, an authoritative upstream rejection is `failed`, and only an
unknown dispatch/result is `indeterminate`. Every
attempt and outcome has a monotonic sequence, timestamp, attempt/request id, opaque proxy
principal, effective actor kind/id, action, Project/Playlist/Version ids, and only the bounded
result fields needed for reconciliation: API error code, decision status, Note id, and Attachment
id.

The schema intentionally cannot store request bodies, Note subject/content, annotation PNG bytes,
media or avatar URLs, script/OAuth credentials, proxy or webhook secrets, raw authenticated
subjects, cookies, or WebSocket tickets. Unknown fields are rejected. SQLite uses full synchronous
commits and rollback-journal mode, and database triggers reject updates and deletes. Protect and
back up this store as security/audit metadata; it is not replaced by the recent ShotGrid Version
activity shown in the browser.

`SHOTGRID_REVIEW_AUDIT_MAX_ENTRIES` defaults to 100,000 and may be set from 2 to 10,000,000. A
normally completed mutation consumes two rows. Capacity accounting reserves an outcome row for
every open attempt before admitting another intent, so a full store rejects a new mutation before
its side effect while existing attempts can still finish. This limit is a safety boundary, not a
retention mechanism. Monitor row count, disk space, filesystem errors, and open attempts; do not
delete rows, edit the database, or rotate it underneath a running API process.

An `attempt` with no matching `outcome` is a manual reconciliation signal, commonly caused by a
process/storage failure after intent or after an uncertain upstream dispatch. Correlate its request
id, timestamp, actor, and entity ids with the publication journal and authoritative ShotGrid Note,
Attachment, Version status, and activity data. Treat uncertain dispatch as indeterminate and never
automatically replay it. Preserve the database and the incident disposition together until an
approved retention and archival procedure exists.

## Production gates

The implemented controls support one fixed-principal, one-process pilot. They do not close these
external deployment decisions:

- **Organization identity:** multi-user release requires the organization's SSO/session boundary,
  a trusted subject-to-ShotGrid-user mapping, per-user project entitlements, offboarding and group
  synchronization, and a measured revocation SLA. A shared fixed subject or sudo login must not be
  presented as per-person attribution.
- **Retention and legal policy:** owners must approve retention, legal hold, backup, archival,
  access review, and deletion rules for audit, publication, event, and annotation stores plus
  browser-local review data. Until then, preserve records and keep the pilot's scope/capacity
  bounded rather than inventing an automatic purge.
- **Multi-instance operation:** this version has no distributed room ownership, webhook/SSE fanout,
  principal revocation channel, or fencing for SQLite owners. Run exactly one API process with
  exclusive durable stores. Horizontal scaling requires a different coordination and persistence
  design.

## Operational verification

Perform these checks in a staging deployment before enabling reviewers:

1. Start the single API replica with the production-style origin, durable directory, and secret.
   Confirm `GET /api/health` returns `{"mode":"shotgrid","status":"ok"}` (or `mock` in a local
   smoke test). This endpoint proves only that the process is serving requests; it does not probe
   SQLite durability or an upgraded WebSocket.
2. Through the public same-origin proxy, open the same canonical review URL in two browser sessions
   routed under the one configured fixed pilot subject. Confirm the WebSocket upgrades successfully
   and a human reviewer's annotation appears in the second session without a refresh. Confirm a
   service reviewer is visibly read-only and cannot create, change, or delete that annotation.
3. Exercise the configured session and active-room ceilings in staging. Confirm excess connections
   fail closed as collaboration unavailable, existing rooms remain usable, and proxy/API metrics
   expose the rejection without recording ticket query values.
4. Create and sync a distinctive annotation, close every client, stop the API cleanly, and back up
   `SHOTGRID_REVIEW_SYNC_STORE_DIR` plus the separately managed `REVIEW_SYNC_SECRET`. Restart with
   the same volume, secret, deployment scope, and one replica; reopen the same Version and confirm
   the annotation is restored while the media is fetched again through the normal media route.
5. Test disaster recovery with the API stopped: restore the directory to an exclusively mounted
   durable volume, restore the same secret from the secret manager, start one replica, repeat the
   two-browser check, and inspect logs for SQLite or schema errors. Never copy or restore a live
   database underneath a running room owner.
6. Attempt a Project id outside `SHOTGRID_REVIEW_PROJECT_IDS` and a mismatched
   Project/Playlist/Version deep link. Confirm neither returns review data. Confirm startup rejects
   a webhook Project allowlist that is not a subset of the review allowlist.
7. Confirm a forged proxy token or subject is rejected on HTTP, SSE, and WebSocket Upgrade. Leave
   SSE and WebSocket connections open past five minutes and confirm each reconnects through the
   proxy and reauthorizes without losing the durable annotation document.
8. Perform one decision and one publication, then inspect the audit database through a read-only
   operational export. Confirm each has an intent and outcome, expected ids/status, and no request
   body, Note text, PNG, URL, secret, raw subject, or ticket. Exercise the capacity alert and manual
   open-attempt reconciliation runbook before enabling pilot traffic.

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
- `POST /api/review/playlists/:playlistId/versions/:versionId/collaboration-session`
- `PUT /api/review/playlists/:playlistId/versions/:versionId/decision`
- `PUT /api/review/playlists/:playlistId/versions/:versionId/publications/:publicationId`

The collaboration session route returns the authorization descriptor for the WebSocket connection;
`/api/review/sync/:roomId` is an Upgrade endpoint rather than a JSON browsing route.

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
