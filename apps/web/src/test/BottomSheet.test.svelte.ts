import { cleanup, render } from "@testing-library/svelte";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createRawSnippet } from "svelte";
import BottomSheet from "../lib/components/BottomSheet.svelte";

beforeAll(() => {
  if (!("PointerEvent" in window)) {
    class PE extends MouseEvent {
      pointerId: number;
      pointerType: string;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
        this.pointerType = init.pointerType ?? "touch";
      }
    }
    (window as unknown as Record<string, unknown>).PointerEvent = PE;
  }
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = () => {};
    Element.prototype.releasePointerCapture = () => {};
  }
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      onchange: null,
      dispatchEvent: () => false
    })) as typeof window.matchMedia;
  }
});

const body = createRawSnippet(() => ({ render: () => "<p>body</p>" }));

describe("BottomSheet motion", () => {
  afterEach(() => cleanup());

  it("animates in from off-screen after mount", async () => {
    render(BottomSheet, {
      props: { title: "Test", onClose: vi.fn(), children: body }
    });
    const sheet = document.querySelector(".bottom-sheet") as HTMLElement;
    expect(sheet).toBeTruthy();
    const initial = sheet.style.transform;
    await new Promise((r) => setTimeout(r, 700));
    const later = sheet.style.transform;
    expect(later === initial && initial.includes(String(window.innerHeight))).toBe(false);
  });

  it("springs back after a small downward drag", { timeout: 15000 }, async () => {
    render(BottomSheet, {
      props: { title: "Test", onClose: vi.fn(), children: body }
    });
    const sheet = document.querySelector(".bottom-sheet") as HTMLElement;
    await new Promise((r) => setTimeout(r, 1500)); // let entrance fully settle
    // Give the sheet a real height so dismissDistance() is meaningful.
    Object.defineProperty(sheet, "offsetHeight", { value: 600, configurable: true });
    sheet.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, clientX: 200, clientY: 500, bubbles: true }));
    // Drag down 60px, then hold still for a beat so the smoothed release
    // velocity decays below the 0.5 fling threshold and the sheet springs
    // back instead of dismissing.
    for (let i = 1; i <= 6; i++) {
      window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: 200, clientY: 500 + i * 10, bubbles: true }));
      await new Promise((r) => setTimeout(r, 30));
    }
    for (let i = 0; i < 4; i++) {
      window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: 200, clientY: 560, bubbles: true }));
      await new Promise((r) => setTimeout(r, 60));
    }
    window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, clientX: 200, clientY: 560, bubbles: true }));
    // Wait until the settle spring brings the sheet back to rest.
    let offset = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const t = sheet.style.transform;
      offset = t ? Math.abs(parseFloat(t.replace(/[^0-9.\-]/g, ""))) : 0;
      if (offset < 5) break;
    }
    expect(Math.abs(offset)).toBeLessThan(5); // settled back to rest
  });

  it("drives scrolled content to the top, then drags the sheet, on a downward pull", { timeout: 15000 }, async () => {
    render(BottomSheet, {
      props: { title: "Test", onClose: vi.fn(), children: body }
    });
    const sheet = document.querySelector(".bottom-sheet") as HTMLElement;
    const scroller = document.querySelector(".sheet-scroll") as HTMLElement;
    await new Promise((r) => setTimeout(r, 1500)); // entrance settle
    Object.defineProperty(sheet, "offsetHeight", { value: 600, configurable: true });
    // Simulate content that can scroll, currently scrolled down 120px.
    Object.defineProperty(scroller, "scrollHeight", { value: 1200, configurable: true });
    Object.defineProperty(scroller, "clientHeight", { value: 600, configurable: true });
    let scrollTop = 120;
    Object.defineProperty(scroller, "scrollTop", {
      get: () => scrollTop,
      set: (v) => { scrollTop = v; },
      configurable: true
    });

    sheet.dispatchEvent(new PointerEvent("pointerdown", { pointerId: 1, clientX: 200, clientY: 300, bubbles: true }));
    // Pull down 80px: less than the 120px scroll, so the sheet should NOT move
    // yet — the content should scroll up toward 0 instead.
    for (let i = 1; i <= 4; i++) {
      window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: 200, clientY: 300 + i * 20, bubbles: true }));
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(scrollTop).toBeLessThan(120); // content scrolled back toward top
    const sheetOffsetDuringScroll = parseFloat((sheet.style.transform || "0").replace(/[^0-9.\-]/g, "")) || 0;
    expect(sheetOffsetDuringScroll).toBeLessThan(40); // sheet mostly stayed put

    // Keep pulling past the top: now the sheet itself should follow the finger.
    for (let i = 5; i <= 9; i++) {
      window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 1, clientX: 200, clientY: 300 + i * 20, bubbles: true }));
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(scrollTop).toBe(0);
    const sheetOffsetAfterTop = parseFloat((sheet.style.transform || "0").replace(/[^0-9.\-]/g, "")) || 0;
    expect(sheetOffsetAfterTop).toBeGreaterThan(0); // sheet now dragging down
    cleanup();
  });
});
