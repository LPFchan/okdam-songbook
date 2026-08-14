<script lang="ts">
  import { onDestroy, onMount, type Snippet } from "svelte";
  import { X } from "@lucide/svelte";
  import { createSpring, SETTLE, SNAPPY } from "../spring";

  interface Props {
    title: string;
    onClose(): void;
    children: Snippet;
  }

  const { title, onClose, children }: Props = $props();

  let panel = $state<HTMLElement | null>(null);
  let scroller = $state<HTMLElement | null>(null);
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

  // All sheet motion runs through one spring system driven by a single
  // requestAnimationFrame loop — entrance, dragging, settle-back, and
  // dismiss are the same physics, so motion never snaps or restarts.
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let offset = $state(0);
  let backdropOpacity = $state(0);
  let settling = $state(false);
  let dragging = $state(false);
  let closing = false;
  let detachTimer = 0;
  let detachQueued = false;
  let liveOffset = 0;
  let pointerId: number | null = null;
  let startY = 0;
  let startX = 0;
  let lastY = 0;
  let lastAt = 0;
  let velocity = 0; // px per ms, positive = downward
  // During a drag, how far below the finger the panel hangs — the scroll
  // offset captured when the gesture took over.
  let grabLead = 0;

  const sheetSpring = createSpring(0, SNAPPY, () => {});
  const settleSpring = createSpring(0, SETTLE, () => {});

  const FLING_VELOCITY = 0.5; // px/ms

  function maxRubberBand() {
    return Math.min(window.innerHeight * 0.12, 90);
  }

  function rubberBand(raw: number) {
    const max = maxRubberBand();
    return -(max * (1 - Math.exp(raw / max)));
  }

  function dismissDistance() {
    return (panel?.offsetHeight ?? window.innerHeight) + 48;
  }

  // Every moving state registers its current offset here; the driver applies
  // the smallest (highest-on-screen) one so a fling downward always wins
  // over a settle-back that is still flying upward.
  const motion = {
    entrance: null as number | null,
    drag: null as number | null,
    settle: null as number | null,
    dismiss: null as number | null
  };

  function applyMotion() {
    let next = Number.POSITIVE_INFINITY;
    for (const key of ["entrance", "drag", "settle", "dismiss"] as const) {
      const value = motion[key];
      if (value !== null && value < next) next = value;
    }
    if (!Number.isFinite(next)) return;
    liveOffset = next;
    offset = next;
    backdropOpacity = Math.max(0, 1 - next / 400);
  }

  let driverFrame = 0;
  function ensureDriver() {
    if (driverFrame === 0) {
      driverFrame = requestAnimationFrame(() => {
        driverFrame = 0;
        applyMotion();
        if (motion.entrance !== null || motion.drag !== null || motion.settle !== null || motion.dismiss !== null) {
          ensureDriver();
        }
      });
    }
  }

  function stopDriver() {
    if (driverFrame !== 0) {
      cancelAnimationFrame(driverFrame);
      driverFrame = 0;
    }
  }

  function detach() {
    if (!detachQueued) {
      detachQueued = true;
      requestAnimationFrame(() => onClose());
    }
  }

  function dismiss(velocityPxPerMs: number) {
    closing = true;
    if (detachTimer === 0) {
      detachTimer = window.setTimeout(detach, 1400);
    }
    if (reducedMotion) {
      motion.dismiss = dismissDistance();
      ensureDriver();
      detach();
      return;
    }
    sheetSpring.sync(liveOffset, 0);
    sheetSpring.setVelocity(velocityPxPerMs * 1000);
    sheetSpring.setTarget(dismissDistance());
  }

  function requestClose() {
    if (closing) return;
    dismiss(0);
  }

  function onDragStart(event: PointerEvent) {
    if (closing || dragging) return;
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if ((event.target as HTMLElement).closest("button, a, input, select, textarea")) return;
    pointerId = event.pointerId;
    startY = event.clientY;
    startX = event.clientX;
    lastY = event.clientY;
    lastAt = performance.now();
    velocity = 0;
    grabLead = scroller?.scrollTop ?? 0;
    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", onDragEnd);
    window.addEventListener("pointercancel", onDragEnd);
  }

  function onDragMove(event: PointerEvent) {
    if (pointerId === null || event.pointerId !== pointerId) return;
    const dy = event.clientY - startY;
    const dx = event.clientX - startX;

    if (!dragging) {
      // Stay out of the way until the gesture is clearly a vertical pull.
      if (Math.abs(dy) < 8 || Math.abs(dx) > Math.abs(dy)) return;
      if (dy > 0) {
        if (grabLead > 0) return; // content is scrolled; let it scroll back first
        panel?.setPointerCapture(event.pointerId);
        settling = true;
      } else if (scroller && scroller.scrollHeight > scroller.clientHeight + 1) {
        return; // content can scroll up; the browser owns this
      } else {
        panel?.setPointerCapture(event.pointerId);
      }
      dragging = true;
      settleSpring.stop();
      motion.settle = null;
      if (!settling) motion.entrance = null;
      window.getSelection()?.removeAllRanges();
    }

    const now = performance.now();
    const dt = now - lastAt;
    if (dt > 0) {
      // Heavy smoothing so a sparse final event can't fake a huge fling.
      velocity = velocity * 0.75 + ((event.clientY - lastY) / dt) * 0.25;
      lastY = event.clientY;
      lastAt = now;
    }

    let next = dy - grabLead;
    if (settling) {
      if (next <= 0) {
        // The spring finished its run; the finger owns the panel from here.
        settling = false;
        motion.entrance = null;
        sheetSpring.stop();
      } else {
        sheetSpring.sync(next, 0);
        sheetSpring.setTarget(next);
      }
    } else if (next < 0) {
      next = rubberBand(next);
    }
    motion.drag = next;
    ensureDriver();
  }

  function onDragEnd(event: PointerEvent) {
    if (pointerId === null || event.pointerId !== pointerId) return;
    pointerId = null;
    window.removeEventListener("pointermove", onDragMove);
    window.removeEventListener("pointerup", onDragEnd);
    window.removeEventListener("pointercancel", onDragEnd);
    if (!dragging) return;
    dragging = false;
    const released = liveOffset;
    const fling = velocity;
    motion.drag = null;
    if (settling) {
      settling = false;
      return; // never grabbed — the entrance spring carries on undisturbed
    }
    if (released > 0 && (released > 110 || fling > FLING_VELOCITY)) {
      dismiss(fling);
      return;
    }
    // Release above the rubber-band ceiling lands back on the band, not on
    // zero, so the sheet never jumps past where the finger left it.
    const bandFloor = rubberBand(-maxRubberBand());
    const target = released < bandFloor ? bandFloor : 0;
    if (reducedMotion) {
      motion.settle = target;
      ensureDriver();
      motion.settle = null;
      return;
    }
    settleSpring.sync(released, fling * 1000);
    settleSpring.setTarget(target);
    motion.settle = 0;
    ensureDriver();
  }

  function onScroll() {
    // A downward drag grabbed while the content was mid-scroll ends here:
    // once the content reaches the top, the panel follows the finger.
    if (pointerId === null || dragging || grabLead <= 0) return;
    grabLead = scroller?.scrollTop ?? 0;
  }

  onMount(() => {
    if (reducedMotion) {
      backdropOpacity = 1;
      return;
    }
    const start = window.innerHeight;
    liveOffset = start;
    offset = start;
    motion.entrance = start;
    ensureDriver();
    sheetSpring.sync(start, 0);
    sheetSpring.setTarget(0);
  });

  onDestroy(() => {
    sheetSpring.stop();
    settleSpring.stop();
    stopDriver();
    window.clearTimeout(detachTimer);
    window.removeEventListener("pointermove", onDragMove);
    window.removeEventListener("pointerup", onDragEnd);
    window.removeEventListener("pointercancel", onDragEnd);
  });

  $effect(() => {
    motion.entrance = closing ? motion.dismiss : sheetSpring.active ? sheetSpring.value : null;
    if (closing) motion.dismiss = sheetSpring.active ? sheetSpring.value : motion.dismiss;
    ensureDriver();
  });

  $effect(() => {
    motion.settle = settleSpring.active ? settleSpring.value : null;
    ensureDriver();
  });
</script>

<div
  class="sheet-backdrop"
  role="presentation"
  style:opacity={backdropOpacity}
  onmousedown={(event) => {
    if (event.target === event.currentTarget) requestClose();
  }}
>
  <div
    aria-modal="true"
    aria-label={title}
    class="bottom-sheet"
    style:transform={offset > 0 ? "translateY(" + offset + "px)" : undefined}
    bind:this={panel}
    role="dialog"
    tabindex="-1"
    onpointerdown={onDragStart}
    onselectstart={(event) => {
      if (dragging) event.preventDefault();
    }}
  >
    <div class="sheet-grip">
      <div class="sheet-handle" aria-hidden="true"></div>
      <header class="sheet-header">
        <h2>{title}</h2>
        <button bind:this={closeButton} type="button" class="icon-button" aria-label="닫기" onclick={requestClose}>
          <X size={20} />
        </button>
      </header>
    </div>
    <div class="sheet-scroll" bind:this={scroller} onscroll={onScroll}>
      {@render children()}
    </div>
  </div>
</div>
