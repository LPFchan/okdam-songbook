import { describe, expect, it } from "vitest";
import { parseAllowedUsers, readingGeneratorFromEnvironment } from "../src/main.js";

describe("ALLOWED_USERS_JSON", () => {
  it("normalizes a non-empty array of email strings", () => {
    expect(parseAllowedUsers('[" Allowed@Example.COM ","other@example.com"]')).toEqual(["allowed@example.com", "other@example.com"]);
  });

  it.each([
    [undefined, "required"],
    ["", "required"],
    ["not-json", "valid JSON"],
    ["{}", "non-empty JSON array"],
    ["[]", "non-empty JSON array"],
    ['["not-an-email"]', "non-empty JSON array"],
    ['["allowed@example.com", "ALLOWED@example.com"]', "duplicate"]
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
