import { afterEach, describe, expect, it, vi } from "vitest";
import { ParsedApiError, searchTjSongs } from "../lib/api";

describe("api errors", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rejects with an Error that carries the server's message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ ok: false, data: null, error: { code: "TJ_PARSER_ERROR", message: "TJ 검색 결과 형식을 읽지 못했어." }, requestId: "r1", serverTime: "2026-10-08T02:00:00.000Z" }),
      { status: 502, headers: { "Content-Type": "application/json" } }
    )));
    const error = await searchTjSongs({ query: "마리", searchType: "all", nation: "", page: 1, pageSize: 15 }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ParsedApiError);
    expect(error).toMatchObject({ code: "TJ_PARSER_ERROR", status: 502, message: "TJ 검색 결과 형식을 읽지 못했어." });
  });
});
