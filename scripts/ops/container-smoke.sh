#!/bin/sh
set -eu

# Build-focused local smoke for OCI container packaging. It never installs
# binfmt/QEMU and never pushes or deploys an image.

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
image=${SONGBOOK_CONTAINER_IMAGE:-songbook:smoke}
platform=${SONGBOOK_CONTAINER_PLATFORM:-linux/amd64}

if ! command -v docker >/dev/null 2>&1; then
  echo "container smoke: docker is required" >&2
  exit 2
fi

cd "$repo_dir"

echo "container smoke: validating Compose configuration"
docker compose -f compose.yaml config >/dev/null

echo "container smoke: building $image for $platform"
docker build --platform "$platform" --tag "$image" .

echo "container smoke: checking compiled server entrypoint as the image user"
docker run --rm --platform "$platform" --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --entrypoint node "$image" --check /app/apps/server/dist/index.js

echo "container smoke: image metadata"
docker image inspect --format 'architecture={{.Architecture}} os={{.Os}} size={{.Size}}' "$image"

if [ "${SONGBOOK_CONTAINER_RUN:-0}" = 1 ]; then
  echo "container smoke: starting Compose service and waiting for /healthz"
  cleanup() {
    docker compose -f compose.yaml down
  }
  trap cleanup EXIT INT TERM
  docker compose -f compose.yaml up -d --wait
  docker compose -f compose.yaml ps
  docker run --rm --network host curlimages/curl:8.12.1 \
    --fail --silent --show-error http://127.0.0.1:3000/healthz >/dev/null
else
  echo "container smoke: runtime start skipped (set SONGBOOK_CONTAINER_RUN=1 once /healthz is implemented)"
fi

cat <<'EOF'
container smoke: PASS for the declared local build/check.
ARM64/OCI gate: PENDING — run this on the native OCI ARM64 host after review:
  SONGBOOK_CONTAINER_PLATFORM=linux/arm64 scripts/ops/container-smoke.sh
EOF
