FROM node:20-slim AS build
# Prisma picks the query-engine build from the OpenSSL it detects here. Without openssl present
# it guesses 1.1.x and generates an engine the runtime stage (OpenSSL 3.0) cannot load.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /repo
# Every workspace package.json is needed for --frozen-lockfile to agree with the lockfile,
# even though --filter installs only the api's dependency closure.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN pnpm install --filter @app/api... --frozen-lockfile
COPY tsconfig.base.json ./
COPY apps/api apps/api
RUN pnpm --filter @app/api prisma:generate && pnpm --filter @app/api build

FROM node:20-slim AS runtime
# Prisma's query engine links against OpenSSL.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
# A package's node_modules is a tree of symlinks into the root store, so the workspace layout
# has to survive the copy or nothing resolves.
COPY --from=build /repo/node_modules ./node_modules
COPY --from=build /repo/apps/api/node_modules ./apps/api/node_modules
COPY --from=build /repo/apps/api/dist ./apps/api/dist
COPY --from=build /repo/apps/api/package.json ./apps/api/
EXPOSE 3000
CMD ["node", "apps/api/dist/main.js"]
