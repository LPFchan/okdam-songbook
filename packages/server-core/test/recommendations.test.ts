import { describe, expect, it, vi } from "vitest";
import { songSchema, type Song, type TjSearchResult } from "@songbook/shared";
import {
  createTjSearchMirror,
  readTjCredits,
  recommendSongs,
  TjAdapterError,
  topRecommendationPeople,
  type DamAdapter,
  type TjAdapter,
  type TjCredits
} from "../src/index.js";
import { openFakeDatabase } from "./fake-d1.js";

function song(id: string, artist: string, overrides: Partial<Song> = {}): Song {
  return songSchema.parse({ id, title: `Title ${id}`, artist, tjNumber: id, performerIds: ["marie"], createdAt: `2026-01-0${id.slice(-1)}T00:00:00.000Z`, ...overrides });
}

function tjResult(query: string, candidates: TjSearchResult["candidates"] = []): TjSearchResult {
  return { query, searchType: "artist", nation: "", page: 1, pageSize: 30, hasMore: false, candidates, sourceUrl: "https://tj.example/search" };
}

describe("recommendation people", () => {
  it("ranks by saved songs, then artists first, then the most recently added", () => {
    const songs = [song("1", "페퍼톤스"), song("2", "페퍼톤스"), song("3", "실리카겔"), song("4", "실리카 겔"), song("5", "TAK(feat.初音ミク)"), song("6", "Other")];
    const credits = new Map<string, TjCredits>([
      ["1", { composer: "신재평", lyricist: "신재평" }],
      ["2", { composer: "신재평", lyricist: "신재평,이장원" }],
      ["6", { composer: "TAK", lyricist: "" }]
    ]);
    expect(topRecommendationPeople(songs, credits, 4)).toEqual([
      { name: "TAK", role: "artist", songCount: 2 },
      { name: "실리카겔", role: "artist", songCount: 2 },
      { name: "페퍼톤스", role: "artist", songCount: 2 },
      { name: "신재평", role: "composer", songCount: 2 }
    ]);
  });
});

describe("recommendSongs", () => {
  it("searches TJ by each person's role and waits out the rate limit", async () => {
    let calls = 0;
    const search = vi.fn(async (input: { query: string }) => {
      calls += 1;
      if (calls === 2) throw new TjAdapterError("TJ_RATE_LIMITED", "잠시 제한", true);
      return tjResult(input.query, [{ tjNumber: "999", title: "New", artist: input.query, lyricist: "", composer: "", sourceUrl: "https://tj.example/search" }]);
    });
    const tj = { search, lookup: vi.fn() } as unknown as TjAdapter;
    const sleep = vi.fn(async () => {});
    const groups = await recommendSongs({
      catalog: [song("1", "A"), song("2", "A"), song("3", "B", { performerIds: ["yeowool"] })],
      performerIds: ["marie"],
      system: "tj",
      credits: async () => new Map([["1", { composer: "C", lyricist: "" }]]),
      tj,
      sleep
    });
    expect(groups.map((group) => [group.name, group.role, group.candidates.length, group.error])).toEqual([["A", "artist", 1, null], ["C", "composer", 1, null]]);
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ query: "C", searchType: "composer", pageSize: 30 }));
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it("only learns from songs with a DAM number in DAM mode and reports per-person failures", async () => {
    const dam: DamAdapter = { search: vi.fn(async () => { throw new Error("down"); }) };
    const groups = await recommendSongs({
      catalog: [song("1", "A", { damNumber: "1234-56" }), song("2", "B")],
      performerIds: ["marie"],
      system: "dam",
      credits: async () => new Map(),
      dam
    });
    expect(groups).toEqual([{ name: "A", role: "artist", songCount: 1, candidates: [], error: "검색하지 못했어." }]);
  });
});

describe("readTjCredits", () => {
  it("returns composer and lyricist for mirrored TJ numbers only", async () => {
    const database = openFakeDatabase();
    const sourceUrl = "https://www.tjmedia.com/song/accompaniment_search?x";
    await createTjSearchMirror(database.sqlite).replace({ ...tjResult("x"), sourceUrl, candidates: [{ tjNumber: "10", title: "T", artist: "A", lyricist: "L", composer: "C", sourceUrl }] }, "2026-10-10T00:00:00.000Z", "2026-10-10T00:00:00.000Z");
    const credits = await readTjCredits(database.sqlite, ["10", "11", ""]);
    expect([...credits]).toEqual([["10", { composer: "C", lyricist: "L" }]]);
  });
});
