<script lang="ts">
  import { onDestroy, onMount, type Snippet } from "svelte";
  import { X } from "@lucide/svelte";
  import { SETTLE, SNAPPY } from "../spring";

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
  // The sheet's offset from rest, tracked continuously across the gesture so
  // the move handler can be incremental. Positive = pulled down, negative =
  // rubber-banded up.
  let panelOffset = 0;

  // One inline spring, integrated by the driver loop, powers entrance,
  // settle-back, and dismiss. Keeping the physics in this loop (rather than
  // an external rAF-driven spring) means the sheet's motion can never be
  // orphaned by component lifecycle timing.
  const inline = {
    value: 0,
    velocity: 0,
    target: 0,
    running: false,
    kind: null as "entrance" | "settle" | "dismiss" | null,
    stiffness: SNAPPY.stiffness,
    damping: SNAPPY.damping
  };

  function startInline(kind: "entrance" | "settle" | "dismiss", from: number, velocityPxPerSec: number, target: number) {
    const config = kind === "settle" ? SETTLE : SNAPPY;
    inline.value = from;
    inline.velocity = velocityPxPerSec;
    inline.target = target;
    inline.kind = kind;
    inline.stiffness = config.stiffness;
    inline.damping = config.damping;
    inline.running = true;
    motion[kind] = from;
    ensureDriver();
  }

  function inlineStep(dt: number) {
    const displacement = inline.value - inline.target;
    const acceleration = -inline.stiffness * displacement - inline.damping * inline.velocity;
    inline.velocity += acceleration * dt;
    inline.value += inline.velocity * dt;
    const done = Math.abs(inline.value - inline.target) < 1 && Math.abs(inline.velocity) < 25;
    if (done) {
      inline.value = inline.target;
      inline.velocity = 0;
      inline.running = false;
    }
    return inline.value;
  }

  const FLING_VELOCITY = 0.5; // px/ms

  function maxRubberBand() {
    return Math.min(window.innerHeight * 0.12, 90);
  }

  function rubberBand(raw: number) {
    const max = maxRubberBand();
    return -(max * (1 - Math.exp(raw / max)));
  }

  // Inverse of rubberBand: given a (negative) banded offset, recover how far
  // the finger has logically traveled past the edge, so continued pulls keep
  // accumulating smoothly instead of jumping.
  function rubberBandInverse(banded: number) {
    const max = maxRubberBand();
    const ratio = Math.min(0.9999, -banded / max);
    return max * Math.log(1 - ratio); // <= 0
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
  let driverLastAt = 0;
  function ensureDriver() {
    if (driverFrame === 0) {
      driverLastAt = performance.now();
      driverFrame = requestAnimationFrame(function tick(now) {
        driverFrame = 0;
        // Advance the inline entrance/dismiss spring before composing, so the
        // channel value it writes this frame is the one we render.
        if (inline.running) {
          const dt = Math.min((now - driverLastAt) / 1000 || 1 / 60, 1 / 30);
          driverLastAt = now;
          const value = inlineStep(dt);
          if (inline.running) {
            motion[inline.kind ?? "entrance"] = value;
          } else {
            // Spring came to rest: clear its channel and freeze the offset at
            // the settled value so the sheet never lingers a fraction of a
            // pixel off its rest position.
            motion[inline.kind ?? "entrance"] = null;
            if (inline.kind !== "dismiss") {
              liveOffset = inline.target;
              offset = inline.target;
              backdropOpacity = Math.max(0, 1 - inline.target / 400);
            }
          }
        }
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
    motion.entrance = null;
    motion.drag = null;
    startInline("dismiss", liveOffset, velocityPxPerMs * 1000, dismissDistance());
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
    panelOffset = liveOffset;
    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", onDragEnd);
    window.addEventListener("pointercancel", onDragEnd);
  }

  function onDragMove(event: PointerEvent) {
    if (pointerId === null || event.pointerId !== pointerId) return;
    const totalDy = event.clientY - startY;
    const totalDx = event.clientX - startX;

    if (!dragging) {
      // Stay out of the way until the gesture is clearly a vertical pull.
      if (Math.abs(totalDy) < 8 || Math.abs(totalDx) > Math.abs(totalDy)) return;
      panel?.setPointerCapture(event.pointerId);
      // Only treat this as catching the entrance while it is still visibly
      // moving; once it has essentially arrived, the finger owns the sheet.
      settling = motion.entrance !== null && Math.abs(liveOffset) > 6;
      dragging = true;
      inline.running = false;
      motion.settle = null;
      if (!settling) motion.entrance = null;
      panelOffset = liveOffset;
      lastY = event.clientY;
      window.getSelection()?.removeAllRanges();
    }

    const now = performance.now();
    const dt = now - lastAt;
    // Per-event finger travel (positive = finger moved down).
    const step = event.clientY - lastY;
    if (dt > 0) {
      // Heavy smoothing so a sparse final event can't fake a huge fling.
      velocity = velocity * 0.75 + (step / dt) * 0.25;
    }
    lastY = event.clientY;
    lastAt = now;

    // The scroller has touch-action:none, so the browser never scrolls it —
    // every pixel of vertical travel is ours to route. Finger moving up
    // (step<0) scrolls content down while any remains; finger moving down
    // (step>0) scrolls content back toward the top. Whatever is left over
    // after the content hits its edge moves the sheet.
    let remaining = step;
    if (scroller && remaining !== 0) {
      const maxScroll = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const current = scroller.scrollTop;
      const wanted = Math.min(Math.max(current - remaining, 0), maxScroll);
      scroller.scrollTop = wanted;
      // The content absorbed (current - wanted) pixels; the rest moves the sheet.
      remaining = remaining - (current - wanted);
    }

    // Whatever the content could not absorb moves the sheet. Upward past the
    // top rubber-bands; downward is free.
    if (remaining !== 0) {
      let next = panelOffset + remaining;
      if (next < 0) next = panelOffset >= 0 ? rubberBand(remaining) : rubberBand(rubberBandInverse(panelOffset) + remaining);
      panelOffset = next;
      if (settling) {
        if (next <= 0) {
          // The entrance spring finished its run; the finger owns the panel.
          settling = false;
          motion.entrance = null;
          inline.running = false;
        } else {
          inline.value = next;
          inline.target = next;
        }
      }
      motion.drag = next;
      ensureDriver();
    }
  }

  function onDragEnd(event: PointerEvent) {
    if (pointerId === null || event.pointerId !== pointerId) return;
    pointerId = null;
    window.removeEventListener("pointermove", onDragMove);
    window.removeEventListener("pointerup", onDragEnd);
    window.removeEventListener("pointercancel", onDragEnd);
    if (!dragging) return;
    dragging = false;
    const released = panelOffset;
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
    startInline("settle", released, fling * 1000, target);
  }

  onMount(() => {
    if (reducedMotion) {
      backdropOpacity = 1;
      return;
    }
    const start = window.innerHeight;
    liveOffset = start;
    offset = start;
    startInline("entrance", start, 0, 0);
  });

  onDestroy(() => {
    stopDriver();
    window.clearTimeout(detachTimer);
    window.removeEventListener("pointermove", onDragMove);
    window.removeEventListener("pointerup", onDragEnd);
    window.removeEventListener("pointercancel", onDragEnd);
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
    <div class="sheet-scroll" bind:this={scroller}>
      {@render children()}
    </div>
  </div>
</div>
