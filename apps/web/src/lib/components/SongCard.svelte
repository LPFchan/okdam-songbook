<script lang="ts">
  import type { Song } from "@songbook/shared";
  import { formatPerformerNames, primaryKey } from "@songbook/shared";
  import { Heart, Users } from "@lucide/svelte";
  import SongRow from "./SongRow.svelte";

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

<SongRow
  tjNumber={song.tjNumber}
  title={song.title}
  titleReadingKo={song.titleReadingKo}
  artist={song.artist}
  artistReadingKo={song.artistReadingKo}
  {query}
  onOpen={() => onOpen(song)}
>
  {#snippet actions()}
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
  {/snippet}
  {#snippet meta()}
    {#if performerLabel}
      <span class="performer-pill">
        <Users size={13} aria-hidden="true" />
        {performerLabel}
      </span>
    {/if}
    {#if song.country}<span>{song.country}</span>{/if}
    {#if keyLabel}<span>{keyLabel}</span>{/if}
    {#if song.lastPerformedAt}<span>최근 부름</span>{/if}
  {/snippet}
</SongRow>
