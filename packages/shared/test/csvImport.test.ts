import { describe, expect, it } from "vitest";
import { importSongsFromCsv } from "../src/csvImport";

describe("importSongsFromCsv", () => {
  it("imports the OK DAM private page CSV", () => {
    const rows = [
      { title: "レーゾンデートル", tjNumber: "28805", artist: "Eve", country: "일본", recommender: "여울", key: "0", createdAt: "2022년 3월 20일 오후 9:40" },
      { title: "春雷", tjNumber: "28795", artist: "米津玄師", country: "일본", recommender: "여울", key: "-2", createdAt: "2022년 3월 20일 오후 9:40" },
      { title: "瞬き", tjNumber: "28816", artist: "back number", country: "일본", recommender: "여울", key: "여+2", createdAt: "2022년 3월 20일 오후 9:40" },
      { title: "Dreaming", tjNumber: "27360", artist: "FreeTEMPO", country: "일본", recommender: "마리", key: "", createdAt: "2024년 7월 14일 오후 5:51" },
      { title: "Tik Tak Tok", tjNumber: "84434", artist: "실리카 겔", country: "한국", recommender: "뽀냐", key: "", createdAt: "2024년 7월 14일 오후 5:49" }
    ];
    const report = importSongsFromCsv(rows, { csvFileName: "test.csv", generatedAt: "2026-07-01T00:00:00Z" });
    expect(report.totalRows).toBe(5);
    expect(report.inserted).toBe(5);
    expect(report.skipped).toBe(0);
    const eve = report.songs.find((song) => song.artist === "Eve");
    expect(eve?.recommendedKey).toEqual({ baseMode: "original", offset: 0 });
    const backNumber = report.songs.find((song) => song.artist === "back number");
    expect(backNumber?.recommendedKey).toEqual({ baseMode: "female", offset: 2 });
    const spring = report.songs.find((song) => song.artist === "米津玄師");
    expect(spring?.recommendedKey).toEqual({ baseMode: "original", offset: -2 });
    const tikTakTok = report.songs.find((song) => song.title === "Tik Tak Tok");
    expect(tikTakTok?.performerIds).toEqual(["marie", "yeowool"]);
    expect(tikTakTok?.memo).not.toContain("추천인");
  });

  it("deduplicates by TJ number and by (title, artist)", () => {
    const rows = [
      { title: "배불러", tjNumber: "46528", artist: "이진아" },
      { title: "배불러", tjNumber: "46528", artist: "이진아" },
      { title: "Run", tjNumber: "98128", artist: "이진아 (with 그레이)" },
      { title: "Run", tjNumber: "98129", artist: "이진아 (with 그레이)" }
    ];
    const report = importSongsFromCsv(rows, { csvFileName: "test.csv" });
    expect(report.inserted).toBe(2);
    expect(report.skipped).toBe(2);
  });

  it("stores anime imports as Japanese songs", () => {
    const report = importSongsFromCsv([{
      title: "オレンジ",
      tjNumber: "28187",
      artist: "とらドラ!",
      country: "아니메"
    }], { csvFileName: "test.csv" });

    expect(report.songs[0]).toMatchObject({ country: "일본" });
  });

  it("preserves ambiguous key values as warnings", () => {
    const rows = [
      { title: "A", tjNumber: "1", artist: "X", key: "-1?-2?" },
      { title: "B", tjNumber: "2", artist: "X", key: "남" }
    ];
    const report = importSongsFromCsv(rows, { csvFileName: "test.csv" });
    expect(report.warnings).toBe(2);
    expect(report.songs.find((s) => s.title === "A")?.recommendedKey).toBeNull();
    const b = report.songs.find((s) => s.title === "B");
    expect(b?.recommendedKey).toEqual({ baseMode: "male", offset: 0 });
    expect(b?._warnings.length).toBeGreaterThan(0);
  });

  it("moves generated recommender memo into performerIds", () => {
    const rows = [
      { title: "A", tjNumber: "1", artist: "X", memo: "추천인 뽀냐 / 후렴 높음" },
      { title: "B", tjNumber: "2", artist: "Y", memo: "추천인 성욱 · 컨디션 좋을 때" }
    ];
    const report = importSongsFromCsv(rows, { csvFileName: "test.csv" });
    expect(report.songs[0]?.performerIds).toEqual(["marie", "yeowool"]);
    expect(report.songs[0]?.memo).toBe("후렴 높음");
    expect(report.songs[1]?.performerIds).toEqual(["seongwook"]);
    expect(report.songs[1]?.memo).toBe("컨디션 좋을 때");
    expect(report.memoRecommenderRemoved).toBe(2);
  });
});
