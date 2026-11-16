# Control plane image — build from the REPO ROOT:
#   docker build -f apps/api/Dockerfile .
# Runs the Bun control plane with SQLite on a mounted volume; if
# LITESTREAM_REPLICA_URL is set, the DB is stream-replicated (s3://… or r2).
FROM oven/bun:1.3-slim
ENV NODE_ENV=production

WORKDIR /app

# Litestream for SQLite disaster recovery (no-op unless configured).
ADD https://github.com/benbjohnson/litestream/releases/download/v0.5.15/litestream-0.5.15-linux-x86_64.deb /tmp/litestream.deb
RUN dpkg -i /tmp/litestream.deb && rm /tmp/litestream.deb

COPY package.json bun.lock tsconfig.base.json tsconfig.json ./
COPY packages/sdk ./packages/sdk
COPY apps/api ./apps/api
COPY packages/phone-use/package.json ./packages/phone-use/package.json
RUN bun install --production --ignore-scripts || bun install --ignore-scripts

ENV PHONE_USE_CLOUD_DB=/data/phone-use-cloud.sqlite \
    HOST=0.0.0.0 \
    PORT=8080
EXPOSE 8080

COPY apps/api/docker-entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
CMD ["/entrypoint.sh"]
