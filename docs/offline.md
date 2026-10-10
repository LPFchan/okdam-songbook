# Offline Behavior

- IndexedDB stores the latest public song snapshot.
- IndexedDB also keeps each performer filter's loaded 추천 list for a day, so
  it shows again without refetching.
- On startup, cached data is shown first.
- If online, the app refreshes from `GET /api/catalog` and updates the cache.
- First offline launch without cache shows a clear empty state.
- Performance records can be queued offline.
- Add/edit/import stay online-only in the initial implementation.
- Every queued write has `clientRequestId` for duplicate prevention.

