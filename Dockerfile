# Way — single-container image: web app + API + search + embedded Postgres.
# Run: docker run -d -p 8080:8080 -v /path/to/data:/data ghcr.io/bordecielnas-alt/way

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/providers/package.json packages/providers/
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/front/package.json apps/front/
RUN npm ci --ignore-scripts
COPY packages packages
COPY apps/front apps/front
ARG VITE_SATELLITE_URL
ARG VITE_SATELLITE_CREDIT
RUN npm run build -w @way/front

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/providers/package.json packages/providers/
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/front/package.json apps/front/
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY packages packages
COPY apps/api apps/api
COPY --from=build /app/apps/front/dist public

# Everything persistent (database, border snapshots) lives in /data.
ENV DATA_DIR=/data \
    STATIC_DIR=/app/public \
    API_PORT=8080 \
    MEMORY_STORE_FILE=
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s \
  CMD wget -qO- http://127.0.0.1:8080/api/health || exit 1
CMD ["node", "--import", "tsx", "apps/api/src/main.ts"]
