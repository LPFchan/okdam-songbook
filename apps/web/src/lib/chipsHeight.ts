import { createSpring, GENTLE } from "./spring";

/**
 * Measured, spring-driven height animation for the filter chips bar.
 *
 * flex-wrap flips instantly and CSS cannot transition an auto height, so
 * without this the bar hard-snaps between its collapsed and expanded sizes.
 * The action owns the wrap state through `onWrap`: the caller hands over its
 * expanded flag, and the class is only re-applied once the spring has pinned
 * the outgoing height — so no frame ever paints the unanimated snap.
 */
export function chipsHeight(node: HTMLElement, initialExpanded: boolean) {
  let isExpanded = initialExpanded;
  let frame = 0;
  const reduced =
    typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

  const release = () => {
    node.style.height = "";
    node.style.overflowY = "";
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
    requestAnimationFrame(releaseWhenSettled);
  };

  const animateTo = (nextExpanded: boolean) => {
    isExpanded = nextExpanded;
    if (reduced) {
      node.classList.toggle("chips-expanded", nextExpanded);
      release();
      return;
    }
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      // The bar is still in the previous wrap state (the caller stopped
      // driving the class directly), so offsetHeight is the origin. Flip
      // the wrap to measure the destination; nothing paints mid-frame.
      const from = node.offsetHeight;
      node.classList.toggle("chips-expanded", nextExpanded);
      const to = node.offsetHeight;

      if (from === to) {
        release();
        return;
      }
      // Rewind the painted height to the origin, then spring forward.
      // overflowY keeps the wrapped content from spilling while the pinned
      // height trails behind it.
      node.style.overflowY = "clip";
      node.style.height = from + "px";
      spring.settle(from);
      running = true;
      spring.setTarget(to);
      requestAnimationFrame(releaseWhenSettled);
    });
  };

  node.classList.toggle("chips-expanded", initialExpanded);

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
