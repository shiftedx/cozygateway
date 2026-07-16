# syntax=docker/dockerfile:1
# Multi-stage build for the cozygateway process. Build context is the monorepo ROOT.

FROM node:24-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build
# Prune to a self-contained production deployment: dist (the package's only published files) plus
# prod-only node_modules, with the workspace contract hard-copied in. --legacy keeps the
# well-understood deploy semantics across pnpm versions.
RUN pnpm --filter=cozygateway deploy --prod --legacy /app

FROM node:24-slim AS runtime
ENV NODE_ENV=production
ENV COZYGATEWAY_HOST=0.0.0.0
ENV COZYGATEWAY_PORT=8787
ENV COZYGATEWAY_DB_PATH=/data/cozygateway.db
WORKDIR /app
COPY --from=build /app /app
# A default mock ("echo") config so `docker run` works out of the box and the CI smoke test needs
# no mount. Real deployments mount their own config over this path (see docker-compose.yml).
COPY packages/gateway/docker/cozygateway.config.json /app/cozygateway.config.json
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]
EXPOSE 8787
# Reuse the existing unauthenticated GET /health (200, returns GatewayInfo). Node 24 has fetch.
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.COZYGATEWAY_PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
USER node
CMD ["node", "dist/cli.js", "serve", "--config", "/app/cozygateway.config.json"]
