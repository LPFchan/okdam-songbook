# CSV Migration

Supported legacy headers include:

- `곡명` -> `title`
- `번호` -> `tjNumber`
- `아티스트` -> `artist`
- `원작` -> `originalWork`
- `장르` -> `country` (legacy exports stored country buckets in this column)
- `추천인` -> `performerIds`
- `키` -> `keyCandidates`

Ambiguous key values such as `-1?-2?` are not silently converted. The parser preserves the original value and emits a warning.

Legacy performer aliases:

- `마리` -> `["marie"]`
- `성욱` -> `["seongwook"]`
- `여울` -> `["yeowool"]`
- `뽀냐` -> `["marie", "yeowool"]`

`seonguk` and `yeoul` are treated as legacy misspellings and migrate to
`seongwook` and `yeowool`. `ponya` is accepted only as an import alias and is
never stored as a user ID.

CSV import should run as dry-run first, then commit selected rows as one batch with a `clientRequestId`.
