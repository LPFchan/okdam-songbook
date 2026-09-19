import { beforeEach, describe, expect, it } from "vitest";
import { createSongbookService, DomainError, type RoleResolver, type SongbookService } from "../src/index.js";
import { openFakeDatabase } from "./fake-d1.js";

/**
 * The songbook service driven through the D1 executor, so anything the
 * executor cannot express — reading back a queued write, nesting a
 * transaction — fails here the way it would on Cloudflare.
 */
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
  service = createSongbookService(openFakeDatabase(), { roleResolver: roleResolver() });
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

  it("lets a retry rerun a mutation whose first attempt failed, instead of reporting it as in flight", async () => {
    // D1 cannot roll the idempotency claim back with the failed work, so the
    // service releases it by hand. The offline queue replays with the same
    // clientRequestId; before the release it saw CONFLICT for a day.
    const created = await service.createSong(allowed, songInput());
    const clientRequestId = crypto.randomUUID();
    const stale = { ...songInput({ title: "Retry" }), id: created.id, expectedVersion: created.version + 5, clientRequestId } as Parameters<SongbookService["updateSong"]>[1];
    await expect(service.updateSong(allowed, stale)).rejects.toMatchObject({ code: "VERSION_MISMATCH" });
    // An identical retry must see the real error again, not the stuck claim.
    await expect(service.updateSong(allowed, stale)).rejects.toMatchObject({ code: "VERSION_MISMATCH" });
    // And the key is free: the corrected request runs rather than mismatching.
    const retry = await service.updateSong(allowed, { ...stale, expectedVersion: created.version });
    expect(retry.title).toBe("Retry");
    expect(retry.version).toBe(created.version + 1);
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
