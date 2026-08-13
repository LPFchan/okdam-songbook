<script lang="ts">
  import type { Song } from "@songbook/shared";
  import { formatPerformerNames, primaryKey } from "@songbook/shared";
  import { Heart, Users } from "@lucide/svelte";
  import Highlight from "./Highlight.svelte";

  interface Props {
    song: Song;
    query: string;
    onOpen(song: Song): void;
    onFavoriteClick(song: Song): void;
  }

  const { song, query, onOpen, onFavoriteClick }: Props = $props();

  const keyLabel = $derived(primaryKey(song));
  const performerLabel = $derived(formatPerformerNames(song.performerIds, true));
  const favorite = $derived(song.status === "favorite");
</script>

<div class="song-card" role="button" tabindex="0" onclick={() => onOpen(song)} onkeydown={(event) => {
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    onOpen(song);
  }
}}>
  <span class="tj-number">[{song.tjNumber || "----"}]</span>
  <span class="song-content">
    <span class="song-title-line">
      <strong><Highlight text={song.title} {query} /></strong>
      {#if song.titleReadingKo}<span class="song-reading">{song.titleReadingKo}</span>{/if}
    </span>
    <span class="song-artist-line">
      <span><Highlight text={song.artist} {query} /></span>
      {#if song.artistReadingKo}<span class="song-reading">{song.artistReadingKo}</span>{/if}
    </span>
  </span>
  <span class="song-card-actions">
    <button
      type="button"
      class="heart-button"
      aria-label={favorite ? "즐겨찾기에서 제거" : "즐겨찾기에 추가"}
      aria-pressed={favorite}
      onclick={(event) => {
        event.stopPropagation();
        onFavoriteClick(song);
      }}
    >
      <Heart size={18} fill={favorite ? "currentColor" : "none"} />
    </button>
  </span>
  <span class="song-meta">
    {#if performerLabel}
      <span class="performer-pill">
        <Users size={13} aria-hidden="true" />
        {performerLabel}
      </span>
    {/if}
    {#if song.country}<span>{song.country}</span>{/if}
    {#if song.genres[0]}<span>{song.genres[0]}</span>{/if}
    {#if keyLabel}<span>{keyLabel}</span>{/if}
    {#if song.lastPerformedAt}<span>최근 부름</span>{/if}
  </span>
</div>
