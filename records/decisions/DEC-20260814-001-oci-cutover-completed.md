# DEC-20260814-001: OCI Cutover Completed and Legacy Stack Retired

Opened: 2026-08-14 15-05-00 KST
Recorded by agent: codex-k3

## Metadata

- Status: accepted
- Deciders: operator
- Supersedes: none (fulfills DEC-20260813-005)
- Related ids: DEC-20260813-005, RSH-20260813-004

## Decision

The OCI single server is the production path for Songbook. The application
serves https://okdam.lost.plus through the existing Cloudflare Tunnel from a
Docker container on oci-ubuntu, with scheduled integrity-checked backups.
The GitHub Pages / Apps Script / Cloudflare Worker topology is retired; its
source remains in the repository for the observation window but no longer
receives traffic or deploys.

## Context

DEC-20260813-005 accepted the OCI single-server architecture with an
operator-gated cutover and a 30-day observation window. The cutover was
performed on 2026-08-13 and validated on 2026-08-14: the ARM64 image builds
and runs healthy on the host, the tunnel hostname serves `/healthz`, the
production SQLite database is populated and serving, and the backup timer
plus a restore drill are in place. Repository records written before the
cutover still described the integrated source as pre-production; this
decision records the completed state so STATUS, PLANS, and deployment docs
can describe reality.

## Options Considered

### Keep Records As Pre-Production Until Every Smoke Item Is Checked

- Upside: conservative; no claim without full evidence.
- Downside: records already contradicted the observable production state,
  which misleads every future agent session about where the app runs.

### Record The Completed Cutover Now

- Upside: records match the running system; deploy procedure is documented
  where agents actually look.
- Downside: a few verification items (full external MCP client matrix,
  systematic offline/multi-tab smoke) remain open and are tracked as such.

## Rationale

Truth documents must describe what is true now. The app is live and serving
real use; recording that does not preclude finishing the remaining
verification matrix, which stays listed in `records/PLANS.md`.

## Consequences

- `records/STATUS.md` and `docs/deployment.md` describe the OCI deployment
  and its update procedure as the current production path.
- Legacy Pages/Apps Script/Worker removal remains a separate future decision
  after the observation window; nothing legacy was deleted by this decision.
