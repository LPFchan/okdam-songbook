import type { KaraokeSystem, PerformerId, RecommendationGroup } from "@songbook/shared";
import { fetchRecommendations } from "./api";
import { db } from "./db";

const DAY_MS = 24 * 60 * 60 * 1_000;
// Spacing between pages, so a fast scroll walks the list instead of bursting.
const CADENCE_MS = 1_000;
const RETRY_BASE_MS = 2_000;
const RETRY_MAX_MS = 30_000;
// After this many failed requests in a row the feed waits for 다시 시도.
const MAX_FAILURES = 5;
// An artist whose search keeps failing is dropped after this many tries.
const MAX_ARTIST_ATTEMPTS = 3;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * One performer filter's recommendations, kept for a day: in memory so
 * leaving the app and coming back shows them at once, and in IndexedDB so a
 * relaunch does too. Pages load one at a time, only while `wanted()` says the
 * reader is near the end, and failures are retried with growing waits.
 */
export class RecommendationFeed {
  groups = $state<RecommendationGroup[]>([]);
  hasMore = $state(true);
  loading = $state(false);
  /** Automatic retries ran out; the reader has to ask again. */
  failed = $state(false);
  startedAt = 0;
  private running = false;
  private failures = 0;
  private readonly attempts = new Map<string, number>();
  private readonly restored: Promise<void>;

  constructor(readonly key: string, private readonly input: { system: KaraokeSystem; performerIds: PerformerId[] }) {
    this.restored = this.restore();
  }

  get expired(): boolean {
    return Boolean(this.startedAt) && Date.now() - this.startedAt > DAY_MS;
  }

  private async restore() {
    try {
      const saved = await db.recommendations.get(this.key);
      if (!saved || Date.now() - saved.startedAt > DAY_MS || this.groups.length) return;
      this.groups = saved.groups;
      this.hasMore = saved.hasMore;
      this.startedAt = saved.startedAt;
    } catch {
      // Without IndexedDB the feed simply starts empty.
    }
  }

  private persist() {
    void db.recommendations.put({ key: this.key, startedAt: this.startedAt, groups: $state.snapshot(this.groups), hasMore: this.hasMore }).catch(() => {});
  }

  retry(wanted: () => boolean, requireCredential: () => Promise<string>) {
    this.failed = false;
    this.failures = 0;
    void this.pump(wanted, requireCredential);
  }

  async pump(wanted: () => boolean, requireCredential: () => Promise<string>): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.restored;
      while (this.hasMore && !this.failed && wanted()) {
        const wait = await this.loadPage(requireCredential);
        this.loading = Boolean(wait);
        await sleep(wait || CADENCE_MS);
      }
    } finally {
      this.loading = false;
      this.running = false;
    }
  }

  /** Loads one page and returns how long to wait before the next. */
  private async loadPage(requireCredential: () => Promise<string>): Promise<number> {
    this.loading = true;
    const exclude = this.groups.map((group) => group.name);
    try {
      await requireCredential();
      const page = await fetchRecommendations({ ...this.input, performerIds: [...this.input.performerIds], exclude });
      this.failures = 0;
      let retrying = 0;
      const done: RecommendationGroup[] = [];
      for (const group of page.groups) {
        if (exclude.includes(group.name)) continue;
        if (!group.error) {
          done.push(group);
          continue;
        }
        // Left out of exclude, the artist comes back first on the next page.
        const attempt = (this.attempts.get(group.name) ?? 0) + 1;
        this.attempts.set(group.name, attempt);
        if (attempt < MAX_ARTIST_ATTEMPTS) retrying = Math.max(retrying, attempt);
        else done.push({ ...group, candidates: [], error: null });
      }
      if (!this.startedAt) this.startedAt = Date.now();
      this.groups = [...this.groups, ...done];
      this.hasMore = page.hasMore || retrying > 0;
      this.persist();
      return retrying ? RETRY_BASE_MS * retrying : 0;
    } catch {
      this.failures += 1;
      if (this.failures >= MAX_FAILURES) this.failed = true;
      return Math.min(RETRY_BASE_MS * 2 ** (this.failures - 1), RETRY_MAX_MS);
    } finally {
      this.loading = false;
    }
  }
}

const feeds = new Map<string, RecommendationFeed>();

export function recommendationFeed(system: KaraokeSystem, performerIds: PerformerId[]): RecommendationFeed {
  const key = `${system}:${[...performerIds].sort().join(",")}`;
  let feed = feeds.get(key);
  if (!feed || feed.expired) {
    feed = new RecommendationFeed(key, { system, performerIds: [...performerIds] });
    feeds.set(key, feed);
  }
  return feed;
}

/** Forget every feed, in memory and on disk. */
export async function clearRecommendationFeeds(): Promise<void> {
  feeds.clear();
  await db.recommendations.clear();
}
