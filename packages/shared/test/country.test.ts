import { describe, expect, it } from "vitest";
import { detectSongCountry } from "../src/country";

describe("song country detection", () => {
  it.each([
    ["フォニイ", "ツミキ", "일본"],
    ["春雷", "米津玄師", "일본"],
    ["좋은 날", "아이유", "한국"],
    ["Bad Guy", "Billie Eilish", "미국"],
    ["Звезда", "Молчат Дома", "그 외"]
  ])("detects %s by its title and artist scripts", (title, artist, country) => {
    expect(detectSongCountry(title, artist)).toBe(country);
  });

  it("reuses the country of an existing artist before falling back to script", () => {
    expect(detectSongCountry("Dreaming", "FreeTEMPO", [{
      artist: "FreeTEMPO",
      artistAliases: [],
      country: "일본"
    }])).toBe("일본");
  });

  it("matches an existing artist alias", () => {
    expect(detectSongCountry("New Song", "The Weeknd", [{
      artist: "위켄드",
      artistAliases: ["The Weeknd"],
      country: "미국"
    }])).toBe("미국");
  });
});
