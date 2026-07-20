# ── Build stage ────────────────────────────────────────────
FROM node:22-slim AS build

RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# ── Production stage ──────────────────────────────────────
FROM node:22-slim

LABEL org.opencontainers.image.source=https://github.com/runnane/elegoo-web

RUN corepack enable && corepack prepare pnpm@9 --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --prod

# Copy built frontend + source (tsx runs .ts at runtime)
COPY --from=build /app/dist ./dist
COPY src ./src

ENV NODE_ENV=production
ENV PORT=8088
EXPOSE 8088 7125

CMD ["pnpm", "service"]
