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
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen?.();
    }
  }
</script>

<!--
  Two branches rather than conditional attributes: a card is either a button or
  plain content, and writing role and tabindex as literals is what lets the
  compiler check them. The row cannot itself be a <button> because the actions
  snippet renders buttons, and interactive elements do not nest.
-->
{#snippet body()}
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
{/snippet}

{#if onOpen}
  <div class="song-card" role="button" tabindex="0" onclick={onOpen} onkeydown={handleKeydown}>
    {@render body()}
  </div>
{:else}
  <div class="song-card">
    {@render body()}
  </div>
{/if}
