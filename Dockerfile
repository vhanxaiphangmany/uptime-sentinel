# syntax=docker/dockerfile:1

# Zero runtime dependencies: no build step, just the Node runtime.
FROM node:24-alpine AS base
WORKDIR /app
ENV NODE_ENV=production
# Create a non-root user and a writable data directory for SQLite.
RUN addgroup -S app && adduser -S app -G app \
  && mkdir -p /data \
  && chown app:app /data

COPY --chown=app:app package.json ./
COPY --chown=app:app tsconfig.json ./
COPY --chown=app:app src ./src
COPY --chown=app:app test ./test
COPY --chown=app:app README.md ./

USER app
EXPOSE 8080
ENV DB_PATH=/data/sentinel.db
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1

CMD ["node", "src/main.ts"]
