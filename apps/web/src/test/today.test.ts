import { afterEach, describe, expect, it, vi } from "vitest";
import { today } from "../lib/today.svelte";

describe("today store", () => {
  afterEach(() => vi.useRealTimers());

  it("rolls over to the next day at local midnight", () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(new Date(2026, 9, 12, 23, 59));
    const stop = today.start();
    expect(today.now.getDate()).toBe(12);
    vi.advanceTimersByTime(2 * 60_000);
    expect(today.now.getDate()).toBe(13);
    stop();
  });
});
