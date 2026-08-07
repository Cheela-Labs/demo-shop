# syntax=docker/dockerfile:1

# Container image for Cloud Run (or anything else that runs a container).
#
# The database is SQLite, baked into the image and living on the container's
# **ephemeral** filesystem. Reads are fine; writes — orders, sign-ups, carts —
# last only as long as the instance does. That is a deliberate trade for a demo
# deployment, and it carries one hard requirement: run **exactly one instance**
# (`--max-instances 1`), because a second instance means a second, divergent
# copy of the database. Point `repo.js` at Postgres before removing that cap.
#
#   docker build --platform=linux/amd64 \
#     --build-arg VITE_CHEELA_PUBLIC_KEY=ch_pk_… \
#     -t <region>-docker.pkg.dev/<project>/shop/cheela-shop:v1 .
#
# `--platform` matters when building from an ARM machine: sharp resolves a
# platform-specific prebuilt binary at install time, and an arm64 one will not
# run on Cloud Run.

# Node 24 for two reasons that are not negotiable: `node:sqlite` (added in
# 22.5) and unflagged TypeScript stripping, since server/src/index.js imports
# ../.cheela/runtime.ts directly.
FROM node:24-slim AS build
WORKDIR /app

# Manifests first, so a dependency install is only redone when they change.
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci

# Both build arguments are declared *after* the install on purpose: changing
# either one should rebuild the bundle, not re-run npm ci.

# Vite inlines this into the bundle at build time — see Assistant.jsx. Setting
# it as a runtime environment variable does nothing at all: the panel silently
# does not render, which looks exactly like a broken integration.
ARG VITE_CHEELA_PUBLIC_KEY
ENV VITE_CHEELA_PUBLIC_KEY=$VITE_CHEELA_PUBLIC_KEY

# Also build-time, and for a sharper reason. The demo account is seeded below,
# and `DEMO_ACCOUNT=off` only skips *creating* it — it never removes one that
# already exists. Setting it on the running service therefore leaves the fixed,
# publicly documented session token sitting in the baked database. Pass
# `--build-arg DEMO_ACCOUNT=off` for anything reachable by strangers.
ARG DEMO_ACCOUNT
ENV DEMO_ACCOUNT=$DEMO_ACCOUNT

COPY . .

RUN npm run build --workspace client

# Seed at build time rather than on boot. `index.js` calls `seed()` before it
# listens, and a cold start that has to rasterise 48 PNGs does it in front of
# the startup probe. Seeding is hash-checked, so the call at boot then finds
# the artwork up to date and returns immediately.
RUN node server/src/seed.js

# Drops vite, esbuild and typescript. Note it does *not* drop @cheela/cli,
# which is a plain dependency of the client workspace rather than a dev one —
# harmless, since publishing a runtime needs the deploy key (`ch_sk_…`) and
# that never reaches this image.
RUN npm prune --omit=dev


FROM node:24-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production

# The seeded database ships inside the image, and SQLite writes beside it
# (`-wal`, `-shm`), so the application user has to own the tree.
COPY --from=build --chown=node:node /app ./
USER node

# Documentation only — Cloud Run injects PORT, and index.js reads it.
EXPOSE 8080

# Not `npm start`: that wrapper adds --env-file-if-exists for local .env files,
# which is the wrong mechanism here. Configuration arrives from the platform.
CMD ["node", "server/src/index.js"]
