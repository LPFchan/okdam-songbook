import { describe, expect, it } from "vitest";
import { readingGeneratorFromEnvironment } from "../src/main.js";

describe("reading AI environment", () => {
  it("stays optional when no reading settings are present", () => {
    expect(readingGeneratorFromEnvironment({})).toBeUndefined();
  });

  it("requires endpoint, key, and model as one complete group", () => {
    expect(() => readingGeneratorFromEnvironment({ AI_ENDPOINT: "https://ai.example/v1/chat/completions" })).toThrow("must be set together");
    expect(readingGeneratorFromEnvironment({
      AI_ENDPOINT: "https://ai.example/v1/chat/completions",
      CLOUDFLARE_AI_API_TOKEN: "secret",
      AI_MODEL: "reading-model"
    })).toBeDefined();
  });
});
