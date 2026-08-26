import { useEffect, useRef, useState } from "react";
import { supportsMotion } from "./theme.js";
import { isScreenReaderMode } from "./screen-reader-mode.js";

export const spinnerFrames = ["◐", "◓", "◑", "◒"] as const;
export const pulseFrames = ["·", "✧", "✦", "✧"] as const;

/**
 * Whether frame-based animation should run at all. Extends `supportsMotion` (CI, `TERM=dumb`,
 * `ALFACODE_REDUCED_MOTION=1`) rather than replacing it: screen-reader mode implies reduced
 * motion too, since its whole point is a linear, non-repainting output that a spinner ticking
 * every frame would fight against — even outside the dedicated screen-reader render path (e.g.
 * shared primitives like `LoadingLabel` during provider setup).
 */
export function shouldAnimate(environment: NodeJS.ProcessEnv = process.env): boolean {
  return supportsMotion(environment) && !isScreenReaderMode(environment);
}

export function useAnimationFrame(frameCount: number, interval = 90): number {
  const [frame, setFrame] = useState(0);
  const enabled = shouldAnimate() && frameCount > 1;
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setFrame((current) => (current + 1) % frameCount), interval);
    return () => clearInterval(timer);
  }, [enabled, frameCount, interval]);
  return enabled ? frame : 0;
}

export function useSpinner(active = true): string {
  const frame = useAnimationFrame(active ? spinnerFrames.length : 1);
  return active ? (spinnerFrames[frame] ?? spinnerFrames[0]) : "✓";
}

export function usePulse(active = true): string {
  const frame = useAnimationFrame(active ? pulseFrames.length : 1, 180);
  return active ? (pulseFrames[frame] ?? pulseFrames[0]) : "·";
}

export interface TwinkleOptions {
  /** Brightness levels in each point's cycle (0 = dimmest, levels-1 = brightest). Default 3. */
  readonly levels?: number;
  /** Milliseconds per shared tick. Default 220. */
  readonly interval?: number;
  /** Per-index phase-offset multiplier that staggers points against each other. Default 1. */
  readonly offset?: number;
}

/**
 * A starfield of `count` independently-phased points, each cycling through `levels` brightness
 * steps on a shared clock but offset by its own index — so they read as twinkling organically
 * rather than blinking in lockstep. No randomness: each point's phase is a deterministic function
 * of its index, which keeps this cheap to reason about and to test.
 *
 * Disabled (reduced motion, CI, `TERM=dumb`, screen-reader mode — see `shouldAnimate`): every
 * point is pinned at its brightest level, i.e. a fully-lit, still starfield rather than a
 * flickering or blank one.
 */
export function useTwinkle(count: number, options: TwinkleOptions = {}): readonly number[] {
  const levels = Math.max(2, options.levels ?? 3);
  const interval = options.interval ?? 220;
  const offset = options.offset ?? 1;
  const enabled = shouldAnimate() && count > 0 && levels > 1;
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setTick((current) => (current + 1) % levels), interval);
    return () => clearInterval(timer);
  }, [enabled, levels, interval]);
  return Array.from({ length: count }, (_, index) => (enabled ? (tick + index * offset) % levels : levels - 1));
}

/**
 * True for a brief window (`durationMs`) whenever `trigger` changes identity/value, then settles
 * back to false — a transient highlight pulse for "something just arrived" (a new message, a new
 * background task) rather than a persistent state. Never flashes on first mount: only a genuine
 * change after the initial render counts. Always false when animation is disabled.
 */
export function useFlash(trigger: unknown, durationMs = 500): boolean {
  const [active, setActive] = useState(false);
  const previous = useRef(trigger);
  useEffect(() => {
    if (!shouldAnimate()) {
      setActive(false);
      return;
    }
    if (Object.is(previous.current, trigger)) return;
    previous.current = trigger;
    setActive(true);
    const timer = setTimeout(() => setActive(false), durationMs);
    return () => clearTimeout(timer);
  }, [trigger, durationMs]);
  return shouldAnimate() ? active : false;
}
