import { describe, expect, it } from "vitest";
import { isSongCountry } from "../src/country";

describe("song countries", () => {
  it("accepts only the four country chips", () => {
    expect(["일본", "미국", "한국", "그 외"].every(isSongCountry)).toBe(true);
    expect(isSongCountry("USA")).toBe(false);
    expect(isSongCountry("")).toBe(false);
  });
});
