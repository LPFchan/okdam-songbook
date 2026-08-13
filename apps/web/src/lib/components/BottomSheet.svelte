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
      requestClose();
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

  // Play the closing animation, then notify the parent.
  let closing = $state(false);
  function requestClose() {
    if (closing) return;
    closing = true;
    window.setTimeout(onClose, 190);
  }

  // Vertical drag: pull down past a threshold (or fling) to dismiss,
  // otherwise the sheet springs back. Dragging up just stretches slightly.
  let dragOffset = $state(0);
  let dragging = $state(false);
  let dragStartY = 0;
  let dragStartAt = 0;
  let dragPointerId: number | null = null;

  function onDragStart(event: PointerEvent) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if ((event.target as HTMLElement).closest("button, a, input, select, textarea")) return;
    dragging = true;
    dragPointerId = event.pointerId;
    dragStartY = event.clientY;
    dragStartAt = performance.now();
    dragOffset = 0;
    panel?.setPointerCapture(event.pointerId);
  }

  function onDragMove(event: PointerEvent) {
    if (!dragging || event.pointerId !== dragPointerId) return;
    const raw = event.clientY - dragStartY;
    dragOffset = raw >= 0 ? raw : raw * 0.25;
  }

  function onDragEnd(event: PointerEvent) {
    if (!dragging || event.pointerId !== dragPointerId) return;
    dragging = false;
    dragPointerId = null;
    const elapsed = performance.now() - dragStartAt;
    const velocity = elapsed > 0 ? dragOffset / elapsed : 0;
    const shouldDismiss = dragOffset > 110 || (dragOffset > 48 && velocity > 0.45);
    if (shouldDismiss) {
      dragOffset = 0;
      requestClose();
      return;
    }
    dragOffset = 0;
  }
</script>

<div
  class="sheet-backdrop"
  class:sheet-closing={closing}
  role="presentation"
  onmousedown={(event) => {
    if (event.target === event.currentTarget) requestClose();
  }}
>
  <div
    aria-modal="true"
    aria-label={title}
    class="bottom-sheet"
    class:sheet-dragging={dragging}
    style:transform={dragging ? `translateY(${dragOffset}px)` : undefined}
    bind:this={panel}
    role="dialog"
    tabindex="-1"
    onpointerdown={onDragStart}
    onpointermove={onDragMove}
    onpointerup={onDragEnd}
    onpointercancel={onDragEnd}
  >
    <div class="sheet-handle" aria-hidden="true"></div>
    <header class="sheet-header">
      <h2>{title}</h2>
      <button bind:this={closeButton} type="button" class="icon-button" aria-label="닫기" onclick={requestClose}>
        <X size={20} />
      </button>
    </header>
    {@render children()}
  </div>
</div>
