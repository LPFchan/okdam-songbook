import { describe, expect, it } from "vitest";
import { buildDamKeywordRequest, isDamNumberQuery, normalizeDamNumber, parseDamDetailResponse, parseDamKeywordResponse, sampleSongs, searchSongs, sortSongs } from "../src/index.js";

describe("DAM numbers", () => {
  it("normalizes the ways people type a request number", () => {
    expect(normalizeDamNumber("1472-59")).toBe("1472-59");
    expect(normalizeDamNumber("147259")).toBe("1472-59");
    expect(normalizeDamNumber("１４７２ ５９")).toBe("1472-59");
    expect(normalizeDamNumber("フォニイ")).toBeNull();
    expect(isDamNumberQuery("1472-59")).toBe(true);
    expect(isDamNumberQuery("52537")).toBe(false);
  });

  it("builds the keyword request DAM's own page sends", () => {
    const request = buildDamKeywordRequest({ query: " loser ", page: 2, pageSize: 15 });
    expect(request.url).toMatch(/SearchVariousByKeywordApi$/);
    expect(JSON.parse(request.body)).toMatchObject({ keyword: "loser", pageNo: "2", dispCount: "15", sort: "1" });
  });

  it("parses keyword and detail responses, and rejects unknown shapes", () => {
    const ok = { result: { statusCode: "0000" } };
    expect(parseDamKeywordResponse({ ...ok, data: { hasNext: "0" }, list: [{ requestNo: "3246-30", title: "LOSER", artist: "米津玄師" }] }))
      .toMatchObject({ hasMore: false, candidates: [{ damNumber: "3246-30", sourceUrl: expect.stringContaining("requestNo=3246-30") }] });
    expect(parseDamDetailResponse({ ...ok, data: { requestNo: "9999-99" } })).toBeNull();
    expect(() => parseDamKeywordResponse({ result: { statusCode: "0000" } })).toThrow("DAM_PARSER_DRIFT");
  });
});

describe("searching and sorting by DAM number", () => {
  const songs = sampleSongs.slice(0, 3).map((song, index) => ({ ...song, damNumber: ["", "3246-30", "1472-59"][index]! }));

  it("finds a song by its DAM number with or without the hyphen", () => {
    expect(searchSongs(songs, "324630").map((song) => song.damNumber)).toEqual(["3246-30"]);
    expect(searchSongs(songs, "3246-30").map((song) => song.damNumber)).toEqual(["3246-30"]);
  });

  it("puts songs without a DAM number last", () => {
    expect(sortSongs(songs, "damNumber").map((song) => song.damNumber)).toEqual(["1472-59", "3246-30", ""]);
  });
});
