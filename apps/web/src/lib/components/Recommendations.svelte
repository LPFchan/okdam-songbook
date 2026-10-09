<script lang="ts" module>
  import type { RecommendationResult } from "@songbook/shared";

  // One answer per filter and page for the life of the page: the server-side
  // TJ mirror keeps upstream calls cheap, but there is no reason to repeat even those.
  const cache = new Map<string, Promise<RecommendationResult>>();
</script>

<script lang="ts">
  import { untrack } from "svelte";
  import { formatPerformerNames, type KaraokeSystem, type PerformerId, type RecommendationGroup, type Song } from "@songbook/shared";
  import { fetchRecommendations } from "../api";
  import { findSavedSong, karaokeSources } from "../karaokeSources";
  import CandidateList from "./CandidateList.svelte";

  interface Props {
    system: KaraokeSystem;
    performerIds: PerformerId[];
    enabled: boolean;
    songs: Song[];
    requireCredential(): Promise<string>;
    onOpenExisting(song: Song): void;
    onSongSaved(song: Song): void;
  }

  const { system, performerIds, enabled, songs, requireCredential, onOpenExisting, onSongSaved }: Props = $props();

  const DEBOUNCE_MS = 400;
  const COLLAPSED_COUNT = 5;

  let ready = $state(false);
  let loading = $state(false);
  let groups = $state<RecommendationGroup[]>([]);
  let hasMore = $state(true);
  let error = $state("");
  let expanded = $state<Record<string, boolean>>({});
  let bottomVisible = $state(false);
  // Bumped per filter so answers for an older filter are dropped.
  let generation = 0;

  const requestKey = $derived(`${system}:${[...performerIds].sort().join(",")}`);

  $effect(() => {
    void requestKey;
    // Clear right away: the old filter's songs must not stay clickable while
    // the heading already describes the new one.
    generation += 1;
    ready = false;
    loading = false;
    groups = [];
    hasMore = true;
    error = "";
    expanded = {};
    if (!enabled || !performerIds.length) return;
    const timer = setTimeout(() => (ready = true), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  });

  // The first page loads on its own; later pages load as the bottom scrolls into view.
  $effect(() => {
    if (ready && !loading && !error && hasMore && (!groups.length || bottomVisible)) untrack(loadPage);
  });

  function loadPage() {
    const run = generation;
    const exclude = groups.map((group) => group.name);
    const key = `${requestKey}@${exclude.join("\n")}`;
    const input = { performerIds: [...performerIds], system, exclude };
    loading = true;
    let request = cache.get(key);
    if (!request) {
      request = requireCredential().then(() => fetchRecommendations(input));
      cache.set(key, request);
      // Per-artist failures arrive inside a resolved answer; drop those too
      // so the next visit retries once TJ/DAM recovers.
      request.then(
        (page) => {
          if (page.groups.some((group) => group.error)) cache.delete(key);
        },
        () => cache.delete(key)
      );
    }
    void request
      .then((page) => {
        if (run !== generation) return;
        // Never twice: each group is keyed by artist name.
        groups = [...groups, ...page.groups.filter((group) => !exclude.includes(group.name))];
        hasMore = page.hasMore;
      })
      .catch((reason: unknown) => {
        if (run === generation) error = reason instanceof Error ? reason.message : "추천 곡을 불러오지 못했어요.";
      })
      .finally(() => {
        if (run === generation) loading = false;
      });
  }

  function watchBottom(node: HTMLElement) {
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => (bottomVisible = Boolean(entry?.isIntersecting)), { rootMargin: "400px" });
    observer.observe(node);
    return {
      destroy() {
        observer.disconnect();
        bottomVisible = false;
      }
    };
  }

  // Songs already in the Songbook are hidden, as is a song a second artist
  // also leads to: it stays with whoever ranked higher.
  const visibleGroups = $derived.by(() => {
    const seen = new Set<string>();
    return groups.map((group) => ({
      ...group,
      candidates: group.candidates.filter((candidate) => {
        const number = karaokeSources[system].number(candidate);
        if (seen.has(number) || findSavedSong(system, candidate, songs)) return false;
        seen.add(number);
        return true;
      })
    })).filter((group) => group.candidates.length || group.error);
  });
</script>

{#if enabled && performerIds.length}
  <section class="omnibar-tj recommendations" aria-label="추천 곡" aria-live="polite">
    <header class="omnibar-tj-heading">
      <div>
        <h2>추천</h2>
        <p>{formatPerformerNames(performerIds)}의 곡을 부른 가수들의 다른 {karaokeSources[system].label} 곡이에요.</p>
      </div>
    </header>
    {#each visibleGroups as group (group.name)}
      {@const groupKey = group.name}
      <div class="recommendation-group">
        <h3>
          {group.name}
          <span>저장된 곡 {group.songCount}곡</span>
        </h3>
        {#if group.error}<p class="omnibar-tj-status error">{group.error}</p>{/if}
        {#if group.candidates.length}
          <CandidateList
            {system}
            candidates={expanded[groupKey] ? group.candidates : group.candidates.slice(0, COLLAPSED_COUNT)}
            {songs}
            {requireCredential}
            {onOpenExisting}
            {onSongSaved}
          />
          {#if group.candidates.length > COLLAPSED_COUNT && !expanded[groupKey]}
            <button type="button" class="secondary-button recommendation-more" onclick={() => (expanded = { ...expanded, [groupKey]: true })}>
              {group.candidates.length - COLLAPSED_COUNT}곡 더 보기
            </button>
          {/if}
        {/if}
      </div>
    {/each}
    {#if loading}<p class="omnibar-tj-status">추천 곡을 찾는 중…</p>{/if}
    {#if error}
      <p class="omnibar-tj-status error">{error}</p>
      <button type="button" class="secondary-button recommendation-more" onclick={() => (error = "")}>다시 시도</button>
    {/if}
    {#if !hasMore && !visibleGroups.length}
      <p class="omnibar-tj-status">새로 찾은 곡이 없어요.</p>
    {/if}
    {#if hasMore}
      <!-- Re-observe after each page so the next one waits for a fresh measurement. -->
      {#key groups.length}<div class="recommendation-bottom" use:watchBottom></div>{/key}
    {/if}
  </section>
{/if}
