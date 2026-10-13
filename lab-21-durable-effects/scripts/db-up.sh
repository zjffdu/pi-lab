#!/usr/bin/env bash
# Starts (or restarts) the Postgres container dedicated to Lab 21 and writes DATABASE_URL into the
# ignored .env. The password is generated locally, never printed, and only guards synthetic data.
set -euo pipefail
cd "$(dirname "$0")/.."

RUNTIME="$(command -v podman || command -v docker || true)"
[ -n "$RUNTIME" ] || { echo "Need podman or docker on PATH." >&2; exit 1; }

NAME=pi-lab-21-pg
PORT=5545
IMAGE=docker.io/library/postgres:16

if "$RUNTIME" container inspect "$NAME" >/dev/null 2>&1; then
  "$RUNTIME" start "$NAME" >/dev/null
  grep -q '^DATABASE_URL=.' .env 2>/dev/null || {
    echo "Container $NAME exists but .env has no DATABASE_URL; run npm run db:down first to recreate it." >&2
    exit 1
  }
else
  PASSWORD="$(openssl rand -hex 16)"
  "$RUNTIME" run -d --name "$NAME" -p "127.0.0.1:${PORT}:5432" \
    -e POSTGRES_USER=pilab -e POSTGRES_PASSWORD="$PASSWORD" -e POSTGRES_DB=pi_lab_21 "$IMAGE" >/dev/null
  URL="postgres://pilab:${PASSWORD}@127.0.0.1:${PORT}/pi_lab_21"
  touch .env
  grep -v '^DATABASE_URL=' .env > .env.tmp || true
  { echo "DATABASE_URL=${URL}"; cat .env.tmp; } > .env
  rm -f .env.tmp
fi

for _ in $(seq 1 30); do
  "$RUNTIME" exec "$NAME" pg_isready -U pilab -d pi_lab_21 >/dev/null 2>&1 && { echo "Postgres ready on 127.0.0.1:${PORT} (DATABASE_URL is in .env)"; exit 0; }
  sleep 1
done
echo "Postgres did not become ready in 30s." >&2
exit 1
