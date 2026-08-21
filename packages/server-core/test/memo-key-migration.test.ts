import { migrateMemoKey } from "@songbook/shared";
import { describe, expect, it } from "vitest";
// The migration script is a plain .mjs one-shot ops tool; load it untyped.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { migrateRow } from "../../scripts/migrate-memo-keys.mjs";

describe("migrate-memo-keys script", () => {
  it("moves a whole-line key notation into keyCandidates and keeps the rest of the memo", () => {
    const result = migrateRow("여+1\n브릿지 고음 주의", "[]");
    expect(result).not.toBeNull();
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ baseMode: "female", offset: 1, isPrimary: true });
    expect(result.memo).toBe("브릿지 고음 주의");
  });

  it("leaves rows that already have key candidates untouched", () => {
    const existing = JSON.stringify([{ id: "k1", baseMode: "male", offset: -2, label: "", memo: "", isPrimary: true }]);
    expect(migrateRow("여+2", existing)).toBeNull();
  });

  it("does not guess on prose that merely mentions a key", () => {
    expect(migrateRow("여+1로 부르면 편함", "[]")).toBeNull();
  });

  it("handles mode-only and offset-only notations", () => {
    const modeOnly = migrateRow("여키", "[]");
    expect(modeOnly.candidates[0]).toMatchObject({ baseMode: "female", offset: 0 });
    const offsetOnly = migrateRow("-2", "[]");
    expect(offsetOnly.candidates[0]).toMatchObject({ baseMode: "original", offset: -2 });
  });

  it("matches the shared migrateMemoKey behavior", () => {
    const shared = migrateMemoKey("남 -1\n후렴에서 쉬기", () => "fixed-id");
    const script = migrateRow("남 -1\n후렴에서 쉬기", "[]");
    expect(script.candidates[0]).toMatchObject({ baseMode: "male", offset: -1 });
    expect(script.memo).toBe(shared.memo);
  });
});
