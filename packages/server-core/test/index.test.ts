import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import {
  createAuditRepository,
  createFavoriteRepository,
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
    id: "song-1", tjNumber: "12345", title: "Title", titleReadingKo: "",
    artist: "Artist", artistReadingKo: "", country: "", recommendedKey: null,
    performerIds: [], memo: "",
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
    expect(database.sqlite.prepare("SELECT id FROM schema_migrations").all()).toEqual(expect.arrayContaining([{ id: "0001_core" }, { id: "0100_mcp_token_resources" }, { id: "0101_tj_mirror" }, { id: "0102_drop_song_genres" }, { id: "0103_drop_practicing_status" }, { id: "0104_personal_favorites" }, { id: "0105_collapse_song_schema" }]));
    const songColumns = database.sqlite.prepare("PRAGMA table_info('songs')").all() as Array<{ name: string }>;
    expect(songColumns.map((column) => column.name)).not.toContain("genres_json");
  });

  it("removes retired song fields and statuses without losing related data", () => {
    const legacy = new Database(":memory:");
    try {
      legacy.exec(migrations[0].sql);
      legacy.exec("CREATE TABLE schema_migrations (id TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)");
      legacy.prepare("INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)").run("0001_core", "2026-08-13T00:00:00.000Z");
      legacy.prepare("INSERT INTO songs (id, title, artist, country, genres_json, original_work, key_candidates_json, memo, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run("legacy-song", "Title", "Artist", "일본", '["J-POP"]', "애니메이션", '[{"id":"key-1","baseMode":"female","offset":2,"label":"추천","memo":"","isPrimary":true}]', "후렴 주의", "practicing", "2026-08-13T00:00:00.000Z", "2026-08-13T00:00:00.000Z");
      legacy.prepare("INSERT INTO songs (id, title, artist, country, genres_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("legacy-favorite", "Favorite", "Artist", "한국", '[]', "favorite", "2026-08-13T00:00:00.000Z", "2026-08-13T00:00:00.000Z");
      legacy.prepare("INSERT INTO performances (id, song_id, performed_at, created_at, client_request_id) VALUES (?, ?, ?, ?, ?)").run("performance-1", "legacy-song", "2026-08-13T00:00:00.000Z", "2026-08-13T00:00:00.000Z", "request-1");
      legacy.pragma("foreign_keys = ON");

      expect(runMigrations(legacy)).toEqual(expect.arrayContaining(["0102_drop_song_genres", "0103_drop_practicing_status", "0104_personal_favorites", "0105_collapse_song_schema"]));
      expect(legacy.prepare("SELECT memo, recommended_key_json FROM songs WHERE id=?").get("legacy-song")).toEqual({ memo: "원작: 애니메이션\n후렴 주의", recommended_key_json: '{"baseMode":"female","offset":2}' });
      expect(legacy.prepare("SELECT song_id FROM performances").get()).toEqual({ song_id: "legacy-song" });
      expect(legacy.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(legacy.pragma("foreign_key_check")).toEqual([]);
      const columns = legacy.prepare("PRAGMA table_info('songs')").all() as Array<{ name: string }>;
      expect(columns.map((column) => column.name)).not.toEqual(expect.arrayContaining(["genres_json", "original_work", "key_candidates_json", "status", "title_romanized", "title_aliases_json", "artist_aliases_json", "youtube_url", "youtube_video_id", "is_official_tj_video"]));
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
      "songs_updated_at_idx",
      "song_favorites_song_idx",
      "performances_song_cancelled_idx",
      "performances_performed_at_idx",
      "audit_events_entity_idx",
      "audit_events_created_at_idx",
      "audit_events_request_idx",
      "idempotency_keys_expiry_idx",
      "idempotency_keys_actor_operation_idx"
    ]));
  });

  it("stores favorites per user and cascades them when a song is deleted", () => {
    const songs = createSongRepository(database.sqlite);
    songs.insert(song());
    const favorites = createFavoriteRepository(database.sqlite);
    favorites.set("one@example.com", "song-1", true, "2026-08-13T00:00:00.000Z");
    favorites.set("two@example.com", "song-1", true, "2026-08-13T01:00:00.000Z");
    expect(favorites.listSongIds("one@example.com")).toEqual(["song-1"]);
    expect(favorites.listSongIds("other@example.com")).toEqual([]);
    favorites.set("one@example.com", "song-1", false, "2026-08-13T02:00:00.000Z");
    expect(favorites.listSongIds("one@example.com")).toEqual([]);
    expect(songs.remove("song-1", 1)).toBe(true);
    expect(favorites.listSongIds("two@example.com")).toEqual([]);
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
