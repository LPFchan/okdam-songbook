import type { SqlExecutor } from "./sql.js";
import { tjSearchResultSchema, type TjSearchResult } from "@songbook/shared";

export interface TjMirrorSnapshot {
  result: TjSearchResult;
  checkedAt: string | null;
  lastAttemptedAt: string | null;
  lastErrorCode: string | null;
  consecutiveFailures: number;
}

export interface TjSearchMirror {
  get(queryKey: string): Promise<TjMirrorSnapshot | null>;
  replace(result: TjSearchResult, checkedAt: string, attemptedAt: string): Promise<void>;
  recordFailure(queryKey: string, attemptedAt: string, code: string): Promise<number | null>;
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !value.trim()) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed);
}

function rawString(value: unknown): string {
  return typeof value === "string" ? value : String(value ?? "");
}

function cloneResult(result: TjSearchResult): TjSearchResult {
  return { ...result, candidates: result.candidates.map((candidate) => ({ ...candidate })) };
}

function parseSnapshot(resultRow: Record<string, unknown> | undefined, candidateRows: Array<Record<string, unknown>>): TjMirrorSnapshot | null {
  if (!resultRow) return null;
  const sourceUrl = rawString(resultRow.source_url);
  const candidates = candidateRows.map((row) => ({
    tjNumber: rawString(row.tj_number),
    title: rawString(row.title),
    artist: rawString(row.artist),
    lyricist: rawString(row.lyricist),
    composer: rawString(row.composer),
    sourceUrl
  }));
  const parsed = tjSearchResultSchema.safeParse({
    query: rawString(resultRow.query),
    searchType: rawString(resultRow.search_type),
    nation: rawString(resultRow.nation),
    page: Number(resultRow.page),
    pageSize: Number(resultRow.page_size),
    hasMore: Boolean(resultRow.has_more),
    candidates,
    sourceUrl
  });
  if (!parsed.success) return null;
  return {
    result: parsed.data,
    checkedAt: isIsoTimestamp(resultRow.checked_at) ? rawString(resultRow.checked_at) : null,
    lastAttemptedAt: isIsoTimestamp(resultRow.last_attempted_at) ? rawString(resultRow.last_attempted_at) : null,
    lastErrorCode: resultRow.last_error_code === null || resultRow.last_error_code === undefined ? null : rawString(resultRow.last_error_code),
    consecutiveFailures: Number.isSafeInteger(Number(resultRow.consecutive_failures)) && Number(resultRow.consecutive_failures) >= 0 ? Number(resultRow.consecutive_failures) : 0
  };
}

const UPSERT_SONG_SQL = "INSERT INTO tj_mirror_songs (tj_number,title,artist,lyricist,composer,first_seen_at,last_seen_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(tj_number) DO UPDATE SET title=excluded.title, artist=excluded.artist, lyricist=excluded.lyricist, composer=excluded.composer, last_seen_at=excluded.last_seen_at";
const UPSERT_QUERY_SQL = "INSERT INTO tj_mirror_queries (query_key,query,search_type,nation,page,page_size,has_more,source_url,checked_at,last_attempted_at,last_error_code,consecutive_failures) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,0) ON CONFLICT(query_key) DO UPDATE SET query=excluded.query, search_type=excluded.search_type, nation=excluded.nation, page=excluded.page, page_size=excluded.page_size, has_more=excluded.has_more, source_url=excluded.source_url, checked_at=excluded.checked_at, last_attempted_at=excluded.last_attempted_at, last_error_code=NULL, consecutive_failures=0";
const SELECT_MEMBERSHIP_SQL = "SELECT r.result_position, s.tj_number, s.title, s.artist, s.lyricist, s.composer FROM tj_mirror_query_results r LEFT JOIN tj_mirror_songs s ON s.tj_number=r.tj_number WHERE r.query_key=? ORDER BY r.result_position ASC";

export function createTjSearchMirror(sqlite: SqlExecutor): TjSearchMirror {
  return {
    get: async (queryKey) => {
      const query = await sqlite.prepare("SELECT * FROM tj_mirror_queries WHERE query_key=?").get<Record<string, unknown>>(queryKey);
      if (!query) return null;
      const rows = await sqlite.prepare(SELECT_MEMBERSHIP_SQL).all<Record<string, unknown>>(queryKey);
      if (rows.some((row) => row.tj_number === null || row.tj_number === undefined)) return null;
      return parseSnapshot(query, rows);
    },
    replace: async (result, checkedAt, attemptedAt) => {
      await sqlite.transaction(async () => {
        for (const candidate of result.candidates) {
          await sqlite.prepare(UPSERT_SONG_SQL).run(candidate.tjNumber, candidate.title, candidate.artist, candidate.lyricist, candidate.composer, checkedAt, checkedAt);
        }
        await sqlite.prepare(UPSERT_QUERY_SQL).run(result.sourceUrl, result.query, result.searchType, result.nation, result.page, result.pageSize, result.hasMore ? 1 : 0, result.sourceUrl, checkedAt, attemptedAt);
        await sqlite.prepare("DELETE FROM tj_mirror_query_results WHERE query_key=?").run(result.sourceUrl);
        const insert = sqlite.prepare("INSERT INTO tj_mirror_query_results (query_key,tj_number,result_position) VALUES (?,?,?)");
        const seen = new Set<string>();
        let index = 0;
        for (const candidate of result.candidates) {
          if (seen.has(candidate.tjNumber)) continue;
          seen.add(candidate.tjNumber);
          await insert.run(result.sourceUrl, candidate.tjNumber, index);
          index += 1;
        }
      });
    },
    recordFailure: async (queryKey, attemptedAt, code) => {
      const result = await sqlite.prepare("UPDATE tj_mirror_queries SET last_attempted_at=?, last_error_code=?, consecutive_failures=consecutive_failures+1 WHERE query_key=?").run(attemptedAt, code, queryKey);
      if (result.changes !== 1) return null;
      const row = await sqlite.prepare("SELECT consecutive_failures FROM tj_mirror_queries WHERE query_key=?").get<{ consecutive_failures: number }>(queryKey);
      return row ? Number(row.consecutive_failures) : null;
    }
  };
}

interface MemoryEntry extends TjMirrorSnapshot {
  result: TjSearchResult;
}

export class InMemoryTjSearchMirror implements TjSearchMirror {
  private readonly entries = new Map<string, MemoryEntry>();

  async get(queryKey: string): Promise<TjMirrorSnapshot | null> {
    const entry = this.entries.get(queryKey);
    if (!entry) return null;
    return { ...entry, result: cloneResult(entry.result) };
  }

  async replace(result: TjSearchResult, checkedAt: string, attemptedAt: string): Promise<void> {
    this.entries.set(result.sourceUrl, {
      result: cloneResult(result),
      checkedAt,
      lastAttemptedAt: attemptedAt,
      lastErrorCode: null,
      consecutiveFailures: 0
    });
  }

  async recordFailure(queryKey: string, attemptedAt: string, code: string): Promise<number | null> {
    const entry = this.entries.get(queryKey);
    if (!entry) return null;
    entry.lastAttemptedAt = attemptedAt;
    entry.lastErrorCode = code;
    entry.consecutiveFailures += 1;
    return entry.consecutiveFailures;
  }
}

/**
 * Standalone adapter fallback. It retains every observed canonical key for the
 * lifetime of the adapter; production wiring should use createTjSearchMirror
 * so the mirror survives process restarts.
 */
export function createInMemoryTjSearchMirror(): TjSearchMirror {
  return new InMemoryTjSearchMirror();
}
