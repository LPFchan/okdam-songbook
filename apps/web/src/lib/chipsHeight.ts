import { createSpring, GENTLE } from "./spring";

/**
 * Measured, spring-driven height animation for the filter chips bar.
 *
 * flex-wrap flips instantly, so the bar's height would otherwise hard-snap
 * between its collapsed and expanded sizes. Svelte applies the class change
 * in the same microtask as the action update, so the measurement defers to
 * the next frame, rewinds to the pre-flip height, then springs forward.
 */
export function chipsHeight(node: HTMLElement, initialExpanded: boolean) {
  let isExpanded = initialExpanded;
  let animating = false;
  let frame = 0;
  const reduced =
    typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  const release = () => {
    animating = false;
    node.style.height = "";
    node.style.overflowY = "";
  };

  // Writes the pinned height every frame. The writer is armed only after
  // settle(), because the spring reports active=false during its own
  // synchronous settle callback.
  let running = false;
  const spring = createSpring(0, GENTLE, (value) => {
    if (!running) return;
    node.style.height = Math.round(value * 10) / 10 + "px";
  });

  const animateTo = (nextExpanded: boolean) => {
    isExpanded = nextExpanded;
    if (reduced) {
      release();
      return;
    }
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      // By now the class flip has been painted: offsetHeight is the
      // destination. Rewind to the previous state to measure the origin.
      const to = node.offsetHeight;
      node.classList.toggle("chips-expanded", !isExpanded);
      const from = node.offsetHeight;
      node.classList.toggle("chips-expanded", isExpanded);

      if (from === to) {
        release();
        return;
      }
      animating = true;
      // Keep the unexpanded overflow-x clipping but block vertical spill
      // while the pinned height is smaller than the wrapped content.
      node.style.overflowY = "clip";
      spring.settle(from);
      // Arm the writer only after settle(), whose synchronous onUpdate
      // would otherwise write before the spring starts moving.
      running = true;
      spring.setTarget(to);
      // The spring's final step lands exactly on the target with
      // active=false; the next onUpdate after that never fires, so detect
      // the end on a trailing frame and release the pinned height.
      const releaseWhenSettled = () => {
        if (!spring.active) {
          running = false;
          release();
          return;
        }
        requestAnimationFrame(releaseWhenSettled);
      };
      requestAnimationFrame(releaseWhenSettled);
    });
  };

  animateTo(initialExpanded);

  return {
    update(nextExpanded: boolean) {
      if (nextExpanded !== isExpanded) animateTo(nextExpanded);
    },
    destroy() {
      cancelAnimationFrame(frame);
      spring.stop();
    }
  };
}
