# =============================================================================
# Multi-stage image: TypeScript build, then a minimal runtime image.
# better-sqlite3 is a native module: it is compiled in the builder stage and
# copied as-is. Both stages share the same base image, hence the same Node
# version and glibc, hence the same ABI.
# =============================================================================

# --- Stage 1: build ----------------------------------------------------------
FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Toolchain needed to build better-sqlite3 from source when no prebuilt binary
# is available for the target platform.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Dependencies are installed before the sources are copied, so the Docker cache
# is only invalidated when package.json or package-lock.json change.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Drop the development dependencies from node_modules.
RUN npm prune --omit=dev

# --- Stage 2: runtime --------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

ENV NODE_ENV=production \
    DB_PATH=/app/data/watch.db \
    LOG_LEVEL=info

WORKDIR /app

# The node image already ships a non-root user named "node".
RUN mkdir -p /app/data && chown -R node:node /app

COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./

USER node

# The SQLite store must outlive the container.
# VOLUME ["/app/data"]

# Port for the Streamable HTTP transport (unused in stdio mode).
EXPOSE 3000

# Fixed ENTRYPOINT plus an overridable CMD, so `docker run image fetch` works.
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["mcp"]
