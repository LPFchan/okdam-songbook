import type Database from "better-sqlite3";
import { tjSearchResultSchema, type TjSearchResult } from "@songbook/shared";

export interface TjMirrorSnapshot {
  result: TjSearchResult;
  checkedAt: string | null;
  lastAttemptedAt: string | null;
  lastErrorCode: string | null;
  consecutiveFailures: number;
}

export interface TjSearchMirror {
  get(queryKey: string): TjMirrorSnapshot | null;
  replace(result: TjSearchResult, checkedAt: string, attemptedAt: string): void;
  recordFailure(queryKey: string, attemptedAt: string, code: string): number | null;
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

export function createTjSearchMirror(sqlite: Database.Database): TjSearchMirror {
  return {
    get: (queryKey) => {
      const query = sqlite.prepare("SELECT * FROM tj_mirror_queries WHERE query_key=?").get(queryKey) as Record<string, unknown> | undefined;
      if (!query) return null;
      const rows = sqlite.prepare(`
        SELECT r.result_position, s.tj_number, s.title, s.artist, s.lyricist, s.composer
        FROM tj_mirror_query_results r
        LEFT JOIN tj_mirror_songs s ON s.tj_number=r.tj_number
        WHERE r.query_key=?
        ORDER BY r.result_position ASC
      `).all(queryKey) as Array<Record<string, unknown>>;
      if (rows.some((row) => row.tj_number === null || row.tj_number === undefined)) return null;
      return parseSnapshot(query, rows);
    },
    replace: (result, checkedAt, attemptedAt) => {
      const write = sqlite.transaction(() => {
        for (const candidate of result.candidates) {
          sqlite.prepare(`
            INSERT INTO tj_mirror_songs (tj_number,title,artist,lyricist,composer,first_seen_at,last_seen_at)
            VALUES (?,?,?,?,?,?,?)
            ON CONFLICT(tj_number) DO UPDATE SET
              title=excluded.title,
              artist=excluded.artist,
              lyricist=excluded.lyricist,
              composer=excluded.composer,
              last_seen_at=excluded.last_seen_at
          `).run(candidate.tjNumber, candidate.title, candidate.artist, candidate.lyricist, candidate.composer, checkedAt, checkedAt);
        }
        sqlite.prepare(`
          INSERT INTO tj_mirror_queries (query_key,query,search_type,nation,page,page_size,has_more,source_url,checked_at,last_attempted_at,last_error_code,consecutive_failures)
          VALUES (?,?,?,?,?,?,?,?,?,?,NULL,0)
          ON CONFLICT(query_key) DO UPDATE SET
            query=excluded.query,
            search_type=excluded.search_type,
            nation=excluded.nation,
            page=excluded.page,
            page_size=excluded.page_size,
            has_more=excluded.has_more,
            source_url=excluded.source_url,
            checked_at=excluded.checked_at,
            last_attempted_at=excluded.last_attempted_at,
            last_error_code=NULL,
            consecutive_failures=0
        `).run(result.sourceUrl, result.query, result.searchType, result.nation, result.page, result.pageSize, result.hasMore ? 1 : 0, result.sourceUrl, checkedAt, attemptedAt);
        sqlite.prepare("DELETE FROM tj_mirror_query_results WHERE query_key=?").run(result.sourceUrl);
        const insert = sqlite.prepare("INSERT INTO tj_mirror_query_results (query_key,tj_number,result_position) VALUES (?,?,?)");
        const seen = new Set<string>();
        result.candidates.forEach((candidate, index) => {
          if (seen.has(candidate.tjNumber)) return;
          seen.add(candidate.tjNumber);
          insert.run(result.sourceUrl, candidate.tjNumber, index);
        });
      });
      write();
    },
    recordFailure: (queryKey, attemptedAt, code) => {
      const result = sqlite.prepare(`
        UPDATE tj_mirror_queries
        SET last_attempted_at=?, last_error_code=?, consecutive_failures=consecutive_failures+1
        WHERE query_key=?
      `).run(attemptedAt, code, queryKey);
      if (result.changes !== 1) return null;
      const row = sqlite.prepare("SELECT consecutive_failures FROM tj_mirror_queries WHERE query_key=?").get(queryKey) as { consecutive_failures: number } | undefined;
      return row ? Number(row.consecutive_failures) : null;
    }
  };
}

interface MemoryEntry extends TjMirrorSnapshot {
  result: TjSearchResult;
}

export class InMemoryTjSearchMirror implements TjSearchMirror {
  private readonly entries = new Map<string, MemoryEntry>();

  get(queryKey: string): TjMirrorSnapshot | null {
    const entry = this.entries.get(queryKey);
    if (!entry) return null;
    return { ...entry, result: cloneResult(entry.result) };
  }

  replace(result: TjSearchResult, checkedAt: string, attemptedAt: string): void {
    this.entries.set(result.sourceUrl, {
      result: cloneResult(result),
      checkedAt,
      lastAttemptedAt: attemptedAt,
      lastErrorCode: null,
      consecutiveFailures: 0
    });
  }

  recordFailure(queryKey: string, attemptedAt: string, code: string): number | null {
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
