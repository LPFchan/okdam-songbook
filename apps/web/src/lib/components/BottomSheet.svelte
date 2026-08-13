<script lang="ts">
  import { onDestroy, type Snippet } from "svelte";
  import { X } from "@lucide/svelte";

  interface Props {
    title: string;
    onClose(): void;
    children: Snippet;
  }

  const { title, onClose, children }: Props = $props();

  let panel = $state<HTMLElement | null>(null);
  let closeButton = $state<HTMLButtonElement | null>(null);
  let previousFocus: HTMLElement | null = null;

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key !== "Tab" || !panel) return;
    const focusable = Array.from(
      panel.querySelectorAll<HTMLElement>(
        "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])"
      )
    );
    if (!focusable.length) {
      event.preventDefault();
      panel.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  $effect(() => {
    previousFocus = document.activeElement as HTMLElement | null;
    document.body.classList.add("scroll-locked");
    closeButton?.focus();
    window.addEventListener("keydown", onKeydown);
    return () => {
      window.removeEventListener("keydown", onKeydown);
      document.body.classList.remove("scroll-locked");
      if (previousFocus && document.contains(previousFocus)) previousFocus.focus();
    };
  });

  onDestroy(() => {
    document.body.classList.remove("scroll-locked");
  });
</script>

<div
  class="sheet-backdrop"
  role="presentation"
  onmousedown={(event) => {
    if (event.target === event.currentTarget) onClose();
  }}
>
  <div aria-modal="true" aria-label={title} class="bottom-sheet" bind:this={panel} role="dialog" tabindex="-1">
    <div class="sheet-handle" aria-hidden="true"></div>
    <header class="sheet-header">
      <h2>{title}</h2>
      <button bind:this={closeButton} type="button" class="icon-button" aria-label="닫기" onclick={onClose}>
        <X size={20} />
      </button>
    </header>
    {@render children()}
  </div>
</div>
