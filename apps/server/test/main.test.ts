import { describe, expect, it } from "vitest";
import { parseAllowedUsers, readingGeneratorFromEnvironment } from "../src/main.js";

describe("ALLOWED_USERS_JSON", () => {
  it("normalizes a non-empty email-to-name object", () => {
    expect(parseAllowedUsers('{" Allowed@Example.COM ":"마리","other@example.com":"여울"}')).toEqual({
      "allowed@example.com": "마리",
      "other@example.com": "여울"
    });
  });

  it.each([
    [undefined, "required"],
    ["", "required"],
    ["not-json", "valid JSON"],
    ["{}", "non-empty JSON object"],
    ["[]", "non-empty JSON object"],
    ['{"not-an-email":"마리"}', "non-empty JSON object"],
    ['{"allowed@example.com":""}', "non-empty JSON object"],
    ['{"allowed@example.com":"마리","ALLOWED@example.com":"여울"}', "duplicate"]
  ])("rejects %j", (value, message) => {
    expect(() => parseAllowedUsers(value)).toThrow(message);
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
