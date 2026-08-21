<script lang="ts">
  import type { Snippet } from "svelte";
  import Highlight from "./Highlight.svelte";

  interface Props {
    tjNumber: string;
    title: string;
    titleReadingKo?: string;
    artist: string;
    artistReadingKo?: string;
    query?: string;
    onOpen?(): void;
    actions?: Snippet;
    meta?: Snippet;
  }

  const { tjNumber, title, titleReadingKo, artist, artistReadingKo, query = "", onOpen, actions, meta }: Props = $props();

  function handleKeydown(event: KeyboardEvent) {
    if (!onOpen) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen();
    }
  }
</script>

<div
  class="song-card"
  role={onOpen ? "button" : undefined}
  tabindex={onOpen ? 0 : undefined}
  onclick={onOpen}
  onkeydown={handleKeydown}
>
  <span class="tj-number">{tjNumber || "—"}</span>
  <span class="song-content">
    <span class="song-title-line">
      <strong><Highlight text={title} {query} /></strong>
      {#if titleReadingKo}<span class="song-reading">{titleReadingKo}</span>{/if}
    </span>
    <span class="song-artist-line">
      <span><Highlight text={artist} {query} /></span>
      {#if artistReadingKo}<span class="song-reading">{artistReadingKo}</span>{/if}
    </span>
  </span>
  {#if actions}<span class="song-card-actions">{@render actions()}</span>{/if}
  {#if meta}<span class="song-meta">{@render meta()}</span>{/if}
</div>
