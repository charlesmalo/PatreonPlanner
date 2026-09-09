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
# Self-contained, production-only node_modules. Without this the runtime image carries the whole
# dev toolchain — including testcontainers, whose only purpose is talking to a Docker daemon.
RUN pnpm --filter @app/api deploy --prod /prod
# `prisma generate` writes the client and its engine to a `.prisma` directory that sits *beside*
# the @prisma/client package rather than inside it, so `pnpm deploy` does not carry it along.
# It has to land next to the package in the deployed store, since that is where @prisma/client
# resolves from — a copy at the node_modules root is never consulted.
# Both paths are resolved with `ls -d` rather than globbed inline: the destination does not exist
# yet, so an unmatched glob would be passed through literally and silently create a junk
# directory, leaving @prisma/client's "did not initialize yet" stub in place.
RUN set -eu; \
    src="$(ls -d /repo/node_modules/.pnpm/@prisma+client@*/node_modules/.prisma)"; \
    dest="$(ls -d /prod/node_modules/.pnpm/@prisma+client@*/node_modules)"; \
    rm -rf "$dest/.prisma"; \
    cp -R "$src" "$dest/.prisma"; \
    test -n "$(ls "$dest"/.prisma/client/*.so.node)"

FROM node:20-slim AS runtime
# Prisma's query engine links against OpenSSL.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app
# `pnpm deploy` resolves the store symlinks into a real tree, so this copy needs no workspace
# layout around it.
COPY --from=build /prod/node_modules ./node_modules
COPY --from=build /repo/apps/api/dist ./dist
COPY --from=build /repo/apps/api/package.json ./
# A writable home for the embedding model, owned by the user the process runs as.
#
# Created here rather than left to the deployment, because Docker copies this directory's
# ownership into a *fresh named volume* mounted over it — so a compose file that mounts one at
# /models gets a directory `node` can write to, instead of a root-owned mountpoint. Without it,
# mounting a volume here reproduces exactly the EACCES this path exists to avoid: the model
# download fails and search silently degrades to trigram.
RUN mkdir -p /models && chown node:node /models
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
