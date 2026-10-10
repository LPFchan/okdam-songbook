import { describe, expect, it } from "vitest";
import { buildDamKeywordRequest, damSearchRequestSchema, rankDamCandidates, isDamNumberQuery, normalizeDamNumber, parseDamDetailResponse, parseDamKeywordResponse, sampleSongs, searchSongs, sortSongs } from "../src/index.js";

describe("DAM numbers", () => {
  it("normalizes the ways people type a request number", () => {
    expect(normalizeDamNumber("1472-59")).toBe("1472-59");
    expect(normalizeDamNumber("147259")).toBe("1472-59");
    expect(normalizeDamNumber("１４７２ ５９")).toBe("1472-59");
    expect(normalizeDamNumber("フォニイ")).toBeNull();
    // DAM numbers always have four digits before the hyphen.
    expect(normalizeDamNumber("123-45")).toBeNull();
    expect(isDamNumberQuery("1472-59")).toBe(true);
    expect(isDamNumberQuery("52537")).toBe(false);
  });

  it("builds the keyword request DAM's own page sends", () => {
    const request = buildDamKeywordRequest({ query: " loser ", page: 2, pageSize: 15 });
    expect(request.url).toMatch(/SearchVariousByKeywordApi$/);
    expect(JSON.parse(request.body)).toMatchObject({ keyword: "loser", pageNo: "2", dispCount: "15", sort: "2" });
  });

  it("puts title and artist matches ahead of lyric and composer matches", () => {
    const song = (damNumber: string, title: string, artist: string, artistYomi = "") =>
      ({ damNumber, title, artist, titleYomi: "", artistYomi, sourceUrl: `https://example.com/${damNumber}` });
    const ranked = rankDamCandidates("tak", [
      song("4332-95", "ultra soul", "B'z"),
      song("6540-80", "愛執～あいしゅう", "TAKAKO"),
      song("1465-67", "I Want You Back - From THE FIRST TAKE", "BE:FIRST"),
      song("2030-03", "I wish you were here", "TMG")
    ]);
    expect(ranked.map((candidate) => candidate.damNumber)).toEqual(["6540-80", "1465-67", "4332-95", "2030-03"]);
    const reading = { ...song("1063-30", "残酷な天使のテーゼ", "高橋洋子"), titleYomi: "ざんこくなてんしのてーぜ" };
    expect(rankDamCandidates("ザンコク", [song("4332-95", "ultra soul", "B'z"), reading])[0]).toBe(reading);
  });

  it("accepts page sizes up to DAM's 100-song limit", () => {
    expect(damSearchRequestSchema.parse({ query: "love", pageSize: 100 }).pageSize).toBe(100);
    expect(damSearchRequestSchema.safeParse({ query: "love", pageSize: 101 }).success).toBe(false);
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

  it("searches songs cached before DAM numbers existed", () => {
    const legacy = sampleSongs.slice(0, 2).map(({ damNumber: _omitted, ...song }) => song) as typeof songs;
    expect(() => searchSongs(legacy, "3246")).not.toThrow();
    expect(() => searchSongs(legacy, legacy[0]!.title)).not.toThrow();
  });

  it("puts songs without a DAM number last", () => {
    expect(sortSongs(songs, "damNumber").map((song) => song.damNumber)).toEqual(["1472-59", "3246-30", ""]);
  });
});
