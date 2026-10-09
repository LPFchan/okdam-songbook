<script lang="ts" module>
  import type { RecommendationGroup } from "@songbook/shared";

  // One answer per filter for the life of the page: the server-side TJ mirror
  // keeps upstream calls cheap, but there is no reason to repeat even those.
  const cache = new Map<string, Promise<RecommendationGroup[]>>();
</script>

<script lang="ts">
  import { formatPerformerNames, type KaraokeSystem, type PerformerId, type RecommendationRole, type Song } from "@songbook/shared";
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
  const roleLabels: Record<RecommendationRole, string> = { artist: "가수", composer: "작곡", lyricist: "작사" };

  let loading = $state(false);
  let loaded = $state(false);
  let groups = $state<RecommendationGroup[]>([]);
  let error = $state("");
  let expanded = $state<Record<string, boolean>>({});

  const requestKey = $derived(`${system}:${[...performerIds].sort().join(",")}`);

  $effect(() => {
    const key = requestKey;
    // Clear right away: the old filter's songs must not stay clickable while
    // the heading already describes the new one.
    loaded = false;
    loading = false;
    groups = [];
    error = "";
    expanded = {};
    if (!enabled || !performerIds.length) return;
    let cancelled = false;
    const input = { performerIds: [...performerIds], system };
    const timer = setTimeout(() => {
      loading = true;
      let request = cache.get(key);
      if (!request) {
        request = requireCredential().then(() => fetchRecommendations(input));
        cache.set(key, request);
        // Per-person failures arrive inside a resolved answer; drop those too
        // so the next visit retries once TJ/DAM recovers.
        request.then(
          (next) => {
            if (next.some((group) => group.error)) cache.delete(key);
          },
          () => cache.delete(key)
        );
      }
      void request
        .then((next) => {
          if (cancelled) return;
          groups = next;
          loaded = true;
        })
        .catch((reason: unknown) => {
          if (!cancelled) error = reason instanceof Error ? reason.message : "추천 곡을 불러오지 못했어요.";
        })
        .finally(() => {
          if (!cancelled) loading = false;
        });
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  });

  // Songs already in the Songbook are hidden, as is a song a second person
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
        <p>{formatPerformerNames(performerIds)}의 곡을 만든 사람들의 {karaokeSources[system].label} 곡이에요.</p>
      </div>
    </header>
    {#if loading}<p class="omnibar-tj-status">추천 곡을 찾는 중…</p>{/if}
    {#if error}<p class="omnibar-tj-status error">{error}</p>{/if}
    {#if loaded && !visibleGroups.length}
      <p class="omnibar-tj-status">새로 찾은 곡이 없어요.</p>
    {/if}
    {#each visibleGroups as group (`${group.role}:${group.name}`)}
      {@const groupKey = `${group.role}:${group.name}`}
      <div class="recommendation-group">
        <h3>
          {group.name}
          <span>{roleLabels[group.role]} · 저장된 곡 {group.songCount}곡</span>
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
  </section>
{/if}
