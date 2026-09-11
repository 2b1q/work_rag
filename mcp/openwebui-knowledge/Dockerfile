FROM node:24-alpine AS build

WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# pnpm, pinned by package.json's packageManager field. The lockfile is pnpm's, so
# `npm ci` could never read it: it failed every build and fell through to `npm i`,
# which resolves fresh versions each time and makes the image unreproducible.
RUN corepack enable

COPY package.json pnpm-lock.yaml tsconfig.json ./
RUN pnpm install --frozen-lockfile

COPY src ./src
RUN pnpm run build

# typescript and @types are most of node_modules and none of it runs.
RUN pnpm prune --prod

FROM node:24-alpine

WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/package.json /app/package.json
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/dist /app/dist

# Nothing here needs root; upload roots are mounted read-only.
USER node

EXPOSE 8787

# /health answers as soon as the process is listening. It deliberately does not
# probe OpenWebUI: this container being unhealthy because its upstream is
# restarting would take the bridge down for no reason.
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

CMD ["node", "dist/index.js"]
