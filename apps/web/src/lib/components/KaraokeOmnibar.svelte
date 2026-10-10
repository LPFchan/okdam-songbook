<script module lang="ts">
  import type { Candidate } from "../karaokeSources";

  // Finished searches by system and query, so a return to the app or a
  // catalog refresh shows the same list instead of searching again.
  const answers = new Map<string, Candidate[]>();
  const ANSWER_LIMIT = 50;
</script>

<script lang="ts">
  import { isSearchableQuery, type KaraokeSystem, type Song } from "@songbook/shared";
  import { karaokeSources } from "../karaokeSources";
  import CandidateList from "./CandidateList.svelte";

  interface Props {
    system?: KaraokeSystem;
    query: string;
    /** Results already found stay on screen while this holds. */
    visible: boolean;
    /** New searches run only while this holds. */
    enabled: boolean;
    songs: Song[];
    requireCredential(): Promise<string>;
    onManualAdd(): void;
    onOpenExisting(song: Song): void;
    onSongSaved(song: Song): void;
  }

  const { system = "tj", query, visible, enabled, songs, requireCredential, onManualAdd, onOpenExisting, onSongSaved }: Props = $props();

  const source = $derived(karaokeSources[system]);

  const DEBOUNCE_MS = 450;

  const trimmedQuery = $derived(query.trim());
  const searchable = $derived(isSearchableQuery(trimmedQuery));

  let loading = $state(false);
  let results = $state<Candidate[]>([]);
  let error = $state("");
  let completedQuery = $state("");

  $effect(() => {
    const q = trimmedQuery;
    const key = `${system}:${q}`;
    const known = searchable && visible ? answers.get(key) : undefined;
    if (known || !enabled || !searchable) {
      loading = false;
      results = known ?? [];
      error = "";
      completedQuery = known ? q : "";
      return;
    }
    let cancelled = false;
    const { search, label } = source;
    const timer = setTimeout(() => {
      loading = true;
      error = "";
      void requireCredential()
        .then(() => search(q))
        .then((candidates) => {
          answers.delete(key);
          answers.set(key, candidates);
          if (answers.size > ANSWER_LIMIT) answers.delete(answers.keys().next().value!);
          if (cancelled) return;
          results = candidates;
          completedQuery = q;
        })
        .catch((reason: unknown) => {
          if (cancelled) return;
          results = [];
          completedQuery = q;
          error = reason instanceof Error ? reason.message : `${label} 검색을 불러오지 못했어요.`;
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
</script>

{#if searchable}
  {#if enabled || completedQuery === trimmedQuery}
    <section class="omnibar-tj" aria-label="{source.label} 검색 결과" aria-live="polite">
      <header class="omnibar-tj-heading">
        <div>
          <h2>{source.label}에서 더 찾기</h2>
        </div>
        <button type="button" class="secondary-button" onclick={onManualAdd}>직접 입력</button>
      </header>
      {#if loading}<p class="omnibar-tj-status">{source.label} 검색 중…</p>{/if}
      {#if error}<p class="omnibar-tj-status error">{error}</p>{/if}
      {#if !loading && !error && completedQuery === trimmedQuery && results.length === 0}
        <p class="omnibar-tj-status">{source.label}에도 검색 결과가 없어요.</p>
      {/if}
      {#if results.length}
        <CandidateList {system} candidates={results} {songs} {requireCredential} {onOpenExisting} {onSongSaved} />
      {/if}
    </section>
  {/if}
{/if}
