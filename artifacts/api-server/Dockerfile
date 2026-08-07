# syntax=docker/dockerfile:1
#
# Build context MUST be the repository root (pnpm workspace monorepo), e.g.:
#   docker build -f artifacts/api-server/Dockerfile -t druid-channels-api:local .

FROM node:24-bookworm-slim AS build
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.10.0 --activate

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm --filter @workspace/api-server run build

# ---------------------------------------------------------------------------
# Runtime: the esbuild bundle in dist/ has no runtime dependency on
# node_modules (see artifacts/api-server/build.mjs), so the final image only
# needs Node + the built dist/ output.
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=8080

COPY --from=build /app/artifacts/api-server/dist ./dist

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/healthz').then((r)=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--enable-source-maps", "dist/index.mjs"]
