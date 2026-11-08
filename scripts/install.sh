#!/bin/sh
# Harborlight installer: run from a reviewed checkout of this repository.
set -eu

SCRIPT_DIR=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
PROJECT_DIR=$(dirname "$SCRIPT_DIR")
cd "$PROJECT_DIR"

if ! command -v docker >/dev/null 2>&1; then
  echo 'Docker Engine is required: https://docs.docker.com/engine/install/' >&2
  exit 1
fi
docker info >/dev/null
docker compose version >/dev/null
if [ ! -f package-lock.json ] || [ ! -f compose.yaml ]; then
  echo 'Run the installer from a complete Harborlight source checkout.' >&2
  exit 1
fi
if [ ! -f .env ]; then
  umask 077
  cp .env.example .env
fi
docker compose up -d --build panel
echo 'Harborlight is starting on the loopback address (default http://127.0.0.1:3000).'
echo 'For a remote server, use SSH port forwarding to complete owner setup.'
echo 'See README.md to configure domains and the optional HTTPS proxy.'
