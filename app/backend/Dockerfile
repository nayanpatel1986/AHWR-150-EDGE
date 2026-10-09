# Production image for the ROM-II backend (no dev server / nodemon).
FROM node:20-alpine
ENV NODE_ENV=production
WORKDIR /app

# Install only production dependencies from the lockfile (reproducible).
COPY backend/package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# App source (node_modules excluded via .dockerignore).
COPY backend/. .
COPY shared /shared

# Writable state directory, owned by the unprivileged 'node' user.
RUN mkdir -p /data && chown -R node:node /data /app
USER node
ENV DATA_DIR=/data

EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://127.0.0.1:5000/healthz >/dev/null 2>&1 || exit 1

CMD ["node", "server.js"]
