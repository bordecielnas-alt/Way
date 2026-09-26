# Static front: Vite build served by nginx (which also proxies /api and /ws).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
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

FROM nginx:1.27-alpine
COPY infra/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/front/dist /usr/share/nginx/html
