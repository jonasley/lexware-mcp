# syntax=docker/dockerfile:1

# Dockerfile for the Lexware Office MCP server.
#
# Uses pnpm, pinned below. Corepack is not bundled in Node >= 25, so pnpm comes
# from its GitHub release archive, verified by checksum.

# Build stage: install deps, compile the app, then prune dev deps.
FROM node:26-slim AS build
WORKDIR /app

# To update pnpm, bump the version and replace both hashes with
# `shasum -a 256` of the new release assets.
ARG PNPM_VERSION=12.16.1
ARG PNPM_SHA256_X64=565ff81174a14f6f7bd5d84c1b17e51031a80230d370a1fe24be5d16bd02a825
ARG PNPM_SHA256_ARM64=f5847699e5d528f8f8e9bcfb385e58cb9fba7482af1b1aa7b70737be42277f81
ENV PATH=/opt/pnpm:$PATH
RUN set -eu; \
    case "$(dpkg --print-architecture)" in \
      amd64) arch=x64; sha=$PNPM_SHA256_X64 ;; \
      arm64) arch=arm64; sha=$PNPM_SHA256_ARM64 ;; \
      *) echo "unsupported architecture" >&2; exit 1 ;; \
    esac; \
    node -e "fetch(process.argv[1]).then(async (r) => { if (!r.ok) process.exit(1); require('fs').writeFileSync('/tmp/pnpm.tar.gz', Buffer.from(await r.arrayBuffer())); })" \
      "https://github.com/pnpm/pnpm/releases/download/v$PNPM_VERSION/pnpm-linux-$arch.tar.gz"; \
    echo "$sha  /tmp/pnpm.tar.gz" | sha256sum -c -; \
    mkdir -p /opt/pnpm; \
    tar -xzf /tmp/pnpm.tar.gz -C /opt/pnpm; \
    rm /tmp/pnpm.tar.gz; \
    pnpm --version

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc* ./
RUN pnpm install --frozen-lockfile

ENV NODE_ENV=production

COPY . .
RUN pnpm build && pnpm prune --prod

# Runtime stage: copy built artifacts and prod deps, run as non-root.
FROM node:26-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Default listen port. Cloud Run overrides PORT at runtime; the server reads it.
ENV PORT=8080
# Bind every interface inside the container, or the platform cannot route in. The server
# defaults to 127.0.0.1 outside a container; publish the port deliberately (see
# docker-compose.yml, which maps it to the host's loopback only).
ENV HOST=0.0.0.0

USER node

COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/package.json ./package.json

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/status').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Run the built server directly rather than via `pnpm start`.
# A wrapper adds a process layer that can swallow SIGTERM, which makes
# graceful shutdowns time out on platforms like Cloud Run, Fly, and k8s.
CMD ["node", "dist/server.js"]
