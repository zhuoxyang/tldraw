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
SHOTGRID_SUDO_AS_LOGIN=reviewer@example.com # optional
```

Optional service settings are `REVIEW_API_HOST`, `REVIEW_API_PORT`, `REVIEW_APP_ORIGIN`, `SHOTGRID_TIMEOUT_MS`, and `SHOTGRID_MAX_RETRIES`. The timeout applies to each upstream attempt. Only idempotent reads retry transient failures; review mutations do not retry automatically.

Never prefix ShotGrid credentials with `VITE_`. Vite variables are public browser configuration and the review application rejects `VITE_SHOTGRID_*` values at build time.

In ShotGrid mode, deploy this service behind a trusted reverse proxy. The proxy must authenticate and authorize every user and action, strip any browser-supplied `X-Review-Proxy-Token` and `X-Review-Authenticated-Login` headers, then inject the server-only proxy token. When `SHOTGRID_SUDO_AS_LOGIN` is configured, the proxy must also inject that exact login so the authenticated identity is bound to ShotGrid impersonation. The proxy token must never be sent to browser code or exposed through CORS.

Project and entity authorization remains the reverse proxy's responsibility until the permission hardening work in issue #12 is complete.
