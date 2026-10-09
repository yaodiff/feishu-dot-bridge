# Advanced OAuth compatibility image; personal Tunnel deployment uses native loopback Node.
FROM node:24-bookworm-slim AS build
# Required by the fail-closed image decoder and its synthetic tests.
RUN apt-get update && apt-get install -y --no-install-recommends util-linux openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --ignore-scripts
COPY src ./src
COPY scripts ./scripts
COPY test ./test
RUN npm test && npm prune --omit=dev --ignore-scripts

FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends util-linux && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production AUTH_MODE=oauth HOST=0.0.0.0 PORT=3000 DATABASE_PATH=/data/bridge.sqlite FEISHU_APPS_FILE=/config/feishu-apps.json
WORKDIR /app
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist/src ./dist/src
COPY --from=build --chown=node:node /app/dist/scripts ./dist/scripts
COPY --from=build --chown=node:node /app/package.json ./
RUN mkdir -m 700 /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["node", "dist/src/main.js"]
