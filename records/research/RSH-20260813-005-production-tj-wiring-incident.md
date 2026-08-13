# RSH-20260813-005: Production TJ Wiring Incident

Opened: 2026-08-13 22-17-00 KST
Recorded by agent: codex-orchestrator

## Symptom

TJ search on `https://okdam.lost.plus` did not work after the OCI cutover.
The Hono search and lookup routes reported that the TJ connection was not
configured.

## Cause

The bounded TJ adapter and its parser were implemented and tested, but the
environment-started production server did not create the adapter or pass it to
`createConfiguredServer`. Test helpers that supplied their own adapter did not
exercise this composition root.

OCI could reach TJ Media successfully and current result markup still matched
the parser, ruling out an upstream outage or parser drift.

## Correction and Evidence

Commit `7fc8715` creates `createTjAdapter()` in `apps/server/src/main.ts` and
passes it into the unified application. A regression test checks the production
entrypoint wiring.

- Server tests: 19 passed.
- Server typecheck, lint, build, and start/health smoke passed.
- A native OCI ARM64 image `songbook:7fc8715-arm64` was built and replaced the
  prior healthy image only after build success.
- The replacement container reached healthy state on `127.0.0.1:3010`.
- The adapter inside the production image searched `사랑`, received 10 parsed
  candidates from `www.tjmedia.com`, and returned TJ number `646` first.

The prior `songbook:7f231e7-arm64` image remains available as a rollback image.
