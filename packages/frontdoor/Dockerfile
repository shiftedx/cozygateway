# syntax=docker/dockerfile:1
# Multi-stage build for the cozygateway front door. Build context is the monorepo ROOT.

FROM node:24-slim AS build
ENV PNPM_HOME=/pnpm
ENV PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm --filter=cozy-frontdoor deploy --prod --legacy /app

FROM node:24-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app /app
RUN mkdir -p /data && chown -R node:node /data /app
VOLUME ["/data"]
EXPOSE 8790
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "const port=process.env.FRONTDOOR_PORT||'8790'; const host=(process.env.FRONTDOOR_API_HOSTNAMES||'relay.cozylabs.ai').split(',')[0].trim(); fetch('http://127.0.0.1:'+port+'/healthz',{headers:{host}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
USER node
# FRONTDOOR_POOL is required. Operators provide the pool and other settings as environment variables.
CMD ["node", "dist/cli.js"]
