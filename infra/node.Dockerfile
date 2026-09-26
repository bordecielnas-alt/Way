# API and worker image (same code, APP selects the entry point).
FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/providers/package.json packages/providers/
COPY packages/core/package.json packages/core/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/front/package.json apps/front/
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

COPY tsconfig.base.json ./
COPY packages packages
COPY apps/api apps/api
COPY apps/worker apps/worker

ARG APP=api
ENV APP=${APP}
USER node
CMD ["sh", "-c", "exec node --import tsx apps/${APP}/src/main.ts"]
