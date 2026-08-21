import { describe, expect, it, vi } from "vitest";
import { createAiReadingGenerator } from "../src/reading.js";

describe("AI reading generator", () => {
  it("calls an OpenAI-compatible endpoint and validates its JSON result", async () => {
    let capturedUrl: string | URL | Request = "";
    let capturedInit: Parameters<typeof fetch>[1];
    const fetcher: typeof fetch = vi.fn(async (input, init) => {
      capturedUrl = input;
      capturedInit = init;
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ titleReadingKo: "하츠네 미쿠", artistReadingKo: "하츠네 미쿠" }) } }]
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const generator = createAiReadingGenerator({
      endpoint: "https://ai.example/v1/chat/completions",
      apiKey: "secret",
      model: "reading-model",
      fetch: fetcher
    });

    await expect(generator.generate({ title: "初音ミク", artist: "初音ミク" })).resolves.toEqual({
      titleReadingKo: "하츠네 미쿠",
      artistReadingKo: "하츠네 미쿠"
    });
    expect(capturedUrl).toBe("https://ai.example/v1/chat/completions");
    expect(capturedInit?.headers).toMatchObject({ Authorization: "Bearer secret" });
    const body = JSON.parse(String(capturedInit?.body));
    expect(body.model).toBe("reading-model");
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages.at(-1).content).toBe(JSON.stringify({ title: "初音ミク", artist: "初音ミク" }));
  });

  it("rejects invalid provider output", async () => {
    const generator = createAiReadingGenerator({
      endpoint: "https://ai.example/v1/chat/completions",
      apiKey: "secret",
      model: "reading-model",
      fetch: async () => Response.json({ choices: [{ message: { content: "not json" } }] })
    });
    await expect(generator.generate({ title: "曲", artist: "歌手" })).rejects.toMatchObject({ code: "EXTERNAL_API_ERROR" });
  });

  it("does not expose provider response bodies in upstream errors", async () => {
    const generator = createAiReadingGenerator({
      endpoint: "https://ai.example/v1/chat/completions",
      apiKey: "secret",
      model: "reading-model",
      fetch: async () => new Response("provider secret details", { status: 429 })
    });
    await expect(generator.generate({ title: "曲", artist: "歌手" })).rejects.toMatchObject({
      code: "EXTERNAL_API_ERROR",
      details: { status: 429 }
    });
  });
});
