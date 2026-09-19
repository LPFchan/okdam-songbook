import { beforeEach, describe, expect, it } from "vitest";
import {
  createAuditRepository,
  createFavoriteRepository,
  createIdempotencyRepository,
  createPerformanceRepository,
  createSongRepository,
  IdempotencyMismatchError,
  type D1SongbookDatabase
} from "../src/index.js";
import type { Song } from "@songbook/shared";
import { openFakeDatabase } from "./fake-d1.js";

let database: D1SongbookDatabase;

beforeEach(() => {
  database = openFakeDatabase();
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

describe("D1 storage foundation", () => {
  it("creates the expected query indexes", async () => {
    const names = (await database.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index'").all<{ name: string }>()).map((row) => row.name);
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

  it("stores favorites per user and cascades them when a song is deleted", async () => {
    const songs = createSongRepository(database.sqlite);
    await songs.insert(song());
    const favorites = createFavoriteRepository(database.sqlite);
    await favorites.set("one@example.com", "song-1", true, "2026-08-13T00:00:00.000Z");
    await favorites.set("two@example.com", "song-1", true, "2026-08-13T01:00:00.000Z");
    expect(await favorites.listSongIds("one@example.com")).toEqual(["song-1"]);
    expect(await favorites.listSongIds("other@example.com")).toEqual([]);
    await favorites.set("one@example.com", "song-1", false, "2026-08-13T02:00:00.000Z");
    expect(await favorites.listSongIds("one@example.com")).toEqual([]);
    expect(await songs.remove("song-1", 1)).toBe(true);
    expect(await favorites.listSongIds("two@example.com")).toEqual([]);
  });

  it("enforces foreign keys and keeps nullable TJ values unique when present", async () => {
    const songs = createSongRepository(database.sqlite);
    await songs.insert(song({ id: "one", tjNumber: "55555" }));
    await songs.insert(song({ id: "null-one", tjNumber: "" }));
    await songs.insert(song({ id: "null-two", tjNumber: "" }));
    await expect(songs.insert(song({ id: "duplicate", tjNumber: "55555" }))).rejects.toThrow();
    const performances = createPerformanceRepository(database.sqlite);
    await expect(performances.insert({ id: "bad", songId: "missing", performedAt: "2026-08-13T00:00:00.000Z", keySelection: null, memo: "", createdByName: "", createdAt: "2026-08-13T00:00:00.000Z", cancelledAt: "", clientRequestId: "req-bad", version: 1 })).rejects.toThrow();
  });

  it("does not report unrelated rows when excluding the row being edited", async () => {
    const songs = createSongRepository(database.sqlite);
    await songs.insert(song({ id: "song-1", tjNumber: "10101" }));
    await songs.insert(song({ id: "song-2", tjNumber: "20202", title: "Other", artist: "Other Artist" }));
    expect(await songs.findDuplicate({ tjNumber: "10101", title: "Title", artist: "Artist" }, "song-1")).toBeNull();
    expect((await songs.findDuplicate({ tjNumber: "20202", title: "New", artist: "New Artist" }, "song-1"))?.id).toBe("song-2");
  });

  it("hard-deletes a song and frees its TJ number while keeping optimistic versions", async () => {
    const songs = createSongRepository(database.sqlite);
    await songs.insert(song());
    expect(await songs.remove("song-1", 1)).toBe(true);
    expect(await songs.get("song-1")).toBeNull();
    await expect(songs.insert(song({ id: "song-2" }))).resolves.not.toThrow();
    expect(await songs.update(song({ id: "song-2", title: "Updated", version: 2, updatedAt: "2026-08-13T03:00:00.000Z" }), 2)).toBe(false);
    expect(await songs.update(song({ id: "song-2", title: "Updated", version: 2, updatedAt: "2026-08-13T03:00:00.000Z" }), 1)).toBe(true);
  });

  it("claims idempotency keys, returns same-request replays, rejects mismatches, and prunes expiry", async () => {
    const repo = createIdempotencyRepository(database.sqlite);
    const input = { key: "request-1", actorSubject: "auth.lost.plus:1", operation: "song.create", requestHash: "hash-a", createdAt: "2026-08-13T00:00:00.000Z", expiresAt: "2026-08-14T00:00:00.000Z" };
    expect((await repo.reserve(input)).kind).toBe("new");
    expect((await repo.reserve(input)).kind).toBe("replay");
    await expect(repo.reserve({ ...input, requestHash: "hash-b" })).rejects.toThrow(IdempotencyMismatchError);
    await expect(repo.reserve({ ...input, actorSubject: "auth.lost.plus:2" })).rejects.toThrow(IdempotencyMismatchError);
    await repo.complete("request-1", '{"ok":true}');
    expect((await repo.get("request-1"))?.responseJson).toBe('{"ok":true}');
    expect((await repo.reserve({ ...input, createdAt: "2026-08-15T00:00:00.000Z", expiresAt: "2026-08-16T00:00:00.000Z" })).kind).toBe("new");
    expect(await repo.prune("2026-08-17T00:00:00.000Z")).toBe(1);
  });

  it("writes and queries complete audit events and performance stats", async () => {
    const songs = createSongRepository(database.sqlite);
    await songs.insert(song());
    const performances = createPerformanceRepository(database.sqlite);
    await performances.insert({ id: "perf-1", songId: "song-1", performedAt: "2026-08-13T04:00:00.000Z", keySelection: null, memo: "", createdByName: "Tester", createdAt: "2026-08-13T04:00:00.000Z", cancelledAt: "", clientRequestId: "request-perf-1", version: 1 });
    expect((await songs.get("song-1"))?.performanceCount).toBe(1);
    expect((await songs.get("song-1"))?.lastPerformedAt).toBe("2026-08-13T04:00:00.000Z");
    const audit = createAuditRepository(database.sqlite);
    await audit.append({ entityType: "song", entityId: "song-1", action: "create", beforeJson: null, afterJson: '{"id":"song-1"}', actorEmail: "allowed@example.com", actorName: "Allowed", actorRole: "allowed", createdAt: "2026-08-13T00:00:00.000Z", clientRequestId: "request-1", entityVersionBefore: null, entityVersionAfter: 1 });
    expect(await audit.list("song", "song-1")).toHaveLength(1);
  });
});
