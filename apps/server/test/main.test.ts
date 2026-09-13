import { describe, expect, it } from "vitest";
import { commonAuthOriginFromEnvironment, readingGeneratorFromEnvironment } from "../src/main.js";

describe("common auth environment", () => {
  it("defaults to auth.lost.plus and accepts an override for local tests", () => {
    expect(commonAuthOriginFromEnvironment({})).toBe("https://auth.lost.plus");
    expect(commonAuthOriginFromEnvironment({ AUTH_ORIGIN: "http://auth.test:3001/" })).toBe("http://auth.test:3001");
  });
});

describe("reading AI environment", () => {
  it("stays optional when no reading settings are present", () => {
    expect(readingGeneratorFromEnvironment({})).toBeUndefined();
  });

  it("requires endpoint, key, and model as one complete group", () => {
    expect(() => readingGeneratorFromEnvironment({ AI_ENDPOINT: "https://ai.example/v1/chat/completions" })).toThrow("must be set together");
    expect(readingGeneratorFromEnvironment({
      AI_ENDPOINT: "https://ai.example/v1/chat/completions",
      AI_API_KEY: "secret",
      AI_MODEL: "reading-model"
    })).toBeDefined();
  });
});
