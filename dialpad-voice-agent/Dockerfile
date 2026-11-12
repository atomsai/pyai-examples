FROM node:24-slim
WORKDIR /app
COPY package.json routing.mjs server.mjs ./
USER node
ENV NODE_ENV=production PORT=8080
CMD ["node", "server.mjs"]
