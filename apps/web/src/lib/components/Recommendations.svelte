<script lang="ts">
  import { untrack } from "svelte";
  import { formatPerformerNames, type KaraokeSystem, type PerformerId, type Song } from "@songbook/shared";
  import { findSavedSong, karaokeSources } from "../karaokeSources";
  import { recommendationFeed, type RecommendationFeed } from "../recommendationFeed.svelte";
  import CandidateList from "./CandidateList.svelte";

  interface Props {
    system: KaraokeSystem;
    performerIds: PerformerId[];
    /** Recommendations already loaded stay on screen while this holds. */
    visible: boolean;
    /** New pages are fetched only while this holds. */
    enabled: boolean;
    songs: Song[];
    requireCredential(): Promise<string>;
    onOpenExisting(song: Song): void;
    onSongSaved(song: Song): void;
  }

  const { system, performerIds, visible, enabled, songs, requireCredential, onOpenExisting, onSongSaved }: Props = $props();

  const DEBOUNCE_MS = 400;
  const COLLAPSED_COUNT = 5;
  // Start the next page well before the reader reaches the end.
  const PREFETCH_MARGIN = "1500px";

  let ready = $state(false);
  let expanded = $state<Record<string, boolean>>({});
  let bottomNear = $state(false);

  const requestKey = $derived(`${system}:${[...performerIds].sort().join(",")}`);
  const feed = $derived(performerIds.length ? recommendationFeed(system, performerIds) : null);

  $effect(() => {
    void requestKey;
    ready = false;
    expanded = {};
    if (!performerIds.length) return;
    const timer = setTimeout(() => (ready = true), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  });

  // The first page loads on its own; later ones while the bottom is near. A
  // feed the reader has switched away from is never wanted again.
  const wanted = (target: RecommendationFeed) =>
    Boolean(ready && enabled && feed === target && target.key === requestKey && (!target.groups.length || bottomNear));

  $effect(() => {
    const current = feed;
    if (current && wanted(current)) untrack(() => void current.pump(() => wanted(current), requireCredential));
  });

  function watchBottom(node: HTMLElement) {
    if (typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => (bottomNear = Boolean(entry?.isIntersecting)), { rootMargin: PREFETCH_MARGIN });
    observer.observe(node);
    return {
      destroy() {
        observer.disconnect();
        bottomNear = false;
      }
    };
  }

  // Songs already in the Songbook are hidden, as is a song a second artist
  // also leads to: it stays with whoever ranked higher. Artists left with no
  // songs, including ones whose search failed, are not shown at all.
  const visibleGroups = $derived.by(() => {
    const seen = new Set<string>();
    return (feed?.groups ?? []).map((group) => ({
      ...group,
      candidates: group.candidates.filter((candidate) => {
        const number = karaokeSources[system].number(candidate);
        if (seen.has(number) || findSavedSong(system, candidate, songs)) return false;
        seen.add(number);
        return true;
      })
    })).filter((group) => group.candidates.length);
  });
</script>

{#if visible && feed && (enabled || visibleGroups.length)}
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
      </div>
    {/each}
    {#if feed.failed}
      <p class="omnibar-tj-status error">추천 곡을 불러오지 못했어요.</p>
      <button type="button" class="secondary-button recommendation-more" onclick={() => { const current = feed; current.retry(() => wanted(current), requireCredential); }}>다시 시도</button>
    {:else if feed.loading || (feed.hasMore && enabled && !visibleGroups.length)}
      <p class="omnibar-tj-status">추천 곡을 찾는 중…</p>
    {:else if !feed.hasMore && !visibleGroups.length}
      <p class="omnibar-tj-status">새로 찾은 곡이 없어요.</p>
    {/if}
    {#if feed.hasMore}
      <!-- Re-observe after each page so the next one waits for a fresh measurement. -->
      {#key feed.groups.length}<div class="recommendation-bottom" use:watchBottom></div>{/key}
    {/if}
  </section>
{/if}
