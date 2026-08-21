import { createSpring, GENTLE } from "./spring";

/**
 * Measured, spring-driven height animation for the filter chips bar.
 *
 * Why this exists: flex-wrap flips instantly, CSS cannot transition an auto
 * height, and Svelte applies class bindings in its own flush — two paints
 * before an action's rAF can react. So the component hands the wrap state
 * over entirely: this action receives a `{ expanded, scroller }` pair, owns
 * the chips-expanded class on the scroller, and pins the bar's height before
 * ever flipping the wrap. The sequence per toggle:
 *
 *   1. pin the bar at its current (outgoing) height with clipping
 *   2. flip the scroller's wrap class — the pin caps the bar's painted box,
 *      but not the scroller's layout, so the scroller reports its natural
 *      wrapped height, which is the spring's destination
 *   3. spring the pinned height to that destination
 *   4. on settle, release the pin so the bar is fluid again
 *
 * Steps 1–2 run synchronously inside one frame, so the relocation is always
 * clipped and never paints. The clip lives on this outer bar, not the
 * scroller, because the scroller's overflow-x would break vertical clipping.
 */
export function chipsHeight(
  node: HTMLElement,
  params: { expanded: boolean; scroller: HTMLElement | null }
) {
  let isExpanded = params.expanded;
  let frame = 0;
  const reduced =
    typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  const release = () => {
    node.style.height = "";
    node.style.overflow = "";
  };

  // Writes the pinned height every frame. The writer arms only after
  // settle(), because the spring reports active=false during its own
  // synchronous settle callback.
  let running = false;
  const spring = createSpring(0, GENTLE, (value) => {
    if (!running) return;
    node.style.height = Math.round(value * 10) / 10 + "px";
  });

  const releaseWhenSettled = () => {
    if (!spring.active) {
      running = false;
      release();
      return;
    }
    frame = requestAnimationFrame(releaseWhenSettled);
  };

  const applyWrap = (expanded: boolean) => {
    params.scroller?.classList.toggle("chips-expanded", expanded);
  };

  const animateTo = (nextExpanded: boolean) => {
    isExpanded = nextExpanded;
    cancelAnimationFrame(frame);
    if (reduced) {
      spring.stop();
      running = false;
      applyWrap(nextExpanded);
      release();
      return;
    }
    frame = requestAnimationFrame(() => {
      const scroller = params.scroller;
      if (!scroller) {
        applyWrap(nextExpanded);
        return;
      }
      const from = node.offsetHeight;
      node.style.height = from + "px";
      node.style.overflow = "clip";
      applyWrap(nextExpanded);
      const to = scroller.offsetHeight;

      if (from === to) {
        release();
        return;
      }
      spring.settle(from);
      running = true;
      spring.setTarget(to);
      frame = requestAnimationFrame(releaseWhenSettled);
    });
  };

  applyWrap(params.expanded);

  return {
    update(next: { expanded: boolean; scroller: HTMLElement | null }) {
      params = next;
      if (next.expanded !== isExpanded) animateTo(next.expanded);
    },
    destroy() {
      cancelAnimationFrame(frame);
      spring.stop();
    }
  };
}
