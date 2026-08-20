import { describe, expect, it, vi } from "vitest";
import type { SongbookService, TjAdapter } from "../src/index.js";
import { combinedSongSearch, TjAdapterError } from "../src/index.js";

const song = { id: "song-1", tjNumber: "123", title: "Song", artist: "Artist" } as never;

function service(): SongbookService {
  return {
    search: vi.fn(() => [song]),
    checkDuplicate: vi.fn(() => song),
    catalog: vi.fn(() => [song]),
    getSong: vi.fn(() => song),
    createSong: vi.fn(), createSongOutcome: vi.fn(), createTjSong: vi.fn(), updateSong: vi.fn(), deleteSong: vi.fn(),
    createPerformance: vi.fn(), cancelPerformance: vi.fn(), performanceStats: vi.fn()
  } as unknown as SongbookService;
}

function tjResult(query: string, searchType: "all" | "number", candidates: Awaited<ReturnType<TjAdapter["search"]>>["candidates"] = []): Awaited<ReturnType<TjAdapter["search"]>> {
  return { query, searchType, nation: "", page: 1, pageSize: 15, hasMore: false, candidates, sourceUrl: "https://tj.example/search" };
}

function adapter(error?: unknown): TjAdapter {
  const search = error
    ? vi.fn(async () => { throw error; })
    : vi.fn(async () => tjResult("Song", "all"));
  return { search: search as TjAdapter["search"], lookup: vi.fn() };
}

describe("combined Songbook search", () => {
  it("always returns local results and never calls TJ anonymously", async () => {
    const tj = adapter();
    const result = await combinedSongSearch({ service: service(), tj, query: "Song", limit: 25, includeTj: true, authenticated: false });
    expect(result).toMatchObject({ saved: [song], tj: { state: "skipped_anonymous", candidates: [] } });
    expect(tj.search).not.toHaveBeenCalled();
  });

  it.each([
    ["disabled_by_input", { includeTj: false, authenticated: true, query: "Song" }],
    ["skipped_short_query", { includeTj: true, authenticated: true, query: "x" }],
    ["unavailable", { includeTj: true, authenticated: true, query: "Song", tj: undefined }]
  ] as const)("reports %s without throwing", async (state, input) => {
    const result = await combinedSongSearch({ service: service(), tj: state === "unavailable" ? undefined : adapter(), query: input.query, limit: 25, includeTj: input.includeTj, authenticated: input.authenticated });
    expect(result.tj.state).toBe(state);
    expect(result.saved).toEqual([song]);
  });

  it("maps throttling, circuit-open, and upstream failures to safe states", async () => {
    const throttled = await combinedSongSearch({ service: service(), tj: adapter(new TjAdapterError("TJ_RATE_LIMITED", "hidden", true)), query: "Song", limit: 25, includeTj: true, authenticated: true });
    expect(throttled.tj).toMatchObject({ state: "throttled", error: { code: "TJ_RATE_LIMITED", retryable: true } });
    const open = await combinedSongSearch({ service: service(), tj: adapter(new TjAdapterError("TJ_CIRCUIT_OPEN", "hidden", true)), query: "Song", limit: 25, includeTj: true, authenticated: true });
    expect(open.tj.state).toBe("circuit_open");
    const failed = await combinedSongSearch({ service: service(), tj: adapter(new Error("secret upstream detail")), query: "Song", limit: 25, includeTj: true, authenticated: true });
    expect(failed.tj).toMatchObject({ state: "failed", error: { code: "TJ_UPSTREAM_ERROR" } });
    expect(failed.tj.error).not.toHaveProperty("message");
  });

  it("uses number search for all-digit queries and marks authoritative duplicates", async () => {
    const tj: TjAdapter = { search: vi.fn(async () => tjResult("123", "number", [{ tjNumber: "123", title: "Song", artist: "Artist", lyricist: "", composer: "", sourceUrl: "https://tj.example/search" }])), lookup: vi.fn() };
    const result = await combinedSongSearch({ service: service(), tj, query: "123", limit: 25, includeTj: true, authenticated: true });
    expect(tj.search).toHaveBeenCalledWith(expect.objectContaining({ searchType: "number", query: "123" }));
    expect(result.tj.candidates[0]).toMatchObject({ exactNumberMatch: true, alreadySaved: true, savedSongId: "song-1" });
  });
});
