import { describe, expect, it } from "vitest";
import { migratePerformerMemo, normalizePerformerIds, songSchema } from "../src";

describe("performer normalization", () => {
  it("maps ponya to Marie and Yeowool", () => {
    expect(normalizePerformerIds("뽀냐").ids).toEqual(["marie", "yeowool"]);
  });

  it("deduplicates ponya and Marie", () => {
    expect(normalizePerformerIds("뽀냐, 마리").ids).toEqual(["marie", "yeowool"]);
  });

  it("splits slash-separated performers", () => {
    expect(normalizePerformerIds("뽀냐/성욱").ids).toEqual(["marie", "yeowool", "seongwook"]);
  });

  it("maps Eunhu by Korean name and id", () => {
    expect(normalizePerformerIds("은후, eunhu, 여울").ids).toEqual(["eunhu", "yeowool"]);
  });

  it("keeps input order for whitespace-separated names", () => {
    expect(normalizePerformerIds("여울 마리").ids).toEqual(["yeowool", "marie"]);
  });

  it("migrates misspelled legacy ids", () => {
    expect(normalizePerformerIds(["seonguk", "yeoul"]).ids).toEqual(["seongwook", "yeowool"]);
  });

  it("removes generated recommender-only memo", () => {
    expect(migratePerformerMemo("추천인 뽀냐")).toMatchObject({
      ids: ["marie", "yeowool"],
      memo: "",
      removedCount: 1
    });
  });

  it("keeps memo text after generated recommender text", () => {
    expect(migratePerformerMemo("추천인 뽀냐 / 후렴 높음")).toMatchObject({
      ids: ["marie", "yeowool"],
      memo: "후렴 높음"
    });
    expect(migratePerformerMemo("추천인 성욱 · 컨디션 좋을 때")).toMatchObject({
      ids: ["seongwook"],
      memo: "컨디션 좋을 때"
    });
  });

  it("deduplicates performerIds in song schema and rejects unknown ids", () => {
    expect(songSchema.parse({ id: "s", title: "A", artist: "B", performerIds: ["marie", "marie"] }).performerIds).toEqual(["marie"]);
    expect(() => songSchema.parse({ id: "s", title: "A", artist: "B", performerIds: ["ponya"] })).toThrow();
  });
});
