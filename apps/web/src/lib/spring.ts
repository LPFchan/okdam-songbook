export interface SpringConfig {
  /** Stiffness — how hard the spring pulls toward the target. */
  stiffness: number;
  /** Damping — higher means less bounce. */
  damping: number;
}

export const SNAPPY: SpringConfig = { stiffness: 420, damping: 34 };
export const GENTLE: SpringConfig = { stiffness: 170, damping: 24 };
export const BOUNCY: SpringConfig = { stiffness: 320, damping: 22 };
/** Calm, non-overshooting settle — used for releasing a drag back to rest. */
export const SETTLE: SpringConfig = { stiffness: 140, damping: 32 };

export interface Spring {
  /** Current value. */
  readonly value: number;
  /** Current velocity (units per second). */
  readonly velocity: number;
  /** Whether the spring is currently moving. */
  readonly active: boolean;
  /** Impulse: add to the spring's velocity (e.g. a fling on release). */
  kick(amount: number): void;
  /** Aim the spring at a new target, keeping current position and velocity. */
  setTarget(target: number): void;
  /** Jump straight to a value and stop. */
  settle(value: number): void;
  stop(): void;
}

/**
 * A damped harmonic oscillator integrated on requestAnimationFrame, so it
 * runs at the display's native refresh rate (60/90/120fps) and carries
 * velocity naturally — unlike CSS timing functions, which restart from zero.
 */
export function createSpring(initial: number, config: SpringConfig, onUpdate: (value: number) => void): Spring {
  let value = initial;
  let target = initial;
  let velocity = 0;
  let frame = 0;
  let lastTime = 0;

  const EPSILON_VALUE = 0.01;
  const EPSILON_VELOCITY = 0.01;

  function step(time: number) {
    const dt = Math.min((time - lastTime) / 1000 || 1 / 60, 1 / 30);
    lastTime = time;

    const displacement = value - target;
    const springForce = -config.stiffness * displacement;
    const dampingForce = -config.damping * velocity;
    const acceleration = springForce + dampingForce;

    velocity += acceleration * dt;
    value += velocity * dt;

    if (Math.abs(value - target) < EPSILON_VALUE && Math.abs(velocity) < EPSILON_VELOCITY) {
      value = target;
      velocity = 0;
      frame = 0;
      onUpdate(value);
      return;
    }
    onUpdate(value);
    frame = requestAnimationFrame(step);
  }

  function ensureRunning() {
    if (frame === 0) {
      lastTime = 0;
      frame = requestAnimationFrame((time) => {
        lastTime = time;
        frame = requestAnimationFrame(step);
      });
    }
  }

  return {
    get value() {
      return value;
    },
    get velocity() {
      return velocity;
    },
    get active() {
      return frame !== 0;
    },
    kick(amount: number) {
      velocity += amount;
      ensureRunning();
    },
    setTarget(next: number) {
      if (next === target) return;
      target = next;
      ensureRunning();
    },
    settle(next: number) {
      value = next;
      target = next;
      velocity = 0;
      if (frame !== 0) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
      onUpdate(value);
    },
    stop() {
      if (frame !== 0) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
    }
  };
}
