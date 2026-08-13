# OCI container packaging

This directory describes the future OCI deployment. It does not install
Docker, change a Cloudflare Tunnel, publish DNS, or deploy the application.

The root `compose.yaml` builds the Node 22 application for the host platform,
keeps the HTTP port bound to `127.0.0.1:3000`, and expects the existing
`cloudflared` process on OCI to provide public ingress. The service stores its
database at `/var/lib/songbook/songbook.sqlite` and optional local backup
archives at `/var/backups/songbook` inside the container. Both paths are bind
mounted from the host so the container can be replaced without losing data.

## Prepare an OCI host

OCI is Ubuntu 24.04 ARM64. Install Docker using the host's approved setup
procedure, then create the persistent directories and give them to the image's
non-root user (`node` is UID/GID 1000 in the official Node image):

```sh
sudo install -d -o 1000 -g 1000 -m 0750 /var/lib/songbook /var/backups/songbook
install -m 0600 deploy/container/songbook.env.example deploy/container/songbook.env
```

Edit `songbook.env` only on the host. It is intentionally not a secret store;
protect the file and use the operator's normal credential-management process.
The server reads `DATABASE_PATH`, `ORIGIN`, `ALLOWED_USERS_JSON`,
`BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and
`ASSETS_ROOT`; Compose fixes the two path values for the container. The
example uses a reserved invalid hostname and placeholder account, not live
credentials.

Build and start from a checked-out release on OCI:

```sh
docker compose -f compose.yaml config
docker compose -f compose.yaml build --pull
docker compose -f compose.yaml up -d
docker compose -f compose.yaml ps
curl --fail http://127.0.0.1:3000/healthz
```

The ARM64 build and startup check above is a release gate. A successful local
amd64 build does not provide ARM64 evidence. Never install binfmt or use QEMU
as a substitute for this OCI gate.

For the small OCI root disk (about 9.1 GiB free), keep only the active image
and one rollback image, use the configured three 10 MiB log files, and inspect
space before upgrades:

```sh
df -h / /var/lib/songbook /var/backups/songbook
docker system df
docker image prune --filter 'until=168h'
```

Do not run `docker system prune --volumes` or remove the bind-mounted database
and backup directories. Verify a backup exists before removing an old image.

## Cloudflare Tunnel route

After the container passes its local and OCI gates, add a route in the existing
host-level `cloudflared` configuration, using the real hostname at cutover:

```yaml
ingress:
  - hostname: <songbook-hostname>
    service: http://127.0.0.1:3000
  # keep existing routes below this entry
```

Validate the tunnel configuration with the host's normal `cloudflared tunnel
ingress validate` command, then reload the existing tunnel under the operator's
cutover procedure. This repository change does not touch the live tunnel or
DNS. Preserve the old route until the operator authorizes the cutover and
observation window.

## Environment convention

Copy `songbook.env.example` to the untracked `songbook.env` on each host. The
Compose file loads it if present, and fixed non-secret runtime paths are set in
Compose. Do not commit the copied file, credentials, database files, or backup
archives. If the server later adds required variables, add their names and
validation rules to the example and deployment docs together.
