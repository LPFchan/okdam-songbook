import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import { openD1Database, type D1DatabaseLike, type D1PreparedStatementLike } from "../src/db/d1.js";
import { createSongbookService, DomainError, type RoleResolver, type SongbookService } from "../src/index.js";

const schemaSql = readFileSync(
  fileURLToPath(new URL("../../../apps/worker/migrations/0001_init.sql", import.meta.url)),
  "utf8"
);

/**
 * The songbook service driven through the D1 executor rather than the Node
 * one. better-sqlite3 supplies the storage, but it is reached only through the
 * D1 binding shape, so anything the executor cannot express — reading back a
 * queued write, nesting a transaction — fails here the way it would on
 * Cloudflare. The Node-backed suites cannot catch those; this one exists so a
 * green `npm run verify` means the Worker runtime works too.
 */
function fakeD1(): D1DatabaseLike {
  const db = new Database(":memory:");
  db.exec(schemaSql);
  const statement = (sql: string): D1PreparedStatementLike => {
    let bound: unknown[] = [];
    const self: D1PreparedStatementLike = {
      bind(...values: unknown[]) { bound = values; return self; },
      async first<T>() { return (db.prepare(sql).get(...(bound as never[])) ?? null) as T | null; },
      async all<T>() { return { results: db.prepare(sql).all(...(bound as never[])) as T[] }; },
      async run() { const r = db.prepare(sql).run(...(bound as never[])); return { meta: { changes: Number(r.changes) } }; }
    };
    return self;
  };
  return { prepare: statement };
}

const allowed = { email: "allowed@example.com", displayName: "Allowed" };

function roleResolver(): RoleResolver {
  return {
    resolve: (actor) => actor.email === allowed.email
      ? { subject: actor.subject ?? `legacy-email:${actor.email}`, email: actor.email, displayName: allowed.displayName, role: "allowed" }
      : null
  };
}

function songInput(overrides: Record<string, unknown> = {}) {
  return {
    tjNumber: "12345", title: "Title", titleReadingKo: "", artist: "Artist", artistReadingKo: "",
    country: "", recommendedKey: null, performerIds: [], memo: "", sourceType: "test",
    sourceReference: "", createdByName: "", updatedByName: "", clientRequestId: crypto.randomUUID(),
    ...overrides
  } as Parameters<SongbookService["createSong"]>[1];
}

let service: SongbookService;

beforeEach(() => {
  service = createSongbookService(openD1Database(fakeD1()), { roleResolver: roleResolver() });
});

describe("songbook service on a D1 executor", () => {
  it("creates a song and reads back the stored row", async () => {
    const created = await service.createSong(allowed, songInput());
    expect(created.title).toBe("Title");
    expect(created.version).toBe(1);
    expect(await service.getSong(created.id)).toMatchObject({ id: created.id, title: "Title" });
  });

  it("replays a repeated client request instead of creating a duplicate", async () => {
    const input = songInput();
    const first = await service.createSong(allowed, input);
    const second = await service.createSong(allowed, input);
    expect(second.id).toBe(first.id);
    expect(await service.catalog()).toHaveLength(1);
  });

  it("rejects a second song with the same TJ number", async () => {
    await service.createSong(allowed, songInput());
    await expect(service.createSong(allowed, songInput())).rejects.toThrow(DomainError);
  });

  it("updates a song and bumps its version", async () => {
    const created = await service.createSong(allowed, songInput());
    const updated = await service.updateSong(allowed, {
      ...songInput({ title: "Renamed" }), id: created.id, expectedVersion: created.version
    } as Parameters<SongbookService["updateSong"]>[1]);
    expect(updated.title).toBe("Renamed");
    expect(updated.version).toBe(created.version + 1);
  });

  it("refuses an update against a stale version", async () => {
    const created = await service.createSong(allowed, songInput());
    await expect(service.updateSong(allowed, {
      ...songInput({ title: "Stale" }), id: created.id, expectedVersion: created.version + 5
    } as Parameters<SongbookService["updateSong"]>[1])).rejects.toThrow(DomainError);
  });

  it("deletes a song", async () => {
    const created = await service.createSong(allowed, songInput());
    await service.deleteSong(allowed, { id: created.id, expectedVersion: created.version, clientRequestId: crypto.randomUUID() });
    expect(await service.catalog()).toHaveLength(0);
  });

  it("records and cancels a performance", async () => {
    const song = await service.createSong(allowed, songInput());
    const performance = await service.createPerformance(allowed, {
      songId: song.id, keySelection: null, memo: "", clientRequestId: crypto.randomUUID()
    });
    expect(performance.songId).toBe(song.id);
    expect((await service.performanceStats(song.id)).count).toBe(1);

    const cancelled = await service.cancelPerformance(allowed, {
      performanceId: performance.id, expectedVersion: performance.version, clientRequestId: crypto.randomUUID()
    });
    expect(cancelled.id).toBe(performance.id);
    expect((await service.performanceStats(song.id)).count).toBe(0);
  });

  it("toggles a favorite", async () => {
    const song = await service.createSong(allowed, songInput());
    await service.setFavorite(allowed, { songId: song.id, favorite: true, clientRequestId: crypto.randomUUID() });
    expect(await service.favoriteSongIds(allowed)).toEqual([song.id]);

    await service.setFavorite(allowed, { songId: song.id, favorite: false, clientRequestId: crypto.randomUUID() });
    expect(await service.favoriteSongIds(allowed)).toEqual([]);
  });

  it("searches the catalog", async () => {
    await service.createSong(allowed, songInput({ title: "Blue Moon", tjNumber: "111" }));
    await service.createSong(allowed, songInput({ title: "Red Sun", tjNumber: "222" }));
    const found = await service.search("Blue");
    expect(found.map((song) => song.title)).toEqual(["Blue Moon"]);
  });

  it("still refuses an unauthorized actor", async () => {
    await expect(service.createSong({ email: "stranger@example.com" }, songInput())).rejects.toThrow(DomainError);
  });
});
