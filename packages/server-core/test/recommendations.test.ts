import { describe, expect, it, vi } from "vitest";
import { songSchema, type Song, type TjSearchResult } from "@songbook/shared";
import { recommendSongs, TjAdapterError, topRecommendationPeople, type DamAdapter, type TjAdapter } from "../src/index.js";

function song(id: string, artist: string, overrides: Partial<Song> = {}): Song {
  return songSchema.parse({ id, title: `Title ${id}`, artist, tjNumber: id, performerIds: ["marie"], createdAt: `2026-01-0${id.slice(-1)}T00:00:00.000Z`, ...overrides });
}

function tjResult(query: string, candidates: TjSearchResult["candidates"] = []): TjSearchResult {
  return { query, searchType: "artist", nation: "", page: 1, pageSize: 30, hasMore: false, candidates, sourceUrl: "https://tj.example/search" };
}

describe("recommendation people", () => {
  it("ranks artists by saved songs, then the most recently added", () => {
    const songs = [song("1", "페퍼톤스"), song("2", "페퍼톤스"), song("3", "실리카겔"), song("4", "실리카 겔"), song("5", "TAK(feat.初音ミク)"), song("6", "Other"), song("7", "TAK")];
    expect(topRecommendationPeople(songs).slice(0, 3)).toEqual([
      { name: "TAK", songCount: 2 },
      { name: "실리카겔", songCount: 2 },
      { name: "페퍼톤스", songCount: 2 }
    ]);
  });
});

describe("recommendSongs", () => {
  it("searches TJ by artist, skipping songs without a TJ number, and waits out the rate limit", async () => {
    let calls = 0;
    const search = vi.fn(async (input: { query: string }) => {
      calls += 1;
      if (calls === 1) throw new TjAdapterError("TJ_RATE_LIMITED", "잠시 제한", true);
      return tjResult(input.query, [{ tjNumber: "999", title: "New", artist: input.query, lyricist: "", composer: "", sourceUrl: "https://tj.example/search" }]);
    });
    const tj = { search, lookup: vi.fn() } as unknown as TjAdapter;
    const sleep = vi.fn(async () => {});
    const { groups, hasMore } = await recommendSongs({
      catalog: [song("1", "A"), song("2", "A"), song("3", "B", { performerIds: ["yeowool"] }), song("4", "D", { tjNumber: "", damNumber: "1234-56" })],
      performerIds: ["marie"],
      system: "tj",
      tj,
      sleep
    });
    expect(groups.map((group) => [group.name, group.candidates.length, group.error])).toEqual([["A", 1, null]]);
    expect(hasMore).toBe(false);
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ query: "A", searchType: "artist", pageSize: 30 }));
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("only learns from songs with a DAM number in DAM mode and reports per-person failures", async () => {
    const dam: DamAdapter = { search: vi.fn(async () => { throw new Error("down"); }) };
    const { groups } = await recommendSongs({
      catalog: [song("1", "A", { damNumber: "1234-56" }), song("2", "B")],
      performerIds: ["marie"],
      system: "dam",
      dam
    });
    expect(groups).toEqual([{ name: "A", songCount: 1, candidates: [], error: "검색하지 못했어." }]);
  });

  it("keeps only the artist's own songs, solo or credited, from DAM keyword search", async () => {
    const hit = (damNumber: string, artist: string) => ({ damNumber, title: damNumber, artist, titleYomi: "", artistYomi: "", sourceUrl: "https://www.clubdam.com/" });
    const dam: DamAdapter = { search: vi.fn(async () => ({ query: "RADWIMPS", searchType: "all" as const, page: 1, pageSize: 30, hasMore: false, candidates: [hit("1111-01", "RADWIMPS"), hit("1111-02", "上白石萌音"), hit("1111-03", "RADWIMPS feat.Toaka"), hit("1111-04", "RADWIMPS×上白石萌音"), hit("1111-05", "RADWIMPSS")] })) };
    const { groups } = await recommendSongs({ catalog: [song("1", "RADWIMPS", { damNumber: "1234-56" })], performerIds: ["marie"], system: "dam", dam });
    expect(groups[0]!.candidates.map((candidate) => "damNumber" in candidate && candidate.damNumber)).toEqual(["1111-01", "1111-03", "1111-04"]);
  });

  it("pages through artists five at a time, skipping the ones already shown", async () => {
    const tj = { search: vi.fn(async (input: { query: string }) => tjResult(input.query)), lookup: vi.fn() } as unknown as TjAdapter;
    const catalog = ["1", "2", "3", "4", "5", "6", "7"].map((id) => song(id, `Artist ${id}`));
    const first = await recommendSongs({ catalog, performerIds: ["marie"], system: "tj", tj });
    // Artist 7 leaving the catalog between pages must not push Artist 2 out of reach.
    const second = await recommendSongs({ catalog: catalog.filter((entry) => entry.id !== "7"), performerIds: ["marie"], system: "tj", exclude: first.groups.map((group) => group.name), tj });
    expect([first.groups.length, first.hasMore, second.groups.map((group) => group.name), second.hasMore]).toEqual([5, true, ["Artist 2", "Artist 1"], false]);
  });
});
