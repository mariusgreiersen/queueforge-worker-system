# syntax=docker/dockerfile:1.7
# Multi-stage build for every QueueForge component. Pick one with --target (api | worker | dashboard | test).

ARG NODE_VERSION=24

FROM node:${NODE_VERSION}-alpine AS base
WORKDIR /app

# ---- dependencies (cached until a manifest or the lockfile changes) ----
FROM base AS deps
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/dashboard/package.json apps/dashboard/
RUN npm ci --no-audit --no-fund

# ---- build all apps ----
FROM deps AS build
COPY tsconfig.base.json tsconfig.json ./
COPY packages packages
COPY apps apps
RUN npm run build -w @queueforge/api -w @queueforge/worker -w @queueforge/dashboard

# ---- test runner (used by docker/docker-compose.test.yml) ----
FROM deps AS test
COPY . .
CMD ["sh", "-c", "npm run test:unit && npm run test:integration"]

# ---- production node_modules only (dashboard deps are devDependencies: bundled by Vite) ----
FROM base AS prod-deps
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY apps/dashboard/package.json apps/dashboard/
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM base AS node-runtime
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./
USER node

# ---- API ----
FROM node-runtime AS api
COPY --from=build /app/apps/api/dist ./apps/api/dist
ENV API_HOST=0.0.0.0 API_PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health/live >/dev/null || exit 1
CMD ["node", "--enable-source-maps", "apps/api/dist/server.js"]

# ---- worker ----
FROM node-runtime AS worker
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
CMD ["node", "--enable-source-maps", "apps/worker/dist/main.js"]

# ---- dashboard: static files behind an unprivileged nginx that also proxies the API ----
FROM nginxinc/nginx-unprivileged:1.27-alpine AS dashboard
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/dashboard/dist /usr/share/nginx/html
EXPOSE 8080
