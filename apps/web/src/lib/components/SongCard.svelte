<script lang="ts">
  import type { KaraokeSystem, Song } from "@songbook/shared";
  import { formatPerformerNames, primaryKey } from "@songbook/shared";
  import { Heart, Users } from "@lucide/svelte";
  import SongRow from "./SongRow.svelte";

  interface Props {
    song: Song;
    system?: KaraokeSystem;
    query: string;
    favorite: boolean;
    favoritePending?: boolean;
    onOpen(song: Song): void;
    onFavoriteClick(song: Song): void;
  }

  const { song, system = "tj", query, favorite, favoritePending = false, onOpen, onFavoriteClick }: Props = $props();

  const keyLabel = $derived(primaryKey(song));
  const performerLabel = $derived(formatPerformerNames(song.performerIds, true));
</script>

<SongRow
  number={system === "dam" ? song.damNumber : song.tjNumber}
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
      disabled={favoritePending}
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
