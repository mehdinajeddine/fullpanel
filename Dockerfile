# syntax=docker/dockerfile:1
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json vite.config.ts index.html ./
COPY shared ./shared
COPY server ./server
COPY src ./src
COPY public ./public
RUN npm run build

FROM docker:29-cli AS docker-cli

FROM node:24-alpine AS runtime
RUN apk add --no-cache git openssh-client tini ca-certificates
COPY --from=docker-cli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=docker-cli /usr/local/libexec/docker/cli-plugins /usr/local/libexec/docker/cli-plugins
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 HARBORLIGHT_MODE=docker DATA_DIR=/var/lib/harborlight
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY --from=build /app/dist ./dist
VOLUME ["/var/lib/harborlight"]
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/server/index.js"]
