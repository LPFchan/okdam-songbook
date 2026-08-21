# DEC-20260822-001: Translate The Retired MCP Admin Scope To Write

Opened: 2026-08-22 03-06-47 KST
Recorded by agent: exroot

## Metadata

- Status: accepted
- Deciders: operator, orchestrator
- Amends: the OAuth compatibility consequence of DEC-20260820-003
- Related ids: DEC-20260820-002, DEC-20260820-003

## Decision

Keep the OAuth provider and authorization model limited to `songbook:read` and
`songbook:write`. At the authorization-request boundary, translate the retired
`songbook:admin` name from older ChatGPT connections to `songbook:write` and
deduplicate the result before provider validation.

## Context

ChatGPT retained `songbook:admin` from Okdam's earlier three-scope contract and
sent it together with the current read and write scopes. Better Auth rejected
the whole authorization request as `invalid_scope`, leaving ChatGPT's linking
dialog spinning after the callback.

## Options Considered

### Require Users To Remove And Recreate Existing Connections

- Upside: no compatibility handling in Okdam
- Downside: every stale client fails before it can refresh its connection

### Accept Admin As A Third Provider Scope

- Upside: old requests pass unchanged
- Downside: makes the provider appear three-tiered even when enforcement is not

### Translate Admin To Write At The Request Boundary

- Upside: old connections can finish OAuth
- Upside: provider configuration, issued tokens, and enforcement stay two-tiered
- Downside: the request boundary keeps one retired input mapping

## Rationale

The old admin scope represented deletion, which the current product includes
in write access. Translating that old name to the current permission preserves
the two-tier model at every authoritative layer.

## Consequences

- Older authorization requests no longer fail because they contain
  `songbook:admin`.
- The provider accepts and issues only `songbook:read` and `songbook:write`.
- Discovery and tool policy remain read/write-only.
- The compatibility mapping grants no permission beyond `songbook:write`.
