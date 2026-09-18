# DEC-20260918-001: Keep the Workers Runtime Behind the Cloud Gateway

Opened: 2026-09-18 12-34-11 KST
Recorded by agent: claude

## Metadata

- Status: accepted
- Deciders: operator, orchestrator
- Extends: DEC-20260914-002 to the Cloudflare Workers runtime
- Related ids: DEC-20260914-001

## Decision

The Workers runtime keeps the gateway trust model rather than replacing it.
Songbook does not gain its own token validation. A forthcoming V8/Node Common
Auth gateway runs on Workers for cloud services and locally for local ones;
cloud services reach it as gateway plus hub. Songbook continues to trust only
percent-encoded `X-Lost-Plus-*` identity headers and to own its own
authorization, exactly as it does on OCI.

The Songbook Worker therefore carries no public route: `workers_dev = false`
and no `[[routes]]` entry, leaving a service binding from the gateway Worker as
the only path in. The okdam.lost.plus cutover is blocked until that gateway
exists and the binding is in place.

## Context

DEC-20260914-002 accepted one named downside: the backend port must remain
private, because Songbook cannot distinguish a gateway-issued identity header
from a forged one. On OCI that is satisfied by binding the Node port to
loopback behind the gateway.

A Worker has no loopback. Deployed with a route, it is the edge, and the four
headers it trusts would arrive straight from the internet. A probe against live
OCI production confirmed where the protection actually lives: forged
`X-Lost-Plus-*` headers on `/api/me` return 401 because the gateway strips them
before the application is reached, not because the application rejects them.

## Options Considered

### Verify Signed Tokens Inside Songbook

- Upside: removes the deployment-shape dependency from the trust model
- Upside: the same code would be safe on any runtime
- Downside: reintroduces the per-service credential validation that
  DEC-20260914-002 deliberately centralized
- Downside: two validators can disagree about failure semantics

### Front the Worker With Cloudflare Access

- Upside: no Songbook change
- Downside: a second identity system beside Common Auth
- Downside: diverges from the local gateway path

### Keep the Gateway and Give the Worker No Public Route

- Upside: one credential validator across OCI, cloud, and local
- Upside: the trust boundary stays where DEC-20260914-002 put it
- Downside: the cutover waits on the new gateway
- Downside: the guarantee is a deployment property, so it has to be asserted
  in config rather than enforced by the code

## Rationale

The gateway is staying. Rebuilding validation inside Songbook to unblock a
migration would undo the centralization that DEC-20260914-002 chose, and would
leave two implementations of the security-sensitive path.

## Consequences

- `apps/worker/wrangler.toml` sets `workers_dev = false` and declares no
  routes. Adding either without a gateway in front is an authentication bypass.
- Cloudflare ingress for okdam.lost.plus stays on the OCI gateway until the
  cloud gateway and its service binding exist.
- D1 database `okdam-songbook` (APAC, `9b353a3b`) is provisioned and carries the
  schema. It holds no data; the import waits for the cutover.
- The D1 database id is committed to this public repo with operator sign-off.
  It identifies infrastructure but grants nothing without account credentials.
