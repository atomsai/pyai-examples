# Build in cloud with the repository root as context; no local image build.
FROM node:24-bookworm-slim AS sdk
WORKDIR /app/sdk/twilio
COPY sdk/twilio/package.json sdk/twilio/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY sdk/twilio/src ./src
COPY sdk/twilio/tsconfig*.json ./
RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim
WORKDIR /app/examples/twilio-live-translation
COPY --from=sdk /app/sdk/twilio /app/sdk/twilio
COPY examples/twilio-live-translation/package.json examples/twilio-live-translation/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY examples/twilio-live-translation/*.mjs examples/twilio-live-translation/index.html ./
ENV NODE_ENV=production PORT=8080
USER node
CMD ["node", "server.mjs"]
