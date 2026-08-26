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

/**
 * One shared clock every animated element in the app subscribes to, instead of each hook running
 * its own `setInterval`. Independent per-component timers used to compound: a busy turn with a
 * spinner, a pulse, and several parallel tool-call spinners each ticking on its own uncoordinated
 * schedule added up to a near-continuous stream of re-renders — Ink repaints its whole live region
 * (there is no `<Static>` boundary around the normal, non-screen-reader transcript) on every one
 * of them, which fights native terminal text selection and scrollback the entire time a response
 * is streaming in. All subscribers firing on the same shared tick get batched into one React
 * render pass instead of several staggered ones, so the real repaint ceiling is this one interval,
 * no matter how many animated elements are on screen at once.
 */
const SHARED_TICK_MS = 100;
const tickSubscribers = new Set<() => void>();
let sharedTimer: ReturnType<typeof setInterval> | undefined;

function subscribeTick(listener: () => void): () => void {
  tickSubscribers.add(listener);
  if (sharedTimer === undefined) {
    sharedTimer = setInterval(() => { for (const subscriber of tickSubscribers) subscriber(); }, SHARED_TICK_MS);
  }
  return () => {
    tickSubscribers.delete(listener);
    if (tickSubscribers.size === 0 && sharedTimer !== undefined) {
      clearInterval(sharedTimer);
      sharedTimer = undefined;
    }
  };
}

/**
 * A frame index in [0, frameCount) that advances roughly every `interval` ms, derived from wall-
 * clock time against the shared tick rather than owning a dedicated timer at that exact interval —
 * callers keep expressing their desired cadence in milliseconds exactly as before; only the
 * underlying timer is now shared app-wide. `interval` values finer than the shared tick round up
 * to the shared tick's own granularity, which is the intended tradeoff (see module doc).
 */
export function useAnimationFrame(frameCount: number, interval = 90): number {
  const [, forceRerender] = useState(0);
  const startRef = useRef(Date.now());
  const enabled = shouldAnimate() && frameCount > 1;
  useEffect(() => {
    if (!enabled) return;
    return subscribeTick(() => forceRerender((value) => value + 1));
  }, [enabled]);
  if (!enabled) return 0;
  return Math.floor((Date.now() - startRef.current) / Math.max(SHARED_TICK_MS, interval)) % frameCount;
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
  /** Milliseconds per shared tick. Default 220. Finer than the shared clock's own granularity
   * rounds up to it — see the module doc on why the timer itself is shared app-wide now. */
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
  const interval = Math.max(SHARED_TICK_MS, options.interval ?? 220);
  const offset = options.offset ?? 1;
  const enabled = shouldAnimate() && count > 0 && levels > 1;
  const [, forceRerender] = useState(0);
  const startRef = useRef(Date.now());
  useEffect(() => {
    if (!enabled) return;
    return subscribeTick(() => forceRerender((value) => value + 1));
  }, [enabled]);
  const tick = enabled ? Math.floor((Date.now() - startRef.current) / interval) : 0;
  return Array.from({ length: count }, (_, index) => (enabled ? (tick + index * offset) % levels : levels - 1));
}

/**
 * True for a brief window (`durationMs`) whenever `trigger` changes identity/value, then settles
 * back to false — a transient highlight pulse for "something just arrived" (a new message, a new
 * background task) rather than a persistent state. Never flashes on first mount: only a genuine
 * change after the initial render counts. Always false when animation is disabled. This is a
 * one-shot timeout, not a continuous loop, so it deliberately does not join the shared tick above
 * — it does not contribute to sustained repaint pressure the way a repeating animation does.
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
