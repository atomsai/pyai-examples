# Build in cloud with the repository root as context; no local image build.
FROM node:24-bookworm-slim AS sdk
WORKDIR /app/sdk/twilio
COPY sdk/twilio/package.json sdk/twilio/package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY sdk/twilio/src ./src
COPY sdk/twilio/tsconfig*.json ./
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
WORKDIR /app/examples/plivo-live-translation
COPY --from=sdk /app/sdk/twilio /app/sdk/twilio
COPY examples/plivo-live-translation/package.json examples/plivo-live-translation/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force
COPY examples/plivo-live-translation/*.mjs examples/plivo-live-translation/index.html ./
ENV NODE_ENV=production PORT=8080
USER node
CMD ["node", "server.mjs"]
