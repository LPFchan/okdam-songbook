#!/bin/sh
set -eu

# Build-focused local smoke for OCI container packaging. It never installs
# binfmt/QEMU and never pushes or deploys an image.

repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
image=${SONGBOOK_CONTAINER_IMAGE:-songbook:smoke}
platform=${SONGBOOK_CONTAINER_PLATFORM:-linux/amd64}
project=${SONGBOOK_COMPOSE_PROJECT:-songbook-container-smoke}
if [ -n "${SONGBOOK_SMOKE_DATA_DIR+x}" ]; then
  data_dir=$SONGBOOK_SMOKE_DATA_DIR
  cleanup_data=0
else
  data_dir=$(mktemp -d "${TMPDIR:-/tmp}/songbook-container-data.XXXXXX")
  cleanup_data=1
fi
if [ -n "${SONGBOOK_SMOKE_ENV_FILE+x}" ]; then
  env_file=$SONGBOOK_SMOKE_ENV_FILE
  cleanup_env=0
else
  env_file=$(mktemp "${TMPDIR:-/tmp}/songbook-container-env.XXXXXX")
  cleanup_env=1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "container smoke: docker is required" >&2
  exit 2
fi

cd "$repo_dir"

cleanup() {
  if [ "${cleanup_compose:-0}" = 1 ]; then
    docker compose -p "$project" -f compose.yaml down --volumes >/dev/null 2>&1 || true
  fi
  if [ "$cleanup_data" = 1 ]; then rm -rf "$data_dir"; fi
  if [ "$cleanup_env" = 1 ]; then rm -f "$env_file"; fi
}
trap cleanup EXIT INT TERM

mkdir -p "$data_dir"
mkdir -p "$data_dir/backups"
chmod 700 "$data_dir"
cat >"$env_file" <<'EOF'
ORIGIN=http://127.0.0.1:3000
ALLOWED_USERS_JSON=["allowed@example.invalid"]
BETTER_AUTH_SECRET=container-smoke-secret-012345678901234567890123
EOF
chmod 600 "$env_file"

echo "container smoke: validating Compose configuration"
docker compose -f compose.yaml config >/dev/null

echo "container smoke: building $image for $platform"
docker build --platform "$platform" --tag "$image" .

echo "container smoke: checking compiled server entrypoint as the image user"
docker run --rm --platform "$platform" --read-only --tmpfs /tmp:rw,noexec,nosuid,size=64m \
  --entrypoint node "$image" --check /app/apps/server/dist/main.js

echo "container smoke: image metadata"
docker image inspect --format 'architecture={{.Architecture}} os={{.Os}} size={{.Size}}' "$image"

if [ "${SONGBOOK_CONTAINER_RUN:-0}" = 1 ]; then
  echo "container smoke: starting Compose service and waiting for /healthz"
  cleanup_compose=1
  SONGBOOK_DATA_DIR="$data_dir" \
    SONGBOOK_BACKUP_DIR="$data_dir/backups" \
  SONGBOOK_ENV_FILE="$env_file" \
    SONGBOOK_CONTAINER_IMAGE="$image" \
    docker compose -p "$project" -f compose.yaml up -d --wait
  SONGBOOK_DATA_DIR="$data_dir" \
    SONGBOOK_BACKUP_DIR="$data_dir/backups" \
    SONGBOOK_ENV_FILE="$env_file" \
    docker compose -p "$project" -f compose.yaml ps
  SONGBOOK_DATA_DIR="$data_dir" \
    SONGBOOK_BACKUP_DIR="$data_dir/backups" \
    SONGBOOK_ENV_FILE="$env_file" \
    docker compose -p "$project" -f compose.yaml exec -T songbook \
      node -e "fetch('http://127.0.0.1:3000/healthz').then(async (r) => { if (!r.ok || !(await r.json()).ok) process.exit(1); }) .catch(() => process.exit(1))"
  echo "container smoke: /healthz passed"
else
  echo "container smoke: runtime start skipped (set SONGBOOK_CONTAINER_RUN=1 to run the temporary-data check)"
fi

cat <<'EOF'
container smoke: PASS for the declared local build/check.
ARM64/OCI gate: PENDING — run this on the native OCI ARM64 host after review:
  SONGBOOK_CONTAINER_PLATFORM=linux/arm64 scripts/ops/container-smoke.sh
EOF
