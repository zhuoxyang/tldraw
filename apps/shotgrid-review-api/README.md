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
SHOTGRID_SUDO_AS_LOGIN=reviewer@example.com # optional
```

Optional service settings are `REVIEW_API_HOST`, `REVIEW_API_PORT`, `REVIEW_APP_ORIGIN`, `SHOTGRID_TIMEOUT_MS`, and `SHOTGRID_MAX_RETRIES`. The timeout applies to each upstream attempt. Only idempotent reads retry transient failures; review mutations do not retry automatically.

Never prefix ShotGrid credentials with `VITE_`. Vite variables are public browser configuration and the review application rejects `VITE_SHOTGRID_*` values at build time.
