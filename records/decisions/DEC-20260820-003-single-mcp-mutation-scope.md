# DEC-20260820-003: Use One MCP Mutation Scope

Opened: 2026-08-20 20-14-50 KST
Recorded by agent: codex-orchestrator

## Metadata

- Status: accepted
- Deciders: operator, orchestrator
- Supersedes: the deletion-scope portion of DEC-20260820-002
- Related ids: DEC-20260813-001, DEC-20260820-002

## Decision

Use `songbook:write` for every authenticated MCP mutation, including permanent
song deletion. MCP advertises only `songbook:read` and `songbook:write`.

## Context

The product has one allowlisted authenticated role. Every admitted user can
create, update, and delete songs through the browser, so a separate MCP
deletion tier would not represent an actual product permission boundary.

## Options Considered

### Separate deletion scope

- Upside: clients can omit destructive access
- Downside: creates a permission tier that the product does not have

### One mutation scope

- Upside: matches the browser and domain authorization model
- Upside: keeps OAuth consent and tool policy simple
- Downside: a write-authorized MCP client can also delete songs

## Rationale

OAuth scopes should represent real product permissions. One write scope keeps
MCP consistent with the existing trusted-group model.

## Consequences

- `delete_song` requires `songbook:write`.
- OAuth discovery advertises and accepts only `songbook:read` and
  `songbook:write`.
- Clients that mutate songs request `songbook:write` once.
