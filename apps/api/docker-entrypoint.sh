#!/bin/sh
# With LITESTREAM_REPLICA_URL set (s3://bucket/path or R2 equivalent), restore
# the DB if the volume is empty, then run the control plane under streaming
# replication. Without it, run plainly — the volume alone is the durability.
set -e
DB="${PHONE_USE_CLOUD_DB:-/data/phone-use-cloud.sqlite}"
mkdir -p "$(dirname "$DB")"

if [ -n "$LITESTREAM_REPLICA_URL" ]; then
  if [ ! -f "$DB" ]; then
    litestream restore -if-replica-exists -o "$DB" "$LITESTREAM_REPLICA_URL"
  fi
  exec litestream replicate -exec "bun apps/api/src/control-plane-main.ts" "$DB" "$LITESTREAM_REPLICA_URL"
fi
exec bun apps/api/src/control-plane-main.ts
