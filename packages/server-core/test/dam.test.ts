import { beforeEach, describe, expect, it } from "vitest";
import { damSongUrl, type DamSongCandidate } from "@songbook/shared";
import { createDamAdapter, createSongbookService, DomainError, type DamFetcher, type RoleResolver, type SongbookService } from "../src/index.js";
import { openFakeDatabase } from "./fake-d1.js";

const allowed = { email: "allowed@example.com", displayName: "Allowed" };

function roleResolver(): RoleResolver {
  return {
    resolve: (actor) => actor.email === allowed.email
      ? { subject: `legacy-email:${actor.email}`, email: actor.email, displayName: allowed.displayName, role: "allowed" }
      : null
  };
}

function candidate(overrides: Partial<DamSongCandidate> = {}): DamSongCandidate {
  const damNumber = overrides.damNumber ?? "1472-59";
  return { damNumber, title: "フォニイ", artist: "ツミキ", titleYomi: "", artistYomi: "", sourceUrl: damSongUrl(damNumber), ...overrides };
}

let service: SongbookService;

beforeEach(() => {
  service = createSongbookService(openFakeDatabase(), { roleResolver: roleResolver() });
});

describe("adding songs from DAM", () => {
  it("creates a song that carries only the DAM number", async () => {
    const result = await service.createDamSong(allowed, candidate(), crypto.randomUUID());
    expect(result.outcome).toBe("created");
    expect(result.song).toMatchObject({ damNumber: "1472-59", tjNumber: "", sourceType: "clubdam", country: "일본" });
  });

  it("attaches the DAM number to a saved song with the same name", async () => {
    const saved = await service.createSong(allowed, {
      tjNumber: "52537", title: "フォニイ", titleReadingKo: "포니", artist: "ツミキ", artistReadingKo: "", country: "일본",
      recommendedKey: null, performerIds: [], memo: "", sourceType: "tjmedia", sourceReference: "", createdByName: "", updatedByName: "",
      clientRequestId: crypto.randomUUID()
    });
    const result = await service.createDamSong(allowed, candidate(), crypto.randomUUID());
    expect(result.outcome).toBe("linked");
    expect(result.song).toMatchObject({ id: saved.id, tjNumber: "52537", damNumber: "1472-59", titleReadingKo: "포니", version: 2 });
    expect(await service.catalog()).toHaveLength(1);
  });

  it("reports a DAM number that is already saved", async () => {
    await service.createDamSong(allowed, candidate(), crypto.randomUUID());
    const result = await service.createDamSong(allowed, candidate({ title: "Other", artist: "Someone" }), crypto.randomUUID());
    expect(result).toMatchObject({ outcome: "duplicate", duplicateKind: "damNumber", canOpen: true });
  });

  it("refuses to give two songs the same DAM number", async () => {
    await service.createDamSong(allowed, candidate(), crypto.randomUUID());
    const other = await service.createDamSong(allowed, candidate({ damNumber: "3246-30", title: "LOSER", artist: "米津玄師" }), crypto.randomUUID());
    const update = service.updateSong(allowed, { id: other.song!.id, expectedVersion: 1, damNumber: "1472-59", clientRequestId: crypto.randomUUID() });
    await expect(update).rejects.toMatchObject({ code: "DUPLICATE_DAM_NUMBER" });
  });
});

function jsonResponse(body: unknown, status = 200) {
  return { status, json: async () => body };
}

const ok = { result: { statusCode: "0000" } };

describe("DAM adapter", () => {
  it("looks request numbers up by number instead of keyword", async () => {
    const calls: string[] = [];
    const fetcher: DamFetcher = async (url, init) => {
      calls.push(url);
      expect(JSON.parse(init.body)).toMatchObject({ requestNo: "1472-59" });
      return jsonResponse({ ...ok, data: { requestNo: "1472-59", title: "フォニイ", artist: "ツミキ", titleYomi_Kana: "フォニイ" } });
    };
    const result = await createDamAdapter({ fetcher }).search({ query: "147259", page: 1, pageSize: 15 });
    expect(calls).toEqual([expect.stringContaining("GetMusicDetailInfoApi")]);
    expect(result).toMatchObject({ searchType: "number", hasMore: false, candidates: [{ damNumber: "1472-59", title: "フォニイ" }] });
  });

  it("parses keyword results and caches them", async () => {
    let calls = 0;
    const fetcher: DamFetcher = async () => {
      calls += 1;
      return jsonResponse({ ...ok, data: { hasNext: "1" }, list: [{ requestNo: "3246-30", title: "LOSER", artist: "米津玄師" }, { requestNo: "3246-30", title: "LOSER", artist: "米津玄師" }] });
    };
    const adapter = createDamAdapter({ fetcher });
    const first = await adapter.search({ query: "loser", page: 1, pageSize: 15 });
    await adapter.search({ query: "loser", page: 1, pageSize: 15 });
    expect(calls).toBe(1);
    expect(first).toMatchObject({ searchType: "all", hasMore: true, candidates: [{ damNumber: "3246-30" }] });
    expect(first.candidates).toHaveLength(1);
  });

  it("maps upstream failures, format drift, and throttling to DAM errors", async () => {
    const failing = createDamAdapter({ fetcher: async () => jsonResponse({}, 503) });
    await expect(failing.search({ query: "a", page: 1, pageSize: 15 })).rejects.toMatchObject({ code: "DAM_UPSTREAM_ERROR" });
    const drifted = createDamAdapter({ fetcher: async () => jsonResponse({ result: { statusCode: "9999" } }) });
    await expect(drifted.search({ query: "a", page: 1, pageSize: 15 })).rejects.toMatchObject({ code: "DAM_UPSTREAM_ERROR" });
    const throttled = createDamAdapter({ throttleLimit: 1, fetcher: async () => jsonResponse({ ...ok, data: {}, list: [] }) });
    await throttled.search({ query: "a", page: 1, pageSize: 15 });
    await expect(throttled.search({ query: "b", page: 1, pageSize: 15 })).rejects.toBeInstanceOf(DomainError);
  });
});
