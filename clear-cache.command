#!/bin/sh
set -eu
SIDECAR_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$SIDECAR_DIR"
exec "$SIDECAR_DIR/.venv/bin/python" -m host.cache --clear
