# syntax=docker/dockerfile:1
# Multi-stage build for the cozygateway push relay. Build context is the monorepo ROOT.

# Docker Hub OCI index digest for node:26-slim, verified 2026-09-25.
FROM node:26-slim@sha256:ec7758ee051e457b468b32bde57b0879010b325bb9862718e9615225ce4aaae1 AS build
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm --filter=cozygateway-relay deploy --prod --legacy /app

FROM node:26-slim@sha256:ec7758ee051e457b468b32bde57b0879010b325bb9862718e9615225ce4aaae1 AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
COPY LICENSE /app/LICENSE
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]
EXPOSE 8788
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8788/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
USER node
# Flags are the container-internal defaults; the operator maps host ports and volumes in compose.
CMD ["node", "dist/cli.js", "--host", "0.0.0.0", "--port", "8788", "--db", "/data/relay.db"]
