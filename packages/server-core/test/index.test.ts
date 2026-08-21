import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import {
  createAuditRepository,
  createIdempotencyRepository,
  createPerformanceRepository,
  createSongRepository,
  databasePragmas,
  IdempotencyMismatchError,
  migrations,
  openDatabase,
  runMigrations,
  type SongbookDatabase
} from "../src/index.js";
import type { Song } from "@songbook/shared";

let database: SongbookDatabase;

beforeEach(() => {
  database = openDatabase();
});

afterEach(() => {
  database.close();
});

function song(overrides: Partial<Song> = {}): Song {
  return {
    id: "song-1", tjNumber: "12345", title: "Title", titleReadingKo: "", titleRomanized: "", titleAliases: [],
    artist: "Artist", artistReadingKo: "", artistAliases: [], country: "", originalWork: "", keyCandidates: [],
    performerIds: [], memo: "", status: "active", youtubeUrl: "", youtubeVideoId: "", isOfficialTjVideo: null,
    sourceType: "test", sourceReference: "", createdByName: "Tester", createdAt: "2026-08-13T00:00:00.000Z",
    updatedByName: "Tester", updatedAt: "2026-08-13T00:00:00.000Z", deletedAt: "", version: 1, lastPerformedAt: "", performanceCount: 0,
    ...overrides
  };
}

describe("SQLite storage foundation", () => {
  it("applies required pragmas on every connection", () => {
    expect(databasePragmas(database)).toEqual({ foreignKeys: 1, journalMode: "memory", synchronous: 1, busyTimeout: 5000 });
  });

  it("runs numbered migrations once and records them", () => {
    expect(runMigrations(database.sqlite)).toEqual([]);
    expect(database.sqlite.prepare("SELECT id FROM schema_migrations").all()).toEqual(expect.arrayContaining([{ id: "0001_core" }, { id: "0100_mcp_token_resources" }, { id: "0101_tj_mirror" }, { id: "0102_drop_song_genres" }]));
    const songColumns = database.sqlite.prepare("PRAGMA table_info('songs')").all() as Array<{ name: string }>;
    expect(songColumns.map((column) => column.name)).not.toContain("genres_json");
  });

  it("drops the legacy genre column without losing song data", () => {
    const legacy = new Database(":memory:");
    try {
      legacy.exec(migrations[0].sql);
      legacy.exec("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)");
      legacy.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run("0001_core", "2026-08-13T00:00:00.000Z");
      legacy.prepare("INSERT INTO songs (id, title, artist, country, genres_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run("legacy-song", "Title", "Artist", "일본", '["J-POP"]', "2026-08-13T00:00:00.000Z", "2026-08-13T00:00:00.000Z");

      expect(runMigrations(legacy)).toContain("0102_drop_song_genres");
      expect(legacy.prepare("SELECT id, title, artist, country FROM songs").get()).toEqual({ id: "legacy-song", title: "Title", artist: "Artist", country: "일본" });
      const columns = legacy.prepare("PRAGMA table_info('songs')").all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).not.toContain("genres_json");
    } finally {
      legacy.close();
    }
  });

  it("uses WAL for a file-backed database", () => {
    const directory = mkdtempSync(join(tmpdir(), "songbook-core-"));
    const fileDatabase = openDatabase({ filename: join(directory, "songbook.sqlite") });
    try {
      expect(databasePragmas(fileDatabase).journalMode).toBe("wal");
    } finally {
      fileDatabase.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("creates the expected query indexes", () => {
    const names = (database.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as Array<{ name: string }>).map((row) => row.name);
    expect(names).toEqual(expect.arrayContaining([
      "songs_status_idx",
      "songs_updated_at_idx",
      "performances_song_cancelled_idx",
      "performances_performed_at_idx",
      "audit_events_entity_idx",
      "audit_events_created_at_idx",
      "audit_events_request_idx",
      "idempotency_keys_expiry_idx",
      "idempotency_keys_actor_operation_idx"
    ]));
  });

  it("enforces foreign keys and keeps nullable TJ values unique when present", () => {
    const songs = createSongRepository(database.sqlite);
    songs.insert(song({ id: "one", tjNumber: "55555" }));
    songs.insert(song({ id: "null-one", tjNumber: "" }));
    songs.insert(song({ id: "null-two", tjNumber: "" }));
    expect(() => songs.insert(song({ id: "duplicate", tjNumber: "55555" }))).toThrow();
    const performances = createPerformanceRepository(database.sqlite);
    expect(() => performances.insert({ id: "bad", songId: "missing", performedAt: "2026-08-13T00:00:00.000Z", keySelection: null, memo: "", createdByName: "", createdAt: "2026-08-13T00:00:00.000Z", cancelledAt: "", clientRequestId: "req-bad", version: 1 })).toThrow();
  });

  it("does not report unrelated rows when excluding the row being edited", () => {
    const songs = createSongRepository(database.sqlite);
    songs.insert(song({ id: "song-1", tjNumber: "10101" }));
    songs.insert(song({ id: "song-2", tjNumber: "20202", title: "Other", artist: "Other Artist" }));
    expect(songs.findDuplicate({ tjNumber: "10101", title: "Title", artist: "Artist" }, "song-1")).toBeNull();
    expect(songs.findDuplicate({ tjNumber: "20202", title: "New", artist: "New Artist" }, "song-1")?.id).toBe("song-2");
  });

  it("hard-deletes a song and frees its TJ number while keeping optimistic versions", () => {
    const songs = createSongRepository(database.sqlite);
    songs.insert(song());
    expect(songs.remove("song-1", 1)).toBe(true);
    expect(songs.get("song-1")).toBeNull();
    expect(() => songs.insert(song({ id: "song-2" }))).not.toThrow();
    expect(songs.update(song({ id: "song-2", title: "Updated", version: 2, updatedAt: "2026-08-13T03:00:00.000Z" }), 2)).toBe(false);
    expect(songs.update(song({ id: "song-2", title: "Updated", version: 2, updatedAt: "2026-08-13T03:00:00.000Z" }), 1)).toBe(true);
  });

  it("claims idempotency keys, returns same-request replays, rejects mismatches, and prunes expiry", () => {
    const repo = createIdempotencyRepository(database.sqlite);
    const input = { key: "request-1", actorEmail: "allowed@example.com", operation: "song.create", requestHash: "hash-a", createdAt: "2026-08-13T00:00:00.000Z", expiresAt: "2026-08-14T00:00:00.000Z" };
    expect(repo.reserve(input).kind).toBe("new");
    expect(repo.reserve(input).kind).toBe("replay");
    expect(() => repo.reserve({ ...input, requestHash: "hash-b" })).toThrow(IdempotencyMismatchError);
    expect(() => repo.reserve({ ...input, actorEmail: "other@example.com" })).toThrow(IdempotencyMismatchError);
    repo.complete("request-1", '{"ok":true}');
    expect(repo.get("request-1")?.responseJson).toBe('{"ok":true}');
    expect(repo.reserve({ ...input, createdAt: "2026-08-15T00:00:00.000Z", expiresAt: "2026-08-16T00:00:00.000Z" }).kind).toBe("new");
    expect(repo.prune("2026-08-17T00:00:00.000Z")).toBe(1);
  });

  it("writes and queries complete audit events and performance stats", () => {
    const songs = createSongRepository(database.sqlite);
    songs.insert(song());
    const performances = createPerformanceRepository(database.sqlite);
    performances.insert({ id: "perf-1", songId: "song-1", performedAt: "2026-08-13T04:00:00.000Z", keySelection: null, memo: "", createdByName: "Tester", createdAt: "2026-08-13T04:00:00.000Z", cancelledAt: "", clientRequestId: "request-perf-1", version: 1 });
    expect(songs.get("song-1")?.performanceCount).toBe(1);
    expect(songs.get("song-1")?.lastPerformedAt).toBe("2026-08-13T04:00:00.000Z");
    const audit = createAuditRepository(database.sqlite);
    audit.append({ entityType: "song", entityId: "song-1", action: "create", beforeJson: null, afterJson: '{"id":"song-1"}', actorEmail: "allowed@example.com", actorName: "Allowed", actorRole: "allowed", createdAt: "2026-08-13T00:00:00.000Z", clientRequestId: "request-1", entityVersionBefore: null, entityVersionAfter: 1 });
    expect(audit.list("song", "song-1")).toHaveLength(1);
  });
});
