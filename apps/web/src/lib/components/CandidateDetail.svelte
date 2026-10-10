<script lang="ts">
  import type { DamSongCandidate, KaraokeSystem, TjSongCandidate } from "@songbook/shared";
  import { Plus } from "@lucide/svelte";
  import { karaokeSources, type Candidate } from "../karaokeSources";

  interface Props {
    system: KaraokeSystem;
    candidate: Candidate;
    pending: boolean;
    onAdd(): void;
    registerActions?: (content: import("svelte").Snippet) => void;
  }

  const { system, candidate, pending, onAdd, registerActions }: Props = $props();

  const source = $derived(karaokeSources[system]);
  // Credits TJ and DAM list beyond title and artist; blank ones are left out.
  const extras = $derived(
    (system === "tj"
      ? [["작사", (candidate as TjSongCandidate).lyricist], ["작곡", (candidate as TjSongCandidate).composer]]
      : [["곡명 요미", (candidate as DamSongCandidate).titleYomi], ["아티스트 요미", (candidate as DamSongCandidate).artistYomi]]
    ).filter(([, value]) => value)
  );

  $effect(() => {
    registerActions?.(detailActions);
  });
</script>

<div class="detail-grid">
  <div class="detail-wide">
    <span class="detail-label">아티스트</span>
    <strong>{candidate.artist}</strong>
  </div>
  <div>
    <span class="detail-label">{source.label} 번호</span>
    <strong>{source.number(candidate)}</strong>
  </div>
  {#each extras as [label, value] (label)}
    <div>
      <span class="detail-label">{label}</span>
      <span>{value}</span>
    </div>
  {/each}
</div>

{#snippet detailActions()}
  <button type="button" class="primary-button" disabled={pending} onclick={onAdd}>
    <Plus size={18} />
    {pending ? "추가 중…" : "Songbook에 추가"}
  </button>
{/snippet}
