import { describe, expect, it } from "vitest";
import { openDatabase } from "@songbook/server-core";
import { AdminAuthorizationError, createSongbookAdmin } from "../src/index.js";

const song = { id: "song-1", tjNumber: "12345", title: "Title", artist: "Artist", titleAliases: [], artistAliases: [], genres: [], keyCandidates: [], performerIds: [], status: "active", createdAt: "2026-08-13T00:00:00.000Z", updatedAt: "2026-08-13T00:00:00.000Z" };

describe("owner data tools", () => {
  it("denies editors and supports dry-run, apply, reconcile, and rollback export", () => {
    const database = openDatabase();
    const source = { songs: [song], performances: [], changeLog: [] };
    const editor = createSongbookAdmin(database, { email: "editor@example.com", role: "editor" });
    expect(() => editor.importDryRun(source)).toThrow(AdminAuthorizationError);
    const owner = createSongbookAdmin(database, { email: "owner@example.com", role: "owner" });
    expect(owner.importDryRun(source).songs[0]?.action).toBe("insert");
    expect(database.sqlite.prepare("SELECT COUNT(*) AS count FROM songs").get()).toEqual({ count: 0 });
    expect(owner.importApply(source).inserted).toBe(1);
    expect(owner.reconcile(source).zeroDiff).toBe(true);
    expect(owner.rollbackExport().songs).toContain("song-1");
    database.close();
  });
});
