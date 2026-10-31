# Self-hosted image for the reporting web app (ADR-0002, ADR-0006).
#
# Three stages, because the build needs the whole workspace and the runtime needs
# almost none of it: Next's `standalone` output is already a pruned node_modules plus a
# server entry point, so the runtime image contains no package manager and no source.
#
# NOTE: this file has not been executed in the build environment (Docker is absent
# there). It follows the documented standalone layout for a pnpm workspace; treat the
# first real build as a task, not a formality.

FROM node:22-alpine AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /repo

# ---------------------------------------------------------------- dependencies
# Only the manifests, so a source change does not invalidate the install layer.
FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
COPY packages/corpus/package.json packages/corpus/
COPY packages/template-schema/package.json packages/template-schema/
COPY packages/tokens/package.json packages/tokens/
COPY packages/validation/package.json packages/validation/
COPY db/package.json db/
RUN pnpm install --frozen-lockfile

# ---------------------------------------------------------------------- build
FROM base AS build
COPY --from=deps /repo/node_modules ./node_modules
COPY . .
# `...` builds the web app *and* the workspace packages it depends on (tokens first).
RUN pnpm exec turbo run build --filter=@reporting/web...

# -------------------------------------------------------------------- runtime
FROM node:22-alpine AS runner
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
WORKDIR /app

# The standalone bundle keeps the workspace layout, so the entry point is under apps/web.
COPY --from=build /repo/apps/web/.next/standalone ./
COPY --from=build /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /repo/apps/web/public ./apps/web/public

# The library is data, not code: it is mounted or copied rather than baked into the
# bundle, so a corpus regeneration does not require a rebuild of the image.
COPY --from=build /repo/corpus/generated/templates.json ./corpus/generated/templates.json
ENV CORPUS_PATH=/app/corpus/generated/templates.json

USER node
EXPOSE 3000

# No shell, no package manager, no write access to the filesystem beyond /tmp.
ENTRYPOINT ["node", "apps/web/server.js"]
