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
const owner = { email: "owner@example.com", displayName: "Owner" };
const editor = { email: "editor@example.com", displayName: "Editor" };

function songInput(overrides: Partial<Omit<Song, "id" | "createdAt" | "updatedAt" | "deletedAt" | "version" | "lastPerformedAt" | "performanceCount"> & { clientRequestId: string }> = {}) {
  return {
    tjNumber: "12345", title: "Title", titleReadingKo: "", titleRomanized: "", titleAliases: [], artist: "Artist", artistReadingKo: "", artistAliases: [], country: "", genres: [], originalWork: "", keyCandidates: [], performerIds: [], memo: "", status: "active" as const, youtubeUrl: "", youtubeVideoId: "", isOfficialTjVideo: null, sourceType: "test", sourceReference: "", createdByName: "", updatedByName: "", clientRequestId: crypto.randomUUID(), ...overrides
  };
}

function roleResolver(): RoleResolver {
  return {
    resolve: (actor) => actor.email === owner.email ? { email: actor.email, displayName: actor.displayName ?? "Owner", role: "owner" } : actor.email === editor.email ? { email: actor.email, displayName: actor.displayName ?? "Editor", role: "editor" } : null
  };
}

beforeEach(() => {
  database = openDatabase();
});

afterEach(() => {
  database.close();
});

describe("songbook domain services", () => {
  it("resolves the current role for each protected request", () => {
    const service = createSongbookService(database, { roleResolver: roleResolver() });
    expect(() => service.createSong(owner, songInput())).not.toThrow();
    expect(() => service.createSong({ email: "revoked@example.com" }, songInput({ tjNumber: "54321" }))).toThrowError(DomainError);
    expect(() => service.softDeleteSong(editor, { id: "missing", expectedVersion: 1, clientRequestId: crypto.randomUUID() })).toThrowError(/권한/);
  });

  it("creates, searches, and returns anonymous public catalog rows", () => {
    const service = createSongbookService(database, { roleResolver: roleResolver() });
    const created = service.createSong(editor, songInput({ title: "フォニイ", artist: "ツミキ", tjNumber: "52537", titleRomanized: "phony" }));
    expect(service.catalog().map((song) => song.id)).toEqual([created.id]);
    expect(service.search("phony")[0]?.id).toBe(created.id);
    service.createSong(owner, songInput({ title: "Hidden", artist: "Artist 2", tjNumber: "99999", status: "deleted", clientRequestId: crypto.randomUUID() }));
    expect(service.catalog()).toHaveLength(1);
  });

  it("rejects duplicates and reports version conflicts", () => {
    const service = createSongbookService(database, { roleResolver: roleResolver() });
    const first = service.createSong(owner, songInput());
    expect(Object.hasOwn(first, "clientRequestId")).toBe(false);
    expect(() => service.createSong(editor, songInput({ clientRequestId: crypto.randomUUID() }))).toThrowError(DomainError);
    expect(() => service.updateSong(editor, { id: first.id, expectedVersion: 99, clientRequestId: crypto.randomUUID(), title: "Changed" })).toThrowError(/다른 곳/);
    const updated = service.updateSong(editor, { id: first.id, expectedVersion: 1, clientRequestId: crypto.randomUUID(), title: "Changed" });
    expect(updated.title).toBe("Changed");
    expect(Object.hasOwn(updated, "clientRequestId")).toBe(false);
    expect(Object.hasOwn(updated, "expectedVersion")).toBe(false);
  });

  it("makes mutations replay-safe and audits the successful operation once", () => {
    const service = createSongbookService(database, { roleResolver: roleResolver() });
    const clientRequestId = crypto.randomUUID();
    const first = service.createSong(owner, songInput({ clientRequestId }));
    const replay = service.createSong(owner, songInput({ clientRequestId }));
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
    const created = service.createSong(owner, songInput());
    const clientRequestId = crypto.randomUUID();
    const input = { id: created.id, expectedVersion: created.version, clientRequestId, title: "Updated" };
    const updated = service.updateSong(editor, input);
    expect(Object.hasOwn(updated, "clientRequestId")).toBe(false);
    expect(Object.hasOwn(updated, "expectedVersion")).toBe(false);
    const stored = database.sqlite.prepare("SELECT response_json FROM idempotency_keys WHERE key=?").get(clientRequestId) as { response_json: string };
    expect(Object.hasOwn(JSON.parse(stored.response_json), "clientRequestId")).toBe(false);
    expect(Object.hasOwn(JSON.parse(stored.response_json), "expectedVersion")).toBe(false);
    const replay = service.updateSong(editor, input);
    expect(replay).toEqual(updated);
    expect(Object.hasOwn(replay, "clientRequestId")).toBe(false);
    expect(Object.hasOwn(replay, "expectedVersion")).toBe(false);
  });

  it("rolls back the mutation and idempotency claim when audit writing fails", () => {
    const auditFailure = { append: () => { throw new Error("audit unavailable"); }, list: () => [] };
    const service = createSongbookService(database, { roleResolver: roleResolver(), auditRepository: auditFailure });
    const clientRequestId = crypto.randomUUID();
    expect(() => service.createSong(owner, songInput({ clientRequestId }))).toThrow("audit unavailable");
    expect(createSongRepository(database.sqlite).list({ includeDeleted: true })).toHaveLength(0);
    expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM idempotency_keys WHERE key=?").get(clientRequestId)).toEqual({ count: 0 });
  });

  it("supports owner-only soft delete and restore while reserving TJ numbers", () => {
    const service = createSongbookService(database, { roleResolver: roleResolver() });
    const created = service.createSong(editor, songInput());
    expect(() => service.softDeleteSong(editor, { id: created.id, expectedVersion: 1, clientRequestId: crypto.randomUUID() })).toThrowError(/권한/);
    const deleted = service.softDeleteSong(owner, { id: created.id, expectedVersion: 1, clientRequestId: crypto.randomUUID() });
    expect(deleted.deletedAt).toBeTruthy();
    expect(() => service.createSong(owner, songInput({ clientRequestId: crypto.randomUUID() }))).toThrowError(DomainError);
    const restored = service.restoreSong(owner, { id: created.id, expectedVersion: deleted.version, clientRequestId: crypto.randomUUID() });
    expect(restored.deletedAt).toBe("");
  });

  it("creates, counts, and cancels performance records", () => {
    const service = createSongbookService(database, { roleResolver: roleResolver() });
    const created = service.createSong(editor, songInput());
    const performance = service.createPerformance(editor, { songId: created.id, keySelection: null, memo: "", performedAt: "2026-08-13T10:00:00.000Z", clientRequestId: crypto.randomUUID() });
    expect(service.performanceStats(created.id)).toEqual({ count: 1, lastPerformedAt: "2026-08-13T10:00:00.000Z" });
    expect(service.cancelPerformance(editor, { performanceId: performance.id, expectedVersion: 1, clientRequestId: crypto.randomUUID() }).cancelledAt).toBeTruthy();
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
