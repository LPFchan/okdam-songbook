import { beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { applyImport, exportRollback, exportSheetCsv, ImportValidationError, openDatabase, prepareImport, reconcileImport } from "../src/index.js";

const seedPayload = JSON.parse(readFileSync(new URL("../../../apps-script/seed/songs.json", import.meta.url), "utf8")) as { songs: unknown[] };

const baseSong = (overrides: Record<string, unknown> = {}) => ({
  id: "song-1", tjNumber: "12345", title: "Title", artist: "Artist", titleAliases: [], artistAliases: [], genres: [], keyCandidates: [], performerIds: [], status: "active", createdAt: "2026-08-13T00:00:00.000Z", updatedAt: "2026-08-13T00:00:00.000Z", ...overrides
});

describe("database migration tools", () => {
  let database: ReturnType<typeof openDatabase>;
  beforeEach(() => { database = openDatabase(); });

  it("is repeatable and a dry-run does not mutate", () => {
    const source = { songs: [baseSong()], performances: [], changeLog: [] };
    const plan = prepareImport(database, source);
    expect(plan.valid).toBe(true);
    expect(plan.songs[0]?.action).toBe("insert");
    expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM songs").get()).toEqual({ count: 0 });
    expect(applyImport(database, source).inserted).toBe(1);
    const second = applyImport(database, source);
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.unchanged).toBe(1);
    database.close();
  });

  it("updates a changed source deterministically while retaining identity and supplied version", () => {
    const source = { songs: [baseSong()], performances: [], changeLog: [] };
    applyImport(database, source);
    const changed = { songs: [baseSong({ title: "Changed", version: 4, updatedAt: "2026-08-14T00:00:00.000Z" })], performances: [], changeLog: [] };
    expect(applyImport(database, changed).updated).toBe(1);
    const row = database.sqlite.prepare("SELECT id,title,created_at,version FROM songs").get() as Record<string, unknown>;
    expect(row).toEqual({ id: "song-1", title: "Changed", created_at: "2026-08-13T00:00:00.000Z", version: 4 });
    database.close();
  });

  it("accepts Apps Script seed JSON and Sheet-compatible CSV, rejecting malformed input", () => {
    const jsonSource = JSON.stringify({ songs: [baseSong({ title: "Comma, song", memo: "line\nquoted" })] });
    applyImport(database, jsonSource);
    const csv = exportSheetCsv(database, "Songs");
    const other = openDatabase();
    expect(applyImport(other, csv).inserted).toBe(1);
    expect(() => prepareImport(database, "id,title,artist\n\"unterminated,Title,Artist")).toThrow(ImportValidationError);
    expect(() => prepareImport(database, "{not-json")).toThrow(ImportValidationError);
    other.close();
    database.close();
  });

  it("imports the shipped Apps Script seed shape repeatedly", () => {
    const first = applyImport(database, seedPayload, { generatedAt: "2026-08-13T00:00:00.000Z" });
    expect(first.inserted).toBe(seedPayload.songs.length);
    const second = applyImport(database, seedPayload, { generatedAt: "2026-08-13T00:00:00.000Z" });
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(0);
    expect(second.unchanged).toBe(seedPayload.songs.length);
    expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM songs").get()).toEqual({ count: seedPayload.songs.length });
    database.close();
  });

  it("remaps related rows when a source song matches an existing TJ number", () => {
    applyImport(database, { songs: [baseSong()], performances: [], changeLog: [] });
    const source = {
      songs: [baseSong({ id: "source-song", title: "Renamed from source" })],
      performances: [{ id: "performance-remapped", songId: "source-song", performedAt: "2026-08-13T01:00:00.000Z", clientRequestId: "request-remapped", version: 1 }],
      changeLog: [{ id: "audit-remapped", entityType: "Song", entityId: "source-song", action: "update", beforeJson: null, afterJson: { id: "source-song" }, createdAt: "2026-08-13T00:00:00.000Z", entityVersionBefore: 1, entityVersionAfter: 2 }]
    };
    applyImport(database, source);
    expect(database.sqlite.prepare("SELECT song_id FROM performances WHERE id=?").get("performance-remapped")).toEqual({ song_id: "song-1" });
    expect(database.sqlite.prepare("SELECT entity_id FROM audit_events WHERE id=?").get("audit-remapped")).toEqual({ entity_id: "song-1" });
    database.close();
  });

  it("rejects duplicate performance and audit identities before apply", () => {
    const duplicatePerformances = { songs: [baseSong()], performances: [
      { id: "same", songId: "song-1", performedAt: "2026-08-13T01:00:00.000Z", clientRequestId: "request-a" },
      { id: "same", songId: "song-1", performedAt: "2026-08-13T02:00:00.000Z", clientRequestId: "request-b" }
    ], changeLog: [] };
    expect(() => prepareImport(database, duplicatePerformances)).toThrowError(/Duplicate performance id/);
    const duplicateRequests = { ...duplicatePerformances, performances: [
      { id: "one", songId: "song-1", performedAt: "2026-08-13T01:00:00.000Z", clientRequestId: "same-request" },
      { id: "two", songId: "song-1", performedAt: "2026-08-13T02:00:00.000Z", clientRequestId: "same-request" }
    ] };
    expect(() => prepareImport(database, duplicateRequests)).toThrowError(/Duplicate performance clientRequestId/);
    const duplicateAudits = { songs: [baseSong()], performances: [], changeLog: [
      { id: "same-audit", entityType: "Song", entityId: "song-1", action: "create", createdAt: "2026-08-13T00:00:00.000Z" },
      { id: "same-audit", entityType: "Song", entityId: "song-1", action: "update", createdAt: "2026-08-13T00:00:01.000Z" }
    ] };
    expect(() => prepareImport(database, duplicateAudits)).toThrowError(/Duplicate audit id/);
    database.close();
  });

  it("preserves performances and the complete supplied ChangeLog", () => {
    const source = {
      songs: [baseSong()],
      performances: [{ id: "performance-1", songId: "song-1", performedAt: "2026-08-13T01:00:00.000Z", clientRequestId: "request-1", version: 2 }],
      changeLog: [{ id: "audit-1", entityType: "Song", entityId: "song-1", action: "create", beforeJson: null, afterJson: { id: "song-1" }, actorEmail: "owner@example.com", actorName: "Owner", actorRole: "owner", createdAt: "2026-08-13T00:00:00.000Z", clientRequestId: "request-1", entityVersionBefore: null, entityVersionAfter: 1 }]
    };
    const options = { generatedAt: "2026-08-13T00:00:00.000Z" };
    applyImport(database, source, options);
    const report = reconcileImport(database, source, options);
    expect(report.zeroDiff).toBe(true);
    expect(report.auditCompleteness).toEqual({ source: 1, destination: 1, missing: [], extra: [] });
    expect(exportRollback(database).changeLog).toContain("audit-1");
    database.close();
  });

  it("reports unexplained source/destination differences", () => {
    const source = { songs: [baseSong()], performances: [], changeLog: [] };
    applyImport(database, source);
    database.sqlite.prepare("UPDATE songs SET title='local edit', version=9 WHERE id='song-1'").run();
    const report = reconcileImport(database, source);
    expect(report.zeroDiff).toBe(false);
    expect(report.songs[0]?.status).toBe("changed");
    expect(report.unexplainedDiffs).toContain("song:song-1:changed");
    database.close();
  });
});
