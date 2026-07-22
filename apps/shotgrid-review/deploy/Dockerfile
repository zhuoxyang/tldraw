# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:22-bookworm-slim
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:stable-alpine

FROM ${NODE_IMAGE} AS workspace

WORKDIR /workspace

RUN corepack enable && corepack prepare yarn@4.12.0 --activate

COPY . .

RUN yarn install --immutable --mode=skip-build

FROM workspace AS frontend-build

ARG VITE_REVIEW_STORAGE_NAMESPACE
ARG VITE_TLDRAW_LICENSE_KEY

ENV VITE_REVIEW_API_BASE_URL=/api \
	VITE_REVIEW_DATA_MODE=shotgrid \
	VITE_REVIEW_STORAGE_NAMESPACE=${VITE_REVIEW_STORAGE_NAMESPACE} \
	VITE_TLDRAW_LICENSE_KEY=${VITE_TLDRAW_LICENSE_KEY}

RUN test -n "$VITE_REVIEW_STORAGE_NAMESPACE" \
	&& test -n "$VITE_TLDRAW_LICENSE_KEY" \
	&& yarn workspace tldraw predev \
	&& yarn workspace shotgrid-review build

FROM workspace AS api-build

RUN yarn workspace shotgrid-review-api build

FROM ${NGINX_IMAGE} AS gateway

COPY --from=frontend-build --chown=101:101 /workspace/apps/shotgrid-review/dist /usr/share/nginx/html
COPY --chown=101:101 apps/shotgrid-review/deploy/nginx.conf.template /etc/nginx/review-nginx.conf.template
COPY --chmod=0555 --chown=101:101 apps/shotgrid-review/deploy/gateway-entrypoint.sh /usr/local/bin/review-gateway-entrypoint

USER 101:101

EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/review-gateway-entrypoint"]
CMD ["nginx", "-c", "/tmp/review-nginx.conf", "-g", "daemon off;"]

FROM ${NODE_IMAGE} AS api

RUN groupadd --gid 10001 review \
	&& useradd --uid 10001 --gid review --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin review

WORKDIR /app

COPY --from=api-build --chown=10001:10001 /workspace/apps/shotgrid-review-api/dist/server.js /app/server.js
COPY --from=api-build --chown=10001:10001 /workspace/apps/shotgrid-review-api/dist/review-data-snapshot.js /app/review-data-snapshot.js
COPY --chmod=0555 --chown=10001:10001 apps/shotgrid-review/deploy/api-entrypoint.sh /usr/local/bin/review-api-entrypoint
COPY --chmod=0555 --chown=10001:10001 apps/shotgrid-review/deploy/snapshot-entrypoint.sh /usr/local/bin/review-snapshot-entrypoint

ENV NODE_ENV=production

USER 10001:10001

EXPOSE 5431

ENTRYPOINT ["/usr/local/bin/review-api-entrypoint"]
CMD ["node", "/app/server.js"]
