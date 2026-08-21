# DEC-20260821-001: Attribute Performances To The Signed-In Account

Opened: 2026-08-21 20-30-44 KST
Recorded by agent: codex-orchestrator

## Metadata

- Status: accepted
- Deciders: operator, orchestrator
- Related ids: none

## Decision

Treat the account that taps `오늘 불렀어요!` as the person who sang. Configure
the allowlist as an exact email-to-public-name map and use the mapped name for
session display, new performance records, and the latest-performance summary.

When people sing together, each person creates an individual performance from
their own account. The detail sheet shows the latest mapped public name,
timestamp, and shared total count. This summary remains publicly readable. It
never exposes an email address, and an unmapped historical creator falls back
to the existing timestamp-only text.

## Context

Performance rows already retain the authenticated creator email and a display
name, but the catalog only exposed the latest time and total count. Google
profile names were also accepted after allowlist admission, so they were not a
stable product identity.

## Options Considered

### Use The Signed-In Account

- Keeps the action one tap.
- Uses the identity already established by authentication.
- Makes joint singing two explicit personal records.

### Add A Singer Chooser

- Could record a different or multiple singers from one account.
- Adds interaction and permits one account to claim another person's record.

### Use Google Profile Names

- Requires no configured name map.
- Allows names to drift outside the songbook's chosen public identities.

## Rationale

The trusted group has one account per person, so the authenticated account is
the simplest reliable meaning of a performance. An exact configured name map
keeps admission fail-closed and gives historical rows a stable public name
without storing or publishing another singer field.

## Consequences

- `ALLOWED_USERS_JSON` is an object mapping exact email addresses to public
  display names.
- Existing performance rows resolve their current public name from the stored
  creator email.
- Unlisted accounts remain denied; there is no catch-all identity.
- The public catalog gains a latest-performer name but no email address.
- No database migration or singer-selection UI is required.
