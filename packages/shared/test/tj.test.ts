import { describe, expect, it } from "vitest";
import { buildTjSearchUrl, parseTjHasMore, parseTjSearchHtml } from "../src/tj";

const ordinaryFixture = `
<ul class="grid-container list ico"><li class="grid-item center pos-type"><p class="count"><span class="num2">68058</span></p></li>
<li class="grid-item title3"><div><p><span>Pretender</span></p></div></li>
<li class="grid-item title4 singer"><p><span>Official髭男dism</span></p></li>
<li class="grid-item title5"><p>藤原聡</p></li><li class="grid-item title6"><p>藤原聡</p></li>
</ul></li>`;

const emptySection = `<div class="music-search-list type2"><p class="no-date">검색 결과를 찾을 수 없습니다.</p></div>`;
const confirmedEmptyFixture = Array.from({ length: 6 }, () => emptySection).join("");
const oneSectionEmptyFixture = `<div class="music-search-list"><p class="no-date">검색 결과를 찾을 수 없습니다.</p></div>`;
const populatedSectionsFixture = `<div class="music-search-list type2">${ordinaryFixture}</div>${Array.from({ length: 5 }, () => emptySection).join("")}`;
const driftedPopulatedSectionFixture = `<div class="music-search-list"><ul class="grid-container drift"><li>row class changed</li></ul></div>${Array.from({ length: 5 }, () => emptySection).join("")}`;

describe("TJ parser", () => {
  it("normalizes ordinary rows and preserves Unicode/highlights/icons", () => {
    const result = parseTjSearchHtml(`<ul class="chart-list-area"><li><ul class="grid-container top"></ul></li><li>${ordinaryFixture}</li></ul>`, "https://www.tjmedia.com/song/accompaniment_search");
    expect(result).toEqual([{
      tjNumber: "68058",
      title: "Pretender",
      artist: "Official髭男dism",
      lyricist: "藤原聡",
      composer: "藤原聡",
      sourceUrl: "https://www.tjmedia.com/song/accompaniment_search"
    }]);
  });

  it("decodes highlighted Japanese text and empty responses", () => {
    const html = ordinaryFixture.replace("Pretender", "<span class='highlight'>&#x30D5;&#x30A9;&#x30CB;&#x30A4;</span>").replace("Official髭男dism", "ツミキ(Feat.&amp;可不)");
    expect(parseTjSearchHtml(html, "https://www.tjmedia.com")[0]?.title).toBe("フォニイ");
    expect(parseTjSearchHtml(confirmedEmptyFixture, "https://www.tjmedia.com")).toEqual([]);
  });

  it("keeps valid rows when TJ also renders hidden empty placeholders", () => {
    const html = `${ordinaryFixture}<div>검색 결과를 찾을 수 없습니다.</div>`;
    expect(parseTjSearchHtml(html, "https://www.tjmedia.com")).toHaveLength(1);
  });

  it("confirms one-section and six-section empty results only when every section is explicitly empty", () => {
    expect(parseTjSearchHtml(oneSectionEmptyFixture, "https://www.tjmedia.com/song/accompaniment_search")).toEqual([]);
    expect(parseTjSearchHtml(confirmedEmptyFixture, "https://www.tjmedia.com")).toEqual([]);
    expect(parseTjSearchHtml(populatedSectionsFixture, "https://www.tjmedia.com")).toHaveLength(1);
  });

  it("rejects a populated section whose row structure drifts instead of treating it as empty", () => {
    expect(() => parseTjSearchHtml(driftedPopulatedSectionFixture, "https://www.tjmedia.com")).toThrow("TJ_PARSER_DRIFT");
  });

  it("deduplicates repeated section rows and exposes paging", () => {
    expect(parseTjSearchHtml(`${ordinaryFixture}${ordinaryFixture}`, "https://www.tjmedia.com")).toHaveLength(1);
    expect(parseTjHasMore('<button class="search more-btn">MORE</button>')).toBe(true);
  });

  it("builds a bounded fixed-host URL", () => {
    const url = buildTjSearchUrl({ query: "フォニイ", searchType: "title", nation: "JPN", page: 2, pageSize: 15 });
    expect(url).toContain("https://www.tjmedia.com/song/accompaniment_search?");
    expect(url).toContain("strType=1");
    expect(url).toContain("searchTxt=%E3%83%95%E3%82%A9%E3%83%8B%E3%82%A4");
  });
});
