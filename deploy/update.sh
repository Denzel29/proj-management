#!/usr/bin/env bash
# Update Forge on the server: pull the latest code, rebuild, restart.
#   ~/forge/deploy/update.sh
# Database migrations run automatically when the container starts.
set -euo pipefail
cd "$(dirname "$0")/.."

git pull --ff-only
docker compose up -d --build
docker image prune -f > /dev/null
docker compose ps
