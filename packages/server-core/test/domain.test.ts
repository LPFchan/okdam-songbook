import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Song } from "@songbook/shared";
import {
  createAuditRepository,
  createSongRepository,
  createSongbookService,
  DomainError,
  openDatabase,
  type RoleResolver,
  createTjAdapter,
  TjAdapterError,
  toApiError,
  domainErrorCodes,
  domainErrorCodeToApiErrorCode
} from "../src/index.js";

let database: ReturnType<typeof openDatabase>;
const allowed = { email: "allowed@example.com", displayName: "Allowed" };
const allowedPeer = { email: "peer@example.com", displayName: "Peer" };

function songInput(overrides: Partial<Omit<Song, "id" | "createdAt" | "updatedAt" | "deletedAt" | "version" | "lastPerformedAt" | "lastPerformedByName" | "performanceCount"> & { clientRequestId: string }> = {}) {
  return {
    tjNumber: "12345", title: "Title", titleReadingKo: "", artist: "Artist", artistReadingKo: "", country: "", recommendedKey: null, performerIds: [], memo: "", sourceType: "test", sourceReference: "", createdByName: "", updatedByName: "", clientRequestId: crypto.randomUUID(), ...overrides
  };
}

function roleResolver(): RoleResolver {
  return {
    resolve: (actor) => actor.email === allowed.email
      ? { email: actor.email, displayName: allowed.displayName, role: "allowed" }
      : actor.email === allowedPeer.email
        ? { email: actor.email, displayName: allowedPeer.displayName, role: "allowed" }
        : null
  };
}

beforeEach(() => {
  database = openDatabase();
});

afterEach(() => {
  database.close();
});

describe("songbook domain services", () => {
  it("fails closed when no role resolver is configured", () => {
    const service = createSongbookService(database);
    expect(() => service.createSong(allowed, songInput())).toThrowError(/로그인 또는 허용된 계정/);
  });

  it("resolves the current role for each protected request", () => {
    const service = createSongbookService(database, { roleResolver: roleResolver() });
    expect(() => service.createSong(allowed, songInput())).not.toThrow();
    expect(() => service.createSong({ email: "revoked@example.com" }, songInput({ tjNumber: "54321" }))).toThrowError(DomainError);
    expect(() => service.deleteSong({ email: "unknown@example.com" }, { id: "missing", expectedVersion: 1, clientRequestId: crypto.randomUUID() })).toThrowError(/로그인 또는 허용된 계정/);
  });

  it("creates, searches, and returns anonymous public catalog rows", () => {
    const service = createSongbookService(database, { roleResolver: roleResolver() });
    const created = service.createSong(allowedPeer, songInput({ title: "フォニイ", titleReadingKo: "포니", artist: "ツミキ", tjNumber: "52537" }));
    expect(service.catalog().map((song) => song.id)).toEqual([created.id]);
    expect(service.search("포니")[0]?.id).toBe(created.id);
  });

  it("keeps favorites private to each signed-in account", () => {
    const service = createSongbookService(database, { roleResolver: roleResolver() });
    const created = service.createSong(allowed, songInput());
    const request = { songId: created.id, favorite: true, clientRequestId: crypto.randomUUID() };
    expect(service.setFavorite(allowed, request)).toEqual({ songId: created.id, favorite: true });
    expect(service.setFavorite(allowed, request)).toEqual({ songId: created.id, favorite: true });
    expect(service.favoriteSongIds(allowed)).toEqual([created.id]);
    expect(service.favoriteSongIds(allowedPeer)).toEqual([]);
    expect(JSON.stringify(service.catalog())).not.toContain(allowed.email);
    service.setFavorite(allowed, { songId: created.id, favorite: false, clientRequestId: crypto.randomUUID() });
    expect(service.favoriteSongIds(allowed)).toEqual([]);
  });

  it("rejects duplicates and reports version conflicts", () => {
    const service = createSongbookService(database, { roleResolver: roleResolver() });
    const first = service.createSong(allowed, songInput());
    expect(Object.hasOwn(first, "clientRequestId")).toBe(false);
    expect(() => service.createSong(allowedPeer, songInput({ clientRequestId: crypto.randomUUID() }))).toThrowError(DomainError);
    expect(() => service.updateSong(allowedPeer, { id: first.id, expectedVersion: 99, clientRequestId: crypto.randomUUID(), title: "Changed" })).toThrowError(/다른 곳/);
    const updated = service.updateSong(allowedPeer, { id: first.id, expectedVersion: 1, clientRequestId: crypto.randomUUID(), title: "Changed" });
    expect(updated.title).toBe("Changed");
    expect(Object.hasOwn(updated, "clientRequestId")).toBe(false);
    expect(Object.hasOwn(updated, "expectedVersion")).toBe(false);
  });

  it("returns structured create outcomes, preserves TJ provenance, and hides deleted rows from lookup", () => {
    const service = createSongbookService(database, { roleResolver: roleResolver() });
    const created = service.createSongOutcome(allowed, songInput({ title: "Outcome", artist: "Artist", tjNumber: "77777" }));
    expect(created.outcome).toBe("created");
    const duplicate = service.createSongOutcome(allowed, songInput({ title: "Outcome", artist: "Artist", tjNumber: "77777", clientRequestId: crypto.randomUUID() }));
    expect(duplicate).toMatchObject({ outcome: "duplicate", existing: { id: created.song?.id }, song: null, canOpen: true });

    const tj = service.createTjSong(allowed, { tjNumber: "88888", title: "TJ source", artist: "TJ artist", lyricist: "", composer: "", sourceUrl: "https://tj.example/song" }, crypto.randomUUID());
    expect(tj).toMatchObject({ outcome: "created", song: { country: "미국", sourceType: "tjmedia", sourceReference: "https://tj.example/song" } });

    const deleted = service.createSong(allowed, songInput({ title: "Deleted", artist: "Artist", tjNumber: "99999" }));
    database.sqlite.prepare("UPDATE songs SET deleted_at=? WHERE id=?").run("2026-08-13T00:00:00.000Z", deleted.id);
    expect(service.getSong(deleted.id)).toBeNull();
    const deletedOutcome = service.createSongOutcome(allowed, songInput({ title: "Deleted", artist: "Artist", tjNumber: "99999", clientRequestId: crypto.randomUUID() }));
    expect(deletedOutcome).toMatchObject({ outcome: "deleted", existing: { id: deleted.id }, song: null, canOpen: false });
  });

  it("assigns a TJ-added song to the signed-in performer", () => {
    const marieResolver: RoleResolver = {
      resolve: (actor) => actor.email === allowed.email
        ? { email: actor.email, displayName: "마리", role: "allowed" }
        : null
    };
    const service = createSongbookService(database, { roleResolver: marieResolver });

    const result = service.createTjSong(allowed, {
      tjNumber: "88889",
      title: "TJ default performer",
      artist: "TJ artist",
      lyricist: "",
      composer: "",
      sourceUrl: "https://tj.example/default-performer"
    }, crypto.randomUUID());

    expect(result.song?.performerIds).toEqual(["marie"]);
  });

  it("detects the country when adding a TJ song", () => {
    const service = createSongbookService(database, { roleResolver: roleResolver() });
    service.createSong(allowed, songInput({
      tjNumber: "11111",
      title: "Dreaming",
      artist: "FreeTEMPO",
      country: "일본"
    }));

    const knownArtist = service.createTjSong(allowed, {
      tjNumber: "22222",
      title: "New Latin Title",
      artist: "FreeTEMPO",
      lyricist: "",
      composer: "",
      sourceUrl: "https://tj.example/known-artist"
    }, crypto.randomUUID());
    const korean = service.createTjSong(allowed, {
      tjNumber: "33333",
      title: "좋은 날",
      artist: "아이유",
      lyricist: "",
      composer: "",
      sourceUrl: "https://tj.example/korean"
    }, crypto.randomUUID());

    expect(knownArtist.song?.country).toBe("일본");
    expect(korean.song?.country).toBe("한국");
  });

  it("makes mutations replay-safe and audits the successful operation once", () => {
    const service = createSongbookService(database, { roleResolver: roleResolver() });
    const clientRequestId = crypto.randomUUID();
    const first = service.createSong(allowed, songInput({ clientRequestId }));
    const replay = service.createSong(allowed, songInput({ clientRequestId }));
    expect(replay).toEqual(first);
    expect(Object.hasOwn(replay, "clientRequestId")).toBe(false);
    expect(Object.hasOwn(replay, "expectedVersion")).toBe(false);
    expect(createSongRepository(database.sqlite).list({ includeDeleted: true })).toHaveLength(1);
    expect(createAuditRepository(database.sqlite).list("song", first.id)).toHaveLength(1);
    const storedReplay = database.sqlite.prepare("SELECT response_json FROM idempotency_keys WHERE key=?").get(clientRequestId) as { response_json: string };
    expect(Object.hasOwn(JSON.parse(storedReplay.response_json), "clientRequestId")).toBe(false);
  });

  it("keeps update results and their stored and replayed responses free of request fields", () => {
    const service = createSongbookService(database, { roleResolver: roleResolver() });
    const created = service.createSong(allowed, songInput());
    const clientRequestId = crypto.randomUUID();
    const input = { id: created.id, expectedVersion: created.version, clientRequestId, title: "Updated" };
    const updated = service.updateSong(allowedPeer, input);
    expect(Object.hasOwn(updated, "clientRequestId")).toBe(false);
    expect(Object.hasOwn(updated, "expectedVersion")).toBe(false);
    const stored = database.sqlite.prepare("SELECT response_json FROM idempotency_keys WHERE key=?").get(clientRequestId) as { response_json: string };
    expect(Object.hasOwn(JSON.parse(stored.response_json), "clientRequestId")).toBe(false);
    expect(Object.hasOwn(JSON.parse(stored.response_json), "expectedVersion")).toBe(false);
    const replay = service.updateSong(allowedPeer, input);
    expect(replay).toEqual(updated);
    expect(Object.hasOwn(replay, "clientRequestId")).toBe(false);
    expect(Object.hasOwn(replay, "expectedVersion")).toBe(false);
  });

  it("rolls back the mutation and idempotency claim when audit writing fails", () => {
    const auditFailure = { append: () => { throw new Error("audit unavailable"); }, list: () => [] };
    const service = createSongbookService(database, { roleResolver: roleResolver(), auditRepository: auditFailure });
    const clientRequestId = crypto.randomUUID();
    expect(() => service.createSong(allowed, songInput({ clientRequestId }))).toThrow("audit unavailable");
    expect(createSongRepository(database.sqlite).list({ includeDeleted: true })).toHaveLength(0);
    expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM idempotency_keys WHERE key=?").get(clientRequestId)).toEqual({ count: 0 });
  });

  it("allows an allowlisted user to hard delete and free the TJ number", () => {
    const service = createSongbookService(database, { roleResolver: roleResolver() });
    const created = service.createSong(allowedPeer, songInput());
    const deleted = service.deleteSong(allowed, { id: created.id, expectedVersion: 1, clientRequestId: crypto.randomUUID() });
    expect(deleted.id).toBe(created.id);
    expect(database.sqlite.prepare("SELECT actor_role FROM audit_events WHERE entity_type='song' AND entity_id=? ORDER BY created_at").all(created.id)).toEqual([{ actor_role: "allowed" }, { actor_role: "allowed" }]);
    expect(service.catalog()).toHaveLength(0);
    const recreated = service.createSong(allowed, songInput({ clientRequestId: crypto.randomUUID() }));
    expect(recreated.tjNumber).toBe(created.tjNumber);
  });

  it("creates, counts, and cancels performance records", () => {
    const service = createSongbookService(database, { roleResolver: roleResolver() });
    const created = service.createSong(allowedPeer, songInput());
    const performance = service.createPerformance(allowedPeer, { songId: created.id, keySelection: null, memo: "", performedAt: "2026-08-13T10:00:00.000Z", clientRequestId: crypto.randomUUID() });
    expect(service.performanceStats(created.id)).toEqual({ count: 1, lastPerformedAt: "2026-08-13T10:00:00.000Z" });
    expect(service.getSong(created.id)?.lastPerformedByName).toBe("Peer");
    database.sqlite.prepare("UPDATE performances SET created_by_email=? WHERE id=?").run("unknown@example.com", performance.id);
    expect(service.getSong(created.id)?.lastPerformedByName).toBe("");
    expect(service.cancelPerformance(allowed, { performanceId: performance.id, expectedVersion: 1, clientRequestId: crypto.randomUUID() }).cancelledAt).toBeTruthy();
    expect(service.performanceStats(created.id)).toEqual({ count: 0, lastPerformedAt: "" });
  });

  it("maps domain-only errors to the committed shared API vocabulary", () => {
    expect(Object.keys(domainErrorCodeToApiErrorCode).sort()).toEqual([...domainErrorCodes].sort());
    for (const code of domainErrorCodes) {
      expect(toApiError(new DomainError(code, code)).code).toBe(domainErrorCodeToApiErrorCode[code]);
    }
    expect(toApiError(new DomainError("VERSION_MISMATCH", "stale", { currentVersion: 2 })).code).toBe("CONFLICT");
    expect(toApiError(new DomainError("VERSION_MISMATCH", "stale", { currentVersion: 2 })).details).toMatchObject({ reason: "version-mismatch" });
    expect(toApiError(new DomainError("IDEMPOTENCY_MISMATCH", "reused")).details).toMatchObject({ reason: "idempotency-replay" });
    expect(toApiError(new DomainError("TJ_TIMEOUT", "timeout")).code).toBe("TJ_UPSTREAM_ERROR");
    expect(toApiError(new DomainError("TJ_BODY_TOO_LARGE", "large")).code).toBe("TJ_UPSTREAM_ERROR");
    expect(toApiError(new DomainError("TJ_CIRCUIT_OPEN", "open")).code).toBe("TJ_UPSTREAM_ERROR");
    expect(toApiError(new DomainError("TJ_RATE_LIMITED", "slow")).code).toBe("TJ_RATE_LIMITED");
    expect(toApiError(new DomainError("TJ_PARSER_ERROR", "drift")).code).toBe("TJ_PARSER_ERROR");
  });
});

const tjHtml = `<ul class="grid-container list"><li class="grid-item center"><span class="num2">52537</span></li><li class="grid-item title3"><p>フォニイ</p></li><li class="grid-item title4 singer"><p>ツミキ</p></li><li class="grid-item title5"><p>作詞</p></li><li class="grid-item title6"><p>作曲</p></li></ul></li>`;

function response(body: string, status = 200) {
  return { status, text: async () => body };
}

describe("bounded TJ adapter", () => {
  it("caches successful searches and parses candidates", async () => {
    const fetcher = vi.fn(async () => response(tjHtml));
    const adapter = createTjAdapter({ fetcher, now: () => 1_000 });
    const input = { query: "フォニイ", searchType: "all" as const, nation: "" as const, page: 1, pageSize: 15 };
    expect((await adapter.search(input)).candidates[0]?.tjNumber).toBe("52537");
    await adapter.search(input);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("enforces body limits and exposes a manual fallback contract", async () => {
    const adapter = createTjAdapter({ fetcher: async () => response("x".repeat(100)), maxBodyBytes: 10 });
    const error = await adapter.search({ query: "x", searchType: "all", nation: "", page: 1, pageSize: 15 }).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(TjAdapterError);
    expect((error as TjAdapterError).toManualFallback().manualFallback).toBe(true);
    expect((error as TjAdapterError).code).toBe("TJ_BODY_TOO_LARGE");
  });

  it("throttles and opens a circuit after repeated upstream failures", async () => {
    let current = 1_000;
    const adapter = createTjAdapter({ now: () => current, throttleLimit: 2, throttleWindowMs: 100, circuitFailureThreshold: 2, circuitOpenMs: 1_000, fetcher: async () => response("bad", 503) });
    const input = { query: "x", searchType: "all" as const, nation: "" as const, page: 1, pageSize: 15 };
    await expect(adapter.search(input)).rejects.toMatchObject({ code: "TJ_UPSTREAM_ERROR" });
    current += 101;
    await expect(adapter.search({ ...input, query: "y" })).rejects.toMatchObject({ code: "TJ_UPSTREAM_ERROR" });
    current += 101;
    await expect(adapter.search({ ...input, query: "z" })).rejects.toMatchObject({ code: "TJ_CIRCUIT_OPEN" });
  });
});
