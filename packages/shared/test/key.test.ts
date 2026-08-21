import { describe, expect, it } from "vitest";
import { migrateMemoKey, parseKeyText } from "../src/key.js";

describe("parseKeyText", () => {
  it.each([
    ["여+1", "female", 1],
    ["남 -2", "male", -2],
    ["여키", "female", 0],
    ["남", "male", 0],
    ["-3", "original", -3],
    ["+2", "original", 2]
  ])("parses %s", (text, baseMode, offset) => {
    const parsed = parseKeyText(text, () => "id-1");
    expect(parsed?.candidate).toMatchObject({ baseMode, offset, isPrimary: true });
    expect(parsed?.matchedText).toBe(text);
  });

  it.each(["여+1으로 불러요", "키는 여", "여+13", "", "브릿지 주의"])(
    "rejects %s",
    (text) => {
      expect(parseKeyText(text)).toBeNull();
    }
  );
});

describe("migrateMemoKey", () => {
  it("splits memo segments and keeps non-key text", () => {
    const result = migrateMemoKey("여+1\n후렴 고음 주의", () => "id-x");
    expect(result.candidates).toHaveLength(1);
    expect(result.memo).toBe("후렴 고음 주의");
    expect(result.matched).toEqual(["여+1"]);
  });

  it("returns the memo untouched when nothing matches", () => {
    const result = migrateMemoKey("2절 가사 헷갈림");
    expect(result.candidates).toHaveLength(0);
    expect(result.memo).toBe("2절 가사 헷갈림");
  });

  it("keeps only the first candidate primary", () => {
    const result = migrateMemoKey("여+1, 남-2", () => "id-y");
    expect(result.candidates.map((c) => c.isPrimary)).toEqual([true, false]);
  });
});
