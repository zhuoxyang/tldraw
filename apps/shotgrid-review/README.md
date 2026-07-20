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
