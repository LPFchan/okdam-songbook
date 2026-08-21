# Data Model

## Songs

`id`, `tjNumber`, `title`, `titleReadingKo`, `titleRomanized`, `titleAliasesJson`, `artist`, `artistReadingKo`, `artistAliasesJson`, `country`, `genresJson`, `originalWork`, `keyCandidatesJson`, `performerIdsJson`, `memo`, `status`, `youtubeUrl`, `youtubeVideoId`, `isOfficialTjVideo`, `sourceType`, `sourceReference`, `createdByEmail`, `createdByName`, `createdAt`, `updatedByEmail`, `updatedByName`, `updatedAt`, `deletedAt`, `deletedByEmail`, `version`.

`performerIdsJson` stores structured singer assignments as user IDs, not display names. Built-in IDs are `marie`, `seongwook`, and `yeowool`; legacy `뽀냐` input migrates to `["marie", "yeowool"]`.

`keyCandidatesJson` stores the recommended key as structured candidates
(`baseMode` `original|male|female|custom` plus a semitone `offset`). The web
form edits the primary candidate with a `[-] 0 [+]` stepper and `남`/`여`
mode toggles. Key text that used to live in `memo` was moved into this field
by `scripts/migrate-memo-keys.mjs`, which only moves whole segments that are
purely key notation and leaves the rest of the memo untouched.

Public statuses: `active`, `favorite`, `practicing`, `hold`.

Hidden from public list: `deletion_candidate`, `deleted`.

## Performances

`id`, `songId`, `performedAt`, `keySelectionJson`, `memo`, `createdByEmail`, `createdByName`, `createdAt`, `cancelledAt`, `cancelledByEmail`, `clientRequestId`, `version`.

## ChangeLog

`id`, `entityType`, `entityId`, `action`, `beforeJson`, `afterJson`, `actorEmail`, `actorName`, `actorRole`, `createdAt`, `clientRequestId`, `entityVersionBefore`, `entityVersionAfter`.

## TJ Mirror

The live Node server stores a search-driven local TJ index in three SQLite
tables:

- `tj_mirror_songs`: one normalized row per TJ number with title, artist,
  lyricist, composer, `first_seen_at`, and `last_seen_at`. Rows are retained
  indefinitely; a later partial result page never implies deletion.
- `tj_mirror_queries`: one row per exact canonical TJ search URL, including
  normalized query fields, page and page size, `has_more`, serving `source_url`,
  `checked_at`, `last_attempted_at`, and refresh failure metadata.
- `tj_mirror_query_results`: ordered query membership keyed by query URL and TJ
  number. Candidate source URLs are reconstructed from the serving query row,
  so a song seen by two searches keeps each query's provenance.

Pages 1–10 are independent query snapshots. Freshness lasts 24 hours and
stale refreshes are synchronous for the first caller; an older snapshot is
served when refresh fails. The mirror grows from user searches only and is
not crawled or scheduled.
