import type { KaraokeSystem } from "@songbook/shared";

const STORAGE_KEY = "songbook:karaoke";

/** Which karaoke system's numbers the catalog shows. Remembered per device. */
class KaraokeMode {
  system = $state<KaraokeSystem>("tj");

  load(): void {
    this.system = window.localStorage.getItem(STORAGE_KEY) === "dam" ? "dam" : "tj";
  }

  toggle(): void {
    this.system = this.system === "tj" ? "dam" : "tj";
    window.localStorage.setItem(STORAGE_KEY, this.system);
  }
}

export const karaoke = new KaraokeMode();
