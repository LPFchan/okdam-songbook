<script lang="ts">
  import type { KaraokeSystem, Song } from "@songbook/shared";
  import { candidateKey, findSavedSong, karaokeSources, type Candidate } from "../karaokeSources";
  import { snackbar } from "../snackbar.svelte";
  import BottomSheet from "./BottomSheet.svelte";
  import CandidateDetail from "./CandidateDetail.svelte";
  import SongRow from "./SongRow.svelte";

  interface Props {
    system: KaraokeSystem;
    candidates: Candidate[];
    songs: Song[];
    /** Adding waits while this holds; saved songs still open. */
    paused?: boolean;
    requireCredential(): Promise<string>;
    onOpenExisting(song: Song): void;
    onSongSaved(song: Song): void;
  }

  const { system, candidates, songs, paused = false, requireCredential, onOpenExisting, onSongSaved }: Props = $props();

  const source = $derived(karaokeSources[system]);

  let pending = $state<Record<string, boolean>>({});
  let added = $state<Record<string, Song>>({});
  let previewing = $state<Candidate | null>(null);
  const requestIds = new Map<string, string>();

  const existingByCandidate = $derived.by(() => {
    const matches = new Map<string, Song>();
    for (const candidate of candidates) {
      const existing = findSavedSong(system, candidate, songs);
      if (existing) matches.set(candidateKey(system, candidate), existing);
    }
    return matches;
  });

  async function addCandidate(candidate: Candidate) {
    const key = candidateKey(system, candidate);
    if (pending[key]) return;
    const existing = existingByCandidate.get(key) ?? added[key];
    if (existing) {
      onOpenExisting(existing);
      return;
    }
    if (paused) return;
    let requestId = requestIds.get(key);
    if (!requestId) {
      requestId = crypto.randomUUID();
      requestIds.set(key, requestId);
    }
    pending = { ...pending, [key]: true };
    try {
      const ownerSubject = await requireCredential();
      const response = await source.add(candidate, requestId, ownerSubject);
      const song = response.song ?? response.existing;
      if (song) {
        added = { ...added, [key]: song };
        onSongSaved(song);
        snackbar.show(
          response.outcome === "created"
            ? `${song.title}을(를) 추가했어요.`
            : response.outcome === "linked"
              ? `${song.title}에 DAM 번호를 붙였어요.`
              : `${song.title}은(는) 이미 Songbook에 있어요.`
        );
      }
    } catch (reason) {
      snackbar.show(reason instanceof Error ? reason.message : "곡을 추가하지 못했어요.");
    } finally {
      pending = { ...pending, [key]: false };
    }
  }

  function openCandidate(candidate: Candidate) {
    const key = candidateKey(system, candidate);
    const existing = existingByCandidate.get(key) ?? added[key];
    if (existing) onOpenExisting(existing);
    else previewing = candidate;
  }

  async function addPreviewed(candidate: Candidate) {
    await addCandidate(candidate);
    const key = candidateKey(system, candidate);
    if (added[key] && previewing === candidate) previewing = null;
  }
</script>

<div class="omnibar-tj-results">
  {#each candidates as candidate (candidateKey(system, candidate))}
    {@const key = candidateKey(system, candidate)}
    {@const existing = existingByCandidate.get(key) ?? added[key]}
    <SongRow number={source.number(candidate)} title={candidate.title} artist={candidate.artist} onOpen={() => openCandidate(candidate)}>
      {#snippet actions()}
        <button
          type="button"
          class={existing ? "secondary-button" : "primary-button"}
          disabled={Boolean(pending[key]) || (paused && !existing)}
          onclick={(event) => {
            event.stopPropagation();
            void addCandidate(candidate);
          }}
        >
          {pending[key] ? "추가 중…" : existing ? "Songbook에서 열기" : "바로 추가"}
        </button>
      {/snippet}
    </SongRow>
  {/each}
</div>

{#if previewing}
  {@const candidate = previewing}
  <BottomSheet title={candidate.title} onClose={() => (previewing = null)}>
    {#snippet children(registerActions: (content: import("svelte").Snippet) => void)}
      <CandidateDetail
        {system}
        {candidate}
        pending={Boolean(pending[candidateKey(system, candidate)])}
        {paused}
        onAdd={() => void addPreviewed(candidate)}
        {registerActions}
      />
    {/snippet}
  </BottomSheet>
{/if}
