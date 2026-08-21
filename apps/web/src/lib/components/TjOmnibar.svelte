<script lang="ts">
  import { isSearchableQuery, type Song, type TjSongCandidate } from "@songbook/shared";
  import { addTjSong, searchTjSongs } from "../api";
  import { snackbar } from "../snackbar.svelte";
  import SongRow from "./SongRow.svelte";

  interface Props {
    query: string;
    enabled: boolean;
    songs: Song[];
    requireCredential(): Promise<void>;
    onManualAdd(): void;
    onOpenExisting(song: Song): void;
    onSongSaved(song: Song): void;
  }

  const { query, enabled, songs, requireCredential, onManualAdd, onOpenExisting, onSongSaved }: Props = $props();

  const DEBOUNCE_MS = 450;

  function normalized(value: string): string {
    return value.normalize("NFKC").toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
  }

  function candidateKey(candidate: TjSongCandidate): string {
    return `${candidate.tjNumber}:${candidate.title}:${candidate.artist}`;
  }

  const trimmedQuery = $derived(query.trim());
  const searchable = $derived(isSearchableQuery(trimmedQuery));

  let loading = $state(false);
  let results = $state<TjSongCandidate[]>([]);
  let error = $state("");
  let completedQuery = $state("");
  let pending = $state<Record<string, boolean>>({});
  let added = $state<Record<string, Song>>({});
  const requestIds = new Map<string, string>();

  $effect(() => {
    if (!enabled || !searchable) {
      loading = false;
      results = [];
      error = "";
      completedQuery = "";
      return;
    }
    let cancelled = false;
    const q = trimmedQuery;
    const timer = setTimeout(() => {
      loading = true;
      error = "";
      void requireCredential()
        .then(() => searchTjSongs({ query: q, searchType: /^\d+$/u.test(q) ? "number" : "all", nation: "", page: 1, pageSize: 15 }))
        .then((response) => {
          if (cancelled) return;
          results = response.candidates;
          completedQuery = q;
        })
        .catch((reason: unknown) => {
          if (cancelled) return;
          results = [];
          completedQuery = q;
          error = reason instanceof Error ? reason.message : "TJ 검색을 불러오지 못했어요.";
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

  const existingByCandidate = $derived.by(() => {
    const matches = new Map<string, Song>();
    for (const candidate of results) {
      const existing = songs.find(
        (song) =>
          song.tjNumber === candidate.tjNumber ||
          (normalized(song.title) === normalized(candidate.title) && normalized(song.artist) === normalized(candidate.artist))
      );
      if (existing) matches.set(candidateKey(candidate), existing);
    }
    return matches;
  });

  async function addCandidate(candidate: TjSongCandidate) {
    const key = candidateKey(candidate);
    if (pending[key]) return;
    const existing = existingByCandidate.get(key) ?? added[key];
    if (existing) {
      onOpenExisting(existing);
      return;
    }
    let requestId = requestIds.get(key);
    if (!requestId) {
      requestId = crypto.randomUUID();
      requestIds.set(key, requestId);
    }
    pending = { ...pending, [key]: true };
    try {
      await requireCredential();
      const response = await addTjSong(candidate, requestId);
      const song = response.song ?? response.existing;
      if (song) {
        added = { ...added, [key]: song };
        onSongSaved(song);
        snackbar.show(response.outcome === "created" ? `${song.title}을(를) 추가했어요.` : "이미 Songbook에 있는 곡을 열었어.");
        onOpenExisting(song);
      }
    } catch (reason) {
      snackbar.show(reason instanceof Error ? reason.message : "곡을 추가하지 못했어요.");
    } finally {
      pending = { ...pending, [key]: false };
    }
  }
</script>

{#if searchable}
  {#if enabled}
    <section class="omnibar-tj" aria-label="TJ 검색 결과" aria-live="polite">
      <header class="omnibar-tj-heading">
        <div>
          <h2>TJ에서 더 찾기</h2>
        </div>
        <button type="button" class="secondary-button" onclick={onManualAdd}>직접 입력</button>
      </header>
      {#if loading}<p class="omnibar-tj-status">TJ 검색 중…</p>{/if}
      {#if error}<p class="omnibar-tj-status error">{error}</p>{/if}
      {#if !loading && !error && completedQuery === trimmedQuery && results.length === 0}
        <p class="omnibar-tj-status">TJ에도 검색 결과가 없어요.</p>
      {/if}
      {#if results.length}
        <div class="omnibar-tj-results">
          {#each results as candidate (candidateKey(candidate))}
            {@const key = candidateKey(candidate)}
            {@const existing = existingByCandidate.get(key) ?? added[key]}
            <SongRow tjNumber={candidate.tjNumber} title={candidate.title} artist={candidate.artist}>
              {#snippet actions()}
                <button
                  type="button"
                  class={existing ? "secondary-button" : "primary-button"}
                  disabled={Boolean(pending[key])}
                  onclick={() => void addCandidate(candidate)}
                >
                  {pending[key] ? "추가 중…" : existing ? "Songbook에서 열기" : "바로 추가"}
                </button>
              {/snippet}
            </SongRow>
          {/each}
        </div>
      {/if}
    </section>
  {/if}
{/if}
