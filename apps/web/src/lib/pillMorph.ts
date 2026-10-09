import { createSpring, type SpringConfig } from "./spring";

/**
 * Slightly underdamped, so pills overshoot a hair and settle like liquid
 * instead of sliding to a stop.
 */
export const PILL: SpringConfig = { stiffness: 380, damping: 26 };

function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * Spring a CSS custom property between 0 and 1. The topline uses two of these
 * (--merge-left, --merge-right) to pull neighbouring pills into one: the gap,
 * the facing corners, and the inner borders all read from the same value.
 */
export function mergeSpring(node: HTMLElement, params: { name: string; merged: boolean }) {
  let name = params.name;
  const spring = createSpring(params.merged ? 1 : 0, PILL, (value) => node.style.setProperty(name, String(Math.round(value * 1000) / 1000)));
  spring.settle(params.merged ? 1 : 0);
  return {
    update(next: { name: string; merged: boolean }) {
      name = next.name;
      const target = next.merged ? 1 : 0;
      if (reducedMotion()) spring.settle(target);
      else spring.setTarget(target);
    },
    destroy() {
      spring.stop();
    }
  };
}

/**
 * Spring an inline element's width to fit its only child, so a label that
 * changes text or collapses away resizes its pill smoothly. The pill next to
 * it is flex: 1 and takes up whatever space is freed.
 */
export function springWidth(node: HTMLElement, params: { collapsed?: boolean } = {}) {
  const inner = node.firstElementChild as HTMLElement;
  let collapsed = Boolean(params.collapsed);
  const target = () => (collapsed ? 0 : inner.offsetWidth);
  const spring = createSpring(target(), PILL, (value) => {
    const width = Math.max(0, value);
    node.style.width = `${width}px`;
    node.style.opacity = String(Math.min(1, width / (inner.offsetWidth || 1)));
  });
  spring.settle(target());
  const retarget = () => {
    if (reducedMotion()) spring.settle(target());
    else spring.setTarget(target());
  };
  const observer = new ResizeObserver(retarget);
  observer.observe(inner);
  return {
    update(next: { collapsed?: boolean } = {}) {
      collapsed = Boolean(next.collapsed);
      retarget();
    },
    destroy() {
      observer.disconnect();
      spring.stop();
    }
  };
}
