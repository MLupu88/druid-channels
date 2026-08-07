# syntax=docker/dockerfile:1
#
# Build context MUST be the repository root (pnpm workspace monorepo), e.g.:
#   docker build -f artifacts/partner-radar/Dockerfile -t druid-channels-web:local .
#
# PORT and BASE_PATH are read by vite.config.ts at build time (vite.config.ts
# throws if either is unset) and get baked into the static bundle. PORT here
# only needs to be a valid number for the build step; it has no effect on the
# runtime container, which always serves on 8080 (see nginx.conf).

FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.10.0 --activate

ARG PORT=8080
ARG BASE_PATH=/
ENV PORT=${PORT}
ENV BASE_PATH=${BASE_PATH}

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @workspace/partner-radar run build

# ---------------------------------------------------------------------------
# Runtime: plain nginx serving the pre-built static SPA, with a history-mode
# fallback to index.html. No application framework or reverse-proxying is
# introduced here -- Nginx Proxy Manager remains the only reverse proxy.
FROM nginx:alpine AS runtime

COPY --from=build /app/artifacts/partner-radar/dist/public /usr/share/nginx/html
COPY artifacts/partner-radar/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/ >/dev/null || exit 1
