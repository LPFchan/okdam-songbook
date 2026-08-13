<script lang="ts">
  import { highlightParts } from "@songbook/shared";

  interface Props {
    text: string;
    query: string;
  }

  const { text, query }: Props = $props();
  const parts = $derived(highlightParts(text, query));
</script>

{#each parts as part, index (index)}
  {#if part.hit}<mark class="hit">{part.text}</mark>{:else}{part.text}{/if}
{/each}
