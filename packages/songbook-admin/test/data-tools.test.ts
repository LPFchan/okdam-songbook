import { describe, expect, it } from "vitest";
import { openDatabase } from "@songbook/server-core";
import { AdminAuthorizationError, createSongbookAdmin } from "../src/index.js";

const song = { id: "song-1", tjNumber: "12345", title: "Title", artist: "Artist", titleAliases: [], artistAliases: [], keyCandidates: [], performerIds: [], status: "active", createdAt: "2026-08-13T00:00:00.000Z", updatedAt: "2026-08-13T00:00:00.000Z" };

describe("allowlisted data tools", () => {
  it("denies unknown roles and supports dry-run, apply, reconcile, and rollback export", () => {
    const database = openDatabase();
    const source = { songs: [song], performances: [], changeLog: [] };
    const unknown = createSongbookAdmin(database, { email: "unknown@example.com", role: "unknown" as never });
    expect(() => unknown.importDryRun(source)).toThrow(AdminAuthorizationError);
    const allowed = createSongbookAdmin(database, { email: "allowed@example.com", role: "allowed" });
    expect(allowed.importDryRun(source).songs[0]?.action).toBe("insert");
    expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM songs").get()).toEqual({ count: 0 });
    expect(allowed.importApply(source).inserted).toBe(1);
    expect(allowed.reconcile(source).zeroDiff).toBe(true);
    expect(allowed.rollbackExport().songs).toContain("song-1");
    database.close();
  });
});
