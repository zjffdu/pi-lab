#!/usr/bin/env bash
# Removes the Lab 18 Postgres container and its data, and clears DATABASE_URL from .env.
set -euo pipefail
cd "$(dirname "$0")/.."
RUNTIME="$(command -v podman || command -v docker || true)"
[ -n "$RUNTIME" ] || { echo "Need podman or docker on PATH." >&2; exit 1; }
"$RUNTIME" rm -f pi-lab-18-pg >/dev/null 2>&1 || true
if [ -f .env ]; then grep -v '^DATABASE_URL=' .env > .env.tmp || true; mv .env.tmp .env; fi
echo "Removed container pi-lab-18-pg."
