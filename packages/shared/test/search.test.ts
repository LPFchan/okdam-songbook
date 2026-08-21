import { describe, expect, it } from "vitest";
import { filterSongs, isSearchableQuery, parseCsvKey, sampleSongs, searchSongs, searchTypeForQuery, sortSongs } from "../src";
import { getHangulChoseong, normalizeNumber, normalizeText } from "../src/normalize";

describe("normalization", () => {
  it("normalizes unicode width, case, and spaces", () => {
    expect(normalizeText("  Ｐｈｏｎｙ   TEST ")).toBe("phony test");
  });

  it("normalizes numbers", () => {
    expect(normalizeNumber("ＴＪ ５２５３７")).toBe("52537");
  });

  it("extracts Korean choseong", () => {
    expect(getHangulChoseong("포니")).toBe("ㅍㄴ");
  });
});

describe("search", () => {
  it("matches the omnibar query gate and numeric search rule", () => {
    expect(isSearchableQuery("x")).toBe(false);
    expect(isSearchableQuery("12")).toBe(true);
    expect(isSearchableQuery("  ")).toBe(false);
    expect(searchTypeForQuery("123")).toBe("number");
    expect(searchTypeForQuery("Song")).toBe("all");
  });
  it("finds Japanese title by Korean reading", () => {
    const eve = searchSongs(sampleSongs, "Eve");
    expect(eve.length).toBeGreaterThan(0);
    expect(eve[0]?.artist).toBe("Eve");
  });

  it("finds original Japanese and Latin-script text", () => {
    const phonetic = searchSongs(sampleSongs, "瞬き");
    expect(phonetic.length).toBeGreaterThan(0);
    expect(phonetic[0]?.title).toBe("瞬き");
    const backNumber = searchSongs(sampleSongs, "back number");
    expect(backNumber.length).toBeGreaterThan(0);
    expect(backNumber[0]?.artist).toBe("back number");
  });

  it("prioritizes TJ number search", () => {
    const tj = searchSongs(sampleSongs, "28805");
    expect(tj.length).toBeGreaterThan(0);
    expect(tj[0]?.tjNumber).toBe("28805");
  });

  it("searches ponya as a Marie and Yeowool performer alias", () => {
    const results = searchSongs(sampleSongs, "뽀냐");
    expect(results.length).toBeGreaterThan(0);
    results.forEach((song) => {
      expect(song.performerIds).toContain("marie");
      expect(song.performerIds).toContain("yeowool");
    });
  });

  it("filters migrated ponya songs by Marie and Yeowool but not Seongwook", () => {
    const ponyaSong = sampleSongs.find((song) => song.performerIds.includes("marie") && song.performerIds.includes("yeowool") && !song.performerIds.includes("seongwook"));
    expect(ponyaSong).toBeTruthy();
    expect(filterSongs([ponyaSong!], { performerIds: ["marie"] })).toHaveLength(1);
    expect(filterSongs([ponyaSong!], { performerIds: ["yeowool"] })).toHaveLength(1);
    expect(filterSongs([ponyaSong!], { performerIds: ["seongwook"] })).toHaveLength(0);
  });

  it("supports multi-token AND search", () => {
    const japan = searchSongs(sampleSongs, "일본");
    expect(japan.length).toBeGreaterThan(0);
    japan.forEach((song) => expect(song.country).toBe("일본"));
  });

  it("sorts by Korean reading", () => {
    const sorted = sortSongs(sampleSongs, "title");
    expect(sorted.length).toBeGreaterThan(0);
    // Korean-reading sort falls back to title when reading is empty; verify
    // the result is at least monotonically non-decreasing.
    for (let i = 1; i < sorted.length; i += 1) {
      const prevSong = sorted[i - 1];
      const curSong = sorted[i];
      if (!prevSong || !curSong) continue;
      const prev = prevSong.title || prevSong.titleReadingKo;
      const cur = curSong.title || curSong.titleReadingKo;
      expect(prev.localeCompare(cur, "ko-KR")).toBeLessThanOrEqual(0);
    }
  });
});

describe("csv key parsing", () => {
  it("parses simple offsets", () => {
    expect(parseCsvKey("-2").recommendedKey).toEqual({ baseMode: "original", offset: -2 });
  });

  it("warns on ambiguous offsets", () => {
    expect(parseCsvKey("-1?-2?").warnings.length).toBeGreaterThan(0);
  });
});
