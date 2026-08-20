import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildTjSearchUrl, type TjSearchResult } from "@songbook/shared";
import {
  createTjAdapter,
  createTjSearchMirror,
  openDatabase,
  runMigrations,
  type SongbookDatabase,
  type TjSearchMirror
} from "../src/index.js";

const html = (number: string, title: string) => `<ul class="grid-container list"><li class="grid-item center"><span class="num2">${number}</span></li><li class="grid-item title3"><p>${title}</p></li><li class="grid-item title4 singer"><p>Artist</p></li><li class="grid-item title5"><p>Lyricist</p></li><li class="grid-item title6"><p>Composer</p></li></ul></li>`;
const emptyHtml = Array.from({ length: 6 }, () => `<section class="music-search-list"><div class="no-result"><p>검색 결과를 찾을 수 없습니다.</p></div></section>`).join("");

function result(sourceUrl: string, query = "hello", number = "10001"): TjSearchResult {
  return { query, searchType: "all", nation: "", page: 1, pageSize: 15, hasMore: false, sourceUrl, candidates: [{ tjNumber: number, title: "Title", artist: "Artist", lyricist: "Lyricist", composer: "Composer", sourceUrl }] };
}

function staleSnapshot(sourceUrl: string, overrides: Partial<ReturnType<typeof result>["candidates"][number]> = {}) {
  const snapshot = result(sourceUrl);
  snapshot.candidates[0] = { ...snapshot.candidates[0]!, ...overrides };
  return { result: snapshot, checkedAt: "2026-08-19T00:00:00.000Z", lastAttemptedAt: "2026-08-19T00:00:00.000Z", lastErrorCode: null, consecutiveFailures: 0 };
}

describe("TJ SQLite mirror", () => {
  let database: SongbookDatabase | undefined;
  afterEach(() => database?.close());

  it("creates all mirror tables with repeatable migrations and the required foreign keys", () => {
    database = openDatabase();
    expect(runMigrations(database.sqlite)).toEqual([]);
    const tables = (database.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'tj_mirror_%'").all() as Array<{ name: string }>).map((row) => row.name);
    expect(tables).toEqual(expect.arrayContaining(["tj_mirror_songs", "tj_mirror_queries", "tj_mirror_query_results"]));
    expect(database.sqlite.prepare("PRAGMA foreign_key_list('tj_mirror_query_results')").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ table: "tj_mirror_queries", on_delete: "CASCADE" }),
      expect.objectContaining({ table: "tj_mirror_songs", on_delete: "RESTRICT" })
    ]));
  });

  it("normalizes snapshots, preserves first_seen_at, replaces membership order, and retains absent songs", () => {
    database = openDatabase();
    const mirror = createTjSearchMirror(database.sqlite);
    const source = "https://www.tjmedia.com/song/accompaniment_search?one";
    mirror.replace(result(source, "hello", "10001"), "2026-08-20T00:00:00.000Z", "2026-08-20T00:00:00.000Z");
    const changed = result(source, "hello", "10001");
    changed.candidates[0] = { ...changed.candidates[0]!, title: "Updated", artist: "Updated Artist" };
    const second = result(source, "hello", "10002");
    mirror.replace({ ...second, candidates: [second.candidates[0]!, changed.candidates[0]!] }, "2026-08-21T00:00:00.000Z", "2026-08-21T00:00:00.000Z");
    const snapshot = mirror.get(source);
    expect(snapshot?.result.candidates.map((candidate) => candidate.tjNumber)).toEqual(["10002", "10001"]);
    expect(snapshot?.result.candidates[1]).toMatchObject({ title: "Updated", artist: "Updated Artist" });
    expect(database.sqlite.prepare("SELECT tj_number,title,artist,first_seen_at,last_seen_at FROM tj_mirror_songs ORDER BY tj_number").all()).toEqual([
      { tj_number: "10001", title: "Updated", artist: "Updated Artist", first_seen_at: "2026-08-20T00:00:00.000Z", last_seen_at: "2026-08-21T00:00:00.000Z" },
      { tj_number: "10002", title: "Title", artist: "Artist", first_seen_at: "2026-08-21T00:00:00.000Z", last_seen_at: "2026-08-21T00:00:00.000Z" }
    ]);
    mirror.recordFailure(source, "2026-08-22T00:00:00.000Z", "TJ_UPSTREAM_ERROR");
    expect(mirror.get(source)).toMatchObject({ lastErrorCode: "TJ_UPSTREAM_ERROR", consecutiveFailures: 1 });
    mirror.replace(result(source), "2026-08-23T00:00:00.000Z", "2026-08-23T00:00:00.000Z");
    expect(mirror.get(source)).toMatchObject({ lastErrorCode: null, consecutiveFailures: 0 });
    expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM tj_mirror_songs").get()).toEqual({ count: 2 });
  });

  it("reconstructs candidate provenance from the serving query", () => {
    database = openDatabase();
    const mirror = createTjSearchMirror(database.sqlite);
    const first = "https://www.tjmedia.com/song/accompaniment_search?first";
    const second = "https://www.tjmedia.com/song/accompaniment_search?second";
    mirror.replace(result(first), "2026-08-20T00:00:00.000Z", "2026-08-20T00:00:00.000Z");
    mirror.replace(result(second), "2026-08-20T00:00:00.000Z", "2026-08-20T00:00:00.000Z");
    expect(mirror.get(first)?.result.candidates[0]?.sourceUrl).toBe(first);
    expect(mirror.get(second)?.result.candidates[0]?.sourceUrl).toBe(second);
  });

  it("treats malformed timestamps as stale and persists across reopen", async () => {
    const directory = mkdtempSync(join(tmpdir(), "songbook-tj-mirror-"));
    const filename = join(directory, "songbook.sqlite");
    let fileDatabase: SongbookDatabase | undefined;
    try {
      fileDatabase = openDatabase({ filename });
      const mirror = createTjSearchMirror(fileDatabase.sqlite);
      const source = buildTjSearchUrl({ query: "persist", searchType: "all", nation: "", page: 1, pageSize: 15 });
      mirror.replace(result(source), "2026-08-20T00:00:00.000Z", "2026-08-20T00:00:00.000Z");
      fileDatabase.sqlite.prepare("UPDATE tj_mirror_queries SET checked_at='not-a-date'").run();
      expect(mirror.get(source)?.checkedAt).toBeNull();
      fileDatabase.close();
      fileDatabase = undefined;
      fileDatabase = openDatabase({ filename });
      const reopenedMirror = createTjSearchMirror(fileDatabase.sqlite);
      expect(reopenedMirror.get(source)?.result.candidates[0]?.tjNumber).toBe("10001");
      const fetcher = vi.fn(async () => ({ status: 200, text: async () => html("10002", "Revalidated") }));
      const adapter = createTjAdapter({ mirror: reopenedMirror, now: () => Date.parse("2026-08-21T00:00:00.000Z"), fetcher });
      expect((await adapter.search({ query: "persist", searchType: "all", nation: "", page: 1, pageSize: 15 })).candidates[0]?.tjNumber).toBe("10002");
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      fileDatabase?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("treats malformed reconstructed rows as misses", () => {
    database = openDatabase();
    const mirror = createTjSearchMirror(database.sqlite);
    const source = "https://www.tjmedia.com/song/accompaniment_search?malformed";
    mirror.replace(result(source), "2026-08-20T00:00:00.000Z", "2026-08-20T00:00:00.000Z");
    database.sqlite.prepare("UPDATE tj_mirror_songs SET title='' WHERE tj_number='10001'").run();
    expect(mirror.get(source)).toBeNull();
  });
});

describe("TJ mirror adapter", () => {
  const input = { query: "hello", searchType: "all" as const, nation: "" as const, page: 1, pageSize: 15 };

  it("survives a new adapter instance, refreshes successfully at 24 hours, and preserves caller spelling", async () => {
    const database = openDatabase();
    const mirror = createTjSearchMirror(database.sqlite);
    let current = Date.parse("2026-08-20T00:00:00.000Z");
    const firstFetcher = vi.fn(async () => ({ status: 200, text: async () => html("10002", "Initial") }));
    const first = createTjAdapter({ mirror, now: () => current, fetcher: firstFetcher });
    await first.search({ ...input, query: " hello " });
    const secondFetcher = vi.fn(async () => ({ status: 500, text: async () => "" }));
    const second = createTjAdapter({ mirror, now: () => current, fetcher: secondFetcher });
    expect((await second.search(input)).candidates[0]?.tjNumber).toBe("10002");
    expect(secondFetcher).not.toHaveBeenCalled();
    current += 24 * 60 * 60 * 1_000;
    secondFetcher.mockImplementation(async () => ({ status: 200, text: async () => html("10003", "Refreshed") }));
    const refreshed = await second.search({ ...input, query: " hello " });
    expect(refreshed.candidates[0]?.tjNumber).toBe("10003");
    expect(refreshed.query).toBe(" hello ");
    expect(secondFetcher).toHaveBeenCalledTimes(1);
    database.close();
  });

  it("serves stale data on refresh errors and records one failure for coalesced callers", async () => {
    const source = buildTjSearchUrl(input);
    const mirror: TjSearchMirror = {
      get: vi.fn(() => ({ result: result(source), checkedAt: "2026-08-19T00:00:00.000Z", lastAttemptedAt: null, lastErrorCode: null, consecutiveFailures: 0 })),
      replace: vi.fn(),
      recordFailure: vi.fn(() => 1)
    };
    const warnings: unknown[] = [];
    const adapter = createTjAdapter({ mirror, now: () => Date.parse("2026-08-20T00:00:00.000Z"), fetcher: async () => ({ status: 503, text: async () => "" }), onWarn: (warning) => warnings.push(warning) });
    const [one, two] = await Promise.all([adapter.search(input), adapter.search({ ...input, query: " hello " })]);
    expect(one.candidates[0]?.tjNumber).toBe("10001");
    expect(two.query).toBe(" hello ");
    expect(mirror.recordFailure).toHaveBeenCalledTimes(1);
    expect(warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "refresh_failed", errorCode: "TJ_UPSTREAM_ERROR" })]));
  });

  it("coalesces first-ever failures without unhandled rejection and warns once", async () => {
    let calls = 0;
    const warnings: unknown[] = [];
    const adapter = createTjAdapter({ fetcher: async () => { calls += 1; throw new Error("offline"); }, onWarn: (warning) => warnings.push(warning) });
    const outcomes = await Promise.allSettled([adapter.search(input), adapter.search(input), adapter.search(input)]);
    expect(outcomes.every((outcome) => outcome.status === "rejected")).toBe(true);
    expect(calls).toBe(1);
    expect(warnings.filter((warning) => (warning as { code?: string }).code === "refresh_failed")).toHaveLength(1);
  });

  it("serves stale snapshots for parser drift and body limits while changing only failure metadata", async () => {
    const source = buildTjSearchUrl(input);
    const database = openDatabase();
    const mirror = createTjSearchMirror(database.sqlite);
    mirror.replace(result(source), "2026-08-19T00:00:00.000Z", "2026-08-19T00:00:00.000Z");
    const parserAdapter = createTjAdapter({ mirror, now: () => Date.parse("2026-08-20T00:00:00.000Z"), fetcher: async () => ({ status: 200, text: async () => "<div>drift</div>" }) });
    expect((await parserAdapter.search(input)).candidates[0]?.tjNumber).toBe("10001");
    expect(database.sqlite.prepare("SELECT checked_at,last_error_code,consecutive_failures FROM tj_mirror_queries WHERE query_key=?").get(source)).toEqual({ checked_at: "2026-08-19T00:00:00.000Z", last_error_code: "TJ_PARSER_ERROR", consecutive_failures: 1 });
    const bodyAdapter = createTjAdapter({ mirror, now: () => Date.parse("2026-08-21T00:00:00.000Z"), maxBodyBytes: 2, fetcher: async () => ({ status: 200, text: async () => "large" }) });
    expect((await bodyAdapter.search(input)).candidates[0]?.tjNumber).toBe("10001");
    expect(database.sqlite.prepare("SELECT checked_at,last_error_code,consecutive_failures FROM tj_mirror_queries WHERE query_key=?").get(source)).toEqual({ checked_at: "2026-08-19T00:00:00.000Z", last_error_code: "TJ_BODY_TOO_LARGE", consecutive_failures: 2 });
    database.close();
  });

  it("serves stale data when failure bookkeeping throws and warns on a first-ever failure", async () => {
    const source = buildTjSearchUrl(input);
    const warnings: unknown[] = [];
    const staleMirror: TjSearchMirror = { get: vi.fn(() => staleSnapshot(source)), replace: vi.fn(), recordFailure: vi.fn(() => { throw new Error("telemetry down"); }) };
    const staleAdapter = createTjAdapter({ mirror: staleMirror, now: () => Date.parse("2026-08-20T00:00:00.000Z"), fetcher: async () => ({ status: 503, text: async () => "" }), onWarn: (warning) => warnings.push(warning) });
    expect((await staleAdapter.search(input)).candidates[0]?.tjNumber).toBe("10001");
    expect(warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "mirror_failure_record_failed" }), expect.objectContaining({ code: "refresh_failed" })]));
    const firstWarnings: unknown[] = [];
    const firstAdapter = createTjAdapter({ fetcher: async () => ({ status: 503, text: async () => "" }), onWarn: (warning) => firstWarnings.push(warning) });
    await expect(firstAdapter.search(input)).rejects.toMatchObject({ code: "TJ_UPSTREAM_ERROR" });
    expect(firstWarnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "refresh_failed", errorCode: "TJ_UPSTREAM_ERROR" })]));
    const durableWarnings: unknown[] = [];
    const durableMirror: TjSearchMirror = { get: vi.fn(() => ({ ...staleSnapshot(source), consecutiveFailures: 7 })), replace: vi.fn(), recordFailure: vi.fn(() => 8) };
    const durableAdapter = createTjAdapter({ mirror: durableMirror, now: () => Date.parse("2026-08-20T00:00:00.000Z"), fetcher: async () => ({ status: 503, text: async () => "" }), onWarn: (warning) => durableWarnings.push(warning) });
    expect((await durableAdapter.search(input)).candidates[0]?.tjNumber).toBe("10001");
    expect(durableWarnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "refresh_failed", consecutiveFailures: 8 })]));
  });

  it("handles mirror read/write failures without changing upstream result semantics", async () => {
    const warnings: unknown[] = [];
    const readFailMirror: TjSearchMirror = { get: vi.fn(() => { throw new Error("read down"); }), replace: vi.fn(), recordFailure: vi.fn(() => null) };
    const readAdapter = createTjAdapter({ mirror: readFailMirror, fetcher: async () => ({ status: 200, text: async () => html("10002", "Fetched") }), onWarn: (warning) => warnings.push(warning) });
    expect((await readAdapter.search(input)).candidates[0]?.tjNumber).toBe("10002");
    const writeFailMirror: TjSearchMirror = { get: vi.fn(() => null), replace: vi.fn(() => { throw new Error("write down"); }), recordFailure: vi.fn(() => null) };
    const writeAdapter = createTjAdapter({ mirror: writeFailMirror, fetcher: async () => ({ status: 200, text: async () => html("10003", "Fetched") }), onWarn: (warning) => warnings.push(warning) });
    expect((await writeAdapter.search(input)).candidates[0]?.tjNumber).toBe("10003");
    expect(warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "mirror_read_failed" }), expect.objectContaining({ code: "mirror_write_failed" })]));
  });

  it("bypasses throttle/circuit accounting on a fresh mirror hit and caches confirmed empty results", async () => {
    const source = buildTjSearchUrl(input);
    const fresh: TjSearchMirror = { get: vi.fn(() => staleSnapshot(source)), replace: vi.fn(), recordFailure: vi.fn(() => null) };
    const fetcher = vi.fn(async () => ({ status: 503, text: async () => "" }));
    const hit = createTjAdapter({ mirror: fresh, freshnessMs: 24 * 60 * 60 * 1_000, now: () => Date.parse("2026-08-19T12:00:00.000Z"), throttleLimit: 0, fetcher });
    expect((await hit.search(input)).candidates[0]?.tjNumber).toBe("10001");
    expect(fetcher).not.toHaveBeenCalled();
    const database = openDatabase();
    const mirror = createTjSearchMirror(database.sqlite);
    const emptyAdapter = createTjAdapter({ mirror, now: () => Date.parse("2026-08-20T00:00:00.000Z"), fetcher: vi.fn(async () => ({ status: 200, text: async () => emptyHtml })) });
    expect((await emptyAdapter.search({ ...input, query: "nothing" })).candidates).toEqual([]);
    const emptyFetcher = vi.fn(async () => ({ status: 503, text: async () => "" }));
    const emptyHit = createTjAdapter({ mirror, now: () => Date.parse("2026-08-20T01:00:00.000Z"), fetcher: emptyFetcher });
    expect((await emptyHit.search({ ...input, query: "nothing" })).candidates).toEqual([]);
    expect(emptyFetcher).not.toHaveBeenCalled();
    database.close();
  });

  it("keeps independent query/page keys and coalesces concurrent success to one fetch", async () => {
    const database = openDatabase();
    const mirror = createTjSearchMirror(database.sqlite);
    const fetcher = vi.fn(async (url: string) => ({ status: 200, text: async () => html(url.includes("pageNo=2") ? "10002" : "10001", url.includes("pageNo=2") ? "Page 2" : "Page 1") }));
    const adapter = createTjAdapter({ mirror, fetcher });
    const pageOne = await adapter.search(input);
    const pageTwo = await adapter.search({ ...input, page: 2 });
    expect(pageOne.candidates[0]?.tjNumber).toBe("10001");
    expect(pageTwo.candidates[0]?.tjNumber).toBe("10002");
    expect(fetcher).toHaveBeenCalledTimes(2);
    let release!: (response: { status: number; text: () => Promise<string> }) => void;
    const deferred = new Promise<{ status: number; text: () => Promise<string> }>((resolve) => { release = resolve; });
    const coalescedFetcher = vi.fn(() => deferred);
    const coalesced = createTjAdapter({ fetcher: coalescedFetcher });
    const one = coalesced.search({ ...input, query: "coalesce" });
    const two = coalesced.search({ ...input, query: " coalesce " });
    await Promise.resolve();
    expect(coalescedFetcher).toHaveBeenCalledTimes(1);
    release({ status: 200, text: async () => html("10004", "Coalesced") });
    const [first, second] = await Promise.all([one, two]);
    expect(first.candidates[0]?.tjNumber).toBe("10004");
    expect(second.query).toBe(" coalesce ");
    database.close();
  });

  it("announces circuit open/recovery and refresh recovery", async () => {
    let current = Date.parse("2026-08-20T00:00:00.000Z");
    const warnings: unknown[] = [];
    let successful = false;
    const adapter = createTjAdapter({ circuitFailureThreshold: 1, circuitOpenMs: 1_000, now: () => current, fetcher: async () => {
      if (!successful) return { status: 503, text: async () => "" };
      return { status: 200, text: async () => html("10005", "Recovered") };
    }, onWarn: (warning) => warnings.push(warning) });
    await expect(adapter.search({ ...input, query: "open-one" })).rejects.toMatchObject({ code: "TJ_UPSTREAM_ERROR" });
    await expect(adapter.search({ ...input, query: "open-two" })).rejects.toMatchObject({ code: "TJ_CIRCUIT_OPEN" });
    current += 1_001;
    successful = true;
    expect((await adapter.search({ ...input, query: "open-three" })).candidates[0]?.tjNumber).toBe("10005");
    expect(warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "circuit_opened" }), expect.objectContaining({ code: "circuit_recovered" })]));
    const source = buildTjSearchUrl(input);
    const database = openDatabase();
    const mirror = createTjSearchMirror(database.sqlite);
    mirror.replace(result(source), "2026-08-19T00:00:00.000Z", "2026-08-19T00:00:00.000Z");
    mirror.recordFailure(source, "2026-08-19T01:00:00.000Z", "TJ_UPSTREAM_ERROR");
    const recoveryWarnings: unknown[] = [];
    const recovery = createTjAdapter({ mirror, now: () => Date.parse("2026-08-20T00:00:00.000Z"), fetcher: async () => ({ status: 200, text: async () => html("10006", "Refresh") }), onWarn: (warning) => recoveryWarnings.push(warning) });
    expect((await recovery.search(input)).candidates[0]?.tjNumber).toBe("10006");
    expect(mirror.get(source)).toMatchObject({ lastErrorCode: null, consecutiveFailures: 0 });
    expect(recoveryWarnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "refresh_recovered" })]));
    database.close();
  });
});
