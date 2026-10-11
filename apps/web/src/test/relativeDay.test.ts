import { describe, expect, it } from "vitest";
import { relativeDay } from "../lib/relativeDay";

const now = new Date(2026, 9, 12, 1, 30);
const daysAgo = (days: number, hour = 23) => new Date(2026, 9, 12 - days, hour);

describe("relativeDay", () => {
  it("counts calendar days, not 24-hour spans", () => {
    expect(relativeDay(new Date(2026, 9, 12, 0, 5), now)).toBe("오늘");
    expect(relativeDay(daysAgo(1), now)).toBe("어제");
    expect(relativeDay(daysAgo(2, 0), now)).toBe("2일 전");
  });

  it("steps up to weeks, months and years", () => {
    expect(relativeDay(daysAgo(6), now)).toBe("6일 전");
    expect(relativeDay(daysAgo(7), now)).toBe("1주 전");
    expect(relativeDay(daysAgo(29), now)).toBe("4주 전");
    expect(relativeDay(daysAgo(30), now)).toBe("1달 전");
    expect(relativeDay(daysAgo(95), now)).toBe("3달 전");
    expect(relativeDay(daysAgo(364), now)).toBe("11달 전");
    expect(relativeDay(daysAgo(365), now)).toBe("1년 전");
    expect(relativeDay(daysAgo(800), now)).toBe("2년 전");
  });

  it("treats a future timestamp as today", () => {
    expect(relativeDay(new Date(2026, 9, 13), now)).toBe("오늘");
  });

  it("accepts ISO strings", () => {
    expect(relativeDay(daysAgo(3).toISOString(), now)).toBe("3일 전");
  });
});
