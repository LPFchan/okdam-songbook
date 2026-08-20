import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { snackbar } from "../lib/snackbar.svelte";

describe("snackbar", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    snackbar.dismiss();
  });

  afterEach(() => {
    snackbar.dismiss();
    vi.useRealTimers();
  });

  it("auto-dismisses a transient message", () => {
    snackbar.show("저장했어.");
    expect(snackbar.current?.message).toBe("저장했어.");
    vi.advanceTimersByTime(4000);
    expect(snackbar.current).toBeNull();
  });

  it("resets the timer when a new message arrives", () => {
    snackbar.show("첫 번째");
    vi.advanceTimersByTime(3000);
    snackbar.show("두 번째");
    vi.advanceTimersByTime(3000);
    expect(snackbar.current?.message).toBe("두 번째");
    vi.advanceTimersByTime(1000);
    expect(snackbar.current).toBeNull();
  });

  it("dismisses immediately when dismissed", () => {
    snackbar.show("사라져");
    snackbar.dismiss();
    expect(snackbar.current).toBeNull();
    vi.advanceTimersByTime(10000);
    expect(snackbar.current).toBeNull();
  });
});
