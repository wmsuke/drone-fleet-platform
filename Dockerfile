FROM node:22-alpine AS build

WORKDIR /workspace

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/api/package.json apps/api/package.json
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY apps/load-generator/package.json apps/load-generator/package.json
COPY apps/load-report/package.json apps/load-report/package.json
COPY apps/simulator/package.json apps/simulator/package.json
COPY apps/telemetry-ingestor/package.json apps/telemetry-ingestor/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/protocol/package.json packages/protocol/package.json
RUN pnpm install --frozen-lockfile

COPY apps ./apps
COPY packages ./packages
COPY tsconfig.json ./tsconfig.json

ARG VITE_API_BASE_URL=http://127.0.0.1:3000
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
RUN pnpm build

FROM node:22-alpine AS runtime

WORKDIR /workspace

RUN corepack enable

COPY --from=build /workspace /workspace

ENV NODE_ENV=production
