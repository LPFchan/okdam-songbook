import { describe, expect, it } from "vitest";
import { countryClassifierFromEnvironment, createAiCountryClassifier } from "../src/country.js";

function classifierAnswering(content: string, requests: unknown[] = []) {
  return createAiCountryClassifier({
    endpoint: "https://ai.example/v1/chat/completions",
    apiKey: "secret",
    model: "country-model",
    fetch: async (_input, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return Response.json({ choices: [{ message: { content } }] });
    }
  });
}

describe("AI country classifier", () => {
  it("sends the title and artist and returns one of the four countries", async () => {
    const requests: Array<{ messages: Array<{ content: string }> }> = [];
    const classifier = classifierAnswering(JSON.stringify({ country: "일본" }), requests as unknown[]);
    await expect(classifier.classify({ title: "Sugarless GiRL", artist: "CAPSULE" })).resolves.toBe("일본");
    expect(requests[0]?.messages.at(-1)?.content).toBe(JSON.stringify({ title: "Sugarless GiRL", artist: "CAPSULE" }));
  });

  it("rejects an answer outside the four countries", async () => {
    await expect(classifierAnswering(JSON.stringify({ country: "Japan" })).classify({ title: "曲", artist: "歌手" }))
      .rejects.toMatchObject({ code: "EXTERNAL_API_ERROR" });
  });

  it("stays off when no AI settings are present", () => {
    expect(countryClassifierFromEnvironment({})).toBeUndefined();
  });
});
