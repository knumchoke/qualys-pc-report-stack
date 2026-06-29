# ---------- builder ----------
# Installs deps and builds INSIDE alpine so Prisma's native engines match the
# runtime image's OS+arch. The local (macOS) node_modules is never used here.
FROM node:22-alpine AS builder
WORKDIR /usr/src/app

# Corporate TLS inspection (Zscaler) re-signs registry.npmjs.org. When building
# behind Zscaler the container must trust its root CA or npm/Prisma fetches fail
# with UNABLE_TO_GET_ISSUER_CERT_LOCALLY. The cert is OPTIONAL: the cr[t] glob lets
# the COPY no-op when Zscaler_Root_CA.crt isn't in the build context (e.g. building
# off the corporate network), while package.json (always present) keeps the COPY
# source list non-empty so the build doesn't fail. The RUN is guarded the same way.
COPY package.json Zscaler_Root_CA.cr[t] /tmp/ca/
RUN if [ -f /tmp/ca/Zscaler_Root_CA.crt ]; then \
      mkdir -p /usr/local/share/ca-certificates && \
      cp /tmp/ca/Zscaler_Root_CA.crt /usr/local/share/ca-certificates/ && \
      cat /tmp/ca/Zscaler_Root_CA.crt >> /etc/ssl/certs/ca-certificates.crt && \
      echo "Zscaler root CA installed."; \
    else echo "No Zscaler CA in build context — skipping (assuming direct TLS)."; fi
# Harmless if the file is absent: Node just warns and continues with its built-in CAs.
ENV NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/Zscaler_Root_CA.crt

# Deps layer — only re-runs when package.json / lockfile change.
COPY package*.json ./
RUN npm ci

# Prisma 7 generates a TypeScript client into src/generated/prisma, so the source
# must be present first; tsc then compiles app + generated client together.
COPY prisma ./prisma
COPY prisma.config.ts tsconfig.json ./
COPY src ./src
RUN npx prisma generate
RUN npx tsc

# ---------- runtime ----------
FROM node:22-alpine AS runtime
WORKDIR /usr/src/app
ENV NODE_ENV=production

COPY package*.json ./
COPY --from=builder /usr/src/app/node_modules ./node_modules
COPY --from=builder /usr/src/app/dist ./dist
COPY prisma ./prisma
# prisma.config.ts supplies the datasource URL that `prisma db push` reads on boot.
COPY prisma.config.ts ./
COPY public ./public

EXPOSE 3000

# Sync the schema to Postgres on boot (demo-friendly), then start the server.
# Prisma 7's `db push` no longer runs (or accepts --skip-generate for) generation.
CMD ["sh", "-c", "npx prisma db push --accept-data-loss && node dist/server.js"]
