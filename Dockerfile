FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-fund --no-audit
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY tests ./tests
RUN npm run check && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    CODEX_BIN=/app/node_modules/.bin/codex \
    DATA_DIR=/data \
    HOST=0.0.0.0
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/docs ./docs
COPY package.json ./
RUN node node_modules/playwright/cli.js install --with-deps chromium --only-shell \
    && mkdir -p /data /home/node/.cache \
    && chown -R node:node /data /home/node \
    && chmod -R a+rX /ms-playwright \
    && rm -rf /var/lib/apt/lists/*
USER node
EXPOSE 8080
CMD ["node", "dist/src/main.js"]
